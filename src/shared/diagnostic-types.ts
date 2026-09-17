export type DiagnosticLevel = 'info' | 'warning' | 'error'

export interface DiagnosticLogEntry {
  id: string
  timestamp: string
  level: DiagnosticLevel
  category: 'application' | 'settings' | 'automation' | 'ipc'
  event: string
  message: string
  errorCode?: string
  tcode?: string
  details?: Record<string, string | number | boolean>
}

export interface DiagnosticLogQuery {
  search?: string
  levels?: DiagnosticLevel[]
  limit?: number
}

export interface DiagnosticLogResult {
  entries: DiagnosticLogEntry[]
  logDirectory: string
  dataDirectory: string
}

export type OpenLogFolderResult =
  | { success: true }
  | { success: false; message: string }

export function isDiagnosticLogQuery(value: unknown): value is DiagnosticLogQuery {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const validSearch =
    candidate.search === undefined ||
    (typeof candidate.search === 'string' && candidate.search.length <= 200)
  const validLimit =
    candidate.limit === undefined ||
    (Number.isInteger(candidate.limit) &&
      Number(candidate.limit) >= 1 &&
      Number(candidate.limit) <= 500)
  const validLevels =
    candidate.levels === undefined ||
    (Array.isArray(candidate.levels) &&
      candidate.levels.every(
        (level) => level === 'info' || level === 'warning' || level === 'error'
      ))
  return validSearch && validLimit && validLevels
}
