export interface Me52nBatchConfig {
  excelPath: string
  sheetName: string
  prColumn: number
  dataStartRow: number
  batchStartRow: number
  batchSize: number
  targetProjectRef: string
  allowedWbs: string[]
  overwriteExisting: boolean
  concurrency: number
  workerStartDelaySec: number
  taskErrorRetries: number
  loginTimeoutSec: number
  checkpointEnabled: boolean
  writebackToSource: boolean
  confirmed: boolean
  parallelConfirmed: boolean
}

export interface Me52nPreviewRow {
  pr: string
  excelRows: number[]
}

export interface Me52nExcelPreview {
  sheetName: string
  startRow: number
  endRow: number
  scannedRows: number
  uniquePrs: number
  duplicateRows: number
  blankRows: number
  invalidRows: number
  sample: Me52nPreviewRow[]
}

export type Me52nPreviewResult =
  | { success: true; preview: Me52nExcelPreview }
  | { success: false; message: string }

export type Me52nBatchErrorCode =
  | 'INVALID_CONFIG'
  | 'OPERATION_IN_PROGRESS'
  | 'ENGINE_UNAVAILABLE'
  | 'CANCELLED'
  | 'EXECUTION_FAILED'

export type Me52nBatchResult =
  | {
      success: true
      message: string
      processed: number
      succeeded: number
      skipped: number
      failed: number
      browserCount: number
      resultPath: string
      checkpointPath: string
      backupPath: string
    }
  | { success: false; errorCode: Me52nBatchErrorCode; message: string }

export type Me52nProgressStage =
  | 'preparing'
  | 'connecting-sap'
  | 'processing'
  | 'complete'
  | 'cancelled'
  | 'failed'

export interface Me52nBatchProgress {
  stage: Me52nProgressStage
  message: string
  current?: number
  total?: number
  pr?: string
  status?: 'running' | 'success' | 'skipped' | 'failed'
}

export type SelectMe52nExcelResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message?: string }

export interface Me52nCancelResult { success: boolean; message: string }

export function isMe52nBatchConfig(value: unknown): value is Me52nBatchConfig {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.excelPath === 'string' && c.excelPath.length > 0 && c.excelPath.length <= 1_024 &&
    typeof c.sheetName === 'string' && c.sheetName.length <= 128 &&
    integerInRange(c.prColumn, 1, 16_384) &&
    integerInRange(c.dataStartRow, 1, 1_048_576) &&
    integerInRange(c.batchStartRow, 0, 1_048_576) &&
    integerInRange(c.batchSize, 0, 100_000) &&
    typeof c.targetProjectRef === 'string' && c.targetProjectRef.trim().length > 0 && c.targetProjectRef.length <= 80 &&
    Array.isArray(c.allowedWbs) && c.allowedWbs.length > 0 && c.allowedWbs.length <= 50 &&
    c.allowedWbs.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 80) &&
    typeof c.overwriteExisting === 'boolean' &&
    integerInRange(c.concurrency, 1, 5) &&
    integerInRange(c.workerStartDelaySec, 0, 15) &&
    integerInRange(c.taskErrorRetries, 0, 3) &&
    integerInRange(c.loginTimeoutSec, 30, 600) &&
    typeof c.checkpointEnabled === 'boolean' && typeof c.writebackToSource === 'boolean' &&
    typeof c.confirmed === 'boolean' && typeof c.parallelConfirmed === 'boolean'
  )
}

function integerInRange(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
}
