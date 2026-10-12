import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import { timeSavings } from '../../shared/time-savings'
import { RFQ_RUN_ID } from '../../shared/rfq-safe-recovery'
import type { RfqSafeRecoveryService } from '../services/rfq-safe-recovery-service'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { SettingsService } from '../services/settings-service'
import { isTrustedRenderer } from './ipc-security'

export function registerSafeRecoveryHandlers(recovery: RfqSafeRecoveryService, history: ExecutionHistoryService,
  settings: SettingsService, isRunning: () => boolean): void {
  ipcMain.handle(IPC_CHANNELS.getTimeSavings, async event => {
    if (!isTrustedRenderer(event)) throw new Error('Untrusted dashboard request.')
    const [entries, preferences] = await Promise.all([history.getEntries({ limit: 500 }), settings.getSettings()])
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
