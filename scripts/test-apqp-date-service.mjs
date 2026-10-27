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
const dates = { fPlanDate: null, gPlanDate: '2026-10-20', hPlanDate: '2026-12-25', mPlanDate: null }
const editable = Object.fromEntries(types.APQP_DATE_KEYS.map(key => [key, true]))
const record = { apqp: '2000000000', material: '10000000', vendor: '0041889', plant: 'C100', project: '775773', dates, editable, readable: true }
const session = { sessionId: '/app/con[0]/ses[0]', system: 'VCE', client: '100', sapUser: 'MOCK_SAP_LOGIN' }
const context = () => ({ service: {}, runId: randomUUID() })
const quiet = () => undefined
const changed = () => [{ apqp: record.apqp, dates: { ...dates, mPlanDate: '2026-12-30' } }]
const readData = () => ({ records: [structuredClone(record)], fieldSchema: types.APQP_DATE_SCHEMA, stageOnly: false, session })

function mockService(response, clock = Date.now) {
  const calls = []
  const service = new ApqpDateService({ dates: async input => {
    calls.push(structuredClone(input))
    return input.action === 'query'
      ? { success: true, data: readData(), resultPath: 'owned/read.json' }
      : typeof response === 'function' ? response(input) : structuredClone(response)
  } }, clock)
  return { service, calls }
}

test('planned-only payloads reject old actual fields, overrides, duplicate identities and invalid dates', () => {
  assert.deepEqual(types.APQP_DATE_KEYS, ['fPlanDate', 'gPlanDate', 'hPlanDate', 'mPlanDate'])
  assert(types.isApqpDateQuery(query))
  assert.equal(types.isIsoApqpDate('2026-02-30'), false)
  const request = { snapshotId: randomUUID(), confirmed: true, edits: changed() }
  assert(types.isApqpDateExecuteRequest(request))
  for (const extra of [{ writesEnabled: true }, { stageOnly: false }, { sessionId: '/other' }]) {
    assert.equal(types.isApqpDateExecuteRequest({ ...request, ...extra }), false)
  }
  assert.equal(types.isApqpDates({ ...dates, gActualDate: '2026-10-27' }), false)
  assert.equal(types.isApqpDates({ gPlanDate: null, gActualDate: null, hPlanDate: null, hActualDate: null }), false)
  assert.equal(types.isApqpDateExecuteRequest({ ...request, edits: [...changed(), ...changed()] }), false)
})

test('only production 949 is available for APQP date management', async () => {
  const { service } = mockService()
  assert.equal(service.capabilities().stageOnly, false)
  assert(service.capabilities().productionWritesEnabled)
  assert.equal(service.capabilities().qaWritesEnabled, false)
  assert.equal((await service.query({ ...query, environment: 'QA' }, quiet, context())).errorCode, 'APQP_DATE_PRODUCTION_ONLY')
  service.capabilities().productionWritesEnabled = false
  assert(service.capabilities().productionWritesEnabled)
})

test('old engines, missing permission evidence and old schemas are not editable snapshots', async () => {
  for (const mutate of [data => delete data.fieldSchema, data => { data.fieldSchema = 'OLD_GH_ACTUAL' },
    data => delete data.records[0].editable, data => { data.records[0].editable.mPlanDate = 'true' }]) {
    const data = readData(); mutate(data)
    const service = new ApqpDateService({ dates: async () => ({ success: true, data, resultPath: 'owned/old.json' }) })
    assert.equal((await service.query(query, quiet, context())).errorCode, 'APQP_DATE_INVALID_SNAPSHOT')
  }
})

test('main-owned originals cannot be forged, and expired/uncertain tokens cannot be retried', async () => {
  let now = Date.now()
  const { service, calls } = mockService({ success: false, errorCode: 'APQP_DATE_ENGINE_FAILED', message: 'Process ended' }, () => now)
  const found = await service.query(query, quiet, context())
  found.snapshot.records[0].dates.gPlanDate = '2099-01-01'
  const input = { snapshotId: found.snapshot.id, confirmed: true, edits: changed() }
  assert.equal((await service.execute(input, quiet, context())).writeMayHaveOccurred, true)
  assert.equal(calls[1].originals[0].dates.gPlanDate, '2026-10-20')
  assert.equal((await service.execute(input, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
  const again = await service.query(query, quiet, context()); now += 3_600_001
  assert.equal((await service.execute({ ...input, snapshotId: again.snapshot.id }, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
})

test('all-invalid clears, comments and missing identities fail before calling SAP', async () => {
  const { service, calls } = mockService()
  const found = await service.query(query, quiet, context())
  for (const edits of [[{ apqp: record.apqp, dates: { ...dates, gPlanDate: null } }],
    [{ apqp: record.apqp, dates, sdComments: { g: 'Obsolete' } }], []]) {
    assert.equal((await service.execute({ snapshotId: found.snapshot.id, edits, confirmed: true }, quiet, context())).success, false)
  }
  assert.equal(calls.length, 1)
})

test('native summary must prove saved counts/identity/schema; unverifiable results lock the token', async () => {
  const desired = changed()[0].dates
  const baseline = { records: [{ ...structuredClone(record), dates: desired, saved: true, inputStatus: 'VERIFIED', changedFieldsSaved: 1 }],
    session, fieldSchema: types.APQP_DATE_SCHEMA, update: { total: 1, processed: 1, succeeded: 1, skipped: 0, failed: 0,
      issues: [], staged: 0, stageOnly: false, savedFields: 1, cancelled: false } }
  for (const mutate of [data => { data.fieldSchema = 'OLD' }, data => { data.records[0].vendor = 'OTHER' },
    data => { data.update.stageOnly = true }, data => { data.update.processed = 2 },
    data => { data.records[0].dates.mPlanDate = null }, data => { data.update.savedFields = 4 },
    data => { data.records[0].changedFieldsSaved = 4; data.update.savedFields = 4 }]) {
    const data = structuredClone(baseline); mutate(data)
    const { service } = mockService({ success: true, data, resultPath: 'owned/update.json' })
    const found = await service.query(query, quiet, context())
    const input = { snapshotId: found.snapshot.id, confirmed: true, edits: changed() }
    assert.equal((await service.execute(input, quiet, context())).errorCode, 'APQP_DATE_UPDATE_UNCERTAIN')
    assert.equal((await service.execute(input, quiet, context())).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
  }
})

test('real protocol saves and reopens every edited record, with a grey F date exposed to Hub', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apqp-planned-service-'))
  const runner = new ApqpRunner({ executable: 'not-used', script: resolve('scripts/fixtures/apqp-dates-fake-engine.py'), preferScript: true }, new GeneratedArtifacts(root))
  const service = new ApqpDateService(runner)
  const pending = service.query(query, quiet, context())
  assert.equal((await runner.dates({ action: 'query', query }, quiet, context())).success, false, 'One native process lock')
  const found = await pending
  assert(found.success, found.message)
  assert.equal(found.snapshot.records[0].editable.fPlanDate, false)
  assert.equal(found.snapshot.records[0].editable.mPlanDate, true)
  const edits = found.snapshot.records.map((row,index) => ({ apqp: row.apqp, dates: { ...row.dates, ...(index < 3 ? { mPlanDate: '2026-12-30' } : {}) } }))
  const result = await service.execute({ snapshotId: found.snapshot.id, edits, confirmed: true }, quiet, context())
  assert(result.success, result.message)
  assert.equal(result.update.succeeded, 3)
  assert.equal(result.update.savedFields, 3)
  assert.equal(result.update.staged, 0)
  assert.equal(result.update.stageOnly, false)
  assert.equal(result.snapshot.records[0].dates.mPlanDate, '2026-12-30')
  const audit = JSON.parse(await readFile(result.resultPath, 'utf8'))
  assert.equal(audit.fieldSchema, types.APQP_DATE_SCHEMA)
  assert.equal(audit.writeEvents.filter(e => e.event === 'SAVE_DISPATCHED').length, 3)
  assert.equal(audit.writeEvents.filter(e => e.event === 'UPDATE_VERIFIED').length, 3)
  assert(!audit.writeEvents.some(e => e.event.startsWith('SD_')))
  const again = await service.execute({ snapshotId: result.snapshot.id, edits, confirmed: true }, quiet, context())
  assert.equal(again.errorCode, 'APQP_DATE_NO_CHANGES')
})

test('fresh readonly failures skip and preserve the row; other planned updates are saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apqp-planned-skip-'))
  const service = new ApqpDateService(new ApqpRunner({ executable: 'unused', script: resolve('scripts/fixtures/apqp-dates-fake-engine.py'), preferScript: true }, new GeneratedArtifacts(root)))
  for (const userId of ['PREINPUT_ERRORS', 'ALL_READONLY']) {
    const found = await service.query({ ...query, userId }, quiet, context())
    assert(found.success, found.message)
    const edits = found.snapshot.records.map((row,index) => ({ apqp: row.apqp, dates: { ...row.dates, ...(index < 3 ? { fPlanDate: '2026-10-27' } : {}) } }))
    const result = await service.execute({ snapshotId: found.snapshot.id, edits, confirmed: true }, quiet, context())
    assert(result.success, result.message)
    assert.equal(result.update.succeeded, userId === 'ALL_READONLY' ? 0 : 2)
    assert.equal(result.update.failed, userId === 'ALL_READONLY' ? 3 : 1)
    assert.equal(result.update.issues[0].code, 'APQP_DATE_READ_ONLY')
    assert.equal(result.snapshot.records[0].dates.fPlanDate, null)
  }
})

test('mismatched query details and accepted cross-plant 0000 keep their exact identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apqp-planned-filters-'))
  const service = new ApqpDateService(new ApqpRunner({ executable: 'unused', script: resolve('scripts/fixtures/apqp-dates-fake-engine.py'), preferScript: true }, new GeneratedArtifacts(root)))
  const rejected = await service.query({ ...query, userId: 'MISMATCH' }, quiet, context())
  assert.equal(rejected.errorCode, 'SAP_QUERY_FILTER_MISMATCH')
  assert.equal(rejected.comparison.mismatchRows, 25)
  const shared = await service.query({ ...query, userId: 'SHARED' }, quiet, context())
  assert(shared.success, shared.message)
  assert(shared.snapshot.records.every(row => row.plant === '0000'))
})
