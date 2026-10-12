import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExecutionHistoryEntry } from '../../shared/execution-history-types'
import { RFQ_RUN_ID, type RfqRecoveryRecord, type RfqRecoveryRecorder, type RfqRecoveryView } from '../../shared/rfq-safe-recovery'

/** Durable review ledger only. No SAP connection, command, resume, or process termination. */
export class RfqSafeRecoveryService implements RfqRecoveryRecorder {
  private active = new Set<string>()
  constructor(readonly directory: string, private readonly runsDirectory: string,
    private readonly probe: (pid: number) => 'alive' | 'dead' | 'unknown' = processStatus,
    private readonly legacyRunsDirectories: string[] = []) { mkdirSync(directory, { recursive: true }) }

  begin(runId: string, environment: 'PROD' | 'QA', resultPath: string): void {
    if (this.read(runId)) throw new Error('A recovery record already exists for this run.')
    const now = new Date().toISOString()
    this.write({ version: 1, runId, environment, startedAt: now, updatedAt: now, ownerPid: process.pid,
      engineClosed: false, phase: 'active', projects: [], totalGroups: null, completedGroupKeys: [], uncertainGroupKeys: [], rfqNumbers: [], resultPath })
    this.active.add(runId)
  }
  launched(runId: string, pid: number): void {
    const record = this.require(runId)
    if (!validPid(pid)) throw new Error('RFQ process identity is unavailable; launch is blocked.')
    this.write({ ...record, enginePid: pid })
  }
  observe(runId: string, event: Record<string, unknown>): void {
    const type = event.type
    // Flush durable boundaries only; per-row timing/UI hints must not cause synchronous disk writes.
    if (typeof type !== 'string' || !['VALIDATION_COMPLETED', 'RUN_STARTED', 'GROUP_STARTED', 'BUYER_RECEIPT_SAVED',
      'RFQ_CREATED', 'GROUP_COMPLETED', 'GROUP_FAILED', 'RESULT_FILE', 'RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED'].includes(type)) return
    const record = this.require(runId)
    if (event.runId && event.runId !== runId) throw new Error('RFQ event belongs to another run.')
    if (type === 'VALIDATION_COMPLETED' && event.preview && typeof event.preview === 'object') {
      const preview = event.preview as { groupCount?: unknown; groups?: { project?: unknown }[] }
      if (validCount(preview.groupCount)) record.totalGroups = preview.groupCount
      if (Array.isArray(preview.groups)) record.projects = [...new Set(preview.groups.map(group => group.project).filter((p): p is string => typeof p === 'string'))]
    }
    if (validCount(event.total) && event.total > 0) record.totalGroups = event.total
    if (type === 'GROUP_STARTED') {
      for (const key of ['groupKey', 'project', 'plant', 'supplier'] as const) if (typeof event[key] === 'string') record[key] = event[key] as string
      record.materials = Array.isArray(event.materials) ? event.materials.filter((m): m is string => typeof m === 'string') : []
      if (record.project && !record.projects.includes(record.project)) record.projects.push(record.project)
      if (record.groupKey) record.uncertainGroupKeys = [...new Set([...(record.uncertainGroupKeys ?? []), record.groupKey])]
    }
    const groupConfirmed = type === 'GROUP_COMPLETED' && typeof event.groupStatus === 'string'
      && /^(SUCCESS(?:_WITH_SKIPS)?|SKIPPED_\w+|INPUT_REQUIRED_PPAP_DATE|DRY_RUN)$/.test(event.groupStatus)
    if (['BUYER_RECEIPT_SAVED', 'RFQ_CREATED'].includes(type) || groupConfirmed) {
      record.lastConfirmedCheckpoint = type
      record.checkpointGroup = typeof event.groupKey === 'string' ? event.groupKey : record.groupKey
    }
    if (type === 'RFQ_CREATED' && typeof event.rfqNumber === 'string' && event.rfqNumber) record.rfqNumbers = [...new Set([...record.rfqNumbers, event.rfqNumber])]
    // GROUP_FAILED is processed, not confirmed complete. current is an ordinal, not a completion count.
    if (groupConfirmed && typeof event.groupKey === 'string' && event.groupKey) {
      record.completedGroupKeys = [...new Set([...record.completedGroupKeys, event.groupKey])]
      record.uncertainGroupKeys = (record.uncertainGroupKeys ?? []).filter(key => key !== event.groupKey)
    }
    if (['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED'].includes(type)) record.terminal = type
    if (typeof event.resultPath === 'string' && this.safeResult(runId, event.resultPath)) record.resultPath = event.resultPath
    this.write(record)
  }
  close(runId: string, code: number | null): void {
    this.active.delete(runId)
    const record = this.require(runId)
    this.write({ ...record, engineClosed: true, phase: code === 0 && record.terminal === 'RUN_COMPLETED' && !record.uncertainGroupKeys?.length ? 'complete' : 'review' })
  }
  importLegacy(entries: ExecutionHistoryEntry[]): void {
    for (const entry of entries) {
      if (entry.operation !== 'create-rfq' || !['Running', 'Interrupted'].includes(entry.status) || !RFQ_RUN_ID.test(entry.id) || this.read(entry.id)) continue
      this.write({ version: 1, runId: entry.id, environment: 'UNKNOWN', startedAt: entry.startedAt, updatedAt: new Date().toISOString(),
        engineClosed: false, phase: 'review', projects: [], totalGroups: null, completedGroupKeys: [], rfqNumbers: [], resultPath: entry.resultPath })
    }
  }
  pending(): RfqRecoveryView[] {
    return readdirSync(this.directory).filter(name => RFQ_RUN_ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
      .map(name => this.require(name.slice(0, -5)))
      .filter(record => !this.active.has(record.runId) && ['active', 'review'].includes(record.phase))
      .map(record => ({ ...record, processStatus: this.status(record), resultAvailable: Boolean(record.resultPath && this.safeResult(record.runId, record.resultPath)),
        completedGroups: record.completedGroupKeys.length })).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }
  protectedIds(): Set<string> { return new Set(this.pending().map(record => record.runId)) }
  resolve(runId: string, note: string): void {
    const record = this.require(runId)
    if (this.active.has(runId) || this.status(record) === 'alive') throw new Error('The old Hub or RFQ engine may still be running. Stop it safely before marking this run resolved.')
    if (record.storageIssue) throw new Error('Recovery data is unreadable. Preserve it and ask a key user to inspect it; it cannot be silently replaced.')
    if (!['active', 'review'].includes(record.phase)) throw new Error('This run no longer needs review.')
    if (!note.trim() || note.length > 1000) throw new Error('Enter a short SAP verification note.')
    this.write({ ...record, phase: 'resolved', resolvedAt: new Date().toISOString(), resolutionNote: note.trim() })
  }
  result(runId: string): string {
    const record = this.require(runId)
    if (!record.resultPath || !this.safeResult(runId, record.resultPath)) throw new Error('No safe saved result is available. Do not assume SAP changes were not committed.')
    return record.resultPath
  }
  private status(record: RfqRecoveryRecord): 'alive' | 'dead' | 'unknown' {
    if (record.ownerPid && record.ownerPid !== process.pid && this.probe(record.ownerPid) !== 'dead') return 'alive'
    if (record.engineClosed) return 'dead'
    return record.enginePid ? this.probe(record.enginePid) : 'unknown'
  }
  private safeResult(runId: string, path: string): boolean {
    return [this.runsDirectory, ...this.legacyRunsDirectories].some(directory => {
      try {
        const root = resolve(directory, runId, 'output'), target = resolve(path)
        if (dirname(target).toLowerCase() !== root.toLowerCase() || !/\.(xlsx|xlsm)$/i.test(basename(target))) return false
        // Reject symlinks/junction ancestors and arbitrary renderer-provided locations.
        return realpathSync(root).toLowerCase() === root.toLowerCase() && !lstatSync(target).isSymbolicLink()
          && lstatSync(target).isFile() && realpathSync(target).toLowerCase() === target.toLowerCase()
      } catch { return false }
    })
  }
  private path(id: string): string {
    if (!RFQ_RUN_ID.test(id)) throw new Error('Invalid recovery run ID.')
    const path = join(this.directory, id + '.json')
    if (relative(this.directory, path).startsWith('..')) throw new Error('Recovery path is outside the ledger.')
    return path
  }
  private require(id: string): RfqRecoveryRecord { const record = this.read(id); if (!record) throw new Error('This recovery record does not exist.'); return record }
  private read(id: string): RfqRecoveryRecord | null {
    const path = this.path(id)
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Linked recovery ledger')
      const record = JSON.parse(readFileSync(path, 'utf8')) as RfqRecoveryRecord
      if (record.version !== 1 || record.runId !== id || !['active', 'review', 'complete', 'resolved'].includes(record.phase)
        || !Array.isArray(record.completedGroupKeys) || !record.completedGroupKeys.every(key => typeof key === 'string')
        || !Array.isArray(record.projects) || !record.projects.every(p => typeof p === 'string')
        || !Array.isArray(record.rfqNumbers) || !record.rfqNumbers.every(p => typeof p === 'string')
        || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
        || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))
        || !['PROD', 'QA', 'UNKNOWN'].includes(record.environment)
        || record.ownerPid !== undefined && !validPid(record.ownerPid)
        || record.enginePid !== undefined && !validPid(record.enginePid)
        || ['groupKey', 'project', 'plant', 'supplier', 'lastConfirmedCheckpoint', 'checkpointGroup', 'resultPath', 'terminal', 'resolvedAt', 'resolutionNote'].some(key => {
          const value = (record as unknown as Record<string, unknown>)[key]
          return value !== undefined && typeof value !== 'string'
        })
        || record.materials !== undefined && (!Array.isArray(record.materials) || !record.materials.every(p => typeof p === 'string'))
        || record.uncertainGroupKeys !== undefined && (!Array.isArray(record.uncertainGroupKeys) || !record.uncertainGroupKeys.every(p => typeof p === 'string'))
        || typeof record.engineClosed !== 'boolean' || !(record.totalGroups === null || validCount(record.totalGroups))) throw new Error('Invalid ledger')
      return record
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      // Corrupt evidence is not absence of a run. Fail closed, preserve the original.
      return { version: 1, runId: id, startedAt: '', updatedAt: '', environment: 'UNKNOWN', engineClosed: false, phase: 'review',
        projects: [], totalGroups: null, completedGroupKeys: [], rfqNumbers: [], storageIssue: true }
    }
  }
  private write(record: RfqRecoveryRecord): void {
    if (record.storageIssue) throw new Error('Recovery data is unreadable; preserve the original ledger for key-user review.')
    const path = this.path(record.runId), temp = path + '.' + randomUUID() + '.tmp'
    const fd = openSync(temp, 'wx')
    try { writeFileSync(fd, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    // Windows scanners may briefly hold the target without sharing delete access.
    // Retry the same atomic replacement; never unlink/truncate the old evidence.
    const delays = [15, 40, 80]
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temp, path); break }
      catch (error) {
        if (attempt >= delays.length || !error || typeof error !== 'object' || !('code' in error)
          || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[attempt])
      }
    }
  }
}
function validCount(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100000 }
function validPid(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647 }
function processStatus(pid: number): 'alive' | 'dead' | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown'
  try { process.kill(pid, 0); return 'alive' }
  catch (error) { return error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH' ? 'dead' : 'unknown' }
}
