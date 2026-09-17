export interface Me12BatchConfig {
  excelPath: string
  sheetName: string
  infoRecordColumn: number
  plantColumn: number
  dataStartRow: number
  targetPlant: string
  purchasingOrganization: string
  targetLeadTime: string
  infoCategory: 'standard' | 'consignment'
  infoRecordWidth: number
  dryRun: boolean
  maxItems: number
  maxRetries: number
  saveEvery: number
}

export interface Me12PreviewRow {
  infoRecord: string
  excelRows: number[]
  plant: string
}

export interface Me12ExcelPreview {
  sheetName: string
  infoRecordColumn: number
  plantColumn: number
  dataStartRow: number
  totalDataRows: number
  matchedRows: number
  uniqueInfoRecords: number
  selectedInfoRecords: number
  duplicateRows: number
  skippedOtherPlant: number
  skippedEmptyInfoRecord: number
  limitedByMaxItems: boolean
  sample: Me12PreviewRow[]
}

export type Me12PreviewResult =
  | { success: true; preview: Me12ExcelPreview }
  | { success: false; message: string }

export type Me12BatchErrorCode =
  | 'INVALID_CONFIG'
  | 'FILE_NOT_FOUND'
  | 'WORKBOOK_READ_FAILED'
  | 'NO_MATCHING_RECORDS'
  | 'OPERATION_IN_PROGRESS'
  | 'BROWSER_LAUNCH_FAILED'
  | 'LOGIN_TIMEOUT'
  | 'CANCELLED'
  | 'BATCH_FAILED'

export type Me12BatchResult =
  | {
      success: true
      message: string
      processed: number
      succeeded: number
      skipped: number
      failed: number
      browserCount: number
      resultPath: string
      backupPath: string
    }
  | {
      success: false
      errorCode: Me12BatchErrorCode
      message: string
    }

export type Me12ProgressStage =
  | 'preparing'
  | 'backing-up'
  | 'starting-browser'
  | 'waiting-for-login'
  | 'processing'
  | 'saving'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface Me12BatchProgress {
  stage: Me12ProgressStage
  message: string
  current?: number
  total?: number
  excelRows?: number[]
  infoRecord?: string
  worker?: number
  status?: 'running' | 'success' | 'skipped' | 'failed'
}

export type SelectExcelFileResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message?: string }

export type DownloadMe12TemplateResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message?: string }

export interface Me12CancelResult {
  success: boolean
  message: string
}

export function isMe12BatchConfig(value: unknown): value is Me12BatchConfig {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.excelPath === 'string' &&
    candidate.excelPath.length <= 1_024 &&
    typeof candidate.sheetName === 'string' &&
    candidate.sheetName.length <= 100 &&
    isIntegerInRange(candidate.infoRecordColumn, 1, 16_384) &&
    isIntegerInRange(candidate.plantColumn, 1, 16_384) &&
    isIntegerInRange(candidate.dataStartRow, 2, 1_048_576) &&
    typeof candidate.targetPlant === 'string' &&
    candidate.targetPlant.length >= 1 &&
    candidate.targetPlant.length <= 20 &&
    typeof candidate.purchasingOrganization === 'string' &&
    candidate.purchasingOrganization.length <= 20 &&
    typeof candidate.targetLeadTime === 'string' &&
    candidate.targetLeadTime.length >= 1 &&
    candidate.targetLeadTime.length <= 10 &&
    (candidate.infoCategory === 'standard' || candidate.infoCategory === 'consignment') &&
    isIntegerInRange(candidate.infoRecordWidth, 0, 30) &&
    typeof candidate.dryRun === 'boolean' &&
    isIntegerInRange(candidate.maxItems, 0, 100_000) &&
    isIntegerInRange(candidate.maxRetries, 0, 10) &&
    isIntegerInRange(candidate.saveEvery, 1, 10_000)
  )
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}
