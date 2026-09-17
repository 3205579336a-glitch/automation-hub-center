export type ExecutionHistoryStatus =
  | 'Running'
  | 'Success'
  | 'Partial'
  | 'Failed'
  | 'Cancelled'

export interface ExecutionHistoryEntry {
  id: string
  operation: 'open-sap' | 'create-rfq' | 'me12-batch' | 'me01-source-list' | 'me52n-project-ref' | 'apqp-plan-closure'
  label: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: ExecutionHistoryStatus
  summary: string
  tcode?: string
  dryRun?: boolean
  total?: number
  processed?: number
  succeeded?: number
  skipped?: number
  failed?: number
  browserCount?: number
  sessionCount?: number
  logPath?: string
  resultPath?: string
  backupPath?: string
}

export interface ExecutionHistoryQuery {
  search?: string
  statuses?: ExecutionHistoryStatus[]
  limit?: number
}

export interface ExecutionHistoryResult {
  entries: ExecutionHistoryEntry[]
}

export function isExecutionHistoryQuery(value: unknown): value is ExecutionHistoryQuery {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const validSearch =
    candidate.search === undefined ||
    (typeof candidate.search === 'string' && candidate.search.length <= 200)
  const validLimit =
    candidate.limit === undefined ||
    (Number.isInteger(candidate.limit) &&
      Number(candidate.limit) >= 1 &&
      Number(candidate.limit) <= 500)
  const statuses = candidate.statuses
  const validStatuses =
    statuses === undefined ||
    (Array.isArray(statuses) && statuses.every(isExecutionHistoryStatus))
  return validSearch && validLimit && validStatuses
}

function isExecutionHistoryStatus(value: unknown): value is ExecutionHistoryStatus {
  return (
    value === 'Running' ||
    value === 'Success' ||
    value === 'Partial' ||
    value === 'Failed' ||
    value === 'Cancelled'
  )
}
