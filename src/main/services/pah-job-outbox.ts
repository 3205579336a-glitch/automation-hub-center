import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isObject, isPahClaim, isPahCompletion, isPahId,
  type PahClaim, type PahCompletion } from '../../shared/pah-job-types'

interface PendingCompletion {
  jobId: string
  claim: PahClaim
  outcome: PahCompletion
}

/** Stores results before writeback. A restarted worker can redeliver a result without querying SAP. */
export class PahJobOutbox {
  constructor(private readonly directory: string) {}

  async save(jobId: string, claim: PahClaim, outcome: PahCompletion): Promise<void> {
    if (!isPahId(jobId) || !isPahClaim(claim) || !isPahCompletion(outcome) || outcome.completedAt < claim.startedAt) {
      throw new Error('Invalid completion checkpoint.')
    }
    await mkdir(this.directory, { recursive: true })
    const temporary = join(this.directory, `${jobId}.${randomUUID()}.tmp`)
    const file = await open(temporary, 'wx')
    try {
      await file.writeFile(JSON.stringify({ jobId, claim, outcome }), 'utf8')
      await file.sync()
    } finally { await file.close() }
    await rename(temporary, this.path(jobId))
  }

  async pending(workerId: string): Promise<PendingCompletion[]> {
    const names = await readdir(this.directory).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const pending: PendingCompletion[] = []
    for (const name of names) {
      const id = name.slice(0, -5)
      if (!name.endsWith('.json') || !isPahId(id)) continue
      const text = await readFile(this.path(id), 'utf8')
      let entry: unknown
      try { entry = JSON.parse(text) } catch { continue }
      if (isObject(entry) && Object.keys(entry).length === 3 && entry.jobId === id && isPahClaim(entry.claim)
        && entry.claim.workerId === workerId && isPahCompletion(entry.outcome) && entry.outcome.completedAt >= entry.claim.startedAt) {
        pending.push({ jobId: id, claim: entry.claim, outcome: entry.outcome })
      }
    }
    return pending
  }

  async remove(jobId: string): Promise<void> { await unlink(this.path(jobId)) }

  private path(jobId: string): string {
    if (!isPahId(jobId)) throw new Error('Invalid checkpoint ID.')
    return join(this.directory, `${jobId}.json`)
  }
}
