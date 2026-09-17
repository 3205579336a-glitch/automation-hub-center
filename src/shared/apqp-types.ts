export interface ApqpConfig {
  excelPath: string
  sheetName: string
  plant: string
  system: string
  client: string
  maxWorkers: number
  createSessions: boolean
  maxItems: number
  overwriteExisting: boolean
  confirmed: boolean
}

export interface ApqpPreview {
  sheetName: string
  selected: number
  skipped: number
  invalid: number
  sample: { material: string; vendor: string; excelRow: number }[]
}
export type ApqpPreviewResult = { success: true; preview: ApqpPreview } | { success: false; message: string }
export interface ApqpProgress {
  event: string
  message: string
  current?: number
  total?: number
  workers?: number
  status?: string
  material?: string
  vendor?: string
}
export type ApqpFileResult = { success: true; path: string } | { success: false; cancelled: boolean; message?: string }
export type ApqpResult = {
  success: true
  message: string
  total: number
  processed: number
  succeeded: number
  skipped: number
  failed: number
  workers: number
  cancelled: boolean
  resultPath: string
  backupPath: string
  logPath: string
} | { success: false; message: string }

export function isApqpConfig(value: unknown): value is ApqpConfig {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return typeof c.excelPath === 'string' && c.excelPath.length > 0 && c.excelPath.length <= 1024 &&
    typeof c.sheetName === 'string' && c.sheetName.length <= 100 &&
    typeof c.plant === 'string' && /^[a-zA-Z0-9]{1,4}$/.test(c.plant) &&
    typeof c.system === 'string' && /^(?:[a-zA-Z0-9]{3})?$/.test(c.system) &&
    typeof c.client === 'string' && /^(?:\d{3})?$/.test(c.client) &&
    Number.isInteger(c.maxWorkers) && Number(c.maxWorkers) >= 1 && Number(c.maxWorkers) <= 5 &&
    Number.isInteger(c.maxItems) && Number(c.maxItems) >= 0 && Number(c.maxItems) <= 100000 &&
    typeof c.createSessions === 'boolean' && typeof c.overwriteExisting === 'boolean' && typeof c.confirmed === 'boolean'
}
