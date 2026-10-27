import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { APQP_DATE_SCHEMA, isApqpDateId, isApqpDateQuery, type ApqpDateQuery, type ApqpDateSnapshot, type ApqpNativeDateData } from '../../shared/apqp-date-types'
import type { ExecutionHistoryService } from './execution-history-service'

export interface CachedApqpRead {
  snapshot: ApqpDateSnapshot
  session: ApqpNativeDateData['session']
  fieldSchema: string
}
const RETENTION = 60 * 86_400_000

/** Reuse completed, manifest-owned read evidence. No new files or SAP requests.
 * History/artifact cleanup automatically removes these caches after 60 days.
 */
export class ApqpDateCache {
  constructor(private readonly root: string, private readonly history: Pick<ExecutionHistoryService, 'getEntries'>,
    private readonly now: () => number = Date.now) {}

  async load(query: ApqpDateQuery): Promise<CachedApqpRead | null> {
    const entries = (await this.history.getEntries({ operations: ['apqp-date-management'], limit: 500 }))
      .filter(entry => entry.completedAt && Number.isFinite(Date.parse(entry.completedAt))
        && Date.parse(entry.completedAt) <= this.now() && this.now() - Date.parse(entry.completedAt) < RETENTION)
      .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!))
    for (const entry of entries.filter(entry => entry.apqpDateAction === 'query' && entry.status === 'Success')) {
      try {
        const id = entry.diagnosticRunId
        if (!id) continue
        await this.owned(id)
        const request = await this.json(id, 'apqp-date-request.json')
        if (request.action !== 'query' || !sameQuery(request.query, query)) continue
        const data = await this.json(id, 'apqp-dates-result.json')
        if (data.fieldSchema !== APQP_DATE_SCHEMA || data.readOnly !== true || data.error || data.errorCode || !Array.isArray(data.records)
          || !data.session || typeof data.session !== 'object') continue
        const snapshot: ApqpDateSnapshot = { ...query, id, createdAt: entry.completedAt!,
          records: data.records as ApqpDateSnapshot['records'], resultPath: join(this.root, id, 'apqp-dates-result.json'), cached: true }
        // Historical attempt only, NOT proof of the current SAP save state.
        for (const attempt of entries.filter(item => item.apqpDateAction === 'update' && Date.parse(item.completedAt!) > Date.parse(entry.completedAt!))) {
          try {
            if (!attempt.diagnosticRunId) continue
            await this.owned(attempt.diagnosticRunId)
            const input = await this.json(attempt.diagnosticRunId, 'apqp-date-request.json')
            if (input.action !== 'execute' || !sameQuery(input.query, query)) continue
            const outcome = await this.json(attempt.diagnosticRunId, 'apqp-dates-result.json')
            // A completed verified batch is not an unresolved edit-buffer attempt.
            // Its old read is still explicitly historical; live conflict checks remain.
            if (!outcome.error && outcome.update && typeof outcome.update === 'object'
              && (outcome.update as Record<string, unknown>).stageOnly === false) continue
            if (!Array.isArray(outcome.writeEvents)) continue
            const events = outcome.writeEvents.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
            const last = events.at(-1)
            if (!last || !snapshot.records.some(row => row.apqp === last.apqp && row.material === last.material && row.vendor === last.vendor)) continue
            if (last.event === 'STAGED_READY_NOT_SAVED' || outcome.writeMayHaveOccurred === true) {
              snapshot.lastAttempt = { apqp: String(last.apqp), at: attempt.completedAt!,
                status: last.event === 'STAGED_READY_NOT_SAVED' ? 'STAGED' : 'REVIEW_REQUIRED' }
              break
            }
          } catch { /* An incomplete/removed attempt is never a confirmed success. */ }
        }
        return { snapshot, session: data.session as ApqpNativeDateData['session'], fieldSchema: APQP_DATE_SCHEMA }
      } catch { /* Missing/corrupt/linked/expired evidence is a cache miss. */ }
    }
    return null
  }

  private async owned(id: string): Promise<void> {
    if (!isApqpDateId(id)) throw new Error('Invalid cache identity')
    for (const path of [resolve(this.root), resolve(this.root, id)]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error('Linked cache directory')
    }
    const manifest = await this.json(id, 'artifacts.json')
    if (manifest.version !== 1 || manifest.id !== id || manifest.operation !== 'apqp-date-management'
      || typeof manifest.finishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.finishedAt))
      || Date.parse(manifest.finishedAt) > this.now() || this.now() - Date.parse(manifest.finishedAt) >= RETENTION) throw new Error('Unfinished/expired cache')
  }
  private async json(id: string, name: string): Promise<Record<string, unknown>> {
    const path = resolve(this.root, id, name), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_000_000 || (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error('Invalid cache file')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache data')
    return value as Record<string, unknown>
  }
}
function sameQuery(value: unknown, query: ApqpDateQuery): boolean {
  return isApqpDateQuery(value) && value.environment === query.environment && value.project === query.project && value.userId.toUpperCase() === query.userId.toUpperCase()
}
