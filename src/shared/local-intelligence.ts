import type { ExecutionHistoryEntry } from './execution-history-types'

export const DEFAULT_TASK_ORDER = ['create-rfq', 'me12-batch', 'apqp-plan-closure', 'me01-source-list'] as const
export type AutomationId = typeof DEFAULT_TASK_ORDER[number]
export type WorkUnit = 'groups' | 'rows' | 'items'
export type TimingStep = 'startup' | 'npl' | 'buyerReceipt' | 'rfq' | 'records' | 'resultWrite'
export const TIMING_STEPS: TimingStep[] = ['startup', 'npl', 'buyerReceipt', 'rfq', 'records', 'resultWrite']

export interface PerformanceSample {
  version: 1
  activeDurationMs: number
  waitingForUserMs: number
  startupMs: number
  unitDurationMs: number
  concurrency: number
  workUnits: { kind: WorkUnit; total: number; completed: number; learned: number }
  stepDurations: Partial<Record<TimingStep, number>>
}
export interface TaskRanking {
  order: AutomationId[]
  personalized: boolean
  frequentlyUsed: AutomationId[]
}
export interface EtaSnapshot {
  automationId: AutomationId
  runId: string
  active: boolean
  state: 'running' | 'waiting' | 'recovering' | 'saving'
  total: number
  completed: number
  remainingMs: number | null
  confidence: 'learning' | 'estimated' | 'high'
  historicalRuns: number
  unit: WorkUnit
}
export interface LocalIntelligenceSnapshot { ranking: TaskRanking; eta: EtaSnapshot | null }
export interface TimingModel { startupMs: number; unitMs: number; historicalRuns: number }
export interface TimingProgress {
  type?: string; event?: string; stage?: string; status?: string; state?: string
  current?: number; total?: number; worker?: number; workers?: number; succeeded?: number
}
export function completedUnits(id: AutomationId, progress: TimingProgress): number | undefined {
  const completed = id === 'create-rfq' ? ['GROUP_COMPLETED', 'GROUP_FAILED'].includes(progress.type ?? '')
    : id === 'apqp-plan-closure' ? progress.event === 'record'
    : progress.stage === 'processing' && ['success', 'skipped', 'failed'].includes(progress.status ?? '')
  return completed && Number.isInteger(progress.current) && progress.current! >= 0 && progress.current! <= 100_000 ? progress.current : undefined
}

const DAY = 86_400_000
export const RANKING_WINDOW_MS = 60 * DAY
export const MAX_PERFORMANCE_SAMPLES = 100
const ALPHA = 0.3
const FALLBACK: Record<AutomationId, { startupMs: number; unitMs: number; unit: WorkUnit }> = {
  'create-rfq': { startupMs: 15_000, unitMs: 60_000, unit: 'groups' },
  'me12-batch': { startupMs: 20_000, unitMs: 15_000, unit: 'rows' },
  'me01-source-list': { startupMs: 12_000, unitMs: 6_000, unit: 'rows' },
  'apqp-plan-closure': { startupMs: 15_000, unitMs: 7_000, unit: 'items' }
}
export function isAutomationId(value: unknown): value is AutomationId {
  return DEFAULT_TASK_ORDER.includes(value as AutomationId)
}
export function fallbackModel(id: AutomationId): TimingModel {
  return { startupMs: FALLBACK[id].startupMs, unitMs: FALLBACK[id].unitMs, historicalRuns: 0 }
}
export function workUnit(id: AutomationId): WorkUnit { return FALLBACK[id].unit }

/** Frequency/recency/success = 50/35/15. No negative penalty for SAP failures. */
export function rankTasks(history: unknown, now = Date.now()): TaskRanking {
  const fallback: TaskRanking = { order: [...DEFAULT_TASK_ORDER], personalized: false, frequentlyUsed: [] }
  if (!Array.isArray(history) || !Number.isFinite(now)) return fallback
  const signals = DEFAULT_TASK_ORDER.map(id => ({ id, frequency: 0, recency: 0, success: 0, count: 0 }))
  const seen = new Set<string>()
  for (const entry of history as ExecutionHistoryEntry[]) {
    if (!entry || typeof entry.id !== 'string' || seen.has(entry.id) || !isAutomationId(entry.operation)
        || !['Running', 'Success', 'Partial', 'Failed', 'Cancelled'].includes(entry.status)) continue
    seen.add(entry.id)
    const age = now - Date.parse(entry.startedAt)
    if (!Number.isFinite(age) || age < 0 || age > RANKING_WINDOW_MS) continue
    const signal = signals.find(item => item.id === entry.operation)!
    signal.count++
    signal.frequency += Math.exp(-age / (30 * DAY))
    signal.recency = Math.max(signal.recency, Math.exp(-age / (14 * DAY)))
    if (entry.status === 'Success' || entry.status === 'Partial' && (entry.succeeded ?? 0) > 0) {
      signal.success += Math.exp(-age / (14 * DAY))
    }
  }
  const maxFrequency = Math.max(...signals.map(item => item.frequency))
  if (!maxFrequency) return fallback
  const maxSuccess = Math.max(1, ...signals.map(item => item.success))
  const score = (item: typeof signals[number]): number => 0.5 * item.frequency / maxFrequency
    + 0.35 * item.recency + 0.15 * item.success / maxSuccess
  // Modern JS stable sort preserves business ordering on ties.
  signals.sort((a, b) => score(b) - score(a))
  return { order: signals.map(item => item.id), personalized: true,
    frequentlyUsed: signals.filter(item => item.count >= 3).slice(0, 2).map(item => item.id) }
}

const finite = (value: unknown, maximum = 86_400_000): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
export function validPerformance(value: unknown, id: AutomationId): value is PerformanceSample {
  if (!value || typeof value !== 'object') return false
  const p = value as PerformanceSample
  return p.version === 1 && finite(p.activeDurationMs) && finite(p.waitingForUserMs, 30 * 86_400_000)
    && finite(p.startupMs) && p.startupMs <= p.activeDurationMs && finite(p.unitDurationMs) && p.unitDurationMs > 0
    && Number.isInteger(p.concurrency) && p.concurrency >= 1 && p.concurrency <= 20
    && !!p.workUnits && p.workUnits.kind === workUnit(id)
    && [p.workUnits.total, p.workUnits.completed, p.workUnits.learned].every(n => finite(n, 100_000) && Number.isInteger(n))
    && p.workUnits.learned > 0 && p.workUnits.learned <= p.workUnits.completed && p.workUnits.completed <= p.workUnits.total
    && finite(p.unitDurationMs * p.workUnits.learned) && p.unitDurationMs * p.workUnits.learned <= p.activeDurationMs + 1
    && !!p.stepDurations && !Array.isArray(p.stepDurations)
    && Object.entries(p.stepDurations).every(([key, duration]) => TIMING_STEPS.includes(key as TimingStep) && finite(duration))
    && Object.values(p.stepDurations).reduce((sum, duration) => sum + duration, 0) <= p.activeDurationMs + 1
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2
}
function robustAverage(values: number[], fallback: number): number {
  if (!values.length) return fallback
  const center = values.length >= 3 ? median(values) : fallback
  const bounded = (value: number): number => Math.max(Math.max(100, center / 4), Math.min(center * 4, value))
  return values.reduce((average, value, index) => index === 0 ? bounded(value) : ALPHA * bounded(value) + (1 - ALPHA) * average, fallback)
}
/** Legacy wall-clock durations are never learned: their manual waits are unknown. */
export function timingModel(history: unknown, id: AutomationId): TimingModel {
  const fallback = fallbackModel(id)
  if (!Array.isArray(history)) return fallback
  const samples = (history as ExecutionHistoryEntry[]).filter(entry => entry && entry.operation === id && !entry.dryRun
    && ['Success', 'Partial', 'Failed'].includes(entry.status) && Number.isFinite(Date.parse(entry.completedAt ?? ''))
    && validPerformance(entry.performance, id)).sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!))
    .slice(-MAX_PERFORMANCE_SAMPLES).map(entry => entry.performance!)
  const count = samples.length
  const blend = 1 - Math.exp(-count / 4)
  const unit = robustAverage(samples.map(sample => sample.unitDurationMs * sample.concurrency), fallback.unitMs)
  const startup = robustAverage(samples.map(sample => sample.startupMs), fallback.startupMs)
  return { unitMs: fallback.unitMs * (1 - blend) + unit * blend,
    startupMs: fallback.startupMs * (1 - blend) + startup * blend, historicalRuns: count }
}

export function estimateRemaining(model: TimingModel, input: {
  total: number; completed: number; concurrency: number; startupDone: boolean;
  startupElapsed: number; unitElapsed: number; observedUnitMs?: number; learned: number
}): number | null {
  if (!Number.isInteger(input.total) || input.total <= 0 || input.completed < 0
      || !finite(model.unitMs) || !finite(model.startupMs)) return null
  const remaining = Math.max(0, input.total - input.completed)
  if (!remaining) return input.startupDone ? 0 : model.startupMs
  const concurrency = Math.max(1, Math.min(20, input.concurrency || 1))
  const base = model.unitMs / concurrency
  const blend = input.observedUnitMs && input.learned ? 1 - Math.exp(-input.learned / 3) : 0
  let unit = base * (1 - blend) + Math.min(base * 4, Math.max(base / 4, input.observedUnitMs ?? base)) * blend
  // A stalled current batch must not reach zero while work is still pending.
  if (input.startupDone && input.unitElapsed > unit) unit = Math.min(base * 4, Math.max(unit, input.unitElapsed / 1.5))
  const startup = input.startupDone ? 0 : Math.max(0, model.startupMs - input.startupElapsed)
  const elapsed = input.startupDone ? Math.min(input.unitElapsed, unit) : 0
  return Math.max(1000, Math.round(startup + remaining * unit - elapsed))
}
