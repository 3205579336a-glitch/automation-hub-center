import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings } from '../../shared/settings-types'
import { isAppSettings } from '../../shared/settings-types'
import type { DiagnosticLogger } from './diagnostic-logger'
import type { LocalStoragePaths } from './local-storage-paths'

export class SettingsService {
  private static readonly SETTINGS_SCHEMA_VERSION = 6
  private readonly settingsPath: string
  private readonly defaults: AppSettings

  constructor(
    private readonly storagePaths: LocalStoragePaths,
    downloadsDirectory: string,
    private readonly logger: DiagnosticLogger
  ) {
    this.settingsPath = storagePaths.settingsPath
    this.defaults = {
      sapWebGuiUrl: 'https://ui5ce.volvo.com/sap/bc/gui/sap/its/webgui?~transaction={tcode}#',
      browser: 'chrome',
      headless: false,
      defaultDownloadFolder: downloadsDirectory,
      batchStartRow: 2,
      batchSize: 100,
      maxConcurrentBrowsers: 1,
      language: 'en',
      fontSize: 'medium',
      theme: 'light'
    }
  }

  async getSettings(): Promise<AppSettings> {
    try {
      return await this.readSettings(this.settingsPath)
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return this.migrateLegacySettingsFile()
      }
      await this.logger.error({
        category: 'settings',
        event: 'settings.read-failed',
        message: getErrorMessage(error)
      })
      return this.defaults
    }
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    const normalized: AppSettings = {
      ...settings,
      sapWebGuiUrl: settings.sapWebGuiUrl.trim(),
      defaultDownloadFolder: settings.defaultDownloadFolder.trim()
    }
    const temporaryPath = `${this.settingsPath}.tmp`

    await mkdir(dirname(this.settingsPath), { recursive: true })
    const storedSettings = {
      ...normalized,
      schemaVersion: SettingsService.SETTINGS_SCHEMA_VERSION
    }
    await writeFile(temporaryPath, `${JSON.stringify(storedSettings, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.settingsPath)
    await this.logger.info({
      category: 'settings',
      event: 'settings.saved',
      message: 'Application settings were saved locally.'
    })

    return normalized
  }

  private async readSettings(path: string): Promise<AppSettings> {
    const content = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(content)
    if (!isAppSettings(parsed)) {
      return migrateLegacySettings(parsed, this.defaults)
    }
    return parsed
  }

  private async migrateLegacySettingsFile(): Promise<AppSettings> {
    try {
      const migrated = await this.readSettings(this.storagePaths.legacySettingsPath)
      await this.saveSettings(migrated)
      await this.logger.info({
        category: 'settings',
        event: 'settings.migrated',
        message: 'Legacy settings were migrated to the hidden local data directory.'
      })
      return migrated
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveSettings(this.defaults)
        return this.defaults
      }
      await this.logger.warning({
        category: 'settings',
        event: 'settings.migration-skipped',
        message: getErrorMessage(error)
      })
      return this.defaults
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function migrateLegacySettings(value: unknown, defaults: AppSettings): AppSettings {
  if (typeof value !== 'object' || value === null) {
    return defaults
  }
  const candidate = value as Record<string, unknown>
  const legacyUrl =
    typeof candidate.sapWebGuiUrl === 'string' &&
    !candidate.sapWebGuiUrl.includes('sap-webgui.example.internal')
      ? candidate.sapWebGuiUrl
      : defaults.sapWebGuiUrl
  return {
    ...defaults,
    sapWebGuiUrl: legacyUrl,
    browser:
      candidate.browser === 'msedge' || candidate.browser === 'chrome'
        ? candidate.browser
        : defaults.browser,
    defaultDownloadFolder:
      typeof candidate.defaultDownloadFolder === 'string'
        ? candidate.defaultDownloadFolder
        : defaults.defaultDownloadFolder,
    batchStartRow:
      Number.isInteger(candidate.batchStartRow) && Number(candidate.batchStartRow) > 0
        ? Number(candidate.batchStartRow)
        : defaults.batchStartRow,
    batchSize:
      Number.isInteger(candidate.batchSize) && Number(candidate.batchSize) > 0
        ? Number(candidate.batchSize)
        : defaults.batchSize,
    maxConcurrentBrowsers:
      Number.isInteger(candidate.maxConcurrentBrowsers) &&
      Number(candidate.maxConcurrentBrowsers) > 0
        ? Number(candidate.maxConcurrentBrowsers)
        : defaults.maxConcurrentBrowsers,
    language:
      candidate.language === 'zh-CN' || candidate.language === 'en'
        ? candidate.language
        : defaults.language,
    fontSize:
      candidate.fontSize === 'small' ||
      candidate.fontSize === 'medium' ||
      candidate.fontSize === 'large'
        ? candidate.fontSize
        : defaults.fontSize,
    theme:
      candidate.theme === 'dark' || candidate.theme === 'light'
        ? candidate.theme
        : defaults.theme
  }
}
