export interface Me01BatchConfig {
  excelPath: string
  confirmed: boolean
}

export interface Me01PreviewRow {
  material: string
  parma: string
  excelRows: number[]
}

export interface Me01ExcelPreview {
  sheetName: string
  totalDataRows: number
  uniqueMaterials: number
  duplicateRows: number
  skippedBlankRows: number
  sample: Me01PreviewRow[]
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
    }
  | { success: false; errorCode: Me01BatchErrorCode; message: string }

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
  return (
    typeof candidate.excelPath === 'string' &&
    candidate.excelPath.length > 0 &&
    candidate.excelPath.length <= 1_024 &&
    typeof candidate.confirmed === 'boolean'
  )
}
