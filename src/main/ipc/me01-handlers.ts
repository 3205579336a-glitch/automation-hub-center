import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  DownloadMe01TemplateResult,
  Me01BatchProgress,
  Me01BatchResult,
  Me01CancelResult,
  Me01PreviewResult,
  SelectMe01ExcelResult
} from '../../shared/me01-types'
import { isMe01BatchConfig } from '../../shared/me01-types'
import type { Me01NativeRunner } from '../automation/me01-native-runner'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { Me01ExcelService } from '../services/me01-excel-service'
import type { SettingsService } from '../services/settings-service'
import { downloadTemplateWithSaveDialog } from '../services/template-download-service'
import { isTrustedRenderer } from './ipc-security'

export function registerMe01Handlers(
  excelService: Me01ExcelService,
  runner: Me01NativeRunner,
  logger: DiagnosticLogger,
  history: ExecutionHistoryService,
  templatePath: string,
  settingsService: SettingsService
): void {
  ipcMain.handle(IPC_CHANNELS.downloadMe01Template, async (event): Promise<DownloadMe01TemplateResult> => {
    if (!isTrustedRenderer(event)) return { success: false, cancelled: false, message: 'The template request was rejected.' }
    try {
      const settings = await settingsService.getSettings()
      const result = await downloadTemplateWithSaveDialog({
        event,
        templatePath,
        suggestedFileName: 'ME01_Source_List_Template.xlsx',
        configuredDirectory: settings.defaultDownloadFolder
      })
      if (!result.success) return result
      await logger.info({ category: 'automation', event: 'me01.template.downloaded', message: 'The ME01 Source List template was downloaded.', tcode: 'ME01', details: { targetPath: result.path } })
      return result
    } catch (error) {
      const message = getErrorMessage(error)
      await logger.error({ category: 'automation', event: 'me01.template.download-failed', message, errorCode: 'ME01_TEMPLATE_DOWNLOAD_FAILED', tcode: 'ME01' })
      return { success: false, cancelled: false, message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.selectMe01ExcelFile, async (event): Promise<SelectMe01ExcelResult> => {
    if (!isTrustedRenderer(event)) return { success: false, cancelled: false, message: 'The file request was rejected.' }
    const options: Electron.OpenDialogOptions = {
      title: 'Select the ME01 Source List workbook',
      properties: ['openFile'],
      filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] }]
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true }
    return { success: true, path: result.filePaths[0] }
  })

  ipcMain.handle(IPC_CHANNELS.previewMe01Batch, async (event, input: unknown): Promise<Me01PreviewResult> => {
    if (!isTrustedRenderer(event) || !isMe01BatchConfig(input)) return { success: false, message: 'The ME01 preview request is invalid.' }
    try {
      const preview = await excelService.preview(input.excelPath)
      await logger.info({ category: 'automation', event: 'me01.preview.succeeded', message: `ME01 preview found ${preview.uniqueMaterials} unique material(s).`, tcode: 'ME01', details: { totalDataRows: preview.totalDataRows, uniqueMaterials: preview.uniqueMaterials, duplicateRows: preview.duplicateRows } })
      return { success: true, preview }
    } catch (error) {
      const message = getErrorMessage(error)
      await logger.error({ category: 'automation', event: 'me01.preview.failed', message, errorCode: 'ME01_PREVIEW_FAILED', tcode: 'ME01' })
      return { success: false, message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.startMe01Batch, async (event, input: unknown): Promise<Me01BatchResult> => {
    if (!isTrustedRenderer(event) || !isMe01BatchConfig(input) || !input.confirmed) {
      return { success: false, errorCode: 'INVALID_CONFIG', message: 'Upload a valid workbook and confirm the active SAP GUI session before running ME01.' }
    }
    const reportProgress = (progress: Me01BatchProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.me01Progress, progress)
    }
    const historyEntry = await history.start({ operation: 'me01-source-list', label: 'ME01 Source List — Plant C100', summary: 'ME01 source-list batch is running.', tcode: 'ME01' })
    await logger.info({ category: 'automation', event: 'me01.batch.started', message: 'ME01 Source List batch started for Plant C100.', tcode: 'ME01' })
    const result = await runner.run(input, reportProgress)
    await history.finish(historyEntry.id, result.success ? {
      status: result.failed > 0 ? 'Partial' : 'Success', summary: result.message,
      total: result.processed, processed: result.processed, succeeded: result.succeeded,
      skipped: result.skipped, failed: result.failed, resultPath: result.resultPath, backupPath: result.backupPath
    } : { status: result.errorCode === 'CANCELLED' ? 'Cancelled' : 'Failed', summary: result.message })
    await (result.success ? logger.info.bind(logger) : logger.error.bind(logger))({
      category: 'automation', event: result.success ? 'me01.batch.completed' : 'me01.batch.failed',
      message: result.message, ...(!result.success ? { errorCode: result.errorCode } : {}), tcode: 'ME01',
      details: result.success ? { processed: result.processed, succeeded: result.succeeded, skipped: result.skipped, failed: result.failed } : undefined
    })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.cancelMe01Batch, async (event): Promise<Me01CancelResult> => {
    if (!isTrustedRenderer(event)) return { success: false, message: 'The cancel request was rejected.' }
    const accepted = runner.cancel()
    return { success: accepted, message: accepted ? 'Cancellation requested. The ME01 engine is stopping.' : 'No ME01 batch is currently active.' }
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
