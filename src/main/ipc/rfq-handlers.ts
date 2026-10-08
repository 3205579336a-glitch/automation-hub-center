import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  DownloadRfqTemplateResult,
  RfqBatchProgress,
  RfqBatchResult,
  RfqCancelResult,
  RfqPreviewResult,
  SelectRfqExcelResult
} from '../../shared/rfq-batch-types'
import { isRfqBatchConfig } from '../../shared/rfq-batch-types'
import { isInteractionResponse } from '../../shared/automation-interaction'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { RfqNativeRunner } from '../automation/rfq-native-runner'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { RfqExcelService } from '../services/rfq-excel-service'
import type { SettingsService } from '../services/settings-service'
import { downloadTemplateWithSaveDialog } from '../services/template-download-service'
import type { GuidedAutomationService } from '../services/guided-automation-service'
import { isTrustedRenderer } from './ipc-security'

export function registerRfqHandlers(
  excelService: RfqExcelService,
  runner: RfqNativeRunner,
  logger: DiagnosticLogger,
  history: ExecutionHistoryService,
  templatePath: string,
  settingsService: SettingsService,
  guided?: GuidedAutomationService
): void {
  ipcMain.handle(
    IPC_CHANNELS.downloadRfqTemplate,
    async (event): Promise<DownloadRfqTemplateResult> => {
      if (!isTrustedRenderer(event)) {
        return { success: false, cancelled: false, message: 'The template request was rejected.' }
      }
      try {
        const settings = await settingsService.getSettings()
        const result = await downloadTemplateWithSaveDialog({
          event,
          templatePath,
          suggestedFileName: 'Create_RFQ_Template.xlsx',
          configuredDirectory: settings.defaultDownloadFolder
        })
        if (!result.success) return result
        await logger.info({
          category: 'automation',
          event: 'rfq.template.downloaded',
          message: 'The Create RFQ template was copied to the configured download folder.',
          tcode: 'ZMFM050072',
          details: { targetPath: result.path }
        })
        return result
      } catch (error) {
        const message = getErrorMessage(error)
        await logger.error({
          category: 'automation',
          event: 'rfq.template.download-failed',
          message,
          errorCode: 'RFQ_TEMPLATE_DOWNLOAD_FAILED',
          tcode: 'ZMFM050072'
        })
        return { success: false, cancelled: false, message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.selectRfqExcelFile,
    async (event): Promise<SelectRfqExcelResult> => {
      if (!isTrustedRenderer(event)) {
        return { success: false, cancelled: false, message: 'The file request was rejected.' }
      }
      const options: Electron.OpenDialogOptions = {
        title: 'Select the Create RFQ workbook',
        properties: ['openFile'],
        filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] }]
      }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true }
      return { success: true, path: result.filePaths[0] }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.previewRfqBatch,
    async (event, input: unknown): Promise<RfqPreviewResult> => {
      if (!isTrustedRenderer(event)) return { success: false, message: 'The preview request was rejected.' }
      if (!isRfqBatchConfig(input)) return { success: false, message: 'The RFQ run settings are invalid.' }
      try {
        const preview = await excelService.preview(input)
        await logger.info({
          category: 'automation',
          event: 'rfq.preview.succeeded',
          message: `RFQ preview validated ${preview.validRows} row(s) in ${input.environment}.`,
          tcode: 'ZMFM050072',
          details: { environment: input.environment, validRows: preview.validRows, invalidRows: preview.invalidRows }
        })
        return { success: true, preview }
      } catch (error) {
        const message = getErrorMessage(error)
        await logger.error({
          category: 'automation',
          event: 'rfq.preview.failed',
          message,
          errorCode: 'RFQ_PREVIEW_FAILED',
          tcode: 'ZMFM050072'
        })
        return { success: false, message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.startRfqBatch,
    async (event, input: unknown): Promise<RfqBatchResult> => {
      if (!isTrustedRenderer(event) || !isRfqBatchConfig(input)) {
        return { success: false, errorCode: 'INVALID_CONFIG', message: 'The RFQ run request is invalid.' }
      }
      if (guided?.isRunning()) return { success: false, errorCode: 'OPERATION_IN_PROGRESS', message: 'Finish or stop the current automation first.' }
      if (input.environment === 'PROD' && !input.productionConfirmed) {
        return { success: false, errorCode: 'INVALID_CONFIG', message: 'Confirm the Production warning before starting Create RFQ.' }
      }
      let reservation: string | undefined
      try { reservation = guided?.begin() } catch { return { success: false, errorCode: 'OPERATION_IN_PROGRESS', message: 'Finish or stop the current automation first.' } }
      try {
      const reportProgress = (progress: RfqBatchProgress): void => {
        if (progress.state === 'WAITING_FOR_USER') {
          try {
            const owner = BrowserWindow.fromWebContents(event.sender)
            if (owner && !owner.isDestroyed()) {
              owner.flashFrame(true)
              owner.once('focus', () => { if (!owner.isDestroyed()) owner.flashFrame(false) })
            }
          } catch { /* Windows attention is best-effort; Python stays paused. */ }
        }
        try { if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.rfqProgress, progress) } catch { /* Engine state survives renderer notification failure. */ }
        if (progress.state === 'WAITING_FOR_USER' || progress.state === 'RECOVERING'
            || ['INTERACTION_RESOLVED', 'RUN_CANCELLED', 'RUN_FAILED', 'RUN_COMPLETED'].includes(progress.type ?? '')) {
          try { if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.automationInteraction, runner.getInteraction()) } catch { /* The request remains readable through getAutomationInteraction. */ }
        }
      }
      const historyEntry = await history.start({
        operation: 'create-rfq',
        label: `Create RFQ — ${input.environment === 'QA' ? 'Test CEQ 321' : 'Production VCE 949'}`,
        summary: `Create RFQ is running in ${input.environment}.`,
        tcode: 'ZMFM050072'
      })
      await logger.info({
        category: 'automation',
        event: 'rfq.batch.started',
        message: `Create RFQ started in ${input.environment}.`,
        tcode: 'ZMFM050072',
        details: { environment: input.environment }
      })
      const result = await runner.run(input, (progress) => {
        reportProgress(progress)
        if (['ACTION_REQUIRED', 'RECOVERABLE_ERROR', 'GROUP_FAILED', 'RUN_FAILED'].includes(progress.type ?? '')) {
          void logger.warning({ category: 'automation', event: `rfq.${progress.type}`, message: progress.message,
            tcode: 'ZMFM050072', details: { runId: historyEntry.id, group: progress.groupKey ?? '' } }).catch(() => undefined)
        }
      }, historyEntry.id)
      try { if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.automationInteraction, null) } catch { /* Renderer may have closed. */ }
      await history.finish(historyEntry.id, result.success
        ? {
            status: result.failed > 0 || result.skipped > 0 || (result.withSkips ?? 0) > 0 ? 'Partial' : 'Success',
            summary: result.message,
            total: result.total ?? result.processed,
            processed: result.processed,
            succeeded: result.succeeded,
            skipped: result.skipped,
            failed: result.failed,
            resultPath: result.resultPath
          }
        : {
            status: result.errorCode === 'CANCELLED' ? 'Cancelled' : 'Failed',
            summary: result.message,
            total: result.total,
            processed: result.processed,
            succeeded: result.succeeded,
            skipped: result.skipped,
            failed: result.failed,
            resultPath: result.resultPath
          })
      await (result.success ? logger.info.bind(logger) : logger.error.bind(logger))({
        category: 'automation',
        event: result.success ? 'rfq.batch.completed' : 'rfq.batch.failed',
        message: result.message,
        ...(!result.success ? { errorCode: result.errorCode } : {}),
        tcode: 'ZMFM050072',
        details: result.success
          ? { environment: input.environment, processed: result.processed, succeeded: result.succeeded, skipped: result.skipped, failed: result.failed }
          : { environment: input.environment }
      })
      return result
      } finally { if (reservation) guided?.end(reservation) }
    }
  )

  ipcMain.handle(IPC_CHANNELS.cancelRfqBatch, async (event): Promise<RfqCancelResult> => {
    if (!isTrustedRenderer(event)) return { success: false, message: 'The cancel request was rejected.' }
    const accepted = await runner.cancel()
    return {
      success: accepted,
      message: accepted
        ? 'Stop requested. The current RFQ group will finish and save before stopping.'
        : 'No Create RFQ run is currently active.'
    }
  })

  ipcMain.handle(IPC_CHANNELS.getAutomationInteraction, (event) => {
    if (!isTrustedRenderer(event)) return null
    return guided?.getInteraction() ?? runner.getInteraction()
  })

  ipcMain.handle(IPC_CHANNELS.respondAutomationInteraction, async (event, input: unknown) => {
    if (!isTrustedRenderer(event) || !isInteractionResponse(input)) return { success: false, message: 'Invalid interaction response.' }
    try {
      const success = guided?.getInteraction()?.runId === input.runId ? await guided.respond(input) : await runner.respond(input)
      return { success, message: success ? undefined : 'This request is no longer active. Check the current prompt.' }
    } catch {
      return { success: false, message: 'Could not send the response. Automation remains paused; try again.' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.openAutomationArtifact, async (event, path: unknown) => {
    if (!isTrustedRenderer(event) || typeof path !== 'string' || !guided) return { success: false, message: 'Request rejected.' }
    try { return await guided.openArtifact(path) } catch { return { success: false, message: 'The result file could not be opened.' } }
  })

  ipcMain.handle(IPC_CHANNELS.openRfqArtifact, async (event, path: unknown) => {
    if (!isTrustedRenderer(event) || typeof path !== 'string' || !runner.canOpen(path)) {
      return { success: false, message: 'Only result files and diagnostic folders from this RFQ session can be opened.' }
    }
    const message = await shell.openPath(path)
    return { success: !message, message }
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
