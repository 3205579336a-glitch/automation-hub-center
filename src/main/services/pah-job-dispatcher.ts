import { APQP_DATE_SCHEMA } from '../../shared/apqp-date-types'
import { PAH_MAX_RESULT_BYTES, isPahCompletion, type PahExecutionOutcome,
  type PahJobRequest, type PahRequester } from '../../shared/pah-job-types'
import type { ApqpDateQueryOperation } from './apqp-date-query-operation'

/** From the local operator policy, independently of SharePoint or Copilot input. */
export interface PahDesktopApproval {
  requester: PahRequester
  sapUser: string
  sdUser: string
  projects: readonly string[]
  /** Revoked on lock, disconnect, operator/policy change or loss of desktop assurance. */
  signal: AbortSignal
}

const SAP_UNAVAILABLE_CODES = new Set([
  'SAP_GUI_UNAVAILABLE', 'SAP_TARGET_CONNECTION_MISSING', 'SAP_TARGET_AMBIGUOUS', 'SAP_TARGET_INVENTORY_UNREADABLE',
  'SAP_SESSION_SCAN_FAILED', 'SAP_SESSION_IDENTITY_UNREADABLE', 'SAP_NOT_SIGNED_IN', 'SAP_LOGIN_REQUIRED',
  'SAP_LOGIN_DIALOG_OPEN', 'SAP_MULTIPLE_LOGONS', 'SAP_LOGIN_STATE_UNREADABLE', 'SAP_LOGIN_WINDOW_UNAVAILABLE',
  'SAP_ENVIRONMENT_AMBIGUOUS', 'SAP_NO_IDLE_SESSION', 'SAP_SESSION_BUSY', 'SAP_SESSION_DIALOG_OPEN',
  'SAP_SESSION_STATE_UNREADABLE', 'SAP_SESSION_UNAVAILABLE', 'SAP_SESSION_AMBIGUOUS'
])
const QUERY_FAILURE_CODES = new Set([
  'SAP_GRID_INCOMPLETE', 'SAP_GRID_COLUMNS_CHANGED', 'SAP_QUERY_FILTER_MISMATCH', 'SAP_EXTRA_FILTERS',
  'APQP_DATE_UNREADABLE', 'MULTIPLE_APQP_MATCHES', 'APQP_DATE_INVALID_SNAPSHOT'
])

export class PahJobDispatcher {
  constructor(private readonly query: ApqpDateQueryOperation) {}

  permits(request: PahJobRequest, requester: PahRequester, approval: PahDesktopApproval): boolean {
    return requester.tenantId === approval.requester.tenantId && requester.objectId === approval.requester.objectId
      && approval.projects.includes(request.parameters.project)
  }

  /** The request type has a single registered action. No generic engine invocation is exposed. */
  reserve(jobId: string, request: PahJobRequest, approval: PahDesktopApproval, signal: AbortSignal): {
    execute: () => Promise<PahExecutionOutcome>; release: () => void
  } | null {
    const reserved = this.query.reserveAgentQuery({ project: request.parameters.project, environment: 'PROD',
      userId: approval.sdUser }, jobId, { sapUser: approval.sapUser, signal })
    if (!reserved) return null
    return {
      release: reserved.release,
      execute: async () => {
        if (signal.aborted) return { status: 'Review Required', result: null, errorCode: 'DESKTOP_UNAVAILABLE' }
        const { result, runId, historyId } = await reserved.run()
        const audit = { runId, historyId }
        if (signal.aborted) return { ...audit, status: 'Review Required', result: null, errorCode: 'DESKTOP_UNAVAILABLE' }
        if (!result.success) {
          const code = result.errorCode ?? ''
          if (result.cancelled || code === 'CANCELLED') return { ...audit, status: 'Review Required', result: null, errorCode: 'CANCELLED' }
          if (code === 'SAP_AGENT_SESSION_MISMATCH') return { ...audit, status: 'Failed', result: null, errorCode: 'UNAUTHORIZED' }
          if (SAP_UNAVAILABLE_CODES.has(code)) return { ...audit, status: 'Failed', result: null, errorCode: 'SAP_UNAVAILABLE' }
          if (QUERY_FAILURE_CODES.has(code)) return { ...audit, status: 'Failed', result: null, errorCode: 'QUERY_FAILED' }
          return { ...audit, status: 'Review Required', result: null, errorCode: 'OUTCOME_UNCONFIRMED' }
        }
        const completion = { ...audit, status: 'Succeeded', errorCode: null, result: {
          schema: APQP_DATE_SCHEMA, readAt: result.snapshot.createdAt,
          records: result.snapshot.records.map(({ apqp, dates }) => ({ apqp, dates }))
        } } as const
        if (Buffer.byteLength(JSON.stringify(completion.result), 'utf8') > PAH_MAX_RESULT_BYTES) {
          return { ...audit, status: 'Review Required', result: null, errorCode: 'RESULT_TOO_LARGE' }
        }
        return isPahCompletion({ ...completion, completedAt: result.snapshot.createdAt }) ? completion
          : { ...audit, status: 'Review Required', result: null, errorCode: 'OUTCOME_UNCONFIRMED' }
      }
    }
  }
}
