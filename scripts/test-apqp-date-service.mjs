/* global structuredClone */
// Main-process API contracts and real child-process protocol, always with fake SAP.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url), cache = new Map()
function load(path) {
  const file = resolve(path)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name), module, module.exports)
  return module.exports
}
const types = load('src/shared/apqp-date-types.ts')
const { ApqpDateService } = load('src/main/services/apqp-date-service.ts')
const { ApqpRunner } = load('src/main/automation/apqp-runner.ts')
const { GeneratedArtifacts } = load('src/main/services/generated-artifacts.ts')
const query = { project: '775773', userId: 'EE00221', environment: 'PROD' }
const dates = { gPlanDate: '2026-10-20', gActualDate: null, hPlanDate: '2026-12-25', hActualDate: null }
const record = { apqp: '2000000000', material: '10000000', vendor: '0041889', plant: 'C100', project: '775773', dates, readable: true }
const session = { sessionId: '/app/con[0]/ses[0]', system: 'VCE', client: '100', sapUser: 'MOCK_SAP_LOGIN' }
const context = () => ({ service: {}, runId: randomUUID() })
const quiet = () => undefined

test('strict renderer payloads reject overrides, paths, duplicate identities and rolled-over dates', () => {
  assert(types.isApqpDateQuery(query))
  for (const input of [{ ...query, writesEnabled: true }, { ...query, project: '../../file' }, { ...query, environment: 'OTHER' }]) assert.equal(types.isApqpDateQuery(input), false)
  assert.equal(types.isIsoApqpDate('2026-02-30'), false)
  const request = { snapshotId: randomUUID(), edits: [{ apqp: record.apqp, dates }] }
  assert(types.isApqpDatePreviewRequest(request))
  assert.equal(types.isApqpDatePreviewRequest({ ...request, originals: [record] }), false)
  assert.equal(types.isApqpDatePreviewRequest({ ...request, edits: [...request.edits, ...request.edits] }), false)
  assert.equal(types.isApqpDateExecuteRequest({ previewId: randomUUID(), confirmed: true, writesEnabled: true }), false)
  assert(types.isApqpDateExecuteRequest({ ...request, confirmed: true }))
  assert(types.isApqpDateExecuteRequest({ ...request, edits: [{ ...request.edits[0], sdComments: { g: 'AAA', h: '' } }], confirmed: true }))
  for (const sdComments of [{ other: 'invalid' }, { g: 1 }, { g: 'x'.repeat(256) }, { g: 'line\nbreak' }, null]) {
    assert.equal(types.isApqpDateExecuteRequest({ ...request, edits: [{ ...request.edits[0], sdComments }], confirmed: true }), false)
  }
  assert.equal(types.isApqpDateExecuteRequest({ ...request, confirmed: true, writesEnabled: true }), false)
  assert.equal(types.isApqpDateExecuteRequest({ ...request, confirmed: true, stageOnly: false }), false)
})

function mockService(clock = () => Date.now()) {
  const calls = []
  const runner = { dates: async input => {
    calls.push(structuredClone(input))
    return input.action === 'query'
      ? { success: true, data: { records: [structuredClone(record)], stageOnly: true, session: { ...session, system: input.query.environment === 'QA' ? 'CEQ' : 'VCE' } }, resultPath: 'owned/result.json' }
      : { success: true, data: { records: [], session, preview: { total: 1, changedRecords: 1, changedFields: 1, unchanged: 0, conflicts: 0, invalid: 0,
        changes: [{ apqp: record.apqp, field: 'gActualDate', current: null, desired: '2026-11-01' }], issues: [] } }, resultPath: 'owned/preview.json' }
  } }
  return { service: new ApqpDateService(runner, clock), calls }
}

test('trusted main snapshot cannot be altered through query result or desired edits', async () => {
  const { service, calls } = mockService()
  const found = await service.query(query, quiet, context()); assert(found.success)
  found.snapshot.records[0].dates.gPlanDate = '2099-01-01'
  const edits = [{ apqp: record.apqp, dates: { ...dates, gActualDate: '2026-11-01' } }]
  const result = await service.preview({ snapshotId: found.snapshot.id, edits }, quiet, context()); assert(result.success)
  assert.equal(calls[1].originals[0].dates.gPlanDate, '2026-10-20')
  assert.equal(calls[1].session.client, '100')
  const policy = service.capabilities()
  service.capabilities = () => ({ ...policy, productionWritesEnabled: false })
  const denied = await service.execute({ snapshotId: found.snapshot.id, edits, confirmed: true }, quiet, context())
  assert.equal(denied.errorCode, 'APQP_DATE_PRODUCTION_LOCKED')
  assert.equal(calls.length, 2, 'Execute gate must not start a native process')
  service.capabilities().productionWritesEnabled = true
  assert.equal(service.capabilities().productionWritesEnabled, false)
})

test('missing, expired and superseded snapshots/previews fail closed', async () => {
  let now = Date.now()
  const { service } = mockService(() => now)
  assert.equal((await service.preview({ snapshotId: randomUUID(), edits: [] }, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
  const found = await service.query(query, quiet, context())
  const input = { snapshotId: found.snapshot.id, edits: [{ apqp: record.apqp, dates: { ...dates, gActualDate: '2026-11-01' } }] }
  const first = await service.preview(input, quiet, context())
  await service.preview(input, quiet, context())
  assert.notEqual(first.preview.id, (await service.preview(input, quiet, context())).preview.id)
  now += 3_600_001
  assert.equal((await service.preview(input, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
  assert.equal((await service.execute({ ...input, confirmed: true }, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
})

test('real runner launches actual native API with fake SAP; owned files, conflict-free preview and Stop exclusion', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'apqp-date-service-'))
  const runner = new ApqpRunner({ executable: 'not-used', script: resolve('scripts/fixtures/apqp-dates-fake-engine.py'), preferScript: true }, new GeneratedArtifacts(folder))
  const service = new ApqpDateService(runner)
  const pending = service.query(query, quiet, context())
  const overlap = await runner.dates({ action: 'query', query }, quiet, context())
  assert.equal(overlap.success, false, 'Same APQP process lock covers both workflows')
  const found = await pending; assert(found.success, found.message)
  assert.equal(found.snapshot.records.length, 25)
  const audit = JSON.parse(await readFile(found.snapshot.resultPath, 'utf8'))
  assert.equal(audit.writesEnabled, false)
  assert.equal(audit.readOnly, true)
  assert.equal(audit.records.length, 25)
  const edits = found.snapshot.records.map(row => ({ apqp: row.apqp, dates: { ...row.dates } }))
  edits[0].dates.gActualDate = '2026-11-01'
  const result = await service.preview({ snapshotId: found.snapshot.id, edits }, quiet, context())
  assert(result.success, result.message); assert.equal(result.preview.changedFields, 1)
  const updated = await service.execute({ snapshotId: found.snapshot.id, edits, confirmed: true }, quiet, context())
  assert(updated.success, updated.message)
  assert.equal(updated.update.succeeded, 0)
  assert.equal(updated.update.staged, 1)
  const updateAudit = JSON.parse(await readFile(updated.resultPath, 'utf8'))
  assert.equal(updateAudit.environment, 'PROD')
  assert.equal(updateAudit.session.system, 'VCE')
  assert.equal(updateAudit.writePolicy.productionOwnerAuthorized, true)
  assert.equal(updateAudit.writePolicy.qaSaveAcceptancePassed, false)
  assert.equal(updateAudit.writeEvents.filter(event => event.event === 'SAVE_DISPATCHED').length, 0)
  assert.equal(updateAudit.writeEvents.at(-1).event, 'STAGED_READY_NOT_SAVED')
  const mismatch = await service.query({ ...query, userId: 'MISMATCH' }, quiet, context())
  assert.equal(mismatch.success, false)
  assert.equal(mismatch.errorCode, 'SAP_QUERY_FILTER_MISMATCH')
  assert.equal(mismatch.comparison.mismatchRows, 25)
  assert.equal(mismatch.comparison.rows[0].checks[0].actual, 'C999')
  assert(mismatch.details.includes('WERKS'), 'Technical comparison survives native → runner → service')
  const errorAudit = JSON.parse(await readFile(mismatch.logPath, 'utf8'))
  assert.equal(errorAudit.comparison.rows[0].checks[0].expected, 'C100 / 0000')
  assert.equal(errorAudit.records.length, 0, 'Mismatched queries never open detail')
  const shared = await service.query({ ...query, userId: 'SHARED' }, quiet, context())
  assert(shared.success, shared.message)
  assert(shared.snapshot.records.every(row => row.plant === '0000'), 'Main preserves accepted shared Plant identity')
})

test('single-click update validates desired dates and cannot bypass the unaccepted QA gate', async () => {
  const { service, calls } = mockService()
  const found = await service.query({ ...query, environment: 'QA' }, quiet, context())
  assert(found.success)
  const input = { snapshotId: found.snapshot.id, confirmed: true, edits: [{ apqp: record.apqp, dates: { ...dates, gActualDate: '2026-10-20' } }] }
  assert.equal((await service.execute(input, quiet, context())).errorCode, 'APQP_DATE_WRITE_NOT_VALIDATED')
  assert.equal(calls.length, 1, 'No separate preview and no native writer while QA gate is closed')
  input.edits[0].dates.gPlanDate = null
  assert.equal((await service.execute(input, quiet, context())).errorCode, 'APQP_DATE_VALIDATION_FAILED')
  input.edits[0].dates = { ...dates }
  assert.equal((await service.execute(input, quiet, context())).errorCode, 'APQP_DATE_NO_CHANGES')
})

test('one-click QA test fills only one record and keeps persisted snapshot unchanged', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'apqp-date-update-service-'))
  const runner = new ApqpRunner({ executable: 'not-used', script: resolve('scripts/fixtures/apqp-dates-fake-engine.py'), preferScript: true }, new GeneratedArtifacts(folder))
  const service = new ApqpDateService(runner)
  // QA acceptance is simulated in this fake-SAP test only, not production policy.
  const originalCapabilities = service.capabilities()
  service.capabilities = () => ({ ...originalCapabilities, writesEnabled: true, qaWritesEnabled: true })
  const found = await service.query({ ...query, environment: 'QA' }, quiet, context())
  assert(found.success, found.message)
  const edits = found.snapshot.records.map(row => ({ apqp: row.apqp, dates: { ...row.dates } }))
  edits[0].dates.gActualDate = '2026-10-20'
  edits[0].sdComments = { g: 'AAA' }
  const events = []
  const result = await service.execute({ snapshotId: found.snapshot.id, edits, confirmed: true }, event => events.push(event), context())
  assert(result.success, result.message)
  assert.equal(result.update.succeeded, 0)
  assert.equal(result.update.staged, 1)
  assert.equal(result.update.total, 1)
  assert.equal(result.snapshot.records[0].dates.gActualDate, null, 'Staged values must not replace a saved-data snapshot')
  assert.equal(service.previews.size, 0, 'No preview IDs or separate preview process')
  const audit = JSON.parse(await readFile(result.resultPath, 'utf8'))
  assert.equal(audit.writeEvents.filter(event => event.event === 'SAVE_DISPATCHED').length, 0)
  assert.equal(audit.writeEvents.at(-1).event, 'STAGED_READY_NOT_SAVED')
  assert(audit.writeEvents.some(event => event.event === 'SD_CONFIRM_INPUT_DISPATCHED' && event.group === 'g'))
  assert.equal(audit.writeEvents.filter(event => event.event === 'SAVE_CONFIRMATION_DISPATCHED').length, 0)
  assert.equal(audit.writeEvents.at(-1).sd.g.comment, 'AAA')
  delete edits[0].sdComments // Comments are tied to an actual-date edit, not a separate comment-only workflow.
  assert(events.some(event => event.material === result.snapshot.records[0].material && event.apqp === result.snapshot.records[0].apqp))
  assert.equal((await service.execute({ snapshotId: result.snapshot.id, edits, confirmed: true }, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
})

test('comment-only and planned-date-only comment requests fail before launching SAP', async () => {
  const { service, calls } = mockService()
  const found = await service.query(query, quiet, context())
  for (const changedDates of [{ ...dates }, { ...dates, gPlanDate: '2026-12-01' }]) {
    const denied = await service.execute({ snapshotId: found.snapshot.id, confirmed: true,
      edits: [{ apqp: record.apqp, dates: changedDates, sdComments: { g: 'AAA' } }] }, quiet, context())
    assert.equal(denied.errorCode, 'APQP_DATE_VALIDATION_FAILED')
    assert.equal(calls.length, 1)
  }
})

test('an older engine without confirmed input-only support cannot start a test', async () => {
  let starts = 0
  const service = new ApqpDateService({ dates: async input => {
    starts++
    assert.equal(input.action, 'query', 'Never dispatch execution to an old engine')
    return { success: true, data: { records: [structuredClone(record)], session }, resultPath: 'owned/read.json' }
  } })
  const found = await service.query(query, quiet, context())
  assert(found.success)
  const result = await service.execute({ snapshotId: found.snapshot.id, confirmed: true,
    edits: [{ apqp: record.apqp, dates: { ...dates, gActualDate: '2026-10-22' } }] }, quiet, context())
  assert.equal(result.errorCode, 'APQP_DATE_ENGINE_UPDATE_REQUIRED')
  assert.equal(starts, 1)
})

test('writer process failure invalidates the snapshot; an uncertain Save cannot be blindly retried', async () => {
  let starts = 0
  const runner = { dates: async request => request.action === 'query'
    ? { success: true, data: { records: [structuredClone(record)], stageOnly: true, session: { ...session, system: 'CEQ' } }, resultPath: 'owned/read.json' }
    : (starts++, { success: false, errorCode: 'APQP_DATE_ENGINE_FAILED', message: 'Engine exited without a final result.' }) }
  const service = new ApqpDateService(runner), previous = service.capabilities()
  service.capabilities = () => ({ ...previous, writesEnabled: true, qaWritesEnabled: true })
  const found = await service.query({ ...query, environment: 'QA' }, quiet, context())
  const input = { snapshotId: found.snapshot.id, confirmed: true, edits: [{ apqp: record.apqp, dates: { ...dates, gActualDate: '2026-10-20' } }] }
  const result = await service.execute(input, quiet, context())
  assert.equal(result.writeMayHaveOccurred, true)
  assert.equal((await service.execute(input, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
  assert.equal(starts, 1)
})
