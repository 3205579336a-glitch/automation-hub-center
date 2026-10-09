import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const cache = new Map()
const handlers = new Map()
const mocks = {
  electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }, dialog: {}, shell: { openPath: async () => '' } }
}
function load(path) {
  const file = resolve(path)
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  cache.set(file, module.exports)
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? (name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name)), module, module.exports)
  cache.set(file, module.exports)
  return module.exports
}
const shared = load('src/shared/local-intelligence.ts')
const { LocalIntelligenceService } = load('src/main/services/local-intelligence-service.ts')
const { ExecutionHistoryService } = load('src/main/services/execution-history-service.ts')
const { GuidedAutomationService } = load('src/main/services/guided-automation-service.ts')
const nowDate = Date.UTC(2026, 9, 8)
const day = 86400000
let entryNumber = 0
function entry(id, age = 0, status = 'Success', performance) {
  return { id: `test-${++entryNumber}`, operation: id, label: 'Test', summary: 'Test',
    startedAt: new Date(nowDate - age * day).toISOString(), completedAt: new Date(nowDate - age * day + 1).toISOString(),
    status, succeeded: status === 'Success' ? 2 : 0, performance }
}
function sample(id, unitMs = 10000, count = 2, concurrency = 1) {
  return { version: 1, activeDurationMs: 5000 + count * unitMs, waitingForUserMs: 0, startupMs: 5000,
    unitDurationMs: unitMs, concurrency, workUnits: { kind: shared.workUnit(id), total: count, completed: count, learned: count },
    stepDurations: { startup: 5000, records: count * unitMs } }
}
const history = entries => ({ getEntries: async () => entries })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function clockService(id = 'create-rfq', entries = [], publish = () => {}) {
  let time = 0
  const service = new LocalIntelligenceService(history(entries), publish, () => time)
  service.begin('run', id, 'context', 10)
  return { service, set: value => { time = value } }
}

test('Smart Task Ranking', async t => {
  await t.test('cold start preserves business order', () => assert.deepEqual(shared.rankTasks([], nowDate).order, shared.DEFAULT_TASK_ORDER))
  await t.test('frequency dominates a large usage difference', () => {
    const entries = [...Array.from({ length: 18 }, (_, i) => entry('create-rfq', i)), ...Array.from({ length: 8 }, (_, i) => entry('me12-batch', i)), entry('apqp-plan-closure'), entry('me01-source-list')]
    assert.equal(shared.rankTasks(entries, nowDate).order[0], 'create-rfq')
    assert(shared.rankTasks(entries, nowDate).frequentlyUsed.includes('create-rfq'))
  })
  await t.test('recent Source List outranks equally frequent older RFQ', () => {
    assert.equal(shared.rankTasks([entry('create-rfq', 25), entry('me01-source-list', 0)], nowDate).order[0], 'me01-source-list')
  })
  await t.test('hundreds of old runs cannot dominate', () => {
    const entries = [...Array.from({ length: 300 }, () => entry('create-rfq', 90)), entry('apqp-plan-closure')]
    assert.equal(shared.rankTasks(entries, nowDate).order[0], 'apqp-plan-closure')
  })
  await t.test('failures still represent usage, without negative penalties', () => {
    const entries = [...Array.from({ length: 10 }, () => entry('me01-source-list', 0, 'Failed')), entry('create-rfq')]
    assert.equal(shared.rankTasks(entries, nowDate).order[0], 'me01-source-list')
  })
  await t.test('ties are stable', () => {
    assert.deepEqual(shared.rankTasks(shared.DEFAULT_TASK_ORDER.map(id => entry(id)), nowDate).order, shared.DEFAULT_TASK_ORDER)
  })
  await t.test('corrupt/missing/future/unknown histories safely fall back', () => {
    for (const invalid of [null, {}, 'bad', [null, {}, { id: 'x', operation: 'other' }], [entry('create-rfq', -1)]]) {
      assert.deepEqual(shared.rankTasks(invalid, nowDate).order, shared.DEFAULT_TASK_ORDER)
    }
    assert.equal(shared.rankTasks([entry('create-rfq', 90)], nowDate).personalized, false)
  })
  await t.test('duplicate history IDs are not double counted', () => {
    const once = entry('create-rfq')
    assert.deepEqual(shared.rankTasks([once, once, once], nowDate), shared.rankTasks([once], nowDate))
  })
})

test('Adaptive ETA model', async t => {
  const id = 'create-rfq'
  await t.test('zero samples uses built-in fallback', () => {
    assert.deepEqual(shared.timingModel([], id), shared.fallbackModel(id))
    assert.equal(shared.estimateRemaining(shared.fallbackModel(id), { total: 10, completed: 0, concurrency: 1, startupDone: false, startupElapsed: 0, unitElapsed: 0, learned: 0 }), 615000)
  })
  await t.test('local samples gradually replace fallback', () => {
    const values = Array.from({ length: 12 }, (_, i) => entry(id, 12 - i, 'Success', sample(id, 30000)))
    const one = shared.timingModel(values.slice(0, 1), id)
    const all = shared.timingModel(values, id)
    assert(one.unitMs < 60000 && one.unitMs > 30000)
    assert(all.unitMs < one.unitMs && all.unitMs > 30000)
    assert.equal(all.historicalRuns, 12)
  })
  await t.test('faster/slower current units correct remaining estimate', () => {
    const input = { total: 10, completed: 3, concurrency: 1, startupDone: true, startupElapsed: 0, unitElapsed: 0, learned: 3 }
    const base = shared.estimateRemaining(shared.fallbackModel(id), input)
    assert(shared.estimateRemaining(shared.fallbackModel(id), { ...input, observedUnitMs: 20000 }) < base)
    assert(shared.estimateRemaining(shared.fallbackModel(id), { ...input, observedUnitMs: 120000 }) > base)
  })
  await t.test('outlier is bounded and does not destroy learned average', () => {
    const values = Array.from({ length: 10 }, (_, i) => entry(id, 10 - i, 'Success', sample(id, 10000)))
    const base = shared.timingModel(values, id)
    const extreme = shared.timingModel([...values, entry(id, 0, 'Success', sample(id, 10000000))], id)
    assert(extreme.unitMs < base.unitMs * 2)
  })
  await t.test('each automation learns separately', () => {
    const values = Array.from({ length: 10 }, () => entry('me01-source-list', 1, 'Success', sample('me01-source-list', 20000)))
    assert.deepEqual(shared.timingModel(values, id), shared.fallbackModel(id))
    assert(shared.timingModel(values, 'me01-source-list').unitMs > 6000)
  })
  await t.test('cancelled, dry-run, crashed and legacy wall times are not clean samples', () => {
    const values = [entry(id, 1, 'Cancelled', sample(id)), { ...entry(id, 1, 'Success', sample(id)), dryRun: true },
      entry(id, 1, 'Running', sample(id)), { ...entry(id), durationMs: 2000000 }, entry(id, 1, 'Failed', { corrupted: true })]
    assert.equal(shared.timingModel(values, id).historicalRuns, 0)
  })
  await t.test('failed run with reliable completed timings remains useful', () => {
    assert.equal(shared.timingModel([entry(id, 1, 'Failed', sample(id))], id).historicalRuns, 1)
  })
  await t.test('invalid numeric values and impossible timing envelopes are rejected', () => {
    for (const p of [null, {}, { ...sample(id), unitDurationMs: NaN }, { ...sample(id), activeDurationMs: 1 },
      { ...sample(id), concurrency: 0 }, { ...sample(id), workUnits: { kind: 'rows', total: 2, completed: 2, learned: 2 } }]) {
      assert.equal(shared.validPerformance(p, id), false)
    }
  })
  await t.test('actual concurrency is normalized, not mixed blindly', () => {
    const values = Array.from({ length: 12 }, () => entry('apqp-plan-closure', 1, 'Success', sample('apqp-plan-closure', 3000, 10, 3)))
    const model = shared.timingModel(values, 'apqp-plan-closure')
    const input = { total: 10, completed: 2, startupDone: true, startupElapsed: 0, unitElapsed: 0, learned: 0 }
    assert(shared.estimateRemaining(model, { ...input, concurrency: 3 }) < shared.estimateRemaining(model, { ...input, concurrency: 1 }))
  })
  await t.test('performance model reads only last 100 samples', () => {
    assert.equal(shared.timingModel(Array.from({ length: 150 }, (_, i) => entry(id, 150 - i, 'Success', sample(id))), id).historicalRuns, 100)
  })
  await t.test('time never advances work counts; a stalled task never shows zero remaining', () => {
    assert(shared.estimateRemaining(shared.fallbackModel(id), { total: 1, completed: 0, concurrency: 1, startupDone: true, startupElapsed: 0, unitElapsed: 9999999, learned: 0 }) > 0)
    assert.equal(shared.completedUnits(id, { type: 'GROUP_STARTED', current: 1 }), undefined)
    assert.equal(shared.completedUnits('me01-source-list', { stage: 'processing', status: 'running', current: 1 }), undefined)
    assert.equal(shared.completedUnits(id, { type: 'GROUP_COMPLETED', current: 1 }), 1)
  })
})

test('Timing observer and local history integration', async t => {
  await t.test('WAIT and RECOVERING excluded exactly, stage totals exclude pauses', async () => {
    const { service, set } = clockService()
    try {
      set(10000); service.observe('run', { type: 'GROUP_STARTED', current: 1, total: 2 })
      set(30000); service.interaction({ runId: 'context', state: 'WAITING_FOR_USER' })
      assert.equal(service.eta().state, 'waiting'); assert.equal(service.eta().remainingMs, null)
      set(750000); service.interaction({ runId: 'context', state: 'RECOVERING' })
      assert.equal(service.eta().state, 'recovering'); assert.equal(service.eta().remainingMs, null)
      set(760000); service.interaction(null)
      set(800000); service.observe('run', { type: 'GROUP_COMPLETED', current: 1, total: 2, succeeded: 1 })
      const p = service.finish('run', 'Success')
      assert.equal(p.activeDurationMs, 70000); assert.equal(p.waitingForUserMs, 730000)
      assert.equal(p.startupMs, 10000); assert.equal(p.unitDurationMs, 60000)
      assert.equal(Object.values(p.stepDurations).reduce((sum, x) => sum + x, 0), 70000)
      assert.equal(service.eta(), null)
    } finally { service.dispose() }
  })
  await t.test('RFQ event-owned WAIT cannot resume on unrelated log events', () => {
    const { service, set } = clockService()
    try {
      service.observe('run', { state: 'WAITING_FOR_USER' }); set(600000)
      service.observe('run', { type: 'GROUP_PROGRESS' })
      assert.equal(service.eta().state, 'waiting')
      service.observe('run', { type: 'INTERACTION_RESOLVED' })
      assert.equal(service.eta().state, 'running')
    } finally { service.dispose() }
  })
  await t.test('cancelled runs and startup-only runs emit no performance sample', () => {
    let clock = clockService(); clock.set(1000)
    assert.equal(clock.service.finish('run', 'Failed'), undefined)
    clock = clockService(); clock.set(1000); clock.service.observe('run', { type: 'GROUP_STARTED', current: 1 })
    clock.set(61000); clock.service.observe('run', { type: 'GROUP_COMPLETED', current: 1, succeeded: 1 })
    assert.equal(clock.service.finish('run', 'Cancelled'), undefined)
  })
  await t.test('rows count only after completion, duplicate events ignored', () => {
    const { service, set } = clockService('me01-source-list')
    set(1000); service.observe('run', { stage: 'processing', status: 'running', current: 1, total: 10 })
    assert.equal(service.eta().completed, 0)
    set(5000); service.observe('run', { stage: 'processing', status: 'success', current: 1, total: 10 })
    set(8000); service.observe('run', { stage: 'processing', status: 'success', current: 1, total: 10 })
    service.observe('other', { stage: 'processing', status: 'success', current: 7, total: 10 })
    assert.equal(service.eta().completed, 1)
    const p = service.finish('run', 'Success'); assert.equal(p.workUnits.learned, 1); assert.equal(p.unitDurationMs, 4000)
  })
  await t.test('failed intervals excluded; good completed rows retained', () => {
    const { service, set } = clockService('me01-source-list')
    set(1000); service.observe('run', { stage: 'processing', status: 'running', current: 1 })
    set(5000); service.observe('run', { stage: 'processing', status: 'success', current: 1 })
    set(90000); service.observe('run', { stage: 'processing', status: 'failed', current: 2 })
    const p = service.finish('run', 'Failed'); assert.equal(p.workUnits.completed, 2); assert.equal(p.workUnits.learned, 1); assert.equal(p.unitDurationMs, 4000)
  })
  await t.test('APQP workers define startup and completed query items', () => {
    const { service, set } = clockService('apqp-plan-closure')
    set(2000); service.observe('run', { event: 'workers', workers: 3, total: 10 })
    set(6000); service.observe('run', { event: 'record', current: 1, total: 10, worker: 2, status: 'SUCCESS' })
    const p = service.finish('run', 'Success'); assert.equal(p.concurrency, 3); assert.equal(p.startupMs, 2000); assert.equal(p.unitDurationMs, 4000)
  })
  await t.test('ETA broadcast/history failures never throw into automation', async () => {
    const service = new LocalIntelligenceService({ getEntries: async () => { throw Error('history unavailable') } }, () => { throw Error('window closed') }, () => 0)
    assert.doesNotThrow(() => service.begin('run', 'create-rfq', 'context', 2))
    assert.doesNotThrow(() => service.observe('run', { type: 'GROUP_STARTED', current: 1 }))
    await flush()
    const snapshot = await service.snapshot(); assert.deepEqual(snapshot.ranking.order, shared.DEFAULT_TASK_ORDER)
    assert.doesNotThrow(() => service.finish('run', 'Failed'))
  })
  await t.test('late history reads cannot modify a later run', async () => {
    let resolveRead
    const service = new LocalIntelligenceService({ getEntries: () => new Promise(resolve => { resolveRead = resolve }) }, () => {}, () => 0)
    service.begin('old', 'create-rfq', 'old-context', 2); const resolveOld = resolveRead
    service.begin('new', 'me01-source-list', 'new-context', 2)
    resolveOld([entry('create-rfq', 1, 'Success', sample('create-rfq'))]); await flush()
    assert.equal(service.eta().automationId, 'me01-source-list'); assert.equal(service.eta().historicalRuns, 0)
    service.dispose()
  })
  await t.test('guidance observer failures cannot change the owned pause', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'hub-eta-guidance-'))
    try {
      const guided = new GuidedAutomationService(folder, () => false)
      guided.onInteraction(() => { throw Error('ETA broken') })
      const context = guided.begin()
      const { service, set } = clockService('me01-source-list')
      guided.onInteraction(request => service.interaction(request && { ...request, runId: 'context' }))
      await guided.publish({ runId: context, requestId: 'request', state: 'WAITING_FOR_USER', allowedActions: ['stop'], automation: 'Source List', message: 'Manual action' }, async () => true)
      set(120000); assert.equal(service.eta().state, 'waiting')
      assert.equal(guided.getInteraction().requestId, 'request')
      guided.clear('request'); assert.equal(service.eta().state, 'running')
      guided.end(context); service.dispose()
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
  await t.test('existing history retains ordinary entries but only 100 timings per function', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'hub-eta-history-'))
    try {
      const path = join(folder, 'history.json')
      const initial = Array.from({ length: 120 }, (_, i) => entry('create-rfq', i, 'Success', sample('create-rfq')))
      await writeFile(path, JSON.stringify(initial))
      const store = new ExecutionHistoryService(path, { getEntries: async () => [] })
      const started = await store.start({ operation: 'me01-source-list', label: 'Source List', summary: 'Starting' })
      await store.finish(started.id, { status: 'Success', summary: 'Done', performance: sample('me01-source-list') })
      const saved = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(saved.length, 121)
      assert.equal(saved.filter(e => e.operation === 'create-rfq' && e.performance).length, 100)
      assert.equal(saved.filter(e => e.operation === 'me01-source-list' && e.performance).length, 1)
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
  await t.test('corrupt/missing history is safe; failed writes do not poison the write queue', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'hub-eta-corrupt-'))
    try {
      const path = join(folder, 'history.json')
      const store = new ExecutionHistoryService(path, { getEntries: async () => [] })
      assert.deepEqual(await store.getEntries({}), [])
      await writeFile(path, '{bad'); assert.deepEqual(await store.getEntries({}), [])
      const corruptStart = await store.start({ operation: 'create-rfq', label: 'RFQ', summary: 'Still allowed to run' })
      await store.finish(corruptStart.id, { status: 'Success', summary: 'Done' })
      assert.equal(await readFile(path, 'utf8'), '{bad', 'A malformed original history file must not be overwritten')
      const unavailable = join(folder, 'missing', 'history.json')
      const faulty = new ExecutionHistoryService(unavailable, { getEntries: async () => [] })
      const first = await faulty.start({ operation: 'create-rfq', label: 'RFQ', summary: 'Start' })
      await faulty.finish(first.id, { status: 'Failed', summary: 'History unavailable' })
      await mkdir(dirname(unavailable))
      const second = await faulty.start({ operation: 'create-rfq', label: 'RFQ', summary: 'Start' })
      await faulty.finish(second.id, { status: 'Success', summary: 'Done' })
      assert.equal((await faulty.getEntries({}))[0].status, 'Success')
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
})

test('Four real IPC adapters observe mocked engines without changing execution', async t => {
  const configs = {
    'create-rfq': { excelPath: 'fixture.xlsx', environment: 'PROD', productionConfirmed: true },
    'me12-batch': { excelPath: 'fixture.xlsx', sheetName: '', infoRecordColumn: 1, plantColumn: 2, dataStartRow: 2,
      targetPlant: 'C100', purchasingOrganization: 'C100', targetLeadTime: '1', infoCategory: 'standard', infoRecordWidth: 10,
      dryRun: false, maxItems: 0, maxRetries: 2, saveEvery: 5, confirmed: true },
    'me01-source-list': { excelPath: 'fixture.xlsx', confirmed: true },
    'apqp-plan-closure': { excelPath: 'fixture.xlsx', sheetName: '', plant: 'C100', system: '', client: '', maxWorkers: 3,
      createSessions: false, maxItems: 0, overwriteExisting: false, confirmed: false }
  }
  for (const id of shared.DEFAULT_TASK_ORDER) await t.test(id, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'hub-intelligence-ipc-'))
    try {
      handlers.clear()
      const logger = { info: async () => {}, error: async () => {}, warning: async () => {}, getEntries: async () => [] }
      const store = new ExecutionHistoryService(join(folder, 'history.json'), logger)
      let time = 0
      let executions = 0
      const service = new LocalIntelligenceService(store, () => {}, () => time)
      const guided = new GuidedAutomationService(join(folder, 'guidance'), () => false)
      guided.onInteraction(request => service.interaction(request))
      const runner = {
        isRunning: () => false, getInteraction: () => null,
        preview: async () => ({ success: true, preview: { selected: 2, invalid: 0 } }),
        run: async (_config, report, context) => {
          executions++
          const rfq = id === 'create-rfq'
          const apqp = id === 'apqp-plan-closure'
          const start = count => rfq ? { type: 'GROUP_STARTED', current: count, total: 2 }
            : apqp ? { event: 'workers', workers: 2, total: 2 }
            : { stage: 'processing', status: 'running', current: count, total: 2, worker: 1 }
          const done = count => rfq ? { type: 'GROUP_COMPLETED', current: count, total: 2, succeeded: count }
            : apqp ? { event: 'record', current: count, total: 2, status: 'SUCCESS' }
            : { stage: 'processing', current: count, total: 2, status: 'success' }
          time = 1000; report({ ...start(1), message: 'Mock start' })
          time = 2000
          if (rfq) report({ type: 'ACTION_REQUIRED', state: 'WAITING_FOR_USER', message: 'Mock manual pause' })
          else await guided.publish({ runId: context.runId, requestId: 'mock-request', automation: 'Mock', state: 'WAITING_FOR_USER',
            allowedActions: ['stop'], message: 'Mock manual pause' }, async () => true)
          time = 302000
          if (rfq) report({ type: 'ACTION_REQUIRED', state: 'RECOVERING', message: 'Mock verification' })
          else await guided.change('mock-request', 'RECOVERING')
          time = 308000
          if (rfq) report({ type: 'INTERACTION_RESOLVED', message: 'Mock resume' })
          else guided.clear('mock-request')
          time = 313000; report({ ...done(1), message: 'Mock completed' })
          if (!apqp) { time = 313500; report({ ...start(2), message: 'Mock second unit' }) }
          time = 316000; report({ ...done(2), message: 'Mock completed' })
          return { success: true, message: 'Mock success', processed: 2, total: 2, succeeded: 2, skipped: 0, failed: 0,
            browserCount: 1, workers: 2, cancelled: false, resultPath: '', backupPath: '' }
        }
      }
      const settings = { getSettings: async () => ({ maxConcurrentSapSessions: 2 }) }
      const excel = { preview: async () => ({ uniqueMaterials: 2 }) }
      if (id === 'create-rfq') load('src/main/ipc/rfq-handlers.ts').registerRfqHandlers(excel, runner, logger, store, '', settings, guided, service)
      if (id === 'me12-batch') load('src/main/ipc/me12-handlers.ts').registerMe12Handlers(excel, runner, logger, store, '', settings, guided, service)
      if (id === 'me01-source-list') load('src/main/ipc/me01-handlers.ts').registerMe01Handlers(excel, runner, logger, store, '', settings, guided, service)
      if (id === 'apqp-plan-closure') load('src/main/ipc/apqp-handlers.ts').registerApqpHandlers(runner, logger, store, settings, '', guided, service)
      const channel = id === 'create-rfq' ? 'rfq:start' : id === 'me12-batch' ? 'me12:start' : id === 'me01-source-list' ? 'me01:start' : 'apqp:start'
      const result = await handlers.get(channel)({ senderFrame: { url: 'file:///renderer/index.html' }, sender: { isDestroyed: () => true } }, configs[id])
      assert.equal(result.success, true); assert.equal(executions, 1)
      const [saved] = await store.getEntries({})
      assert.equal(saved.performance.waitingForUserMs, 306000)
      assert.equal(saved.performance.activeDurationMs, 10000)
      assert.equal(saved.performance.workUnits.completed, 2)
      assert.equal(shared.timingModel([saved], id).historicalRuns, 1)
      assert.equal(service.eta(), null)
      assert.equal(guided.isRunning(), false)
    } finally { await rm(folder, { recursive: true, force: true }) }
  })
})
