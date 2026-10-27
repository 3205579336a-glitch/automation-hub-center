import type { ExecutionHistoryEntry } from './execution-history-types'

/** Reference assumptions, not measured buyer productivity. Key users can calibrate them. */
// Owner-provided manual effort: RFQ 35 min/group; SLT/APQP 5 min/record.
// Source List 5 min/record remains a reference assumption, editable by key users.
export const DEFAULT_MANUAL_SECONDS = { 'create-rfq': 2100, 'me12-batch': 300, 'apqp-plan-closure': 300, 'me01-source-list': 300 }
export type ManualTimeBaselines = typeof DEFAULT_MANUAL_SECONDS
export const APQP_DATE_MANUAL_SECONDS_PER_FIELD = 60
export interface SavingsPeriod { savedMs: number; manualMs: number; actualMs: number; runs: number; successfulUnits: number; successfulDateFields: number }
export interface TimeSavingsSummary {
  today: SavingsPeriod; last30Days: SavingsPeriod; excludedRuns: number; baselines: ManualTimeBaselines; calibrated: boolean
}
export function isManualTimeBaselines(value: unknown): value is ManualTimeBaselines {
  return Boolean(value && typeof value === 'object' && Object.keys(DEFAULT_MANUAL_SECONDS).every(key => {
    const seconds = (value as Record<string, unknown>)[key]
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 1 && seconds <= 86400
  }))
}
export function timeSavings(entries: ExecutionHistoryEntry[], baselines = DEFAULT_MANUAL_SECONDS, calibrated = false,
  pending = new Set<string>(), now = new Date()): TimeSavingsSummary {
  const empty = (): SavingsPeriod => ({ savedMs: 0, manualMs: 0, actualMs: 0, runs: 0, successfulUnits: 0, successfulDateFields: 0 })
  const summary: TimeSavingsSummary = { today: empty(), last30Days: empty(), excludedRuns: 0, baselines, calibrated }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime()
  const seen = new Set<string>()
  for (const entry of entries) {
    const completed = Date.parse(entry.completedAt ?? '')
    const dateUpdate = entry.operation === 'apqp-date-management' && entry.apqpDateAction === 'update'
    if (seen.has(entry.id) || !dateUpdate && !Object.prototype.hasOwnProperty.call(baselines, entry.operation) || !Number.isFinite(completed) || completed < cutoff || completed > now.getTime()) continue
    seen.add(entry.id)
    const seconds = dateUpdate ? APQP_DATE_MANUAL_SECONDS_PER_FIELD : baselines[entry.operation as keyof ManualTimeBaselines]
    if (entry.id.startsWith('diagnostic-') || !['Success', 'Partial'].includes(entry.status) || pending.has(entry.id) || entry.dryRun || !Number.isInteger(entry.succeeded)
      || entry.succeeded! <= 0 || entry.succeeded! > 100000 || typeof entry.durationMs !== 'number' || !Number.isFinite(entry.durationMs) || entry.durationMs < 0
      || dateUpdate && (!Number.isInteger(entry.apqpDateFieldsSaved) || entry.apqpDateFieldsSaved! < entry.succeeded! || entry.apqpDateFieldsSaved! > entry.succeeded! * 4 || Boolean(entry.apqpStaged))) {
      summary.excludedRuns++; continue
    }
    // Deduct the entire batch wall time once, including pauses and failed/skipped-row overhead.
    // Never multiply automation time by worker count or count skipped work as success.
    const fields = dateUpdate ? entry.apqpDateFieldsSaved! : 0
    const manual = (dateUpdate ? fields : entry.succeeded!) * seconds * 1000, actual = entry.durationMs
    for (const period of completed >= today ? [summary.today, summary.last30Days] : [summary.last30Days]) {
      period.manualMs += manual; period.actualMs += actual; period.runs++; period.successfulUnits += entry.succeeded!; period.successfulDateFields += fields
    }
  }
  for (const period of [summary.today, summary.last30Days]) period.savedMs = Math.max(0, period.manualMs - period.actualMs)
  return summary
}
