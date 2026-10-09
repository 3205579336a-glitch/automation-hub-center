import { ipcMain } from 'electron'
import type { ExecutionHistoryResult } from '../../shared/execution-history-types'
import { isExecutionHistoryQuery } from '../../shared/execution-history-types'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import type { LocalIntelligenceService } from '../services/local-intelligence-service'
import { isTrustedRenderer } from './ipc-security'

export function registerHistoryHandlers(history: ExecutionHistoryService, intelligence: LocalIntelligenceService,
  isRunning: () => boolean = () => false): void {
  ipcMain.handle(IPC_CHANNELS.deleteExecutionHistory, async (event, input: unknown) => {
    if (!isTrustedRenderer(event) || input !== undefined) return { success: false, message: 'Invalid bulk log cleanup request.' }
    if (isRunning()) return { success: false, message: 'Stop or finish the active automation before deleting history.' }
    try { return { success: true, ...await history.clear() } }
    catch (error) { return { success: false, message: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC_CHANNELS.getLocalIntelligence, async event => {
    if (!isTrustedRenderer(event)) throw new Error('Invalid local intelligence request')
    return intelligence.snapshot()
  })
  ipcMain.handle(
    IPC_CHANNELS.getExecutionHistory,
    async (event, input: unknown): Promise<ExecutionHistoryResult> => {
      if (!isTrustedRenderer(event) || !isExecutionHistoryQuery(input)) {
        throw new Error('Invalid execution history request')
      }
      return history.getPage(input)
    }
  )
}
