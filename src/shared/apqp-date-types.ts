/** UI/API contract. No SAP selectors, session indices or write override in renderer inputs. */
export const APQP_DATE_SCHEMA = 'APQP_PLANNED_FGHM_V1'
export const APQP_DATE_KEYS = ['fPlanDate', 'gPlanDate', 'hPlanDate', 'mPlanDate'] as const
export type ApqpDateKey = typeof APQP_DATE_KEYS[number]
/** Planned-date selectors confirmed by the owner's 2026-10-27 recording. */
export const APQP_DATE_LABELS: Record<ApqpDateKey, { en: string; zh: string }> = {
  gPlanDate: { en: 'RTS Action & Closure Planned Date', zh: 'RTS 行动关闭计划日期' },
  fPlanDate: { en: 'RTS Confirmation Planned Date', zh: 'RTS Confirmation 计划日期' },
  hPlanDate: { en: 'Total PPAP Planned Date', zh: 'Total PPAP 计划日期' },
  mPlanDate: { en: 'APQP Closure Plan Date', zh: 'APQP 关闭计划日期' }
}
export type ApqpDates = Record<ApqpDateKey, string | null>
export type ApqpEnvironment = 'QA' | 'PROD'
export interface ApqpDateQuery { project: string; userId: string; environment: ApqpEnvironment }
export interface ApqpDateRecord {
  apqp: string; material: string; vendor: string; plant: string; project: string
  dates: ApqpDates; readable: boolean
  editable: Record<ApqpDateKey, boolean>
}
export interface ApqpDateSnapshot extends ApqpDateQuery {
  id: string; createdAt: string; records: ApqpDateRecord[]; resultPath: string
  /** Cached values are explicitly historical, never a fresh SAP read. */
  cached?: boolean
  lastAttempt?: { apqp: string; at: string; status: 'STAGED' | 'REVIEW_REQUIRED' }
}
/** Blank/omitted comments preserve SAP text; only edited matching actual dates use these. */
export interface ApqpSdComments { g?: string; h?: string }
export interface ApqpDateEdit { apqp: string; dates: ApqpDates; sdComments?: ApqpSdComments }
export interface ApqpDatePreviewRequest { snapshotId: string; edits: ApqpDateEdit[] }
export interface ApqpDateChange { apqp: string; field: ApqpDateKey; current: string | null; desired: string }
export interface ApqpDatePreview {
  id: string; snapshotId: string; total: number; changedRecords: number; changedFields: number
  unchanged: number; conflicts: number; invalid: number; changes: ApqpDateChange[]
  issues: { apqp: string; status: 'CONFLICT' | 'VALIDATION_ERROR' }[]; expiresAt: string
}
/** One user click; current-SAP conflict checks happen inside the execution path. */
export interface ApqpDateExecuteRequest extends ApqpDatePreviewRequest { confirmed: true }
export interface ApqpDateRecordIssue {
  apqp: string; material: string; vendor: string; code: string; message: string; messageZh: string
  navigation: 'NOT_OPENED' | 'RETURNED_UNCHANGED'
}
export interface ApqpDateUpdateSummary {
  total: number; processed: number; succeeded: number; skipped: number; cancelled: boolean
  savedFields?: number
  staged?: number; stagedApqp?: string; stageOnly?: boolean; failed?: number; issues?: ApqpDateRecordIssue[]
}
export interface ApqpDateCapabilities {
  writesEnabled: boolean; productionWritesEnabled: boolean; qaWritesEnabled: boolean
  stageOnly?: boolean
  code: 'APQP_DATE_WRITE_NOT_VALIDATED' | 'APQP_DATE_WRITES_ENABLED'; message: string; messageZh: string
}
export const APQP_DATE_CAPABILITIES: ApqpDateCapabilities = {
  // Owner explicitly authorized production on 2026-10-20. This is permission to
  // expose the write workflow, NOT a claim that live QA acceptance has passed.
  writesEnabled: true, productionWritesEnabled: true, qaWritesEnabled: false, stageOnly: false, code: 'APQP_DATE_WRITES_ENABLED',
  message: 'Uses SAP 949. Only edited dates are saved. Grey dates cannot be changed.',
  messageZh: '使用 SAP 949，只保存你修改的日期。灰色日期不可修改。'
}
export interface ApqpQueryMismatch {
  totalRows: number; mismatchRows: number; sampleLimit: number
  rows: { rowNumber: number; apqp: string; material: string; checks: {
    field: 'plant' | 'project' | 'userId'; label: string; labelZh: string; column: string
    expected: string; actual: string; matches: boolean
  }[] }[]
}
export type ApqpDateError = { success: false; message: string; messageZh?: string; errorCode?: string; cancelled?: boolean
  details?: string; logPath?: string; comparison?: ApqpQueryMismatch | null; writeMayHaveOccurred?: boolean; succeeded?: number }
export type ApqpDateQueryResult = { success: true; snapshot: ApqpDateSnapshot } | ApqpDateError
export type ApqpDatePreviewResult = { success: true; preview: ApqpDatePreview; resultPath: string } | ApqpDateError
export type ApqpDateExecuteResult = { success: true; snapshot: ApqpDateSnapshot; update: ApqpDateUpdateSummary; resultPath: string } | ApqpDateError
export interface ApqpNativeDateData {
  records: ApqpDateRecord[]
  fieldSchema?: string
  stageOnly?: boolean
  session: { sessionId: string; system: string; client: string; sapUser: string }
  preview?: Omit<ApqpDatePreview, 'id' | 'snapshotId' | 'expiresAt'>
  update?: ApqpDateUpdateSummary
}
export type ApqpNativeDateResult = { success: true; data: ApqpNativeDateData; resultPath: string } | ApqpDateError

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key))
export const isApqpDateId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
export function isIsoApqpDate(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00.000Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
export function isApqpDates(value: unknown): value is ApqpDates {
  return object(value) && keys(value, [...APQP_DATE_KEYS]) && APQP_DATE_KEYS.every(key => isIsoApqpDate(value[key]))
}
export function isApqpSdComments(value: unknown): value is ApqpSdComments {
  return object(value) && Object.entries(value).every(([group, text]) => ['g', 'h'].includes(group)
    && typeof text === 'string' && text.length <= 255
    && !Array.from(text).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
}
export function isApqpDateQuery(value: unknown): value is ApqpDateQuery {
  return object(value) && keys(value, ['project', 'userId', 'environment'])
    && typeof value.project === 'string' && /^[A-Za-z0-9_/-]{1,32}$/.test(value.project)
    && typeof value.userId === 'string' && /^[A-Za-z0-9_/-]{1,32}$/.test(value.userId)
    && ['QA', 'PROD'].includes(String(value.environment))
}
export function isApqpDatePreviewRequest(value: unknown): value is ApqpDatePreviewRequest {
  return object(value) && keys(value, ['snapshotId', 'edits']) && isApqpDateId(value.snapshotId)
    && Array.isArray(value.edits) && value.edits.length > 0 && value.edits.length <= 10000
    && value.edits.every(edit => object(edit) && keys(edit, edit.sdComments === undefined ? ['apqp', 'dates'] : ['apqp', 'dates', 'sdComments']) && typeof edit.apqp === 'string'
      && /^[A-Za-z0-9_-]{1,40}$/.test(edit.apqp) && isApqpDates(edit.dates)
      && (edit.sdComments === undefined || isApqpSdComments(edit.sdComments)))
    && new Set(value.edits.map(edit => edit.apqp)).size === value.edits.length
}
export function isApqpDateExecuteRequest(value: unknown): value is ApqpDateExecuteRequest {
  return object(value) && keys(value, ['snapshotId', 'edits', 'confirmed']) && value.confirmed === true
    && isApqpDatePreviewRequest({ snapshotId: value.snapshotId, edits: value.edits })
}
