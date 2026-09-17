import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  DownloadRfqTemplateResult,
  RfqBatchProgress,
  RfqBatchResult,
  RfqCancelResult,
  RfqPreviewResult,
  SelectRfqExcelResult
} from '../../shared/rfq-batch-types'
import { isRfqBatchConfig } from '../../shared/rfq-batch-types'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { RfqNativeRunner } from '../automation/rfq-native-runner'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { RfqExcelService } from '../services/rfq-excel-service'
import type { SettingsService } from '../services/settings-service'
import { downloadTemplateWithSaveDialog } from '../services/template-download-service'
import { isTrustedRenderer } from './ipc-security'

export function registerRfqHandlers(
  excelService: RfqExcelService,
  runner: RfqNativeRunner,
  logger: DiagnosticLogger,
  history: ExecutionHistoryService,
  templatePath: string,
  settingsService: SettingsService
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
      if (input.environment === 'PROD' && !input.productionConfirmed) {
        return { success: false, errorCode: 'INVALID_CONFIG', message: 'Confirm the Production warning before starting Create RFQ.' }
      }
      const reportProgress = (progress: RfqBatchProgress): void => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.rfqProgress, progress)
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
      const result = await runner.run(input, reportProgress)
      await history.finish(historyEntry.id, result.success
        ? {
            status: result.failed > 0 ? 'Partial' : 'Success',
            summary: result.message,
            total: result.processed,
            processed: result.processed,
            succeeded: result.succeeded,
            skipped: result.skipped,
            failed: result.failed,
            resultPath: result.resultPath
          }
        : {
            status: result.errorCode === 'CANCELLED' ? 'Cancelled' : 'Failed',
            summary: result.message
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
    }
  )

  ipcMain.handle(IPC_CHANNELS.cancelRfqBatch, async (event): Promise<RfqCancelResult> => {
    if (!isTrustedRenderer(event)) return { success: false, message: 'The cancel request was rejected.' }
    const accepted = runner.cancel()
    return {
      success: accepted,
      message: accepted
        ? 'Cancellation requested. The RFQ engine is stopping.'
        : 'No Create RFQ run is currently active.'
    }
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
