import type { ApqpDateRecord } from '../../../../shared/apqp-date-types'

export const APQP_PROJECTS_KEY = 'apqp-recent-projects'
export const DEFAULT_APQP_PROJECT = '775773'
const PROJECT_PATTERN = /^[A-Za-z0-9_/-]{1,32}$/
const MAX_PROJECTS = 10
type ProjectStorage = Pick<Storage, 'getItem' | 'setItem'>

function projects(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && PROJECT_PATTERN.test(value)))]
    .slice(0, MAX_PROJECTS)
}

export function readApqpProjects(storage?: ProjectStorage): string[] {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(APQP_PROJECTS_KEY) ?? '[]')
    const saved = Array.isArray(value) ? projects(value) : []
    return saved.length ? saved : [DEFAULT_APQP_PROJECT]
  } catch { return [DEFAULT_APQP_PROJECT] }
}

/** Remember submitted project numbers only; storage failure never blocks SAP. */
export function rememberApqpProject(previous: string[], value: string, storage?: ProjectStorage): string[] {
  if (!PROJECT_PATTERN.test(value)) return previous
  const next = projects([value, ...previous])
  try { (storage ?? localStorage).setItem(APQP_PROJECTS_KEY, JSON.stringify(next)) } catch { /* Local storage may be unavailable/full. */ }
  return next
}

export type ApqpRecordOrder = 'original' | 'supplier-asc' | 'supplier-desc'
const supplierOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/** Display-only: never mutate the snapshot, date edits, or native execution order. */
export function visibleApqpRecords(records: ApqpDateRecord[], search: string, order: ApqpRecordOrder): ApqpDateRecord[] {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const result = records.filter(row => terms.every(term => [row.apqp, row.material, row.vendor].some(value => value.toLowerCase().includes(term))))
  if (order !== 'original') result.sort((a, b) => supplierOrder.compare(a.vendor, b.vendor) * (order === 'supplier-asc' ? 1 : -1))
  return result
}
