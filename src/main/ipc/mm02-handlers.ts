import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { MM02_OPERATION, MM02_TEMPLATE, type Mm02Config, type Mm02PreviewResult, type Mm02Result } from '../../shared/mm02-types'
import type { Mm02NativeRunner } from '../automation/mm02-native-runner'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { GuidedAutomationService } from '../services/guided-automation-service'
import type { LocalIntelligenceService } from '../services/local-intelligence-service'
import { readMm02Input } from '../services/mm02-excel-service'
import type { SettingsService } from '../services/settings-service'
import { downloadTemplateWithSaveDialog } from '../services/template-download-service'
import { isTrustedRenderer } from './ipc-security'

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
const validPath = (path: unknown): path is string => typeof path === 'string' && path.length > 0 && path.length < 32_768

export function registerMm02Handlers(runner: Mm02NativeRunner, templatePath: string, settings: SettingsService,
  guided: GuidedAutomationService, history: ExecutionHistoryService, logger: DiagnosticLogger, intelligence: LocalIntelligenceService): void {
  ipcMain.handle(IPC_CHANNELS.downloadMm02Template, async event => {
    if (!isTrustedRenderer(event)) return { success: false, cancelled: false, message: 'Request rejected.' }
    try {
      return await downloadTemplateWithSaveDialog({ event, templatePath, suggestedFileName: MM02_TEMPLATE,
        configuredDirectory: (await settings.getSettings()).defaultDownloadFolder })
    } catch (error) { return { success: false, cancelled: false, message: errorMessage(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.selectMm02Excel, async event => {
    if (!isTrustedRenderer(event)) return { success: false, cancelled: false, message: 'Request rejected.' }
    const options: Electron.OpenDialogOptions = { properties: ['openFile'], title: 'Select the MM02 Sub-commodity workbook',
      filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] }] }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? { success: false, cancelled: true } : { success: true, path: result.filePaths[0] }
  })
  ipcMain.handle(IPC_CHANNELS.previewMm02Batch, async (event, path: unknown): Promise<Mm02PreviewResult> => {
    if (!isTrustedRenderer(event) || !validPath(path)) return { success: false, message: 'Invalid MM02 workbook request.' }
    try { return { success: true, preview: (await readMm02Input(path)).preview } }
    catch (error) { return { success: false, message: errorMessage(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.startMm02Batch, async (event, input: unknown): Promise<Mm02Result> => {
    const config = input as Partial<Mm02Config> | undefined
    if (!isTrustedRenderer(event) || !config || config.confirmed !== true || !validPath(config.excelPath) ||
        typeof config.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(config.previewToken)) {
      return { success: false, errorCode: 'INVALID_CONFIG', message: 'Review the MM02 template and confirm the SAP update first.' }
    }
    let runId: string
    try { runId = guided.begin() } catch (error) { return { success: false, errorCode: 'OPERATION_IN_PROGRESS', message: errorMessage(error) } }
    try {
      let checked: Awaited<ReturnType<typeof readMm02Input>>
      try { checked = await readMm02Input(config.excelPath) }
      catch (error) { return { success: false, errorCode: 'INVALID_CONFIG', message: errorMessage(error) } }
      if (checked.preview.token !== config.previewToken) {
        return { success: false, errorCode: 'MM02_UPLOAD_CHANGED', message: 'The saved workbook changed after preview. Upload it again before starting. / 文件在预览后有变动，请重新上传并核对。' }
      }
      const entry = await history.start({ operation: MM02_OPERATION, label: 'MM02 Sub-commodity — Production 949',
        summary: 'Updating material Sub-commodity.', diagnosticRunId: runId, tcode: 'MM02', total: checked.tasks.length })
      intelligence.begin(entry.id, MM02_OPERATION, runId, checked.tasks.length)
      const result = await runner.run(checked.tasks, progress => {
        intelligence.observe(entry.id, progress)
        if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.mm02Progress, progress)
      }, { service: guided, runId })
      const status = result.errorCode === 'CANCELLED' ? 'Cancelled' : (result.succeeded ?? 0) > 0 && (!result.success || result.failed) ? 'Partial'
        : !result.success || result.failed && !result.skipped ? 'Failed' : result.failed ? 'Partial' : 'Success'
      const performance = intelligence.finish(entry.id, status)
      guided.registerArtifacts(result.resultPath, result.logPath)
      await history.finish(entry.id, { status, summary: result.message, total: checked.tasks.length, processed: result.processed,
        succeeded: result.succeeded, skipped: result.skipped, failed: result.failed, resultPath: result.resultPath, logPath: result.logPath, performance })
      await (result.success ? logger.info.bind(logger) : logger.error.bind(logger))({ category: 'automation', tcode: 'MM02',
        event: result.success ? 'mm02.batch.completed' : 'mm02.batch.failed', message: result.message,
        errorCode: result.errorCode, details: { runId: entry.id, processed: result.processed ?? 0, succeeded: result.succeeded ?? 0,
          skipped: result.skipped ?? 0, failed: result.failed ?? 0 } }).catch(() => undefined)
      return result
    } finally { guided.end(runId) }
  })
  ipcMain.handle(IPC_CHANNELS.cancelMm02Batch, event => ({ success: isTrustedRenderer(event) && runner.cancel() }))
}
