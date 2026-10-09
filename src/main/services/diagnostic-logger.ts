import { appendFile, readFile, readdir, lstat, realpath, writeFile, rename, unlink } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DiagnosticLevel,
  DiagnosticLogEntry,
  DiagnosticLogQuery
} from '../../shared/diagnostic-types'

export type DiagnosticLogInput = Omit<DiagnosticLogEntry, 'id' | 'timestamp'>

export class DiagnosticLogger {
  private writeQueue: Promise<void> = Promise.resolve()
  private runContext = new AsyncLocalStorage<string>()

  constructor(private readonly logsDirectory: string) {}

  withRun<T>(id: string, work: () => Promise<T>): Promise<T> { return this.runContext.run(id, work) }

  log(input: DiagnosticLogInput): Promise<void> {
    const entry: DiagnosticLogEntry = {
      ...input,
      details: this.runContext.getStore() ? { ...input.details, runId: this.runContext.getStore()! } : input.details,
      id: randomUUID(),
      timestamp: new Date().toISOString()
    }
    const filePath = join(this.logsDirectory, `sap-toolbox-${entry.timestamp.slice(0, 10)}.jsonl`)
    this.writeQueue = this.writeQueue
      .then(() => appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8'))
      .catch((error: unknown) => {
        console.error('Unable to write diagnostic log:', error)
      })
    return this.writeQueue
  }

  info(input: Omit<DiagnosticLogInput, 'level'>): Promise<void> {
    return this.log({ ...input, level: 'info' })
  }

  warning(input: Omit<DiagnosticLogInput, 'level'>): Promise<void> {
    return this.log({ ...input, level: 'warning' })
  }

  error(input: Omit<DiagnosticLogInput, 'level'>): Promise<void> {
    return this.log({ ...input, level: 'error' })
  }

  async getEntries(query: DiagnosticLogQuery): Promise<DiagnosticLogEntry[]> {
    await this.writeQueue
    const fileNames = (await readdir(this.logsDirectory))
      .filter((name) => /^sap-toolbox-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse()
    const entries: DiagnosticLogEntry[] = []
    const limit = query.limit ?? 100
    let skipped = 0

    for (const fileName of fileNames) {
      const content = await readFile(join(this.logsDirectory, fileName), 'utf8')
      const fileEntries = content
        .split(/\r?\n/)
        .filter(Boolean)
        .map(parseLogEntry)
        .filter((entry): entry is DiagnosticLogEntry => entry !== null)
        .reverse()

      for (const entry of fileEntries) {
        if (matchesQuery(entry, query)) {
          if (skipped < (query.offset ?? 0)) { skipped++; continue }
          entries.push(entry)
          if (entries.length >= limit) {
            return entries
          }
        }
      }
    }
    return entries
  }

  async deleteRun(id: string): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const names = (await readdir(this.logsDirectory)).filter(name => /^sap-toolbox-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      for (const name of names) {
        const path = join(this.logsDirectory, name)
        if ((await lstat(path)).isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) continue
        const content = await readFile(path, 'utf8')
        // Preserve malformed/unattributed legacy lines; never delete unrelated runs.
        const remaining = content.split(/\r?\n/).filter(line => {
          const entry = parseLogEntry(line)
          return entry?.details?.runId !== id
        }).join('\n')
        if (remaining === content) continue
        const temporary = path + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, remaining, 'utf8')
        await rename(temporary, path)
      }
    })
    await this.writeQueue
  }

  async purge(before?: number, protectedRuns = new Set<string>()): Promise<string[]> {
    const warnings: string[] = []
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      if ((await realpath(this.logsDirectory)).toLowerCase() !== resolve(this.logsDirectory).toLowerCase()) {
        warnings.push('Linked log directories were kept.'); return
      }
      const names = (await readdir(this.logsDirectory)).filter(name => /^sap-toolbox-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      for (const name of names) {
        const path = join(this.logsDirectory, name)
        try {
          if ((await lstat(path)).isSymbolicLink() || (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) {
            warnings.push('Linked diagnostic files were kept.'); continue
          }
          const content = await readFile(path, 'utf8')
          const remaining = content.split(/\r?\n/).filter(line => {
            if (!line) return false
            const entry = parseLogEntry(line)
            if (entry?.details?.runId && protectedRuns.has(String(entry.details.runId))) return true
            // Auto retention preserves malformed/undated legacy lines. Manual
            // Clear All may remove them, but only within named diagnostic files.
            return before !== undefined && (!entry || !Number.isFinite(Date.parse(entry.timestamp)) || Date.parse(entry.timestamp) >= before)
          })
          if (!remaining.length) await unlink(path)
          else {
            const updated = remaining.join('\n') + '\n'
            if (updated === content) continue
            const temporary = path + '.' + randomUUID() + '.tmp'
            await writeFile(temporary, updated, 'utf8'); await rename(temporary, path)
          }
        } catch { warnings.push('Some diagnostic files could not be removed; they were kept.') }
      }
    })
    await this.writeQueue
    return [...new Set(warnings)]
  }
}

function parseLogEntry(line: string): DiagnosticLogEntry | null {
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const candidate = value as Record<string, unknown>
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.timestamp !== 'string' ||
      typeof candidate.event !== 'string' ||
      typeof candidate.message !== 'string' ||
      !isLevel(candidate.level) ||
      !isCategory(candidate.category)
    ) {
      return null
    }
    return value as DiagnosticLogEntry
  } catch {
    return null
  }
}

function matchesQuery(entry: DiagnosticLogEntry, query: DiagnosticLogQuery): boolean {
  if (query.levels && query.levels.length > 0 && !query.levels.includes(entry.level)) {
    return false
  }
  const search = query.search?.trim().toLowerCase()
  if (!search) {
    return true
  }
  return [
    entry.category,
    entry.event,
    entry.message,
    entry.errorCode ?? '',
    entry.tcode ?? ''
  ].some((value) => value.toLowerCase().includes(search))
}

function isLevel(value: unknown): value is DiagnosticLevel {
  return value === 'info' || value === 'warning' || value === 'error'
}

function isCategory(value: unknown): value is DiagnosticLogEntry['category'] {
  return value === 'application' || value === 'settings' || value === 'automation' || value === 'ipc'
}
