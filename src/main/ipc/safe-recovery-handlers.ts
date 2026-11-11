import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { timeSavings } from '../../shared/time-savings'
import { rankTasks } from '../../shared/local-intelligence'
import type { DashboardCounts, DashboardSnapshot } from '../../shared/dashboard-types'
import { RFQ_RUN_ID } from '../../shared/rfq-safe-recovery'
import type { RfqSafeRecoveryService } from '../services/rfq-safe-recovery-service'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { SettingsService } from '../services/settings-service'
import { isTrustedRenderer } from './ipc-security'

export function registerSafeRecoveryHandlers(recovery: RfqSafeRecoveryService, history: ExecutionHistoryService,
  settings: SettingsService, isRunning: () => boolean): void {
  ipcMain.handle(IPC_CHANNELS.getDashboardSnapshot, async (event): Promise<DashboardSnapshot> => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted dashboard request.')
    const [entries, preferences] = await Promise.all([
      history.getRetainedEntries(),
      settings.getSettings().catch(() => null)
    ])
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
    const counts: DashboardCounts = { today: 0, yesterday: 0, successful: 0, failed: 0, finalized: 0 }
    const recent: DashboardSnapshot['recent'] = []
    for (const entry of entries) {
      if (entry.operation === 'me52n-project-ref' || entry.operation === 'open-sap') continue
      if (recent.length < 3) recent.push(entry)
      const started = Date.parse(entry.startedAt)
      if (started >= start) {
        counts.today++
        if (entry.status === 'Success') counts.successful++
        if (entry.status === 'Failed') counts.failed++
        if (entry.status === 'Success' || entry.status === 'Partial' || entry.status === 'Failed') counts.finalized++
      } else if (started >= yesterday) counts.yesterday++
    }
    let savings: DashboardSnapshot['savings'] = null
    if (preferences) {
      try { savings = timeSavings(entries, preferences.manualTimeBaselines, preferences.manualTimeCalibrated, recovery.protectedIds(), now) }
      catch { /* Do not show an estimate if the protected-run list cannot be read. */ }
    }
    return { counts, recent, ranking: rankTasks(entries, now.getTime()), savings }
  })
  ipcMain.handle(IPC_CHANNELS.getTimeSavings, async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted dashboard request.')
    const [entries, preferences] = await Promise.all([history.getRetainedEntries(), settings.getSettings()])
    return timeSavings(entries, preferences.manualTimeBaselines, preferences.manualTimeCalibrated, recovery.protectedIds())
  })
  ipcMain.handle(IPC_CHANNELS.getRfqRecovery, event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted recovery request.')
    return recovery.pending()
  })
  ipcMain.handle(IPC_CHANNELS.openRecoveryResult, async (event, runId: unknown) => {
    if (!isTrustedRenderer(event) || typeof runId !== 'string' || !RFQ_RUN_ID.test(runId)) return { success: false, message: 'Invalid recovery result request.' }
    try {
      if (recovery.pending().find(record => record.runId === runId)?.processStatus !== 'dead') throw new Error('Confirm the old RFQ engine has stopped before opening its working file.')
      const message = await shell.openPath(recovery.result(runId)); return { success: !message, message }
    }
    catch (error) { return { success: false, message: String(error instanceof Error ? error.message : error) } }
  })
  ipcMain.handle(IPC_CHANNELS.resolveRfqRecovery, async (event, input: unknown) => {
    if (!isTrustedRenderer(event) || !input || typeof input !== 'object') return { success: false, message: 'Invalid recovery resolution.' }
    const value = input as Record<string, unknown>
    if (typeof value.runId !== 'string' || !RFQ_RUN_ID.test(value.runId) || value.verifiedInSap !== true || value.engineStopped !== true
      || value.note !== undefined && (typeof value.note !== 'string' || !value.note.trim() || value.note.length > 1000)) return { success: false, message: 'Confirm SAP verification and that this task has stopped.' }
    if (isRunning()) return { success: false, message: 'Finish or safely stop the active task before resolving a prior run.' }
    try {
      // Ledger resolution is the authoritative record. A history failure must not undo human review.
      const note = typeof value.note === 'string' ? value.note : 'User confirmed in Hub: task stopped and existing Buyer Receipt / RFQ checked in SAP. No automatic resume or SAP write performed.'
      recovery.resolve(value.runId, note)
      await history.markRecoveryResolved(value.runId, note).catch(() => undefined)
      return { success: true }
    } catch (error) { return { success: false, message: String(error instanceof Error ? error.message : error) } }
  })
}
