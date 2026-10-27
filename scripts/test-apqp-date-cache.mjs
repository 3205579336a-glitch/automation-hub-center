import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url), modules = new Map()
function load(path) {
  const file = resolve(path)
  if (modules.has(file)) return modules.get(file).exports
  const module = { exports: {} }; modules.set(file, module)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name), module, module.exports)
  return module.exports
}
const { ApqpDateCache } = load('src/main/services/apqp-date-cache.ts')
const { APQP_DATE_SCHEMA, APQP_DATE_KEYS } = load('src/shared/apqp-date-types.ts')
const { ApqpDateService } = load('src/main/services/apqp-date-service.ts')
const { GeneratedArtifacts } = load('src/main/services/generated-artifacts.ts')
const query = { project: '775773', userId: 'EE00221', environment: 'PROD' }
const row = { apqp: '2000360151', material: '11103132', vendor: '46312', plant: 'C100', project: query.project,
  readable: true, editable: Object.fromEntries(APQP_DATE_KEYS.map(key => [key, true])), dates: { gPlanDate: '2026-10-15', fPlanDate: null, hPlanDate: '2026-10-15', mPlanDate: null } }
const session = { sessionId: '/app/con[0]/ses[0]', system: 'VCE', client: '100', sapUser: 'FAKE_USER' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'apqp-date-cache-')), artifacts = new GeneratedArtifacts(root), entries = []
  const history = { getEntries: async () => entries }, cache = new ApqpDateCache(root, history)
  async function record(action, result, inputQuery = query) {
    const id = randomUUID(), directory = await artifacts.create('apqp-date-management', id)
    await writeFile(join(directory, 'apqp-date-request.json'), JSON.stringify({ action, query: inputQuery }))
    await writeFile(join(directory, 'apqp-dates-result.json'), JSON.stringify(result))
    await artifacts.finish(directory)
    const entry = { id, diagnosticRunId: id, operation: 'apqp-date-management', apqpDateAction: action === 'query' ? 'query' : 'update',
      status: action === 'query' ? 'Success' : 'Partial', completedAt: new Date().toISOString(), resultPath: join(directory, 'apqp-dates-result.json') }
    entries.unshift(entry)
    return entry
  }
  const first = await record('query', { records: [row], session, fieldSchema: APQP_DATE_SCHEMA, stageOnly: false, readOnly: true })
  return { root, artifacts, history, cache, entries, first, record }
}

test('completed read restores across cache/service restart without a SAP call or new generated files', async () => {
  const f = await fixture(), before = await readdir(f.root), files = await readdir(join(f.root, f.first.id))
  const cache = new ApqpDateCache(f.root, f.history), calls = []
  const service = new ApqpDateService({ dates: async request => { calls.push(request); throw new Error('SAP must not be used for local restore') } }, Date.now, cache)
  const restored = await service.loadCached(query)
  assert(restored.success)
  assert(restored.snapshot.cached)
  assert.deepEqual(restored.snapshot.records, [row])
  assert.notEqual(restored.snapshot.id, f.first.id, 'New main-owned execution token; old one is not revived')
  assert.equal(restored.snapshot.createdAt, f.first.completedAt, 'Never label cached values as freshly read')
  assert.deepEqual(calls, [])
  assert.deepEqual(await readdir(f.root), before)
  assert.deepEqual(await readdir(join(f.root, f.first.id)), files)
})

test('cache scopes environment/project/business user, rejects incomplete reads, and obeys history deletion/60 days', async () => {
  const f = await fixture()
  for (const different of [{ ...query, environment: 'QA' }, { ...query, project: '775260' }, { ...query, userId: 'OTHER' }]) assert.equal(await f.cache.load(different), null)
  assert(await f.cache.load({ ...query, userId: 'ee00221' }))
  const file = join(f.root, f.first.id, 'apqp-dates-result.json')
  await writeFile(file, JSON.stringify({ records: [row], session, readOnly: true, error: 'CANCELLED' }))
  assert.equal(await f.cache.load(query), null)
  await writeFile(file, JSON.stringify({ records: [row], session, readOnly: true }))
  f.first.completedAt = new Date(Date.now() - 61 * 86_400_000).toISOString()
  assert.equal(await f.cache.load(query), null)
  f.entries.length = 0
  assert.equal(await f.cache.load(query), null, 'Clear history also removes cached availability')
})

test('corrupt, foreign-manifest and path traversal evidence is not restored', async () => {
  const f = await fixture(), file = join(f.root, f.first.id, 'artifacts.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...manifest, operation: 'create-rfq' }))
  assert.equal(await f.cache.load(query), null)
  await writeFile(file, JSON.stringify(manifest))
  await writeFile(join(f.root, f.first.id, 'apqp-date-request.json'), '{bad')
  assert.equal(await f.cache.load(query), null)
  f.first.diagnosticRunId = '../outside'
  assert.equal(await f.cache.load(query), null)
})

test('old G/H actual-date caches cannot be reused as the new F/G/H/M planned schema', async () => {
  const f = await fixture(), file = join(f.root, f.first.id, 'apqp-dates-result.json')
  for (const fieldSchema of [undefined, 'OLD_GH_ACTUALS']) {
    await writeFile(file, JSON.stringify({ records: [row], session, readOnly: true, fieldSchema }))
    assert.equal(await f.cache.load(query), null)
  }
})

test('last staged attempt is historical/unconfirmed, not applied to cached date values', async () => {
  const f = await fixture()
  f.first.completedAt = new Date(Date.now() - 1000).toISOString()
  await f.record('execute', { writeMayHaveOccurred: true, writeEvents: [
    { event: 'STAGED_READY_NOT_SAVED', apqp: row.apqp, material: row.material, vendor: row.vendor, dates: { ...row.dates, fPlanDate: '2026-10-27' } }
  ] })
  const restored = await f.cache.load(query)
  assert.equal(restored.snapshot.lastAttempt.status, 'STAGED')
  assert.equal(restored.snapshot.lastAttempt.apqp, row.apqp)
  assert.equal(restored.snapshot.records[0].dates.fPlanDate, null, 'Uncommitted edit buffer is not saved SAP data')
})

test('restored snapshot still passes original session/values to the live native guard before test input', async () => {
  const f = await fixture(), calls = []
  const runner = { dates: async request => { calls.push(request); return { success: false, errorCode: 'SAP_SESSION_LOST', message: 'Original window changed' } } }
  const service = new ApqpDateService(runner, Date.now, f.cache)
  const cached = await service.loadCached(query)
  const result = await service.execute({ snapshotId: cached.snapshot.id, confirmed: true,
    edits: [{ apqp: row.apqp, dates: { ...row.dates, fPlanDate: '2026-10-27' } }] }, () => undefined, { runId: randomUUID(), service: {} })
  assert.equal(result.errorCode, 'SAP_SESSION_LOST')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].session, session)
  assert.deepEqual(calls[0].originals[0].dates, row.dates, 'Native three-way comparison still gets original values')
  assert.equal(calls[0].action, 'execute')
})
