import type { AutomationInteraction } from '../../shared/automation-interaction'
import type { ExecutionHistoryStatus } from '../../shared/execution-history-types'
import { estimateRemaining, fallbackModel, rankTasks, timingModel, validPerformance, workUnit,
  type AutomationId, type EtaSnapshot, type LocalIntelligenceSnapshot, type PerformanceSample,
  type TimingModel, type TimingStep, type TimingProgress } from '../../shared/local-intelligence'
import type { ExecutionHistoryService } from './execution-history-service'

interface Run {
  id: string; contextId: string; operation: AutomationId; model: TimingModel
  started: number; pauseStarted?: number; pausedMs: number; state: EtaSnapshot['state']
  total: number; completed: number; concurrency: number; startupMs?: number
  lastUnitActive: number; learned: number; learnedMs: number; observedUnitMs?: number; succeeded: number
  step: TimingStep; stepAt: number; steps: Partial<Record<TimingStep, number>>
}

/** Advisory observer only: never returns a SAP command or influences engine control. */
export class LocalIntelligenceService {
  private run: Run | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(private readonly history: Pick<ExecutionHistoryService, 'getEntries'>,
    private readonly publish: (eta: EtaSnapshot) => void,
    private readonly now: () => number = () => performance.now()) {}

  async snapshot(): Promise<LocalIntelligenceSnapshot> {
    try { return { ranking: rankTasks(await this.history.getEntries({ limit: 500 })), eta: this.eta() } }
    catch { return { ranking: rankTasks([]), eta: this.eta() } }
  }
  begin(id: string, operation: AutomationId, contextId: string, total = 0): void {
    try {
      this.dispose()
      const run: Run = { id, contextId, operation, model: fallbackModel(operation), started: this.now(),
        pausedMs: 0, state: 'running', total, completed: 0, concurrency: 1, lastUnitActive: 0,
        learned: 0, learnedMs: 0, succeeded: 0, step: 'startup', stepAt: 0, steps: {} }
      this.run = run
      this.timer = setInterval(() => this.broadcast(), 2000)
      this.timer.unref?.()
      this.broadcast()
      // Never delay engine launch while reading advisory history.
      void this.history.getEntries({ limit: 500 }).then(entries => {
        if (this.run === run) { run.model = timingModel(entries, operation); this.broadcast() }
      }).catch(() => undefined)
    } catch { this.dispose() }
  }
  observe(id: string, progress: TimingProgress): void {
    try {
      const run = this.run
      if (!run || run.id !== id) return
      if (progress.state === 'WAITING_FOR_USER') this.pause('waiting')
      else if (progress.state === 'RECOVERING') this.pause('recovering')
      else if (progress.type === 'INTERACTION_RESOLVED') this.resume()
      if (Number.isInteger(progress.total) && progress.total! > 0 && progress.total! <= 100_000) run.total = progress.total!
      const workers = progress.workers ?? progress.worker
      if (Number.isInteger(workers) && workers! > 0 && workers! <= 20) run.concurrency = Math.max(run.concurrency, workers!)
      const rfq = run.operation === 'create-rfq'
      const apqp = run.operation === 'apqp-plan-closure'
      const rowStart = progress.stage === 'processing' && progress.status === 'running'
      if (progress.type === 'GROUP_STARTED' || !rfq && rowStart || apqp && progress.event === 'workers') {
        this.startupDone()
      }
      if (progress.type === 'GROUP_STARTED') this.step('npl')
      else if (progress.type === 'BUYER_RECEIPT_STARTED' || progress.type === 'GROUP_PROGRESS') this.step('buyerReceipt')
      else if (progress.type === 'RFQ_STARTED') this.step('rfq')
      else if (progress.stage === 'saving') { this.step('resultWrite'); if (run.pauseStarted === undefined) run.state = 'saving' }
      else if (!rfq && (rowStart || apqp && progress.event === 'workers')) this.step('records')
      const groupDone = rfq && ['GROUP_COMPLETED', 'GROUP_FAILED'].includes(progress.type ?? '')
      const rowDone = !rfq && progress.stage === 'processing' && ['success', 'skipped', 'failed'].includes(progress.status ?? '')
      const itemDone = apqp && progress.event === 'record'
      if (groupDone || rowDone || itemDone) {
        this.startupDone()
        const count = progress.current
        if (Number.isInteger(count) && count! > run.completed && count! <= run.total) {
          const active = this.activeMs(run)
          const delta = count! - run.completed
          const duration = Math.max(0, active - run.lastUnitActive)
          const clean = groupDone ? progress.type === 'GROUP_COMPLETED' && (progress.succeeded ?? 0) > run.succeeded
            : itemDone ? ['SUCCESS', 'NO_DATE', 'NO_RESULT'].includes(progress.status ?? '') : progress.status !== 'failed'
          if (clean && duration > 0 && run.pauseStarted === undefined) {
            const unit = duration / delta
            run.observedUnitMs = run.observedUnitMs === undefined ? unit : 0.3 * unit + 0.7 * run.observedUnitMs
            run.learned += delta; run.learnedMs += duration
          }
          run.lastUnitActive = active; run.completed = count!
          run.succeeded = progress.succeeded ?? run.succeeded
          if (groupDone) this.step('resultWrite')
        }
      }
      if (run.pauseStarted === undefined && progress.stage === 'processing' && !groupDone) run.state = 'running'
      this.broadcast()
    } catch { /* A malformed timing event cannot interrupt an automation callback. */ }
  }
  interaction(request: AutomationInteraction | null): void {
    try {
      if (!this.run) return
      if (request && request.runId === this.run.contextId) this.pause(request.state === 'RECOVERING' ? 'recovering' : 'waiting')
      else if (!request) this.resume()
      this.broadcast()
    } catch { /* Guidance is engine-owned, not ETA-owned. */ }
  }
  finish(id: string, status: Exclude<ExecutionHistoryStatus, 'Running'>): PerformanceSample | undefined {
    try {
      const run = this.run
      if (!run || run.id !== id) return undefined
      this.step(run.step)
      const active = this.activeMs(run)
      const sample: PerformanceSample = { version: 1, activeDurationMs: active,
        waitingForUserMs: Math.max(0, this.now() - run.started - active), startupMs: run.startupMs ?? 0,
        unitDurationMs: run.learned ? run.learnedMs / run.learned : 0, concurrency: run.concurrency,
        workUnits: { kind: workUnit(run.operation), total: run.total, completed: run.completed, learned: run.learned },
        stepDurations: { ...run.steps } }
      const eta = this.eta()
      if (eta) { try { this.publish({ ...eta, active: false, remainingMs: null }) } catch { /* UI may be closed. */ } }
      this.dispose()
      return status !== 'Cancelled' && validPerformance(sample, run.operation) ? sample : undefined
    } catch { this.dispose(); return undefined }
  }
  eta(): EtaSnapshot | null {
    try {
      const run = this.run
      if (!run) return null
      const active = this.activeMs(run)
      const remainingMs = run.pauseStarted === undefined ? estimateRemaining(run.model, { total: run.total,
        completed: run.completed, concurrency: run.concurrency, startupDone: run.startupMs !== undefined,
        startupElapsed: active, unitElapsed: Math.max(0, active - run.lastUnitActive),
        observedUnitMs: run.observedUnitMs, learned: run.learned }) : null
      return { automationId: run.operation, runId: run.id, active: true, state: run.state, remainingMs,
        completed: run.completed, total: run.total, unit: workUnit(run.operation), historicalRuns: run.model.historicalRuns,
        confidence: run.model.historicalRuns < 3 ? 'learning' : run.model.historicalRuns < 8 ? 'estimated' : 'high' }
    } catch { return null }
  }
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined; this.run = null
  }
  private activeMs(run: Run): number { return Math.max(0, (run.pauseStarted ?? this.now()) - run.started - run.pausedMs) }
  private pause(state: 'waiting' | 'recovering'): void {
    const run = this.run!
    if (run.pauseStarted === undefined) run.pauseStarted = this.now()
    run.state = state
  }
  private resume(): void {
    const run = this.run!
    if (run.pauseStarted !== undefined) { run.pausedMs += this.now() - run.pauseStarted; run.pauseStarted = undefined }
    run.state = 'running'
  }
  private startupDone(): void {
    const run = this.run!
    if (run.startupMs === undefined) { run.startupMs = this.activeMs(run); run.lastUnitActive = run.startupMs; this.step('records') }
  }
  private step(next: TimingStep): void {
    const run = this.run!
    const active = this.activeMs(run)
    run.steps[run.step] = (run.steps[run.step] ?? 0) + Math.max(0, active - run.stepAt)
    run.stepAt = active; run.step = next
  }
  private broadcast(): void {
    const eta = this.eta()
    if (eta) { try { this.publish(eta) } catch { /* Optional UI hint only. */ } }
  }
}
