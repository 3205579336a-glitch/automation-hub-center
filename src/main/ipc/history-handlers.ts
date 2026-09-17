import { ipcMain } from 'electron'
import type { ExecutionHistoryResult } from '../../shared/execution-history-types'
import { isExecutionHistoryQuery } from '../../shared/execution-history-types'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import { isTrustedRenderer } from './ipc-security'

export function registerHistoryHandlers(history: ExecutionHistoryService): void {
  ipcMain.handle(
    IPC_CHANNELS.getExecutionHistory,
    async (event, input: unknown): Promise<ExecutionHistoryResult> => {
      if (!isTrustedRenderer(event) || !isExecutionHistoryQuery(input)) {
        throw new Error('Invalid execution history request')
      }
      return { entries: await history.getEntries(input) }
    }
  )
}
