import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { isApqpConfig, type ApqpFileResult, type ApqpPreviewResult, type ApqpResult } from '../../shared/apqp-types'
import type { ApqpRunner } from '../automation/apqp-runner'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { SettingsService } from '../services/settings-service'
import { downloadTemplateWithSaveDialog } from '../services/template-download-service'
import { isTrustedRenderer } from './ipc-security'

export function registerApqpHandlers(runner: ApqpRunner, logger: DiagnosticLogger, history: ExecutionHistoryService, settings: SettingsService, templatePath: string): void {
  ipcMain.handle(IPC_CHANNELS.downloadApqpTemplate, async (event): Promise<ApqpFileResult> => {
    if (!isTrustedRenderer(event)) return { success: false, cancelled: false, message: 'Request rejected.' }
    try {
      const configuredDirectory = (await settings.getSettings()).defaultDownloadFolder
      const result = await downloadTemplateWithSaveDialog({
        event,
        templatePath,
        suggestedFileName: 'APQP_Plan_Closure_Template.xlsx',
        configuredDirectory
      })
      if (result.success) {
        await logger.info({ category: 'automation', event: 'apqp.template.downloaded', message: 'The APQP template was downloaded.', tcode: 'ZMFM050035', details: { targetPath: result.path } })
      }
      return result
    } catch (error) {
      const message = messageOf(error)
      await logger.error({ category: 'automation', event: 'apqp.template.download-failed', message, errorCode: 'APQP_TEMPLATE_DOWNLOAD_FAILED', tcode: 'ZMFM050035' })
      return { success: false, cancelled: false, message }
    }
  })
  ipcMain.handle(IPC_CHANNELS.selectApqpExcel, async (event): Promise<ApqpFileResult> => {
    if (!isTrustedRenderer(event)) return { success: false, cancelled: false, message: 'Request rejected.' }
    const options: Electron.OpenDialogOptions = { title: 'Select APQP workbook', properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm'] }] }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? { success: false, cancelled: true } : { success: true, path: result.filePaths[0] }
  })
  ipcMain.handle(IPC_CHANNELS.previewApqp, async (event, config: unknown): Promise<ApqpPreviewResult> => {
    if (!isTrustedRenderer(event) || !isApqpConfig(config)) return { success: false, message: 'Invalid APQP settings.' }
    return runner.preview(config)
  })
  ipcMain.handle(IPC_CHANNELS.startApqp, async (event, config: unknown): Promise<ApqpResult> => {
    if (!isTrustedRenderer(event) || !isApqpConfig(config) || !config.confirmed) return { success: false, message: 'Preview the workbook and authorize SAP session use and Excel writeback first.' }
    const entry = await history.start({ operation: 'apqp-plan-closure', label: 'APQP Plan Closure Date', summary: 'Querying ZMFM050035.', tcode: 'ZMFM050035' })
    await logger.info({ category: 'automation', event: 'apqp.batch.started', message: 'APQP query started.', tcode: 'ZMFM050035', details: { maxWorkers: config.maxWorkers, system: config.system, client: config.client, plant: config.plant } })
    const result = await runner.run(config, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.apqpProgress, progress)
      if (progress.event === 'record' || progress.event === 'notice' || progress.event === 'workers') {
        const writeLog = progress.status && !['SUCCESS', 'NO_DATE', 'NO_RESULT'].includes(progress.status) ? logger.error.bind(logger) : logger.info.bind(logger)
        void writeLog({ category: 'automation', event: `apqp.${progress.event}`, message: progress.message, tcode: 'ZMFM050035' })
      }
    })
    await history.finish(entry.id, result.success ? {
      status: result.cancelled ? 'Cancelled' : result.failed ? (result.succeeded ? 'Partial' : 'Failed') : 'Success', summary: result.message,
      total: result.total, processed: result.processed, succeeded: result.succeeded, skipped: result.skipped,
      failed: result.failed, sessionCount: result.workers, resultPath: result.resultPath, backupPath: result.backupPath, logPath: result.logPath
    } : { status: 'Failed', summary: result.message })
    await (result.success ? logger.info.bind(logger) : logger.error.bind(logger))({ category: 'automation', event: result.success ? 'apqp.batch.completed' : 'apqp.batch.failed', message: result.message, tcode: 'ZMFM050035' })
    return result
  })
  ipcMain.handle(IPC_CHANNELS.cancelApqp, (event) => ({ success: isTrustedRenderer(event) && runner.cancel() }))
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
