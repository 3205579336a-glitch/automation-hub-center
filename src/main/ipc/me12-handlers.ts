import { BrowserWindow, dialog, ipcMain } from 'electron'
import type {
  Me12BatchProgress,
  Me12BatchResult,
  Me12CancelResult,
  DownloadMe12TemplateResult,
  Me12PreviewResult,
  SelectExcelFileResult
} from '../../shared/me12-types'
import { isMe12BatchConfig } from '../../shared/me12-types'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { Me12BatchRunner } from '../automation/me12-batch-runner'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { Me12ExcelService } from '../services/me12-excel-service'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { SettingsService } from '../services/settings-service'
import { downloadTemplateWithSaveDialog } from '../services/template-download-service'
import { isTrustedRenderer } from './ipc-security'

export function registerMe12Handlers(
  excelService: Me12ExcelService,
  runner: Me12BatchRunner,
  logger: DiagnosticLogger,
  history: ExecutionHistoryService,
  templatePath: string,
  settingsService: SettingsService
): void {
  ipcMain.handle(
    IPC_CHANNELS.downloadMe12Template,
    async (event): Promise<DownloadMe12TemplateResult> => {
      if (!isTrustedRenderer(event)) {
        return { success: false, cancelled: false, message: 'The template request was rejected.' }
      }
      try {
        const settings = await settingsService.getSettings()
        const result = await downloadTemplateWithSaveDialog({
          event,
          templatePath,
          suggestedFileName: 'ME12_Supplier_Lead_Time_Template.xlsx',
          configuredDirectory: settings.defaultDownloadFolder
        })
        if (!result.success) return result
        await logger.info({
          category: 'automation',
          event: 'me12.template.downloaded',
          message: 'The ME12 upload template was copied to the configured download folder.',
          tcode: 'ME12',
          details: { targetPath: result.path }
        })
        return result
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'The template could not be saved.'
        await logger.error({
          category: 'automation',
          event: 'me12.template.download-failed',
          message,
          errorCode: 'ME12_TEMPLATE_DOWNLOAD_FAILED',
          tcode: 'ME12'
        })
        return {
          success: false,
          cancelled: false,
          message
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.selectMe12ExcelFile,
    async (event): Promise<SelectExcelFileResult> => {
      if (!isTrustedRenderer(event)) {
        return { success: false, cancelled: false, message: 'The file request was rejected.' }
      }
      const options: Electron.OpenDialogOptions = {
        title: 'Select the ME12 source workbook',
        properties: ['openFile'],
        filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] }]
      }
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) {
        return { success: false, cancelled: true }
      }
      return { success: true, path: result.filePaths[0] }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.previewMe12Batch,
    async (event, input: unknown): Promise<Me12PreviewResult> => {
      if (!isTrustedRenderer(event)) {
        return { success: false, message: 'The preview request was rejected.' }
      }
      if (!isMe12BatchConfig(input)) {
        return { success: false, message: 'The ME12 batch settings are invalid.' }
      }
      try {
        const preview = await excelService.preview(input)
        await logger.info({
          category: 'automation',
          event: 'me12.preview.succeeded',
          message: `ME12 preview found ${preview.selectedInfoRecords} selected ${input.infoCategory} Info Record(s) for Plant ${input.targetPlant}.`,
          tcode: 'ME12',
          details: {
            sheetName: preview.sheetName,
            matchedRows: preview.matchedRows,
            uniqueInfoRecords: preview.uniqueInfoRecords,
            selectedInfoRecords: preview.selectedInfoRecords
          }
        })
        return { success: true, preview }
      } catch (error) {
        const message = getErrorMessage(error)
        await logger.error({
          category: 'automation',
          event: 'me12.preview.failed',
          message,
          errorCode: 'ME12_PREVIEW_FAILED',
          tcode: 'ME12'
        })
        return { success: false, message }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.startMe12Batch,
    async (event, input: unknown): Promise<Me12BatchResult> => {
      if (!isTrustedRenderer(event)) {
        return {
          success: false,
          errorCode: 'INVALID_CONFIG',
          message: 'The batch request was rejected.'
        }
      }
      if (!isMe12BatchConfig(input)) {
        return {
          success: false,
          errorCode: 'INVALID_CONFIG',
          message: 'The ME12 batch settings are invalid.'
        }
      }
      const reportProgress = (progress: Me12BatchProgress): void => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(IPC_CHANNELS.me12Progress, progress)
        }
      }
      await logger.info({
        category: 'automation',
        event: 'me12.batch.started',
        message: `ME12 ${input.infoCategory} batch started for Plant ${input.targetPlant} in ${input.dryRun ? 'dry-run' : 'live'} mode.`,
        tcode: 'ME12',
        details: { maxItems: input.maxItems, saveEvery: input.saveEvery, infoCategory: input.infoCategory }
      })
      const historyEntry = await history.start({
        operation: 'me12-batch',
        label: input.dryRun
          ? 'ME12 Supplier Lead Time — Dry Run'
          : `ME12 Supplier Lead Time — ${input.infoCategory === 'consignment' ? 'Consignment' : 'Standard'}`,
        summary: 'ME12 batch is running.',
        tcode: 'ME12',
        dryRun: input.dryRun
      })
      const result = await runner.run(input, reportProgress)
      await history.finish(
        historyEntry.id,
        result.success
          ? {
              status: result.failed > 0 ? 'Partial' : 'Success',
              summary: result.message,
              total: result.processed,
              processed: result.processed,
              succeeded: result.succeeded,
              skipped: result.skipped,
              failed: result.failed,
              browserCount: result.browserCount,
              resultPath: result.resultPath,
              backupPath: result.backupPath
            }
          : {
              status: result.errorCode === 'CANCELLED' ? 'Cancelled' : 'Failed',
              summary: result.message
            }
      )
      await (result.success ? logger.info.bind(logger) : logger.error.bind(logger))({
        category: 'automation',
        event: result.success ? 'me12.batch.completed' : 'me12.batch.failed',
        message: result.message,
        ...(!result.success ? { errorCode: result.errorCode } : {}),
        tcode: 'ME12',
        details: result.success
          ? {
              processed: result.processed,
              succeeded: result.succeeded,
              skipped: result.skipped,
              failed: result.failed,
              browserCount: result.browserCount
            }
          : undefined
      })
      return result
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.cancelMe12Batch,
    async (event): Promise<Me12CancelResult> => {
      if (!isTrustedRenderer(event)) {
        return { success: false, message: 'The cancel request was rejected.' }
      }
      const accepted = runner.cancel()
      return {
        success: accepted,
        message: accepted
          ? 'Cancellation requested. The current safe step will finish before stopping.'
          : 'No ME12 batch is currently running.'
      }
    }
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
