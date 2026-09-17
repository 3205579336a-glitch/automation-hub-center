import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  ExecutionHistoryEntry,
  ExecutionHistoryQuery,
  ExecutionHistoryStatus
} from '../../shared/execution-history-types'
import type { DiagnosticLogEntry } from '../../shared/diagnostic-types'
import type { DiagnosticLogger } from './diagnostic-logger'

const MAX_STORED_ENTRIES = 500

export class ExecutionHistoryService {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly historyPath: string,
    private readonly logger: DiagnosticLogger
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
    await this.mutate((entries) => [entry, ...entries])
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
    )
  }

  async getEntries(query: ExecutionHistoryQuery): Promise<ExecutionHistoryEntry[]> {
    await this.writeQueue
    const entries = await this.readOrMigrate()
    const search = query.search?.trim().toLowerCase()
    return entries
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
      .slice(0, query.limit ?? 100)
  }

  private async mutate(
    mutation: (entries: ExecutionHistoryEntry[]) => ExecutionHistoryEntry[]
  ): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const entries = await this.readOrMigrate()
      await this.writeEntries(mutation(entries).slice(0, MAX_STORED_ENTRIES))
    })
    return this.writeQueue
  }

  private async readOrMigrate(): Promise<ExecutionHistoryEntry[]> {
    try {
      const content = await readFile(this.historyPath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      return Array.isArray(parsed) ? parsed.filter(isHistoryEntry) : []
    } catch (error) {
      if (!isMissingFile(error)) {
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
    const temporaryPath = `${this.historyPath}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.historyPath)
  }
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
