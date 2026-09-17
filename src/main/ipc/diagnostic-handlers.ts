import { ipcMain, shell } from 'electron'
import type {
  DiagnosticLogResult,
  OpenLogFolderResult
} from '../../shared/diagnostic-types'
import { isDiagnosticLogQuery } from '../../shared/diagnostic-types'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { LocalStoragePaths } from '../services/local-storage-paths'
import { isTrustedRenderer } from './ipc-security'

export function registerDiagnosticHandlers(
  logger: DiagnosticLogger,
  storagePaths: LocalStoragePaths
): void {
  ipcMain.handle(
    IPC_CHANNELS.getDiagnosticLogs,
    async (event, input: unknown): Promise<DiagnosticLogResult> => {
      if (!isTrustedRenderer(event) || !isDiagnosticLogQuery(input)) {
        throw new Error('Invalid diagnostic log request')
      }
      return {
        entries: await logger.getEntries(input),
        logDirectory: storagePaths.logsDirectory,
        dataDirectory: storagePaths.rootDirectory
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.openLogFolder, async (event): Promise<OpenLogFolderResult> => {
    if (!isTrustedRenderer(event)) {
      return { success: false, message: 'The diagnostics request was rejected.' }
    }
    const errorMessage = await shell.openPath(storagePaths.logsDirectory)
    if (errorMessage) {
      return { success: false, message: errorMessage }
    }
    return { success: true }
  })
}
