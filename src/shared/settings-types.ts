export type SupportedBrowser = 'chrome' | 'msedge'
export type AppLanguage = 'en' | 'zh-CN'
export type AppFontSize = 'small' | 'medium' | 'large'
export type AppTheme = 'light' | 'dark'

export interface AppSettings {
  sapWebGuiUrl: string
  browser: SupportedBrowser
  headless: false
  defaultDownloadFolder: string
  batchStartRow: number
  batchSize: number
  maxConcurrentBrowsers: number
  language: AppLanguage
  fontSize: AppFontSize
  theme: AppTheme
}

export type SaveSettingsResult =
  | { success: true; settings: AppSettings }
  | { success: false; message: string }

export function isAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.sapWebGuiUrl === 'string' &&
    (candidate.browser === 'chrome' || candidate.browser === 'msedge') &&
    candidate.headless === false &&
    typeof candidate.defaultDownloadFolder === 'string' &&
    Number.isInteger(candidate.batchStartRow) &&
    Number.isInteger(candidate.batchSize) &&
    Number.isInteger(candidate.maxConcurrentBrowsers) &&
    (candidate.language === 'en' || candidate.language === 'zh-CN') &&
    (candidate.fontSize === 'small' ||
      candidate.fontSize === 'medium' ||
      candidate.fontSize === 'large') &&
    (candidate.theme === 'light' || candidate.theme === 'dark')
  )
}

export function resolveSapUrl(
  value: string,
  tcode = 'SMEN'
): { valid: true; url: URL } | { valid: false; message: string } {
  if (!value.trim()) {
    return { valid: false, message: 'Enter the SAP WebGUI URL template in Settings before starting.' }
  }

  try {
    const resolvedValue = value.trim().split('{tcode}').join(encodeURIComponent(tcode))
    const url = new URL(resolvedValue)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, message: 'The SAP WebGUI URL must start with http:// or https://.' }
    }
    if (url.hostname.toLowerCase() === 'sap-webgui.example.internal') {
      return {
        valid: false,
        message: 'This is the example SAP URL. Replace it in Settings with your organization’s real SAP WebGUI address.'
      }
    }
    return { valid: true, url }
  } catch {
    return { valid: false, message: 'The SAP WebGUI URL template is not valid.' }
  }
}
