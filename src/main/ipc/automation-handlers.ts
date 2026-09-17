import { ipcMain } from 'electron'
import type { AutomationProgress, AutomationResult } from '../../shared/automation-types'
import { isOpenSapRequest } from '../../shared/automation-types'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { BrowserManager } from '../automation/browser-manager'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import type { ExecutionHistoryService } from '../services/execution-history-service'
import { isTrustedRenderer } from './ipc-security'

export function registerAutomationHandlers(
  browserManager: BrowserManager,
  logger: DiagnosticLogger,
  history: ExecutionHistoryService
): void {
  ipcMain.handle(IPC_CHANNELS.openSapWebGui, async (event, input: unknown): Promise<AutomationResult> => {
    if (!isTrustedRenderer(event)) {
      void logger.warning({
        category: 'ipc',
        event: 'automation.untrusted-request',
        message: 'An untrusted renderer attempted to start SAP automation.'
      })
      return {
        success: false,
        errorCode: 'IPC_FORBIDDEN',
        message: 'The automation request was rejected.'
      }
    }
    if (!isOpenSapRequest(input)) {
      void logger.warning({
        category: 'ipc',
        event: 'automation.invalid-request',
        message: 'The SAP automation request failed input validation.'
      })
      return {
        success: false,
        errorCode: 'INVALID_SAP_URL',
        message: 'The SAP operation request is invalid.'
      }
    }

    const tcode = input.tcode?.trim().toUpperCase() || 'SMEN'
    const historyEntry = await history.start({
      operation: tcode === 'ME41' ? 'create-rfq' : 'open-sap',
      label: tcode === 'ME41' ? 'Create RFQ — Open ME41' : 'Open SAP WebGUI',
      summary: `Opening SAP transaction ${tcode}.`,
      tcode
    })

    const reportProgress = (progress: AutomationProgress): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.automationProgress, progress)
      }
      const logInput = {
        category: 'automation' as const,
        event: `automation.${progress.stage}`,
        message: progress.message,
        tcode
      }
      if (progress.stage === 'failed') {
        void logger.error(logInput)
      } else {
        void logger.info(logInput)
      }
    }

    const result = await browserManager.openSapWebGui(input, reportProgress)
    if (!result.success) {
      await history.finish(historyEntry.id, {
        status: 'Failed',
        summary: result.message
      })
      void logger.error({
        category: 'automation',
        event: 'automation.failed',
        message: result.message,
        errorCode: result.errorCode,
        tcode
      })
    } else {
      await history.finish(historyEntry.id, {
        status: 'Success',
        summary: result.message
      })
      void logger.info({
        category: 'automation',
        event: result.requiresUserAction
          ? 'automation.user-action-required'
          : 'automation.succeeded',
        message: result.message,
        tcode
      })
    }
    return result
  })
}
