import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { isApqpDateExecuteRequest, isApqpDatePreviewRequest, isApqpDateQuery, type ApqpDateError } from '../../shared/apqp-date-types'
import type { ApqpDateService } from '../services/apqp-date-service'
import { ApqpDateQueryOperation } from '../services/apqp-date-query-operation'
import type { GuidedAutomationService } from '../services/guided-automation-service'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { LocalIntelligenceService } from '../services/local-intelligence-service'
import { isTrustedRenderer } from './ipc-security'

export function registerApqpDateHandlers(service: ApqpDateService, guided: GuidedAutomationService,
  history: ExecutionHistoryService, logger: DiagnosticLogger, intelligence?: LocalIntelligenceService,
  query = new ApqpDateQueryOperation(service, guided, history, logger, intelligence)): void {
  const invalid = (): ApqpDateError => ({ success: false, message: 'Invalid APQP date request.', messageZh: '无效的 APQP 日期请求。', errorCode: 'APQP_DATE_INVALID_REQUEST' })
  ipcMain.handle(IPC_CHANNELS.apqpDateCapabilities, event => isTrustedRenderer(event) ? service.capabilities() : null)
  ipcMain.handle(IPC_CHANNELS.loadCachedApqpDates, async (event, input: unknown) => {
    if (!isTrustedRenderer(event) || !isApqpDateQuery(input)) return invalid()
    if (guided.isRunning()) return { success: false, message: 'Finish or stop the running automation first.', messageZh: '请先完成或停止正在运行的自动化。', errorCode: 'APQP_DATE_BUSY' }
    try {
      const result = await service.loadCached(input)
      if (result.success) guided.registerArtifacts(result.snapshot.resultPath)
      return result // Local display only: no new execution history, success count or timing sample.
    } catch { return { success: false, message: 'The local result is unavailable. Read from SAP again.', messageZh: '本地结果不可用，请重新从 SAP 读取。', errorCode: 'APQP_DATE_CACHE_MISSING' } }
  })
  ipcMain.handle(IPC_CHANNELS.queryApqpDates, async (event, input: unknown) => {
    if (!isTrustedRenderer(event) || !isApqpDateQuery(input)) return invalid()
    return query.query(input, progress => {
      if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.apqpProgress, progress)
    })
  })
  ipcMain.handle(IPC_CHANNELS.previewApqpDateChanges, async (event, input: unknown) => {
    if (!isTrustedRenderer(event) || !isApqpDatePreviewRequest(input)) return invalid()
    let runId = '', entryId = ''
    try {
      runId = guided.begin()
      const entry = await history.start({ operation: 'apqp-date-management', apqpDateAction: 'preview', diagnosticRunId: runId,
        label: 'APQP date comparison (read-only)', summary: 'Comparing edited dates with current SAP dates.', tcode: 'ZMFM050035' })
      entryId = entry.id
      intelligence?.begin(entryId, 'apqp-date-preview', runId)
      const result = await service.preview(input, progress => { intelligence?.observe(entryId, progress); if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.apqpProgress, progress) }, { service: guided, runId })
      const status = result.success ? result.preview.conflicts || result.preview.invalid ? 'Partial' : 'Success' : result.cancelled ? 'Cancelled' : 'Failed'
      const performance = intelligence?.finish(entryId, status)
      await history.finish(entryId, result.success ? { status, performance, total: result.preview.total,
        summary: `Compared ${result.preview.total} APQPs: ${result.preview.changedRecords} proposed, ${result.preview.conflicts} conflicts, ${result.preview.invalid} invalid. No SAP dates changed.`, resultPath: result.resultPath }
        : { status, performance, summary: result.message, logPath: result.logPath })
      if (result.success) guided.registerArtifacts(result.resultPath)
      if (!result.success && result.logPath) guided.registerArtifacts(result.logPath)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (entryId) await history.finish(entryId, { status: 'Failed', summary: message, performance: intelligence?.finish(entryId, 'Failed') }).catch(() => undefined)
      return { success: false, message, errorCode: 'APQP_DATE_PREVIEW_FAILED' }
    } finally { if (entryId) intelligence?.finish(entryId, 'Cancelled'); if (runId) guided.end(runId) }
  })
  ipcMain.handle(IPC_CHANNELS.executeApqpDateChanges, async (event, input: unknown) => {
    if (!isTrustedRenderer(event) || !isApqpDateExecuteRequest(input)) return invalid()
    let runId = '', entryId = ''
    try {
      runId = guided.begin()
      const entry = await history.start({ operation: 'apqp-date-management', apqpDateAction: 'update', diagnosticRunId: runId,
        label: 'APQP date update', summary: 'Checking and updating edited SAP dates.', tcode: 'ZMFM050035' })
      entryId = entry.id
      intelligence?.begin(entryId, 'apqp-date-update', runId)
      const result = await service.execute(input, progress => { intelligence?.observe(entryId, progress); if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.apqpProgress, progress) }, { service: guided, runId })
      const status = result.success ? result.update.cancelled ? 'Cancelled' : result.update.stageOnly || result.update.failed ? 'Partial' : 'Success' : result.cancelled ? 'Cancelled' : 'Failed'
      const performance = intelligence?.finish(entryId, status)
      await history.finish(entryId, result.success ? { status, performance, total: result.update.total, processed: result.update.processed,
        succeeded: result.update.succeeded, skipped: result.update.skipped, failed: result.update.failed ?? 0, apqpDateFieldsSaved: result.update.savedFields ?? 0, sessionCount: 1, resultPath: result.resultPath,
        ...(result.update.stageOnly ? { dryRun: true, apqpStaged: result.update.staged ?? 0 } : {}),
        summary: result.update.stageOnly ? `${result.update.staged ?? 0} APQP staged. ${result.update.failed ?? 0} record issue(s) safely skipped before input. NOT SAVED. No Save was sent.` : `${result.update.succeeded} APQPs saved and verified; ${result.update.skipped} unchanged; ${result.update.failed ?? 0} record issue(s) skipped before input.` }
        : { status, performance, summary: result.message, logPath: result.logPath, succeeded: result.succeeded })
      if (result.success) guided.registerArtifacts(result.resultPath)
      else if (result.logPath) guided.registerArtifacts(result.logPath)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (entryId) await history.finish(entryId, { status: 'Failed', summary: message, performance: intelligence?.finish(entryId, 'Failed') }).catch(() => undefined)
      return { success: false, message, errorCode: 'APQP_DATE_UPDATE_FAILED' }
    } finally { if (entryId) intelligence?.finish(entryId, 'Cancelled'); if (runId) guided.end(runId) }
  })
  // Both APQP workflows deliberately share the existing cancel channel/runner.
}
