export type RfqEnvironment = 'QA' | 'PROD'

export interface RfqBatchConfig {
  excelPath: string
  environment: RfqEnvironment
  productionConfirmed: boolean
}

export interface RfqPreviewRow {
  excelRow: number
  plant: string
  project: string
  material: string
  supplier: string
  quotationDueDate: string
  valid: boolean
  message: string
}

export interface RfqExcelPreview {
  sheetName: string
  totalRows: number
  validRows: number
  invalidRows: number
  skippedBlankRows: number
  sample: RfqPreviewRow[]
}

export type RfqProgressStage =
  | 'preparing'
  | 'connecting-sap'
  | 'processing'
  | 'saving'
  | 'complete'
  | 'failed'
  | 'cancelled'

export interface RfqBatchProgress {
  stage: RfqProgressStage
  message: string
  current?: number
  total?: number
  status?: 'running' | 'success' | 'skipped' | 'failed'
}

export type SelectRfqExcelResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message?: string }

export type DownloadRfqTemplateResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message: string }

export type RfqPreviewResult =
  | { success: true; preview: RfqExcelPreview }
  | { success: false; message: string }

export type RfqBatchResult =
  | {
      success: true
      message: string
      processed: number
      succeeded: number
      skipped: number
      failed: number
      resultPath: string
      logPath?: string
    }
  | {
      success: false
      errorCode:
        | 'INVALID_CONFIG'
        | 'OPERATION_IN_PROGRESS'
        | 'ENGINE_UNAVAILABLE'
        | 'CANCELLED'
        | 'EXECUTION_FAILED'
      message: string
    }

export interface RfqCancelResult {
  success: boolean
  message: string
}

export function isRfqBatchConfig(value: unknown): value is RfqBatchConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.excelPath === 'string' &&
    candidate.excelPath.length > 0 &&
    candidate.excelPath.length <= 1_000 &&
    (candidate.environment === 'QA' || candidate.environment === 'PROD') &&
    typeof candidate.productionConfirmed === 'boolean'
  )
}
