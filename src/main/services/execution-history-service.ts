import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  ExecutionHistoryEntry,
  ExecutionHistoryQuery,
  ExecutionHistoryResult,
  ExecutionHistoryStatus
} from '../../shared/execution-history-types'
import type { DiagnosticLogEntry } from '../../shared/diagnostic-types'
import type { DiagnosticLogger } from './diagnostic-logger'
import { DEFAULT_TASK_ORDER, MAX_PERFORMANCE_SAMPLES } from '../../shared/local-intelligence'

const MAX_STORED_ENTRIES = 500

export class ExecutionHistoryService {
  private writeQueue: Promise<void> = Promise.resolve()
  private cleaning = false
  isCleaning(): boolean { return this.cleaning }

  constructor(
    private readonly historyPath: string,
    private readonly logger: DiagnosticLogger,
    private readonly cleanup?: (entry: ExecutionHistoryEntry, protectedPaths?: string[]) => Promise<string[]>
  ) {}

  async start(
    input: Omit<ExecutionHistoryEntry, 'id' | 'startedAt' | 'status'>
  ): Promise<ExecutionHistoryEntry> {
    const entry: ExecutionHistoryEntry = {
      ...input,
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      status: 'Running'
    }
    await this.mutate((entries) => [entry, ...entries]).catch(() => this.recordStoreFailure())
    return entry
  }

  async finish(
    id: string,
    update: Omit<Partial<ExecutionHistoryEntry>, 'id' | 'startedAt' | 'operation'>
      & { status: Exclude<ExecutionHistoryStatus, 'Running'>; summary: string }
  ): Promise<void> {
    const completedAt = new Date().toISOString()
    await this.mutate((entries) =>
      entries.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              ...update,
              completedAt,
              durationMs: Math.max(
                0,
                new Date(completedAt).getTime() - new Date(entry.startedAt).getTime()
              )
            }
          : entry
      )
    ).catch(() => this.recordStoreFailure())
  }

  async getEntries(query: ExecutionHistoryQuery): Promise<ExecutionHistoryEntry[]> {
    return (await this.getPage(query)).entries
  }

  async getPage(query: ExecutionHistoryQuery): Promise<ExecutionHistoryResult> {
    await this.writeQueue.catch(() => undefined)
    const entries = await this.readOrMigrate()
    const search = query.search?.trim().toLowerCase()
    const matching = entries
      .filter(entry => !query.operations?.length || query.operations.includes(entry.operation))
      .filter((entry) => !query.statuses?.length || query.statuses.includes(entry.status))
      .filter((entry) => {
        if (!search) {
          return true
        }
        return [
          entry.label,
          entry.summary,
          entry.tcode ?? '',
          entry.resultPath ?? '',
          entry.backupPath ?? ''
        ].some((value) => value.toLowerCase().includes(search))
      })
    const offset = query.offset ?? 0
    return { entries: matching.slice(offset, offset + (query.limit ?? 100)), total: matching.length }
  }

  /** App-owned logs/history only. The same queue protects writes and cleanup. */
  async clear(before?: number): Promise<{ deleted: number; warnings: string[] }> {
    if (this.cleaning) throw new Error('Log cleanup is already in progress.')
    this.cleaning = true
    let deleted = 0
    const warnings: string[] = []
    try {
      this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
        const entries = await this.readOrMigrate(true)
        const removed = entries.filter(entry => entry.status !== 'Running' && (before === undefined ||
          Date.parse(entry.completedAt || entry.startedAt) < before))
        const ids = new Set(removed.map(entry => entry.id))
        await this.writeEntries(entries.filter(entry => !ids.has(entry.id)))
        deleted = removed.length
        if (before === undefined && entries.some(entry => entry.status === 'Running')) warnings.push('Unfinished execution records and their diagnostics were kept.')
        const protectedPaths = entries.flatMap(entry => [entry.resultPath, entry.backupPath]).filter((path): path is string => Boolean(path))
        for (const entry of removed) {
          try { warnings.push(...await this.cleanup?.(entry, protectedPaths) ?? []) }
          catch { warnings.push('Some associated diagnostics could not be safely removed and were kept.') }
        }
        // Keep shared diagnostics attributed to unfinished runs, even on Clear All.
        try { warnings.push(...await this.logger.purge(before, new Set(entries.filter(entry => entry.status === 'Running').map(entry => entry.id)))) }
        catch { warnings.push('Some shared diagnostic logs could not be cleaned and were kept.') }
      })
      await this.writeQueue
      return { deleted, warnings: [...new Set(warnings)] }
    } finally { this.cleaning = false }
  }

  async deleteEntry(id: string): Promise<string[]> {
    let warnings: string[] = []
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const entries = await this.readOrMigrate(true)
      const entry = entries.find(item => item.id === id)
      if (!entry) throw new Error('This execution record no longer exists.')
      if (entry.status === 'Running') throw new Error('Running execution records cannot be deleted.')
      // Commit the removal before cleanup; a failed history write never erases diagnostics.
      await this.writeEntries(entries.filter(item => item.id !== id))
      try { warnings = await this.cleanup?.(entry) ?? [] } catch { warnings.push('Some diagnostic files were kept because cleanup failed.') }
      try { await this.logger.deleteRun?.(id) } catch { warnings.push('Some shared diagnostic logs could not be cleaned.') }
    })
    await this.writeQueue
    return warnings
  }

  private async mutate(
    mutation: (entries: ExecutionHistoryEntry[]) => ExecutionHistoryEntry[]
  ): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const entries = await this.readOrMigrate(true)
      await this.writeEntries(retainPerformance(mutation(entries).slice(0, MAX_STORED_ENTRIES)))
    })
    return this.writeQueue
  }

  private async readOrMigrate(failOnCorrupt = false): Promise<ExecutionHistoryEntry[]> {
    try {
      const content = await readFile(this.historyPath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      const entries = Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : []
      if (failOnCorrupt && (!Array.isArray(parsed) || entries.length !== parsed.length)) {
        throw new Error('Local history is malformed; preserve it rather than overwrite it.')
      }
      return entries
    } catch (error) {
      if (!isMissingFile(error)) {
        if (failOnCorrupt) throw error
        return []
      }
      const migrated = await this.migrateDiagnosticLogs()
      await this.writeEntries(migrated)
      return migrated
    }
  }

  private async migrateDiagnosticLogs(): Promise<ExecutionHistoryEntry[]> {
    const logs = await this.logger.getEntries({ limit: 500 })
    return logs
      .filter((entry) =>
        [
          'automation.succeeded',
          'automation.user-action-required',
          'automation.failed',
          'me12.batch.completed',
          'me12.batch.failed',
          'me01.batch.completed',
          'me01.batch.failed',
          'me52n.batch.completed',
          'me52n.batch.failed'
        ].includes(entry.event)
      )
      .map(historyFromDiagnostic)
      .slice(0, MAX_STORED_ENTRIES)
  }

  private async writeEntries(entries: ExecutionHistoryEntry[]): Promise<void> {
    // Migration reads can arrive together on a first launch; do not share a temp filename.
    const temporaryPath = `${this.historyPath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.historyPath)
  }
  private recordStoreFailure(): void {
    try {
      void this.logger.warning({ category: 'application', event: 'history.store-unavailable',
        message: 'Local execution history could not be saved. Automation is not blocked; ranking and ETA may use defaults.' }).catch(() => undefined)
    } catch { /* Even diagnostic logging is optional for advisory storage failures. */ }
  }
}

/** Keep normal history; bound only optional per-run timing metadata. */
function retainPerformance(entries: ExecutionHistoryEntry[]): ExecutionHistoryEntry[] {
  const counts = new Map<string, number>()
  // Entry order is newest-started first; only one supported batch runs at a time.
  return entries.map(entry => {
    if (!entry.performance || !DEFAULT_TASK_ORDER.includes(entry.operation as typeof DEFAULT_TASK_ORDER[number])) return entry
    const count = (counts.get(entry.operation) ?? 0) + 1
    counts.set(entry.operation, count)
    if (count <= MAX_PERFORMANCE_SAMPLES) return entry
    const normalHistory = { ...entry }
    delete normalHistory.performance
    return normalHistory
  })
}

function historyFromDiagnostic(entry: DiagnosticLogEntry): ExecutionHistoryEntry {
  const isMe12 = entry.tcode === 'ME12' || entry.event.startsWith('me12.')
  const isMe01 = entry.tcode === 'ME01' || entry.event.startsWith('me01.')
  const isMe52n = entry.tcode === 'ME52N' || entry.event.startsWith('me52n.')
  const isRfq = entry.tcode === 'ME41'
  const failed = entry.event.endsWith('.failed')
  const details = entry.details
  return {
    id: `diagnostic-${entry.id}`,
    operation: isMe12 ? 'me12-batch' : isMe01 ? 'me01-source-list' : isMe52n ? 'me52n-project-ref' : isRfq ? 'create-rfq' : 'open-sap',
    label: isMe12
      ? 'ME12 Supplier Lead Time'
      : isMe01
        ? 'ME01 Source List — Plant C100'
        : isMe52n
          ? 'ME52N Project Ref'
        : isRfq
        ? 'Create RFQ — Open ME41'
        : 'Open SAP WebGUI',
    startedAt: entry.timestamp,
    completedAt: entry.timestamp,
    durationMs: 0,
    status: failed ? 'Failed' : 'Success',
    summary: entry.message,
    tcode: entry.tcode,
    processed: numericDetail(details, 'processed'),
    succeeded: numericDetail(details, 'succeeded'),
    skipped: numericDetail(details, 'skipped'),
    failed: numericDetail(details, 'failed')
  }
}

function numericDetail(
  details: DiagnosticLogEntry['details'],
  key: string
): number | undefined {
  const value = details?.[key]
  return typeof value === 'number' ? value : undefined
}

function isHistoryEntry(value: unknown): value is ExecutionHistoryEntry {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.startedAt === 'string' &&
    typeof candidate.summary === 'string' &&
    (candidate.operation === 'open-sap' ||
      candidate.operation === 'create-rfq' ||
      candidate.operation === 'me12-batch' ||
      candidate.operation === 'me01-source-list' ||
      candidate.operation === 'me52n-project-ref' ||
      candidate.operation === 'apqp-plan-closure') &&
    (candidate.status === 'Running' ||
      candidate.status === 'Success' ||
      candidate.status === 'Partial' ||
      candidate.status === 'Failed' ||
      candidate.status === 'Cancelled')
  )
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
