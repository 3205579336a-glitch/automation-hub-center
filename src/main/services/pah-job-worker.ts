import { randomUUID } from 'node:crypto'
import { isPahClaim, isPahId, isPahProject, isPahRequester, parsePahRequest,
  type PahClaim, type PahCompletion } from '../../shared/pah-job-types'
import type { PahDesktopApproval, PahJobDispatcher } from './pah-job-dispatcher'
import type { PahJobOutbox } from './pah-job-outbox'
import { validPahQueueIdentity, type PahJobQueue } from './pah-job-queue'

interface PahWorkerOptions {
  /** Stable, installation-specific queue partition. Run one worker per partition. */
  workerId: string
  queue: PahJobQueue
  outbox: PahJobOutbox
  dispatcher: PahJobDispatcher
  /** Local verifier. Return null unless the approved desktop and its operator are currently present. */
  approveDesktop: (signal: AbortSignal) => Promise<PahDesktopApproval | null>
  onPollError?: (code: 'PAH_POLL_FAILED') => void
  now?: () => number
}

export class PahJobWorker {
  private readonly shutdown = new AbortController()
  private timer?: NodeJS.Timeout
  private inFlight?: Promise<void>

  constructor(private readonly options: PahWorkerOptions) {
    if (!isPahId(options.workerId)) throw new Error('Invalid worker ID.')
  }

  start(intervalMs = 15_000): void {
    if (this.timer || this.shutdown.signal.aborted) return
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 2_147_483_647) {
      throw new Error('Invalid poll interval.')
    }
    const tick = (): void => {
      void this.pollOnce().catch(() => {
        if (!this.shutdown.signal.aborted) this.options.onPollError?.('PAH_POLL_FAILED')
      })
    }
    this.timer = setInterval(tick, intervalMs)
    this.timer.unref()
    tick()
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.shutdown.abort()
    await this.inFlight?.catch(() => undefined)
  }

  pollOnce(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve()
    if (!this.inFlight) this.inFlight = this.poll().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  private async poll(): Promise<void> {
    const { queue, workerId, outbox, dispatcher, approveDesktop } = this.options
    const approval = await approveDesktop(this.shutdown.signal)
    if (!approval || !isPahRequester(approval.requester) || !isPahProject(approval.sapUser)
      || !isPahProject(approval.sdUser) || !approval.projects.every(isPahProject)) return
    const signal = AbortSignal.any([this.shutdown.signal, approval.signal])
    try {
      if (signal.aborted) return
      // Only writeback is retried. A checkpoint survives a lost PATCH response or a Hub restart.
      for (const { jobId, claim, outcome } of await outbox.pending(workerId)) {
        signal.throwIfAborted()
        await queue.complete(jobId, claim, outcome, signal)
        await outbox.remove(jobId)
      }
      signal.throwIfAborted()
      for (const job of await queue.listRunning(workerId, signal)) {
        signal.throwIfAborted()
        if (!validPahQueueIdentity(job) || !isPahClaim(job.claim) || job.claim.workerId !== workerId) {
          throw new Error('Invalid running queue metadata.')
        }
        // Polling is serialized and this partition has one exclusive desktop owner.
        // Any remaining Running item lacks a recoverable outcome.
        await queue.complete(job.jobId, job.claim, { status: 'Review Required', result: null,
          errorCode: 'OUTCOME_UNCONFIRMED', completedAt: this.timestamp(job.claim.startedAt) }, signal)
      }
      signal.throwIfAborted()
      const job = await queue.nextQueued(workerId, signal)
      if (!job) return
      if (!validPahQueueIdentity(job) || typeof job.revision !== 'string' || !job.revision) {
        throw new Error('Invalid queued item metadata.')
      }
      const request = parsePahRequest(job.request)
      const rejection = typeof request === 'string' ? request
        : dispatcher.permits(request, job.requester, approval) ? null : 'UNAUTHORIZED'
      const reserved = typeof request !== 'string' && !rejection ? dispatcher.reserve(job.jobId, request, approval, signal) : null
      if (!rejection && !reserved) return // Leave the item queued while the Hub owns another run.
      const claim: PahClaim = { workerId, claimId: randomUUID(), startedAt: this.timestamp(job.queuedAt) }
      let outcome: PahCompletion
      try {
        signal.throwIfAborted()
        if (!await queue.claim(job, claim, signal)) return
        const execution = rejection ? { status: 'Failed', result: null, errorCode: rejection } as const
          : await reserved!.execute()
        outcome = { ...execution, completedAt: this.timestamp(claim.startedAt) }
        await outbox.save(job.jobId, claim, outcome)
      } finally { reserved?.release() }
      signal.throwIfAborted()
      await queue.complete(job.jobId, claim, outcome, signal)
      await outbox.remove(job.jobId)
    } catch (error) {
      if (!signal.aborted) throw error
    }
  }

  private timestamp(minimum: string): string {
    return new Date(Math.max(this.options.now?.() ?? Date.now(), Date.parse(minimum))).toISOString()
  }
}
