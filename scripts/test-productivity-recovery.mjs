import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url), cache = new Map(), handlers = new Map(), opened = []
const actualFs = require('node:fs')
let blockedRenames = 0, renameAttempts = 0, blockedCode = 'EPERM'
const mocks = { electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  shell: { openPath: async path => { opened.push(path); return '' } }, BrowserWindow: { fromWebContents: () => null }, dialog: {} },
  'node:fs': { ...actualFs, renameSync: (...args) => {
    renameAttempts++
    if (blockedRenames > 0) { blockedRenames--; throw Object.assign(new Error('Mock file held by Windows scanner'), { code: blockedCode }) }
    return actualFs.renameSync(...args)
  } } }
function load(path) {
  const file = resolve(path)
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  cache.set(file, module.exports)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => mocks[name] ?? (name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name)), module, module.exports)
  return module.exports
}
const { timeSavings, DEFAULT_MANUAL_SECONDS, isManualTimeBaselines } = load('src/shared/time-savings.ts')
const { RfqSafeRecoveryService } = load('src/main/services/rfq-safe-recovery-service.ts')
const { ExecutionHistoryService } = load('src/main/services/execution-history-service.ts')
const { DiagnosticLogger } = load('src/main/services/diagnostic-logger.ts')
const { RunDiagnosticCleanup } = load('src/main/services/run-diagnostic-cleanup.ts')
const { RfqNativeRunner } = load('src/main/automation/rfq-native-runner.ts')
const trusted = { senderFrame: { url: 'file:///renderer/index.html' }, sender: { isDestroyed: () => true } }
const now = new Date('2026-10-09T12:00:00'), today = new Date('2026-10-09T10:00:00').toISOString()
const entry = (id, changes = {}) => ({ id, operation: 'me12-batch', label: 'test', summary: 'test', status: 'Success',
  startedAt: today, completedAt: today, succeeded: 10, skipped: 100, failed: 20, durationMs: 100000, ...changes })

test('savings deducts full wall time once; counts confirmed success not skips; excludes uncertain runs', () => {
  const summary = timeSavings([entry('good'), entry('partial', { status: 'Partial', succeeded: 2, durationMs: 60000 }),
    entry('failed', { status: 'Failed' }), entry('dry', { dryRun: true }), entry('uncertain'), entry('no-count', { succeeded: undefined }),
    entry('cancel', { status: 'Cancelled' }), entry('diagnostic-legacy', { durationMs: 0 }), entry('good'), entry('old', { completedAt: '2020-01-01T00:00:00Z' })], DEFAULT_MANUAL_SECONDS, false, new Set(['uncertain']), now)
  assert.equal(summary.today.savedMs, 3440000)
  assert.equal(summary.today.actualMs, 160000)
  assert.equal(summary.today.successfulUnits, 12)
  assert.equal(summary.today.runs, 2)
  assert.equal(summary.excludedRuns, 6)
})
test('periods use completion dates and include negative runs conservatively before flooring to zero', () => {
  const summary = timeSavings([entry('slow', { succeeded: 1, durationMs: 4000000 }), entry('yesterday', { completedAt: new Date('2026-10-08T10:00:00').toISOString() }),
    entry('future', { completedAt: '2099-01-01T00:00:00Z' }), entry('invalid', { durationMs: Infinity })], DEFAULT_MANUAL_SECONDS, true, new Set(), now)
  assert.equal(summary.today.savedMs, 0)
  assert.equal(summary.last30Days.savedMs, 0)
  assert.equal(summary.last30Days.runs, 2)
  assert.equal(summary.calibrated, true)
})

test('APQP date savings use one minute per verified field, not four fields per record or query rows', () => {
  const dateEntry = (id, changes = {}) => entry(id, { operation: 'apqp-date-management', apqpDateAction: 'update',
    succeeded: 2, apqpDateFieldsSaved: 7, durationMs: 30000, ...changes })
  const summary = timeSavings([dateEntry('saved'), dateEntry('partial', { status: 'Partial', succeeded: 1, apqpDateFieldsSaved: 1, durationMs: 10000 }),
    dateEntry('read', { apqpDateAction: 'query' }), dateEntry('preview', { apqpDateAction: 'preview' }),
    dateEntry('legacy', { apqpDateFieldsSaved: undefined }), dateEntry('too-many', { apqpDateFieldsSaved: 9 }),
    dateEntry('too-few', { apqpDateFieldsSaved: 1 }), dateEntry('staged', { apqpStaged: 1 }), dateEntry('dry', { dryRun: true }),
    dateEntry('failed', { status: 'Failed' }), dateEntry('cancelled', { status: 'Cancelled' }), dateEntry('uncertain'), dateEntry('saved')],
    DEFAULT_MANUAL_SECONDS, false, new Set(['uncertain']), now)
  assert.equal(summary.today.successfulDateFields, 8)
  assert.equal(summary.today.successfulUnits, 3)
  assert.equal(summary.today.runs, 2)
  assert.equal(summary.today.manualMs, 480000)
  assert.equal(summary.today.actualMs, 40000)
  assert.equal(summary.today.savedMs, 440000)
})
test('RFQ units are groups; baselines validate finite positive bounded seconds', () => {
  assert.equal(timeSavings([entry('rfq', { operation: 'create-rfq', succeeded: 2, durationMs: 300000 })], DEFAULT_MANUAL_SECONDS, false, new Set(), now).today.savedMs, 3900000)
  for (const value of [NaN, Infinity, 0, -1, 86401]) assert.equal(isManualTimeBaselines({ ...DEFAULT_MANUAL_SECONDS, 'create-rfq': value }), false)
  assert.equal(isManualTimeBaselines(DEFAULT_MANUAL_SECONDS), true)
  assert.equal(isManualTimeBaselines({}), false)
})
async function fixture(probe = () => 'dead') {
  const root = await mkdtemp(join(tmpdir(), 'hub-safe-recovery-test-')), ledger = join(root, 'ledger'), runs = join(root, 'runs')
  await mkdir(runs)
  const recovery = new RfqSafeRecoveryService(ledger, runs, probe)
  const logger = new DiagnosticLogger(join(root, 'logs')); await mkdir(join(root, 'logs'))
  const cleanup = new RunDiagnosticCleanup(runs, join(root, 'interactions'))
  const history = new ExecutionHistoryService(join(root, 'history.json'), logger, (e, protectedPaths) => cleanup.remove(e, protectedPaths), () => recovery.protectedIds())
  const start = async (id = randomUUID()) => {
    const output = join(runs, id, 'output', 'result.xlsx')
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, 'saved-result')
    recovery.begin(id, 'PROD', output); recovery.launched(id, 987654)
    return { id, output }
  }
  return { root, ledger, runs, recovery, history, start, close: () => rm(root, { recursive: true, force: true }) }
}
test('atomic ledger replacement retries transient Windows locks, but preserves old evidence on persistent failure', async () => {
  const f = await fixture()
  try {
    const { id } = await f.start(), path = join(f.ledger, id + '.json')
    blockedRenames = 2; renameAttempts = 0
    f.recovery.observe(id, { type: 'GROUP_STARTED', groupKey: 'g1', total: 1 })
    assert.equal(renameAttempts, 3)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).groupKey, 'g1')
    const before = await readFile(path, 'utf8')
    blockedRenames = 10; renameAttempts = 0
    assert.throws(() => f.recovery.observe(id, { type: 'BUYER_RECEIPT_SAVED' }), /Mock file held/)
    assert.equal(renameAttempts, 4)
    assert.equal(await readFile(path, 'utf8'), before)
    blockedRenames = 1; blockedCode = 'EIO'; renameAttempts = 0
    assert.throws(() => f.recovery.close(id, 0), /Mock file held/)
    assert.equal(renameAttempts, 1, 'Non-lock errors are not retried')
    assert.equal(await readFile(path, 'utf8'), before)
  } finally { blockedRenames = 0; blockedCode = 'EPERM'; await f.close() }
})
test('restart restores 7/12 groups, deduplicates group completions and retains saved Buyer Receipt checkpoint', async () => {
  const f = await fixture()
  try {
    const { id, output } = await f.start()
    for (let i = 1; i <= 7; i++) {
      f.recovery.observe(id, { type: 'GROUP_STARTED', groupKey: `g${i}`, project: '775773', total: 12 })
      f.recovery.observe(id, { type: 'GROUP_COMPLETED', groupKey: `g${i}`, groupStatus: 'SUCCESS', current: i })
    }
    f.recovery.observe(id, { type: 'GROUP_COMPLETED', groupKey: 'g7', groupStatus: 'SUCCESS', current: 999 })
    f.recovery.observe(id, { type: 'GROUP_STARTED', groupKey: 'g8', project: '775773', plant: 'C100', supplier: '41889', materials: ['16808656'], total: 12 })
    f.recovery.observe(id, { type: 'BUYER_RECEIPT_SAVED', groupKey: 'g8' })
    f.recovery.observe(id, { type: 'RFQ_STARTED', groupKey: 'g8' })
    assert.equal(f.recovery.pending().length, 0, 'Live current-owner jobs are not restart recovery notices')
    const restarted = new RfqSafeRecoveryService(f.ledger, f.runs, () => 'dead'), [record] = restarted.pending()
    assert.equal(record.completedGroups, 7); assert.equal(record.totalGroups, 12)
    assert.equal(record.lastConfirmedCheckpoint, 'BUYER_RECEIPT_SAVED'); assert.equal(record.checkpointGroup, 'g8')
    assert.deepEqual(record.uncertainGroupKeys, ['g8']); assert.equal(record.resultAvailable, true)
    assert.equal(restarted.result(id), output)
    restarted.resolve(id, 'Verified in SAP. Existing objects retained; remaining group referred to key user.')
    assert.equal(restarted.pending().length, 0)
    assert.equal(JSON.parse(await readFile(join(f.ledger, id + '.json'), 'utf8')).phase, 'resolved')
    assert.equal(await readFile(output, 'utf8'), 'saved-result')
  } finally { await f.close() }
})
test('alive PID blocks resolution; unknown processes require human attestation, not automatic resume', async () => {
  const f = await fixture(() => 'alive')
  try {
    const { id } = await f.start(), restarted = new RfqSafeRecoveryService(f.ledger, f.runs, () => 'alive')
    assert.equal(restarted.pending()[0].processStatus, 'alive')
    assert.throws(() => restarted.resolve(id, 'verified'), /may still be running/)
    assert.throws(() => restarted.resolve('../bad', 'verified'), /Invalid recovery run ID/)
    const unknown = new RfqSafeRecoveryService(f.ledger, f.runs, () => 'unknown')
    assert.throws(() => unknown.resolve(id, ''), /verification note/)
  } finally { await f.close() }
})
test('terminal event without successful exit stays pending; failed/cancelled groups are not confirmed completed', async () => {
  const f = await fixture()
  try {
    for (const [groupType, groupStatus, code] of [['GROUP_FAILED', 'ERROR', 0], ['GROUP_COMPLETED', 'CANCELLED', 3], ['GROUP_COMPLETED', 'SUCCESS', 1]]) {
      const { id } = await f.start()
      f.recovery.observe(id, { type: 'GROUP_STARTED', groupKey: id, total: 1 })
      f.recovery.observe(id, { type: groupType, groupKey: id, groupStatus })
      f.recovery.observe(id, { type: 'RUN_COMPLETED', total: 1 }); f.recovery.close(id, code)
      const record = f.recovery.pending().find(r => r.runId === id)
      assert(record); assert.equal(record.completedGroups, groupStatus === 'SUCCESS' ? 1 : 0)
    }
    const { id } = await f.start()
    f.recovery.observe(id, { type: 'GROUP_STARTED', groupKey: id, total: 1 })
    f.recovery.observe(id, { type: 'GROUP_COMPLETED', groupKey: id, groupStatus: 'SUCCESS' })
    f.recovery.observe(id, { type: 'RUN_COMPLETED' }); f.recovery.close(id, 0)
    assert(!f.recovery.protectedIds().has(id))
  } finally { await f.close() }
})
test('legacy runs and corrupt evidence stay uncertain; result paths cannot escape owned run output', async () => {
  const f = await fixture()
  try {
    const id = randomUUID()
    f.recovery.importLegacy([entry(id, { operation: 'create-rfq', status: 'Running', resultPath: join(f.root, 'outside.xlsx') })])
    assert.equal(f.recovery.pending()[0].totalGroups, null); assert.equal(f.recovery.pending()[0].processStatus, 'unknown')
    assert.throws(() => f.recovery.result(id), /No safe saved result/)
    const corrupt = randomUUID(), path = join(f.ledger, corrupt + '.json')
    await writeFile(path, '{broken')
    assert(f.recovery.protectedIds().has(corrupt))
    assert.throws(() => f.recovery.resolve(corrupt, 'ignore it'), /unreadable/)
    assert.throws(() => f.recovery.launched(corrupt, 123), /unreadable/)
    assert.throws(() => f.recovery.observe(corrupt, { type: 'GROUP_STARTED' }), /unreadable/)
    assert.throws(() => f.recovery.close(corrupt, 0), /unreadable/)
    assert.equal(await readFile(path, 'utf8'), '{broken')
    const { id: started } = await f.start()
    assert.throws(() => f.recovery.observe(started, { type: 'RFQ_CREATED', runId: 'different' }), /another run/)
  } finally { await f.close() }
})
test('history cap and bulk cleanup never erase unresolved evidence, including ledgers without history', async () => {
  const f = await fixture()
  try {
    const { id } = await f.start(); f.recovery.close(id, 1)
    const protectedEntry = entry(id, { operation: 'create-rfq', status: 'Failed' })
    await writeFile(join(f.root, 'history.json'), JSON.stringify([...Array.from({ length: 500 }, (_, index) => entry(`normal-${index}`)), protectedEntry]))
    await f.history.start({ operation: 'me12-batch', label: 'mock', summary: 'mock' })
    assert((await f.history.getEntries({ limit: 1000 })).some(e => e.id === id), 'Protected old history survives the normal 500-record cap')
    await writeFile(join(f.root, 'history.json'), '[]') // Simulate already-missing history, not evidence.
    let protectedAtPurge
    const history = new ExecutionHistoryService(join(f.root, 'history.json'), { purge: async (_before, ids) => { protectedAtPurge = ids; return [] } }, undefined, () => f.recovery.protectedIds())
    await history.clear()
    assert(protectedAtPurge.has(id), 'Ledger-only diagnostics remain protected too')
  } finally { await f.close() }
})
test('unresolved failed history and diagnostics survive Clear All; manual review is not execution success', async () => {
  const f = await fixture()
  try {
    const e = await f.history.start({ operation: 'create-rfq', label: 'test', summary: 'test' })
    const { id, output } = await f.start(e.id)
    const logs = join(f.runs, id, 'logs'); await mkdir(logs); await writeFile(join(logs, 'engine.log'), 'evidence')
    f.recovery.close(id, 1)
    await f.history.finish(id, { status: 'Failed', summary: 'unknown outcome', resultPath: output })
    assert.equal((await f.history.clear()).deleted, 0)
    await stat(join(logs, 'engine.log'))
    f.recovery.resolve(id, 'Verified RFQ in SAP; not rerun.')
    await f.history.markRecoveryResolved(id, 'Verified RFQ in SAP; not rerun.')
    const [reviewed] = await f.history.getEntries({})
    assert.equal(reviewed.status, 'Failed'); assert(reviewed.recoveryResolvedAt)
    assert.equal((await f.history.clear()).deleted, 1)
    await stat(output); await stat(join(f.ledger, id + '.json'))
  } finally { await f.close() }
})
test('trusted recovery IPC validates attestation; RFQ launch is blocked until prior review resolves', async () => {
  const f = await fixture()
  try {
    const { id, output } = await f.start(); f.recovery.close(id, null)
    let active = false, launches = 0
    load('src/main/ipc/safe-recovery-handlers.ts').registerSafeRecoveryHandlers(f.recovery, f.history, { getSettings: async () => ({}) }, () => active)
    const mark = handlers.get('rfq-recovery:resolve'), open = handlers.get('rfq-recovery:open-result')
    const payload = { runId: id, note: 'SAP manually verified', verifiedInSap: true, engineStopped: true }
    assert.equal((await mark({}, payload)).success, false)
    assert.equal((await mark(trusted, { ...payload, engineStopped: false })).success, false)
    active = true; assert.equal((await mark(trusted, payload)).success, false); active = false
    assert.equal((await open(trusted, '../outside')).success, false)
    assert.equal((await open(trusted, id)).success, true); assert.equal(opened.at(-1), output)
    load('src/main/ipc/rfq-handlers.ts').registerRfqHandlers({}, { run: async () => { launches++; return { success: false, message: 'mock', errorCode: 'EXECUTION_FAILED' } } },
      { info: async () => {}, error: async () => {} }, f.history, '', {}, undefined, undefined, f.recovery)
    const result = await handlers.get('rfq:start')(trusted, { excelPath: 'mock.xlsx', environment: 'PROD', productionConfirmed: true })
    assert.equal(result.errorCode, 'OPERATION_IN_PROGRESS'); assert.equal(launches, 0)
    assert.equal((await mark(trusted, payload)).success, true)
    assert.equal(f.recovery.pending().length, 0)
  } finally { await f.close() }
})
test('real mock child waits for durable process identity before any business event; original stays intact', async () => {
  const f = await fixture(), previous = process.env.SAP_RFQ_PYTHON
  process.env.SAP_RFQ_PYTHON = process.execPath
  try {
    const input = join(f.root, 'input.xlsx'); await writeFile(input, JSON.stringify({ mode: 'success' }))
    const id = randomUUID(), runner = new RfqNativeRunner({ executable: '', preferScript: true, script: resolve('scripts/fixtures/rfq-mock-engine.mjs') }, f.runs, 'test', f.recovery)
    const config = { excelPath: input, environment: 'PROD', productionConfirmed: true }
    const preview = await runner.preview(config)
    const result = await runner.run({ ...config, fingerprint: preview.fingerprint }, event => {
      if (event.type === 'GROUP_STARTED') {
        const saved = JSON.parse(readFileSync(join(f.ledger, id + '.json'), 'utf8'))
        const marker = JSON.parse(readFileSync(join(f.runs, id, 'temp', 'hub-ready.json'), 'utf8'))
        assert(saved.enginePid > 0); assert.equal(marker.pid, saved.enginePid); assert.equal(saved.groupKey, 'MOCK-GROUP')
      }
    }, id)
    assert.equal(result.success, true); assert.equal(f.recovery.pending().length, 0)
    assert.equal(await readFile(input, 'utf8'), JSON.stringify({ mode: 'success' }))
  } finally { if (previous === undefined) delete process.env.SAP_RFQ_PYTHON; else process.env.SAP_RFQ_PYTHON = previous; await f.close() }
})
test('transient boundary-storage failure requests safe stop and cannot later claim a clean finish', async () => {
  const f = await fixture(), previous = process.env.SAP_RFQ_PYTHON
  process.env.SAP_RFQ_PYTHON = process.execPath
  try {
    const input = join(f.root, 'input.xlsx'); await writeFile(input, JSON.stringify({ mode: 'success' }))
    const id = randomUUID()
    let failedOnce = false
    const recorder = {
      begin: (...args) => f.recovery.begin(...args), launched: (...args) => f.recovery.launched(...args), close: (...args) => f.recovery.close(...args),
      observe: (runId, event) => {
        if (event.type === 'GROUP_STARTED' && !failedOnce) { failedOnce = true; throw new Error('Mock transient disk error') }
        f.recovery.observe(runId, event)
      }
    }
    const runner = new RfqNativeRunner({ executable: '', preferScript: true, script: resolve('scripts/fixtures/rfq-mock-engine.mjs') }, f.runs, 'test', recorder)
    const config = { excelPath: input, environment: 'PROD', productionConfirmed: true }, preview = await runner.preview(config)
    const result = await runner.run({ ...config, fingerprint: preview.fingerprint }, () => {}, id)
    assert.equal(result.success, false); assert.match(result.message, /Recovery evidence/)
    assert(f.recovery.protectedIds().has(id), 'Even a later clean terminal event cannot erase uncertainty')
    assert.equal(f.recovery.pending()[0].phase, 'review')
    await stat(join(f.runs, id, 'temp', 'stop-requested'))
    assert.equal(await readFile(input, 'utf8'), JSON.stringify({ mode: 'success' }))
  } finally { if (previous === undefined) delete process.env.SAP_RFQ_PYTHON; else process.env.SAP_RFQ_PYTHON = previous; await f.close() }
})
