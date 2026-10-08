export type RfqEnvironment = 'QA' | 'PROD'

export interface RfqBatchConfig {
  excelPath: string
  environment: RfqEnvironment
  productionConfirmed: boolean
  fingerprint?: string
}

export interface RfqPreviewRow {
  excelRow: number
  plant: string
  project: string
  material: string
  supplier: string
  quotationDueDate: string
  qty12mr?: string
  rfqQtyPrototype?: string
  rfqQtySerial?: string
  costBreakdown?: boolean | null
  valid: boolean
  message: string
  skipped?: boolean
  duplicateOf?: number | null
}

export interface RfqGroupPreview {
  key: string
  plant: string
  project: string
  supplier: string
  materials: string[]
}

export interface RfqExcelPreview {
  sheetName: string
  totalRows: number
  validRows: number
  invalidRows: number
  skippedBlankRows: number
  sample: RfqPreviewRow[]
  groupCount: number
  groups: RfqGroupPreview[]
  plants: string[]
  warnings: string[]
  skippedRows: number
  duplicateRows?: number
  fingerprint: string
}

export type RfqProgressStage =
  | 'preparing'
  | 'connecting-sap'
  | 'processing'
  | 'saving'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'waiting-for-user'
  | 'recovering'

export interface RfqBatchProgress {
  automation?: string
  requestId?: string
  state?: 'WAITING_FOR_USER' | 'RECOVERING' | 'RUNNING' | 'CANCELLED'
  allowedActions?: ('continue' | 'stop')[]
  recoveryPoint?: string
  issueSummary?: string
  issueSummaryZh?: string
  type?: string
  runId?: string
  groupKey?: string
  supplier?: string
  plant?: string
  project?: string
  materials?: string[] | number
  rfqNumber?: string
  rows?: number[]
  step?: string
  succeeded?: number
  skipped?: number
  failed?: number
  stage: RfqProgressStage
  message: string
  current?: number
  total?: number
  status?: 'running' | 'success' | 'skipped' | 'failed' | 'waiting' | 'recovering'
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
      runId?: string
      total?: number
      materials?: number
      withSkips?: number
      rfqNumbers?: string[]
      diagnosticsPath?: string
    }
  | {
      success: false
      errorCode:
        | 'INVALID_CONFIG'
        | 'OPERATION_IN_PROGRESS'
        | 'ENGINE_UNAVAILABLE'
        | 'CANCELLED'
        | 'EXECUTION_FAILED'
      processed?: number
      total?: number
      succeeded?: number
      skipped?: number
      failed?: number
      message: string
      runId?: string
      resultPath?: string
      diagnosticsPath?: string
      rfqNumbers?: string[]
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
