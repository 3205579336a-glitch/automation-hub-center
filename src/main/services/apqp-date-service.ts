import { randomUUID } from 'node:crypto'
import type { ApqpDateCache } from './apqp-date-cache'
import type { ApqpRunner } from '../automation/apqp-runner'
import type { GuidanceContext } from '../automation/native-interaction-bridge'
import type { ApqpProgress } from '../../shared/apqp-types'
import { APQP_DATE_CAPABILITIES, APQP_DATE_KEYS, APQP_DATE_SCHEMA, isApqpDates, isApqpSdComments, type ApqpDateError,
  type ApqpDateExecuteRequest, type ApqpDateExecuteResult, type ApqpDatePreview, type ApqpDatePreviewRequest,
  type ApqpDatePreviewResult, type ApqpDateQuery, type ApqpDateQueryResult, type ApqpDateSnapshot,
  type ApqpNativeDateData, type ApqpDateRecord } from '../../shared/apqp-date-types'

interface StoredSnapshot { snapshot: ApqpDateSnapshot; session: ApqpNativeDateData['session']; expires: number }
const HOUR = 3_600_000
const rejected = (message: string, messageZh: string, errorCode: string): ApqpDateError => ({ success: false, message, messageZh, errorCode })

/** Trusted originals and previews stay in main, never come back from editable UI inputs. */
export class ApqpDateService {
  private snapshots = new Map<string, StoredSnapshot>()
  private previews = new Map<string, ApqpDatePreview>()
  constructor(private readonly runner: ApqpRunner, private readonly now: () => number = Date.now,
    private readonly cache?: Pick<ApqpDateCache, 'load'>) {}
  capabilities(): typeof APQP_DATE_CAPABILITIES { return { ...APQP_DATE_CAPABILITIES } }

  async loadCached(query: ApqpDateQuery): Promise<ApqpDateQueryResult> {
    this.prune()
    if (query.environment !== 'PROD') return rejected('APQP date management uses SAP 949.', 'APQP 日期管理固定使用 SAP 949。', 'APQP_DATE_PRODUCTION_ONLY')
    const cached = await this.cache?.load(query)
    if (!cached || cached.fieldSchema !== APQP_DATE_SCHEMA || cached.snapshot.environment !== query.environment || cached.snapshot.project !== query.project
      || cached.snapshot.userId.toUpperCase() !== query.userId.toUpperCase()
      || !Number.isFinite(Date.parse(cached.snapshot.createdAt)) || !validRecords(cached.snapshot.records) || !validSession(cached.session)
      || cached.session.system !== (query.environment === 'PROD' ? 'VCE' : 'CEQ') || cached.session.client !== '100'
      || cached.snapshot.records.some(row => !['C100', '0000'].includes(row.plant) || row.project !== query.project)) {
      return rejected('No reusable local result was found. Read from SAP first.', '暂无可复用的本地结果，请先从 SAP 读取。', 'APQP_DATE_CACHE_MISSING')
    }
    const snapshot = structuredClone(cached.snapshot)
    snapshot.id = randomUUID() // An old execution token is never revived.
    snapshot.cached = true
    this.snapshots.set(snapshot.id, { snapshot, session: structuredClone(cached.session), expires: this.now() + HOUR })
    // Execution still checks the original session, live list/target identity and
    // current target dates. Cached values never remove conflict/permission gates.
    return { success: true, snapshot: structuredClone(snapshot) }
  }

  async query(query: ApqpDateQuery, report: (event: ApqpProgress) => void, context: GuidanceContext): Promise<ApqpDateQueryResult> {
    this.prune()
    if (query.environment !== 'PROD') return rejected('APQP date management uses SAP 949.', 'APQP 日期管理固定使用 SAP 949。', 'APQP_DATE_PRODUCTION_ONLY')
    const result = await this.runner.dates({ action: 'query', query }, report, context)
    if (!result.success) return result
    if (!result.data || result.data.fieldSchema !== APQP_DATE_SCHEMA || !validRecords(result.data.records) || !validSession(result.data.session)
      || result.data.session.system !== (query.environment === 'PROD' ? 'VCE' : 'CEQ') || result.data.session.client !== '100') {
      return rejected('The native date snapshot is incomplete. Query again.', '原生日期快照不完整，请重新查询。', 'APQP_DATE_INVALID_SNAPSHOT')
    }
    if (result.data.records.some(row => !['C100', '0000'].includes(row.plant) || row.project !== query.project)) {
      return rejected('The returned records do not match the query.', '返回记录与查询条件不一致。', 'APQP_DATE_INVALID_SNAPSHOT')
    }
    const snapshot: ApqpDateSnapshot = { ...query, id: context.runId, createdAt: new Date(this.now()).toISOString(),
      records: structuredClone(result.data.records), resultPath: result.resultPath }
    this.snapshots.set(snapshot.id, { snapshot, session: structuredClone(result.data.session), expires: this.now() + HOUR })
    return { success: true, snapshot: structuredClone(snapshot) }
  }

  async preview(input: ApqpDatePreviewRequest, report: (event: ApqpProgress) => void, context: GuidanceContext): Promise<ApqpDatePreviewResult> {
    this.prune()
    const original = this.snapshots.get(input.snapshotId)
    if (!original) return rejected('The query snapshot expired. Find APQPs again.', '查询快照已过期，请重新查找 APQP。', 'APQP_DATE_SNAPSHOT_EXPIRED')
    const expected = new Map(original.snapshot.records.map(row => [row.apqp, row]))
    if (input.edits.length !== expected.size || input.edits.some(edit => !expected.has(edit.apqp))) {
      return rejected('The edited APQP list differs from the original. Query again.', '修改清单与原查询不同，请重新查询。', 'APQP_DATE_IDENTITY_MISMATCH')
    }
    // All prior plans for this snapshot become stale before a new SAP check starts.
    for (const [id, plan] of this.previews) if (plan.snapshotId === input.snapshotId) this.previews.delete(id)
    const { project, userId, environment } = original.snapshot
    const result = await this.runner.dates({ action: 'preview', query: { project, userId, environment },
      originals: original.snapshot.records, edits: input.edits, session: original.session }, report, context)
    if (!result.success) return result
    const native = result.data.preview
    if (!native || ![native.total, native.changedRecords, native.changedFields, native.unchanged, native.conflicts, native.invalid].every(value => Number.isInteger(value) && value >= 0)
      || native.total !== expected.size || native.changedRecords + native.unchanged + native.conflicts + native.invalid !== native.total
      || !Array.isArray(native.changes) || native.changes.length !== native.changedFields
      || native.changes.some(change => !expected.has(change.apqp) || !APQP_DATE_KEYS.includes(change.field)) || !Array.isArray(native.issues)) {
      return rejected('The SAP comparison did not return a complete preview.', 'SAP 比较未返回完整预览。', 'APQP_DATE_INVALID_PREVIEW')
    }
    const preview: ApqpDatePreview = { ...native, id: randomUUID(), snapshotId: input.snapshotId,
      expiresAt: new Date(Math.min(original.expires, this.now() + 10 * 60_000)).toISOString() }
    this.previews.set(preview.id, structuredClone(preview))
    return { success: true, preview: structuredClone(preview), resultPath: result.resultPath }
  }

  /** No second preview click. Native re-reads/compares immediately before each Save. */
  async execute(input: ApqpDateExecuteRequest, report: (event: ApqpProgress) => void, context: GuidanceContext): Promise<ApqpDateExecuteResult> {
    this.prune()
    const original = this.snapshots.get(input.snapshotId)
    if (!original) {
      return rejected('The query expired. Find APQPs again.', '查询已过期，请重新查找 APQP。', 'APQP_DATE_SNAPSHOT_EXPIRED')
    }
    const expected = new Map(original.snapshot.records.map(row => [row.apqp, row]))
    if (input.edits.length !== expected.size || new Set(input.edits.map(row => row.apqp)).size !== expected.size
      || input.edits.some(row => !expected.has(row.apqp) || !isApqpDates(row.dates)
        || row.sdComments !== undefined && !isApqpSdComments(row.sdComments))) {
      return rejected('The edited list differs from the original query.', '修改清单与原查询不一致，请重新查询。', 'APQP_DATE_IDENTITY_MISMATCH')
    }
    const invalidComments = (row: typeof input.edits[number]): boolean => Object.values(row.sdComments ?? {}).some(text => Boolean(text.trim()))
    const clearsDate = (row: typeof input.edits[number]): boolean => APQP_DATE_KEYS.some(key => row.dates[key] === null && expected.get(row.apqp)!.dates[key] !== null)
    const changed = input.edits.filter(row => APQP_DATE_KEYS.some(key => row.dates[key] !== expected.get(row.apqp)!.dates[key]) || Object.values(row.sdComments ?? {}).some(text => text.trim()))
    const allInvalid = changed.length > 0 && changed.every(row => invalidComments(row) || clearsDate(row))
    if (input.edits.some(invalidComments)) {
      return rejected('Planned-date maintenance does not edit SD Comment or SD conf.',
        '计划日期维护不修改 SD Comment 或 SD conf。', 'APQP_DATE_VALIDATION_FAILED')
    }
    const changedById = new Map(changed.map(row => [row.apqp, row]))
    if (changed.some(clearsDate) && allInvalid) {
      return rejected('Populated dates cannot be cleared. Restore the date before updating.', '已有日期不能清空，请恢复误删日期后再修改。', 'APQP_DATE_VALIDATION_FAILED')
    }
    if (!changed.length) return rejected('No edited dates to update.', '没有待修改的日期。', 'APQP_DATE_NO_CHANGES')
    // Capabilities originate in main, never in editable renderer request flags.
    const gate = this.capabilities()
    if (original.snapshot.environment === 'PROD' && (!gate.writesEnabled || !gate.productionWritesEnabled)) {
      return rejected('Production date updates are disabled by the application policy.', '应用策略尚未开放正式系统日期写入。', 'APQP_DATE_PRODUCTION_LOCKED')
    }
    if (original.snapshot.environment === 'QA' && (!gate.writesEnabled || !gate.qaWritesEnabled)) {
      return rejected('QA date updates remain disabled until controlled Save/re-read acceptance is complete.',
        'QA 日期写入仍未开放，请先完成受控保存及复读验收。', 'APQP_DATE_WRITE_NOT_VALIDATED')
    }
    for (const [id, plan] of this.previews) if (plan.snapshotId === input.snapshotId) this.previews.delete(id)
    const { project, userId, environment } = original.snapshot
    const result = await this.runner.dates({ action: 'execute', query: { project, userId, environment },
      originals: original.snapshot.records, edits: input.edits, session: original.session }, report, context)
    if (!result.success) {
      const uncertain = result.writeMayHaveOccurred || ['APQP_DATE_ENGINE_FAILED', 'APQP_DATE_ENGINE_UNAVAILABLE'].includes(result.errorCode ?? '')
      if (uncertain) this.snapshots.delete(input.snapshotId)
      return uncertain ? { ...result, writeMayHaveOccurred: true } : result
    }
    const update = result.data?.update
    const completed = result.data?.records
    const stageOnly = gate.stageOnly === true
    const staged = update?.staged ?? 0
    const failed = update?.failed ?? 0, issues = update?.issues ?? []
    const fieldsSaved = (row: ApqpDateRecord): number => (row as ApqpDateRecord & { changedFieldsSaved?: number }).changedFieldsSaved ?? 0
    const issueCodes = ['APQP_DATE_CONFLICT', 'APQP_DATE_VALIDATION_FAILED', 'APQP_DATE_READ_ONLY', 'APQP_SD_READ_ONLY', 'APQP_RECORD_WARNING', 'APQP_RECORD_ERROR']
    if (!update || result.data.fieldSchema !== APQP_DATE_SCHEMA || !validRecords(completed) || !validSession(result.data.session)
      || (Object.keys(original.session) as (keyof typeof original.session)[]).some(key => result.data.session[key] !== original.session[key])
      || ![update.total, update.processed, update.succeeded, update.skipped].every(value => Number.isInteger(value) && value >= 0)
      || !Number.isInteger(staged) || staged < 0 || stageOnly !== (update.stageOnly === true)
      || !Number.isInteger(failed) || failed < 0 || !Array.isArray(issues) || issues.length !== failed
      || issues.some(item => !item || !changedById.has(item.apqp) || !issueCodes.includes(item.code)
        || !['NOT_OPENED', 'RETURNED_UNCHANGED'].includes(item.navigation)
        || item.navigation === 'NOT_OPENED' && item.code !== 'APQP_DATE_VALIDATION_FAILED'
        || typeof item.message !== 'string' || typeof item.messageZh !== 'string'
        || ['material', 'vendor'].some(key => item[key as 'material' | 'vendor'] !== expected.get(item.apqp)![key as 'material' | 'vendor']))
      || new Set([...completed.map(row => row.apqp), ...issues.map(item => item.apqp)]).size !== completed.length + failed
      || stageOnly && (update.succeeded !== 0 || staged > 1)
      || stageOnly && completed.some(row => (row as ApqpDateRecord & { saved?: boolean }).saved === true)
      || stageOnly && completed.some(row => 'inputStatus' in row)
        && completed.filter(row => (row as ApqpDateRecord & { inputStatus?: string }).inputStatus === 'STAGED').length !== staged
      || !stageOnly && staged !== 0
      || !stageOnly && (completed.filter(row => (row as ApqpDateRecord & { inputStatus?: string }).inputStatus === 'VERIFIED' && (row as ApqpDateRecord & { saved?: boolean }).saved === true).length !== update.succeeded
        || completed.filter(row => (row as ApqpDateRecord & { inputStatus?: string }).inputStatus === 'UNCHANGED').length !== update.skipped)
      || !Number.isInteger(update.savedFields) || update.savedFields! < 0 || update.savedFields !== completed.reduce((sum, row) => sum + fieldsSaved(row), 0)
      || completed.some(row => !Number.isInteger(fieldsSaved(row)) || fieldsSaved(row) < 0
        || fieldsSaved(row) > APQP_DATE_KEYS.filter(key => changedById.get(row.apqp)?.dates[key] !== expected.get(row.apqp)?.dates[key]).length
        || (row as ApqpDateRecord & { saved?: boolean }).saved !== true && fieldsSaved(row) !== 0
        || (row as ApqpDateRecord & { saved?: boolean }).saved === true && fieldsSaved(row) < 1)
      || update.total !== changed.length || update.processed !== completed.length + failed || update.succeeded + update.skipped + staged + failed !== update.processed
      || update.processed > update.total || typeof update.cancelled !== 'boolean'
      || !stageOnly && !update.cancelled && update.processed !== update.total
      || completed.some(row => !changedById.has(row.apqp)
        || APQP_DATE_KEYS.some(key => changedById.get(row.apqp)!.dates[key] !== expected.get(row.apqp)!.dates[key]
          && row.dates[key] !== changedById.get(row.apqp)!.dates[key])
        || ['material', 'vendor', 'plant', 'project'].some(key => row[key as keyof ApqpDateRecord] !== expected.get(row.apqp)![key as keyof ApqpDateRecord]))) {
      this.snapshots.delete(input.snapshotId)
      return { ...rejected('The update outcome could not be verified. Review the result before retrying.', '无法核实修改结果，请查看结果，不要直接重试。', 'APQP_DATE_UPDATE_UNCERTAIN'), writeMayHaveOccurred: true, logPath: result.resultPath }
    }
    if (stageOnly) {
      // Staged edit-buffer values are NOT persisted SAP data. Invalidate this
      // source for execution; leave its unchanged values for honest UI display.
      if (staged) this.snapshots.delete(input.snapshotId)
      update.stagedApqp = staged ? completed.find(row => (row as ApqpDateRecord & { inputStatus?: string }).inputStatus === 'STAGED')?.apqp ?? completed.at(-1)?.apqp : undefined
      return { success: true, snapshot: structuredClone(original.snapshot), update, resultPath: result.resultPath }
    }
    const done = new Map(completed.map(row => [row.apqp, row]))
    original.snapshot.records = original.snapshot.records.map(row => structuredClone(done.get(row.apqp) ?? row))
    return { success: true, snapshot: structuredClone(original.snapshot), update, resultPath: result.resultPath }
  }

  private prune(): void {
    for (const [id, item] of this.snapshots) if (item.expires <= this.now()) this.snapshots.delete(id)
    for (const [id, item] of this.previews) if (Date.parse(item.expiresAt) <= this.now() || !this.snapshots.has(item.snapshotId)) this.previews.delete(id)
    while (this.snapshots.size > 10) this.snapshots.delete(this.snapshots.keys().next().value!)
  }
}

function validRecords(rows: unknown): rows is ApqpDateRecord[] {
  return Array.isArray(rows) && rows.length <= 10000 && rows.every(row => row && row.readable === true && isApqpDates(row.dates)
    && row.editable && Object.keys(row.editable).length === APQP_DATE_KEYS.length && APQP_DATE_KEYS.every(key => typeof row.editable[key] === 'boolean')
    && ['apqp', 'material', 'vendor', 'plant', 'project'].every(key => typeof row[key] === 'string' && row[key].length <= 100)
    && /^[A-Za-z0-9_-]{1,40}$/.test(row.apqp)) && new Set(rows.map(row => row.apqp)).size === rows.length
}
function validSession(value: ApqpNativeDateData['session']): boolean {
  return !!value && ['sessionId', 'system', 'client', 'sapUser'].every(key => typeof value[key as keyof typeof value] === 'string' && value[key as keyof typeof value].length > 0)
}
