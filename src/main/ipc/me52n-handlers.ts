import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { Me52nBatchProgress, Me52nBatchResult, Me52nCancelResult, Me52nPreviewResult, SelectMe52nExcelResult } from '../../shared/me52n-types'
import { isMe52nBatchConfig } from '../../shared/me52n-types'
import type { Me52nNativeRunner } from '../automation/me52n-native-runner'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { Me52nExcelService } from '../services/me52n-excel-service'
import { isTrustedRenderer } from './ipc-security'

export function registerMe52nHandlers(excel: Me52nExcelService, runner: Me52nNativeRunner, logger: DiagnosticLogger, history: ExecutionHistoryService): void {
  ipcMain.handle(IPC_CHANNELS.selectMe52nExcelFile, async (event): Promise<SelectMe52nExcelResult> => {
    if (!isTrustedRenderer(event)) return { success: false, cancelled: false, message: 'The file request was rejected.' }
    const options: Electron.OpenDialogOptions = { title: 'Select the ME52N purchase requisition workbook', properties: ['openFile'], filters: [{ name: 'Excel workbooks', extensions: ['xlsx', 'xlsm'] }] }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true }
    return { success: true, path: result.filePaths[0] }
  })

  ipcMain.handle(IPC_CHANNELS.previewMe52nBatch, async (event, input: unknown): Promise<Me52nPreviewResult> => {
    if (!isTrustedRenderer(event) || !isMe52nBatchConfig(input)) return { success: false, message: 'The ME52N preview request is invalid.' }
    try {
      const preview = await excel.preview(input)
      await logger.info({ category: 'automation', event: 'me52n.preview.succeeded', message: `ME52N preview found ${preview.uniquePrs} unique PR(s).`, tcode: 'ME52N', details: { sheetName: preview.sheetName, startRow: preview.startRow, endRow: preview.endRow, scannedRows: preview.scannedRows, uniquePrs: preview.uniquePrs, duplicateRows: preview.duplicateRows, blankRows: preview.blankRows, invalidRows: preview.invalidRows } })
      return { success: true, preview }
    } catch (error) {
      const message = getErrorMessage(error)
      await logger.error({ category: 'automation', event: 'me52n.preview.failed', message, errorCode: 'ME52N_PREVIEW_FAILED', tcode: 'ME52N' })
      return { success: false, message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.startMe52nBatch, async (event, input: unknown): Promise<Me52nBatchResult> => {
    if (!isTrustedRenderer(event) || !isMe52nBatchConfig(input) || !input.confirmed || (input.concurrency > 1 && !input.parallelConfirmed)) {
      return { success: false, errorCode: 'INVALID_CONFIG', message: 'Preview the workbook, confirm the live ME52N update, and acknowledge parallel SAP sessions when concurrency is above one.' }
    }
    const report = (progress: Me52nBatchProgress): void => { if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.me52nProgress, progress) }
    const entry = await history.start({ operation: 'me52n-project-ref', label: 'ME52N Project Ref', summary: `ME52N batch is running with ${input.concurrency} browser(s).`, tcode: 'ME52N', browserCount: input.concurrency })
    await logger.info({ category: 'automation', event: 'me52n.batch.started', message: `ME52N Project Ref batch started with ${input.concurrency} browser(s).`, tcode: 'ME52N', details: { targetProjectRef: input.targetProjectRef, allowedWbs: input.allowedWbs.join(';'), concurrency: input.concurrency, batchStartRow: input.batchStartRow, batchSize: input.batchSize } })
    const result = await runner.run(input, report)
    await history.finish(entry.id, result.success ? {
      status: result.failed > 0 ? 'Partial' : 'Success', summary: result.message, total: result.processed, processed: result.processed,
      succeeded: result.succeeded, skipped: result.skipped, failed: result.failed, browserCount: result.browserCount,
      resultPath: result.resultPath, backupPath: result.backupPath
    } : { status: result.errorCode === 'CANCELLED' ? 'Cancelled' : 'Failed', summary: result.message })
    await (result.success ? logger.info.bind(logger) : logger.error.bind(logger))({ category: 'automation', event: result.success ? 'me52n.batch.completed' : 'me52n.batch.failed', message: result.message, ...(!result.success ? { errorCode: result.errorCode } : {}), tcode: 'ME52N', details: result.success ? { processed: result.processed, succeeded: result.succeeded, skipped: result.skipped, failed: result.failed, browserCount: result.browserCount } : undefined })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.cancelMe52nBatch, async (event): Promise<Me52nCancelResult> => {
    if (!isTrustedRenderer(event)) return { success: false, message: 'The cancel request was rejected.' }
    const accepted = runner.cancel()
    return { success: accepted, message: accepted ? 'Cancellation requested. The ME52N engine is stopping.' : 'No ME52N batch is currently active.' }
  })
}

function getErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
