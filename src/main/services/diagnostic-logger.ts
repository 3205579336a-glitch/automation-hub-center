import { appendFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  DiagnosticLevel,
  DiagnosticLogEntry,
  DiagnosticLogQuery
} from '../../shared/diagnostic-types'

export type DiagnosticLogInput = Omit<DiagnosticLogEntry, 'id' | 'timestamp'>

export class DiagnosticLogger {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly logsDirectory: string) {}

  log(input: DiagnosticLogInput): Promise<void> {
    const entry: DiagnosticLogEntry = {
      ...input,
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
          entries.push(entry)
          if (entries.length >= limit) {
            return entries
          }
        }
      }
    }
    return entries
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
