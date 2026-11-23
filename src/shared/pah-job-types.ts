import { APQP_DATE_SCHEMA, isApqpDates, type ApqpDates } from './apqp-date-types'

export const PAH_QUERY_APQP = 'QUERY_APQP_PLANNED_DATES'
export const PAH_MAX_RESULT_BYTES = 48_000

export interface PahRequester {
  tenantId: string
  objectId: string
}

export interface PahJobRequest {
  action: typeof PAH_QUERY_APQP
  caseKey: string
  parameters: { project: string }
}

/** Assigned by the trusted queue ingress and immutable after submission. */
export interface PahJobIdentity {
  jobId: string
  requester: PahRequester
  queuedAt: string
}

export interface PahClaim {
  workerId: string
  claimId: string
  startedAt: string
}

export interface PahQueryResult {
  schema: typeof APQP_DATE_SCHEMA
  readAt: string
  records: { apqp: string; dates: ApqpDates }[]
}

export const PAH_FAILURE_CODES = [
  'INVALID_JOB', 'UNSUPPORTED_ACTION', 'UNAUTHORIZED', 'SAP_UNAVAILABLE', 'QUERY_FAILED'
] as const
export const PAH_REVIEW_CODES = [
  'DESKTOP_UNAVAILABLE', 'CANCELLED', 'OUTCOME_UNCONFIRMED', 'RESULT_TOO_LARGE'
] as const

interface PahExecutionAudit {
  runId?: string
  historyId?: string
}

export type PahExecutionOutcome = PahExecutionAudit & (
  | { status: 'Succeeded'; result: PahQueryResult; errorCode: null }
  | { status: 'Failed'; result: null; errorCode: typeof PAH_FAILURE_CODES[number] }
  | { status: 'Review Required'; result: null; errorCode: typeof PAH_REVIEW_CODES[number] }
)
export type PahCompletion = PahExecutionOutcome & { completedAt: string }

export type PahJob = PahJobIdentity & PahJobRequest & (
  | { status: 'Queued'; claim: null; result: null; errorCode: null }
  | { status: 'Running'; claim: PahClaim; result: null; errorCode: null }
  | ({ claim: PahClaim } & PahCompletion)
)

export const isPahId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)

export const isPahProject = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_/-]{1,32}$/.test(value)

export function isPahRequester(value: unknown): value is PahRequester {
  return isObject(value) && onlyKeys(value, ['tenantId', 'objectId']) && isPahId(value.tenantId) && isPahId(value.objectId)
}

export function isPahTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

export function parsePahRequest(input: unknown): PahJobRequest | 'UNSUPPORTED_ACTION' | 'INVALID_JOB' {
  if (!isObject(input) || !onlyKeys(input, ['action', 'caseKey', 'parameters'])
    || typeof input.action !== 'string' || typeof input.caseKey !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.caseKey)) return 'INVALID_JOB'
  if (input.action !== PAH_QUERY_APQP) return 'UNSUPPORTED_ACTION'
  if (!isObject(input.parameters) || !onlyKeys(input.parameters, ['project']) || !isPahProject(input.parameters.project)) {
    return 'INVALID_JOB'
  }
  return { action: PAH_QUERY_APQP, caseKey: input.caseKey, parameters: { project: input.parameters.project } }
}

export function isPahClaim(value: unknown): value is PahClaim {
  return isObject(value) && onlyKeys(value, ['workerId', 'claimId', 'startedAt'])
    && isPahId(value.workerId) && isPahId(value.claimId) && isPahTimestamp(value.startedAt)
}

export function isPahCompletion(value: unknown): value is PahCompletion {
  if (!isObject(value) || !Object.keys(value).every(key =>
    ['status', 'result', 'errorCode', 'completedAt', 'runId', 'historyId'].includes(key))
    || !isPahTimestamp(value.completedAt) || (value.runId !== undefined && !isPahId(value.runId))
    || (value.historyId !== undefined && !isPahId(value.historyId))) return false
  if (value.status === 'Succeeded') return value.errorCode === null && isPahQueryResult(value.result)
  if (value.result !== null || typeof value.errorCode !== 'string') return false
  const codes: readonly string[] = value.status === 'Failed' ? PAH_FAILURE_CODES
    : value.status === 'Review Required' ? PAH_REVIEW_CODES : []
  return codes.includes(value.errorCode)
}

function isPahQueryResult(value: unknown): value is PahQueryResult {
  return isObject(value) && onlyKeys(value, ['schema', 'readAt', 'records'])
    && value.schema === APQP_DATE_SCHEMA && isPahTimestamp(value.readAt)
    && Array.isArray(value.records) && value.records.length <= 10_000
    && value.records.every(row => isObject(row) && onlyKeys(row, ['apqp', 'dates'])
      && typeof row.apqp === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(row.apqp) && isApqpDates(row.dates))
    && new Set(value.records.map(row => row.apqp)).size === value.records.length
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
