import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { AppSettings, SaveSettingsResult } from '../../shared/settings-types'
import { isAppSettings, resolveSapUrl } from '../../shared/settings-types'
import type { SettingsService } from '../services/settings-service'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import { isTrustedRenderer } from './ipc-security'

export function registerSettingsHandlers(
  settingsService: SettingsService,
  logger: DiagnosticLogger
): void {
  ipcMain.handle(IPC_CHANNELS.getSettings, async (event): Promise<AppSettings> => {
    if (!isTrustedRenderer(event)) {
      throw new Error('Untrusted settings request')
    }
    return settingsService.getSettings()
  })

  ipcMain.handle(
    IPC_CHANNELS.saveSettings,
    async (event, input: unknown): Promise<SaveSettingsResult> => {
      if (!isTrustedRenderer(event)) {
        void logger.warning({
          category: 'ipc',
          event: 'settings.untrusted-request',
          message: 'An untrusted renderer attempted to save settings.'
        })
        return { success: false, message: 'The settings request was rejected.' }
      }
      if (!isAppSettings(input)) {
        void logger.warning({
          category: 'settings',
          event: 'settings.invalid-payload',
          message: 'The settings payload failed schema validation.'
        })
        return { success: false, message: 'The settings payload is invalid.' }
      }

      const urlValidation = resolveSapUrl(input.sapWebGuiUrl)
      if (!urlValidation.valid) {
        return { success: false, message: urlValidation.message }
      }
      if (!input.defaultDownloadFolder.trim()) {
        return { success: false, message: 'Choose a default download folder.' }
      }
      if (input.batchStartRow < 1 || input.batchStartRow > 1_000_000) {
        return { success: false, message: 'Batch start row must be between 1 and 1,000,000.' }
      }
      if (input.batchSize < 1 || input.batchSize > 10_000) {
        return { success: false, message: 'Batch size must be between 1 and 10,000 rows.' }
      }
      if (input.maxConcurrentBrowsers < 1 || input.maxConcurrentBrowsers > 8) {
        return { success: false, message: 'Maximum concurrent browsers must be between 1 and 8.' }
      }

      try {
        const settings = await settingsService.saveSettings(input)
        return { success: true, settings }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        void logger.error({
          category: 'settings',
          event: 'settings.save-failed',
          message
        })
        return { success: false, message: `Settings could not be saved: ${message}` }
      }
    }
  )
}
