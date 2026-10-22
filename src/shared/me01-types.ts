export interface Me01BatchConfig {
  excelPath: string
  confirmed: boolean
  purchasingOrganization?: string
  validFrom?: string
  validTo?: string
}

export function me01BusinessDefaults(): { purchasingOrganization: string; validFrom: string; validTo: string } {
  const today = new Date()
  const validFrom = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return { purchasingOrganization: 'C100', validFrom, validTo: '2099-12-31' }
}

export function resolveMe01Business(config: Me01BatchConfig): ReturnType<typeof me01BusinessDefaults> {
  const defaults = me01BusinessDefaults()
  const result = { purchasingOrganization: (config.purchasingOrganization ?? defaults.purchasingOrganization).trim().toUpperCase(),
    validFrom: config.validFrom ?? defaults.validFrom, validTo: config.validTo ?? defaults.validTo }
  const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  if (!/^[A-Z0-9]{1,4}$/.test(result.purchasingOrganization) || !validDate(result.validFrom) || !validDate(result.validTo) || result.validFrom > result.validTo) {
    throw new Error('Check purchasing organization and validity dates / 请检查采购组织及有效期。')
  }
  return result
}

export interface Me01PreviewRow {
  material: string
  parma: string
  dualSourcing: boolean
  excelRows: number[]
}

export interface Me01ExcelPreview {
  sheetName: string
  totalDataRows: number
  uniqueMaterials: number
  duplicateRows: number
  skippedBlankRows: number
  sample: Me01PreviewRow[]
  uniqueSuppliers?: number
  dualSourcingMaterials: number
  singleSourcingMaterials: number
}

export type Me01PreviewResult =
  | { success: true; preview: Me01ExcelPreview }
  | { success: false; message: string }

export type Me01BatchErrorCode =
  | 'INVALID_CONFIG'
  | 'OPERATION_IN_PROGRESS'
  | 'ENGINE_UNAVAILABLE'
  | 'CANCELLED'
  | 'EXECUTION_FAILED'

export type Me01BatchResult =
  | {
      success: true
      message: string
      processed: number
      succeeded: number
      skipped: number
      failed: number
      resultPath: string
      backupPath: string
      warning?: string
    }
  | { success: false; errorCode: Me01BatchErrorCode; message: string; processed?: number; succeeded?: number; skipped?: number; failed?: number; resultPath?: string; backupPath?: string; warning?: string }

export type Me01ProgressStage =
  | 'preparing'
  | 'connecting-sap'
  | 'processing'
  | 'saving'
  | 'complete'
  | 'cancelled'
  | 'failed'

export interface Me01BatchProgress {
  stage: Me01ProgressStage
  message: string
  current?: number
  total?: number
  material?: string
  status?: 'running' | 'success' | 'skipped' | 'failed'
}

export type SelectMe01ExcelResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message?: string }

export type DownloadMe01TemplateResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message?: string }

export interface Me01CancelResult {
  success: boolean
  message: string
}

export function isMe01BatchConfig(value: unknown): value is Me01BatchConfig {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (['purchasingOrganization', 'validFrom', 'validTo'].some(key => candidate[key] !== undefined && typeof candidate[key] !== 'string')) return false
  try { resolveMe01Business(candidate as unknown as Me01BatchConfig) } catch { return false }
  return (
    typeof candidate.excelPath === 'string' &&
    candidate.excelPath.length > 0 &&
    candidate.excelPath.length <= 1_024 &&
    typeof candidate.confirmed === 'boolean'
  )
}
