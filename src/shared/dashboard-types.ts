import type { ExecutionHistoryEntry } from './execution-history-types'
import type { TaskRanking } from './local-intelligence'
import type { TimeSavingsSummary } from './time-savings'

export interface DashboardCounts {
  today: number
  yesterday: number
  successful: number
  failed: number
  finalized: number
}

export interface DashboardSnapshot {
  counts: DashboardCounts
  recent: ExecutionHistoryEntry[]
  ranking: TaskRanking
  savings: TimeSavingsSummary | null
}
