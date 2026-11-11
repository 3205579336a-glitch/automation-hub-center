export const MM02_TEMPLATE = 'MM02_Sub_commodity_Template.xlsx'
export const MM02_OPERATION = 'mm02-sub-commodity' as const

export interface Mm02Task { material: string; subCommodity: string; excelRows: number[] }
export interface Mm02Preview {
  sheetName: string
  uniqueMaterials: number
  duplicateRows: number
  sample: Mm02Task[]
  token: string
}
export interface Mm02Config { excelPath: string; previewToken: string; confirmed: true }
export type Mm02PreviewResult = { success: true; preview: Mm02Preview } | { success: false; message: string }
export interface Mm02Progress {
  stage: 'connecting-sap' | 'processing' | 'saving'
  status: 'running' | 'success' | 'skipped' | 'failed'
  message: string
  current?: number
  total?: number
  material?: string
}
export interface Mm02Result {
  success: boolean
  errorCode?: string
  message: string
  total?: number
  processed?: number
  succeeded?: number
  skipped?: number
  failed?: number
  resultPath?: string
  logPath?: string
}
