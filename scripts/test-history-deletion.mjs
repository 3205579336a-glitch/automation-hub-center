import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const cache = new Map()
function load(path) {
  const file = resolve(path)
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name), module, module.exports)
  cache.set(file, module.exports)
  return module.exports
}
const { RunDiagnosticCleanup } = load('src/main/services/run-diagnostic-cleanup.ts')
const { ExecutionHistoryService } = load('src/main/services/execution-history-service.ts')
const { DiagnosticLogger } = load('src/main/services/diagnostic-logger.ts')
const { LocalIntelligenceService } = load('src/main/services/local-intelligence-service.ts')
const { timingModel, DEFAULT_TASK_ORDER } = load('src/shared/local-intelligence.ts')
const exists = path => stat(path).then(() => true, () => false)

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'hub-history-delete-'))
  const runs = join(folder, 'runs'), interactions = join(folder, 'interactions'), daily = join(folder, 'daily')
  await Promise.all([runs, interactions, daily].map(path => mkdir(path)))
  const logger = new DiagnosticLogger(daily)
  const cleanup = new RunDiagnosticCleanup(runs, interactions)
  const historyPath = join(folder, 'history.json')
  const service = new ExecutionHistoryService(historyPath, logger, (entry, protectedPaths) => cleanup.remove(entry, protectedPaths))
  return { folder, runs, interactions, daily, logger, cleanup, historyPath, service, close: () => rm(folder, { recursive: true, force: true }) }
}

test('delete RFQ diagnostics only; keep result, original, backup and other runs', async () => {
  const f = await fixture()
  try {
    const entry = await f.service.start({ operation: 'create-rfq', label: 'RFQ', summary: 'Test' })
    const run = join(f.runs, entry.id)
    for (const part of ['logs', 'temp', 'output', 'input']) await mkdir(join(run, part), { recursive: true })
    const result = join(run, 'output', 'result.xlsx'), log = join(run, 'output', 'result_log.csv')
    const original = join(f.folder, 'user_original.xlsx'), backup = join(f.folder, 'backup.xlsx')
    for (const path of [result, original, backup, join(run, 'input', 'snapshot.xlsx'), log, join(run, 'logs', 'result_log.csv'), join(run, 'logs', 'engine.log'), join(run, 'logs', 'run.json'), join(run, 'temp', 'checkpoint.json')]) await writeFile(path, 'fixture')
    const otherRun = join(f.runs, randomUUID()); await mkdir(otherRun); await writeFile(join(otherRun, 'engine.log'), 'keep')
    await f.service.finish(entry.id, { status: 'Success', summary: 'Done', resultPath: result, backupPath: backup, logPath: log })
    await f.logger.withRun(entry.id, () => f.logger.info({ category: 'automation', event: 'run.completed', message: 'delete this run' }))
    await f.logger.withRun('other-id', () => f.logger.info({ category: 'automation', event: 'run.completed', message: 'keep other run' }))
    assert.deepEqual(await f.service.deleteEntry(entry.id), [])
    assert.deepEqual(await f.service.getEntries({}), [])
    for (const path of [result, original, backup, join(run, 'input', 'snapshot.xlsx'), join(otherRun, 'engine.log')]) assert(await exists(path))
    for (const path of [join(run, 'logs'), join(run, 'temp'), log]) assert(!(await exists(path)))
    assert.deepEqual((await f.logger.getEntries({})).map(e => e.message), ['keep other run'])
  } finally { await f.close() }
})

test('history deletion removes learning samples and returns to defaults', async () => {
  const f = await fixture()
  try {
    const entry = await f.service.start({ operation: 'me01-source-list', label: 'Source List', summary: 'Test' })
    await f.service.finish(entry.id, { status: 'Success', summary: 'Done', performance: { version: 1, activeDurationMs: 15000, waitingForUserMs: 0,
      startupMs: 5000, unitDurationMs: 10000, concurrency: 1, workUnits: { kind: 'rows', total: 1, completed: 1, learned: 1 }, stepDurations: { startup: 5000, records: 10000 } } })
    const intelligence = new LocalIntelligenceService(f.service, () => {})
    assert.equal((await intelligence.snapshot()).ranking.order[0], 'me01-source-list')
    assert.equal(timingModel(await f.service.getEntries({}), 'me01-source-list').historicalRuns, 1)
    await f.service.deleteEntry(entry.id)
    assert.deepEqual((await intelligence.snapshot()).ranking.order, DEFAULT_TASK_ORDER)
    assert.equal(timingModel(await f.service.getEntries({}), 'me01-source-list').historicalRuns, 0)
  } finally { await f.close() }
})

test('missing diagnostics are harmless; malformed history is preserved', async () => {
  const f = await fixture()
  try {
    const entry = await f.service.start({ operation: 'create-rfq', label: 'RFQ', summary: 'Test' })
    await f.service.finish(entry.id, { status: 'Failed', summary: 'Done' })
    assert.deepEqual(await f.service.deleteEntry(entry.id), [])
    await writeFile(f.historyPath, '{corrupt history')
    await assert.rejects(f.service.deleteEntry(entry.id))
    assert.equal(await readFile(f.historyPath, 'utf8'), '{corrupt history')
  } finally { await f.close() }
})

test('running entries and invalid IDs cannot delete anything; queue recovers', async () => {
  const f = await fixture()
  try {
    const entry = await f.service.start({ operation: 'create-rfq', label: 'RFQ', summary: 'Test' })
    await assert.rejects(f.service.deleteEntry(entry.id), /Running/)
    await assert.rejects(f.service.deleteEntry('../../history.json'))
    await f.service.finish(entry.id, { status: 'Cancelled', summary: 'Done' })
    await f.service.deleteEntry(entry.id)
    assert.equal((await f.service.getEntries({})).length, 0)
  } finally { await f.close() }
})

test('junctions and external paths are never followed or erased', async () => {
  const f = await fixture()
  try {
    const id = randomUUID(), run = join(f.runs, id), outside = join(f.folder, 'outside')
    await mkdir(run); await mkdir(outside)
    await writeFile(join(outside, 'keep.log'), 'keep')
    await symlink(outside, join(run, 'logs'), process.platform === 'win32' ? 'junction' : 'dir')
    const warnings = await f.cleanup.remove({ id, operation: 'create-rfq', resultPath: join(outside, 'keep.log'), logPath: join(outside, 'keep.log') })
    assert(warnings.length)
    assert.equal(await readFile(join(outside, 'keep.log'), 'utf8'), 'keep')
    assert(await exists(join(run, 'logs')))
    assert.deepEqual(await f.cleanup.remove({ id: '../../outside', operation: 'create-rfq' }), [])
  } finally { await f.close() }
})

test('preserve result even in an unusual diagnostic location; keep uncorrelated legacy logs', async () => {
  const f = await fixture()
  try {
    const id = randomUUID(), run = join(f.runs, id)
    await mkdir(join(run, 'logs'), { recursive: true })
    const result = join(run, 'logs', 'business_result.xlsx')
    await writeFile(result, 'keep')
    const warnings = await f.cleanup.remove({ id, operation: 'create-rfq', resultPath: result })
    assert(warnings.length); assert(await exists(result))
    const log = join(f.daily, 'sap-toolbox-2026-10-09.jsonl')
    await writeFile(log, 'not-json\n' + JSON.stringify({ id: 'legacy', timestamp: 'today', category: 'automation', level: 'info', event: 'old', message: 'legacy' }) + '\n')
    const before = await readFile(log, 'utf8')
    await f.logger.deleteRun(id)
    assert.equal(await readFile(log, 'utf8'), before)
  } finally { await f.close() }
})

test('only identified guided interaction directory is removed', async () => {
  const f = await fixture()
  try {
    const id = randomUUID(), other = randomUUID()
    await mkdir(join(f.interactions, id)); await mkdir(join(f.interactions, other))
    await writeFile(join(f.interactions, id, 'checkpoint.json'), '{}')
    await writeFile(join(f.interactions, other, 'checkpoint.json'), '{}')
    await f.cleanup.remove({ id: randomUUID(), operation: 'me01-source-list', diagnosticRunId: id })
    assert(!(await exists(join(f.interactions, id))))
    assert(await exists(join(f.interactions, other)))
  } finally { await f.close() }
})

test('SAP_SLOW remains active time; Commodity WAIT/recheck is excluded', async () => {
  const f = await fixture()
  try {
    let time = 0
    const service = new LocalIntelligenceService({ getEntries: async () => [] }, () => {}, () => time)
    service.begin('mock', 'create-rfq', 'mock', 1)
    time = 5000; service.observe('mock', { type: 'GROUP_STARTED', current: 1, total: 1 })
    time = 25000; service.observe('mock', { type: 'SAP_SLOW', state: 'SAP_SLOW', stage: 'processing' })
    assert.notEqual(service.eta().remainingMs, null)
    time = 30000; service.observe('mock', { type: 'ACTION_REQUIRED', state: 'WAITING_FOR_USER', recoveryPoint: 'COMMODITY_MISSING' })
    assert.equal(service.eta().remainingMs, null)
    time = 90000; service.observe('mock', { type: 'RECOVERING', state: 'RECOVERING' })
    time = 95000; service.observe('mock', { type: 'INTERACTION_RESOLVED', state: 'RUNNING' })
    time = 115000; service.observe('mock', { type: 'GROUP_COMPLETED', current: 1, total: 1, succeeded: 1 })
    const sample = service.finish('mock', 'Success')
    assert.equal(sample.activeDurationMs, 50000)
    assert.equal(sample.waitingForUserMs, 65000)
  } finally { await f.close() }
})

test('history pagination filters before slicing and returns the true total', async () => {
  const f = await fixture()
  try {
    const rows = Array.from({ length: 61 }, (_, i) => ({ id: randomUUID(), operation: i === 0 ? 'open-sap' : 'create-rfq',
      label: `batch-${i}`, summary: 'fixture', status: i % 2 ? 'Success' : 'Failed', startedAt: new Date().toISOString() }))
    await writeFile(f.historyPath, JSON.stringify(rows))
    const first = await f.service.getPage({ operations: ['create-rfq'], limit: 25 })
    const second = await f.service.getPage({ operations: ['create-rfq'], limit: 25, offset: 25 })
    assert.equal(first.total, 60); assert.equal(second.total, 60)
    assert.equal(first.entries.length, 25); assert.equal(second.entries.length, 25)
    assert.equal(second.entries[0].label, 'batch-26')
    assert(!first.entries.some(row => second.entries.some(other => other.id === row.id)))
    assert.equal((await f.service.getPage({ statuses: ['Success'], offset: 25, limit: 25 })).entries.length, 5)
    assert.equal((await f.service.getPage({ search: 'batch-60', offset: 0, limit: 25 })).total, 1)
  } finally { await f.close() }
})

test('diagnostic pagination skips matching entries, not raw lines', async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 45; i++) await f.logger.log({ category: 'automation', event: `event-${i}`, message: 'fixture', level: i % 2 ? 'error' : 'info' })
    const first = await f.logger.getEntries({ levels: ['error'], limit: 20 })
    const second = await f.logger.getEntries({ levels: ['error'], offset: 20, limit: 20 })
    assert.equal(first.length, 20); assert.equal(second.length, 2)
    assert(!first.some(row => second.some(other => row.id === other.id)))
    assert.equal((await f.logger.getEntries({ search: 'event-0', offset: 0, limit: 20 })).length, 1)
  } finally { await f.close() }
})

test('bulk clear removes every completed history/identified log, protects results and unfinished runs', async () => {
  const f = await fixture()
  try {
    const completed = await f.service.start({ operation: 'create-rfq', label: 'RFQ', summary: 'fixture' })
    const run = join(f.runs, completed.id)
    await mkdir(join(run, 'logs'), { recursive: true }); await mkdir(join(run, 'output'))
    const result = join(run, 'output', 'result.xlsx')
    await writeFile(result, 'keep'); await writeFile(join(run, 'logs', 'engine.log'), 'delete')
    await f.service.finish(completed.id, { status: 'Success', summary: 'done', resultPath: result })
    const running = await f.service.start({ operation: 'apqp-plan-closure', label: 'APQP', summary: 'unfinished' })
    await f.logger.withRun(running.id, () => f.logger.info({ category: 'automation', event: 'unfinished', message: 'keep' }))
    await f.logger.info({ category: 'application', event: 'unattributed', message: 'delete too' })
    await writeFile(join(f.daily, 'not-an-app-file.xlsx'), 'keep')
    const report = await f.service.clear()
    assert.equal(report.deleted, 1); assert(report.warnings.length)
    assert.deepEqual((await f.service.getEntries({})).map(e => e.id), [running.id])
    assert.deepEqual((await f.logger.getEntries({})).map(e => e.message), ['keep'])
    assert(await exists(result)); assert(await exists(join(f.daily, 'not-an-app-file.xlsx')))
    assert(!(await exists(join(run, 'logs', 'engine.log'))))
  } finally { await f.close() }
})

test('60-day retention uses completion date, preserves exact boundary/recent/invalid dates and running logs', async () => {
  const f = await fixture()
  try {
    const cutoff = Date.parse('2030-01-01T00:00:00Z') - 60 * 86400_000
    const old = new Date(cutoff - 1).toISOString(), boundary = new Date(cutoff).toISOString()
    const rows = [
      { id: randomUUID(), label: 'old', startedAt: old, completedAt: old, status: 'Success' },
      { id: randomUUID(), label: 'boundary', startedAt: old, completedAt: boundary, status: 'Failed' },
      { id: randomUUID(), label: 'recent', startedAt: old, completedAt: '2030-01-01T00:00:00Z', status: 'Cancelled' },
      { id: randomUUID(), label: 'unfinished', startedAt: old, status: 'Running' },
      { id: randomUUID(), label: 'invalid-date', startedAt: 'unknown', status: 'Success' }
    ].map(row => ({ ...row, operation: 'create-rfq', summary: 'fixture' }))
    await writeFile(f.historyPath, JSON.stringify(rows))
    const daily = join(f.daily, 'sap-toolbox-2029-01-01.jsonl')
    await writeFile(daily, rows.slice(0, 4).map(row => JSON.stringify({ id: randomUUID(), timestamp: row.completedAt || old,
      category: 'automation', level: 'info', event: row.label, message: row.label, details: { runId: row.id } })).join('\n') + '\nmalformed legacy line\n')
    const report = await f.service.clear(cutoff)
    assert.equal(report.deleted, 1)
    assert.deepEqual((await f.service.getEntries({})).map(row => row.label), ['boundary', 'recent', 'unfinished', 'invalid-date'])
    assert.deepEqual((await f.logger.getEntries({})).map(row => row.event), ['unfinished', 'recent', 'boundary'])
    assert((await readFile(daily, 'utf8')).includes('malformed legacy line'))
  } finally { await f.close() }
})

test('bulk deletion preserves corrupt history and every diagnostic; subsequent queue work recovers', async () => {
  const f = await fixture()
  try {
    await f.logger.info({ category: 'application', event: 'test', message: 'preserve' })
    await writeFile(f.historyPath, '{corrupt')
    await assert.rejects(f.service.clear())
    assert.equal(await readFile(f.historyPath, 'utf8'), '{corrupt')
    assert.equal((await f.logger.getEntries({})).length, 1)
    assert.equal(f.service.isCleaning(), false)
    await writeFile(f.historyPath, '[]')
    await f.service.clear()
    assert.deepEqual(await f.logger.getEntries({}), [])
  } finally { await f.close() }
})

test('bulk cleanup lease stays held and duplicate cleanup is rejected until completion', async () => {
  const f = await fixture()
  try {
    const entry = await f.service.start({ operation: 'me01-source-list', label: 'Source List', summary: 'fixture' })
    await f.service.finish(entry.id, { status: 'Success', summary: 'done' })
    let release
    const blocker = new Promise(resolve => { release = resolve })
    const service = new ExecutionHistoryService(f.historyPath, f.logger, () => blocker.then(() => []))
    const work = service.clear()
    assert(service.isCleaning())
    await assert.rejects(service.clear(), /in progress/)
    release(); await work
    assert.equal(service.isCleaning(), false)
  } finally { await f.close() }
})

test('bulk logger purge does not follow a junction or delete unrelated files', async () => {
  const f = await fixture()
  try {
    const outside = join(f.folder, 'outside'); await mkdir(outside)
    await writeFile(join(outside, 'sap-toolbox-2026-10-09.jsonl'), 'keep')
    const linked = join(f.folder, 'linked-logs')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const logger = new DiagnosticLogger(linked)
    assert((await logger.purge()).length)
    assert.equal(await readFile(join(outside, 'sap-toolbox-2026-10-09.jsonl'), 'utf8'), 'keep')
  } finally { await f.close() }
})

test('page query validators reject invalid offsets, excessive page sizes and arbitrary operations', () => {
  const { isExecutionHistoryQuery } = load('src/shared/execution-history-types.ts')
  const { isDiagnosticLogQuery } = load('src/shared/diagnostic-types.ts')
  for (const query of [{ offset: -1 }, { offset: 1.1 }, { offset: 100001 }, { limit: 501 }]) {
    assert.equal(isExecutionHistoryQuery(query), false); assert.equal(isDiagnosticLogQuery(query), false)
  }
  assert.equal(isExecutionHistoryQuery({ offset: 25, limit: 25, operations: ['create-rfq'] }), true)
  assert.equal(isExecutionHistoryQuery({ operations: ['../../files'] }), false)
})

test('bulk cleanup IPC rejects active runs, untrusted renderers and legacy individual IDs', async () => {
  const file = resolve('src/main/ipc/history-handlers.ts')
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const handlers = new Map(), module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => name === 'electron'
    ? { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } }
    : name === './ipc-security' ? { isTrustedRenderer: event => event.trusted }
      : load(join(dirname(file), name + '.ts')), module, module.exports)
  let running = false, calls = 0
  module.exports.registerHistoryHandlers({ clear: async () => { calls++; return { deleted: 4, warnings: [] } }, getPage: async query => ({ entries: [], total: query.offset }) }, {}, () => running)
  const clear = handlers.get('history:delete')
  assert.equal((await clear({ trusted: false })).success, false)
  assert.equal((await clear({ trusted: true }, randomUUID())).success, false)
  running = true
  assert.equal((await clear({ trusted: true })).success, false)
  assert.equal(calls, 0)
  running = false
  assert.equal((await clear({ trusted: true })).deleted, 4)
  assert.equal(calls, 1)
  assert.deepEqual(await handlers.get('history:get')({ trusted: true }, { offset: 25, limit: 25 }), { entries: [], total: 25 })
})

test('bulk cleanup protects results belonging to another retained record, including non-workbook extensions', async () => {
  const f = await fixture()
  try {
    const first = await f.service.start({ operation: 'create-rfq', label: 'RFQ', summary: 'fixture' })
    const logs = join(f.runs, first.id, 'logs'); await mkdir(logs, { recursive: true })
    const result = join(logs, 'business-result.txt'); await writeFile(result, 'keep business data')
    await f.service.finish(first.id, { status: 'Success', summary: 'done' })
    const other = await f.service.start({ operation: 'apqp-plan-closure', label: 'APQP', summary: 'fixture' })
    await f.service.finish(other.id, { status: 'Success', summary: 'done', resultPath: result })
    const report = await f.service.clear()
    assert.equal(report.deleted, 2); assert(report.warnings.length)
    assert.equal(await readFile(result, 'utf8'), 'keep business data')
  } finally { await f.close() }
})

test('shared logger failure reports a partial cleanup instead of claiming history was not removed', async () => {
  const f = await fixture()
  try {
    const entry = await f.service.start({ operation: 'me01-source-list', label: 'Source List', summary: 'fixture' })
    await f.service.finish(entry.id, { status: 'Success', summary: 'done' })
    f.logger.purge = async () => { throw new Error('logs unavailable') }
    const report = await f.service.clear()
    assert.equal(report.deleted, 1); assert(report.warnings.length)
    assert.deepEqual(await f.service.getEntries({}), [])
  } finally { await f.close() }
})
