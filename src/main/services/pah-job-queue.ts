import { randomUUID } from 'node:crypto'
import { isPahClaim, isPahCompletion, isPahId, isPahRequester, isPahTimestamp,
  type PahClaim, type PahCompletion, type PahJobIdentity, type PahRequester } from '../../shared/pah-job-types'

/** Storage boundary. The adapter must attest provenance and partition rows by worker. */
export interface PahQueueItem extends PahJobIdentity {
  request: unknown
}

export interface PahQueuedItem extends PahQueueItem {
  status: 'Queued'
  revision: string
}

export interface PahRunningItem extends PahQueueItem {
  status: 'Running'
  claim: PahClaim
}

export interface PahJobQueue {
  nextQueued(workerId: string, signal: AbortSignal): Promise<PahQueuedItem | null>
  listRunning(workerId: string, signal: AbortSignal): Promise<PahRunningItem[]>
  /** Atomic compare-and-set. An exception or false gives no permission to execute. */
  claim(item: PahQueuedItem, claim: PahClaim, signal: AbortSignal): Promise<boolean>
  /** Match the current claim and write all terminal fields atomically. An identical prior write is success. */
  complete(jobId: string, claim: PahClaim, outcome: PahCompletion, signal: AbortSignal): Promise<void>
}

type Row = PahQueueItem & { workerId: string; revision: string } & (
  | { status: 'Queued' }
  | { status: 'Running'; claim: PahClaim }
  | { status: PahCompletion['status']; claim: PahClaim; completion: PahCompletion }
)

/** Offline adapter. The second argument simulates metadata supplied by trusted ingress, never by the job. */
export class InMemoryPahJobQueue implements PahJobQueue {
  private readonly jobs = new Map<string, Row>()
  private readonly submissions = new Map<string, string>()

  constructor(private readonly now: () => number = Date.now) {}

  enqueue(request: unknown, ingress: { submissionId: string; requester: PahRequester; workerId: string }): string {
    const { submissionId, requester, workerId } = ingress
    if (!isPahId(submissionId) || !isPahRequester(requester) || !isPahId(workerId)) {
      throw new Error('Invalid trusted submission metadata.')
    }
    const key = [requester.tenantId, requester.objectId, submissionId].join('/')
    const prior = this.submissions.get(key)
    if (prior) return prior
    const jobId = randomUUID()
    this.jobs.set(jobId, { jobId, request: structuredClone(request), requester: structuredClone(requester),
      workerId, queuedAt: new Date(this.now()).toISOString(), status: 'Queued', revision: randomUUID() })
    this.submissions.set(key, jobId)
    return jobId
  }

  get(jobId: string): Row | undefined { return structuredClone(this.jobs.get(jobId)) }

  async nextQueued(workerId: string, signal: AbortSignal): Promise<PahQueuedItem | null> {
    signal.throwIfAborted()
    for (const row of this.jobs.values()) {
      if (row.status === 'Queued' && row.workerId === workerId) return structuredClone(row)
    }
    return null
  }

  async listRunning(workerId: string, signal: AbortSignal): Promise<PahRunningItem[]> {
    signal.throwIfAborted()
    return structuredClone([...this.jobs.values()].filter((row): row is Row & { status: 'Running' } =>
      row.status === 'Running' && row.workerId === workerId))
  }

  async claim(item: PahQueuedItem, claim: PahClaim, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const row = this.jobs.get(item.jobId)
    if (!row || row.status !== 'Queued' || row.revision !== item.revision || !isPahClaim(claim)
      || claim.workerId !== row.workerId || claim.startedAt < row.queuedAt) return false
    this.jobs.set(row.jobId, { ...row, status: 'Running', claim: structuredClone(claim), revision: randomUUID() })
    return true
  }

  async complete(jobId: string, claim: PahClaim, outcome: PahCompletion, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const row = this.jobs.get(jobId)
    if (!row || row.status === 'Queued' || row.claim.claimId !== claim.claimId || row.claim.workerId !== claim.workerId
      || !isPahCompletion(outcome) || outcome.completedAt < row.claim.startedAt) {
      throw new Error('Queue claim or completion rejected.')
    }
    if ('completion' in row) {
      if (JSON.stringify(row.completion) === JSON.stringify(outcome)) return
      throw new Error('Queue item already has a different completion.')
    }
    this.jobs.set(jobId, { ...row, status: outcome.status, completion: structuredClone(outcome), revision: randomUUID() })
  }
}

export function validPahQueueIdentity(item: PahQueueItem): boolean {
  return isPahId(item.jobId) && isPahRequester(item.requester) && isPahTimestamp(item.queuedAt)
}
