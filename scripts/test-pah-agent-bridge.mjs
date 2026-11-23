/* global AbortController, structuredClone */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const modules = new Map()
function load(path) {
  const file = resolve(path)
  if (modules.has(file)) return modules.get(file).exports
  const module = { exports: {} }
  modules.set(file, module)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [] } }
    return name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name)
  }, module, module.exports)
  return module.exports
}
const get = name => load(`src/main/services/${name}.ts`)
const { ApqpDateService } = get('apqp-date-service')
const { ApqpDateQueryOperation } = get('apqp-date-query-operation')
const { ApqpDateCache } = get('apqp-date-cache')
const { ExecutionHistoryService } = get('execution-history-service')
const { GeneratedArtifacts } = get('generated-artifacts')
const { GuidedAutomationService } = get('guided-automation-service')
const { PahJobDispatcher } = get('pah-job-dispatcher')
const { PahJobWorker } = get('pah-job-worker')
const { PahJobOutbox } = get('pah-job-outbox')
const { InMemoryPahJobQueue } = get('pah-job-queue')
const { ApqpRunner } = load('src/main/automation/apqp-runner.ts')
const { APQP_DATE_KEYS, APQP_DATE_SCHEMA } = load('src/shared/apqp-date-types.ts')
const { parsePahRequest, PAH_QUERY_APQP } = load('src/shared/pah-job-types.ts')

const request = { action: PAH_QUERY_APQP, caseKey: 'CASE-401', parameters: { project: '775773' } }
const requester = { tenantId: randomUUID(), objectId: randomUUID() }
const dates = { fPlanDate: null, gPlanDate: '2026-10-20', hPlanDate: '2026-11-30', mPlanDate: null }
const record = { apqp: '2000000000', material: 'M-100', vendor: 'PRIVATE', plant: 'C100', project: '775773',
  dates, readable: true, editable: Object.fromEntries(APQP_DATE_KEYS.map(key => [key, true])) }
const nativeResult = { success: true, resultPath: 'mock-only.json', data: { fieldSchema: APQP_DATE_SCHEMA, records: [record],
  session: { system: 'VCE', client: '100', sapUser: 'BUYER_LOGIN', sessionId: 'private-session' } } }
const approval = signal => ({ requester, sdUser: 'EE00221', sapUser: 'BUYER_LOGIN', projects: ['775773'], signal })

async function setup(t, response, Queue = InMemoryPahJobQueue) {
  const directory = await mkdtemp(join(tmpdir(), 'pah-bridge-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const workerId = randomUUID(), queue = new Queue(), calls = []
  const logs = [], logger = {
    info: async entry => { logs.push(entry) }, error: async entry => { logs.push(entry) },
    warning: async entry => { logs.push(entry) }, getEntries: async () => []
  }
  const history = new ExecutionHistoryService(join(directory, 'history.json'), logger)
  const guided = new GuidedAutomationService(join(directory, 'interactions'), () => false)
  const artifacts = new GeneratedArtifacts(join(directory, 'runs'))
  const cache = new ApqpDateCache(artifacts.directory, history)
  const runner = response === 'native' ? new ApqpRunner({ executable: '',
    script: resolve('scripts/fixtures/apqp-dates-fake-engine.py'), preferScript: true }, artifacts) : {
    dates: async (input, _report, guidance, signal) => {
      assert(guided.isRunning(), 'SAP is reachable only while the real guided lock is held')
      calls.push({ input, runId: guidance.runId })
      return typeof response === 'function' ? response(signal) : structuredClone(response ?? nativeResult)
    }
  }
  const service = new ApqpDateService(runner, Date.now, cache)
  const dispatcher = new PahJobDispatcher(new ApqpDateQueryOperation(service, guided, history, logger))
  const outbox = () => new PahJobOutbox(join(directory, 'outbox'))
  const permit = new AbortController()
  const createWorker = (approveDesktop = async () => approval(permit.signal)) =>
    new PahJobWorker({ workerId, queue, outbox: outbox(), dispatcher, approveDesktop })
  const enqueue = (input = request, identity = requester, submissionId = randomUUID()) =>
    queue.enqueue(input, { workerId, requester: identity, submissionId })
  return { workerId, queue, calls, logs, history, guided, cache, service, outbox, permit, createWorker, enqueue }
}

test('strict job input accepts only the supported action and a project', () => {
  assert.deepEqual(parsePahRequest(request), request)
  for (const fields of [{ jobId: randomUUID() }, { status: 'Queued' }, { requester }, { authorized: true }]) {
    assert.equal(parsePahRequest({ ...request, ...fields }), 'INVALID_JOB')
  }
  for (const parameters of [{ project: 'A B' }, { project: 1 }, { project: 'A\n' },
    { ...request.parameters, userId: 'ADMIN' }, { ...request.parameters, transaction: 'ME21N' }, { ...request.parameters, environment: 'QA' }]) {
    assert.equal(parsePahRequest({ ...request, parameters }), 'INVALID_JOB')
  }
  assert.equal(parsePahRequest({ ...request, action: 'execute' }), 'UNSUPPORTED_ACTION')
})

test('rejects invalid and unsupported jobs before SAP', async t => {
  const fixture = await setup(t), worker = fixture.createWorker()
  const bad = fixture.enqueue({ ...request, parameters: { project: '!' } })
  const unsupported = fixture.enqueue({ ...request, action: 'WRITE_APQP_DATES' })
  await worker.pollOnce()
  await worker.pollOnce()
  assert.equal(fixture.queue.get(bad).completion.errorCode, 'INVALID_JOB')
  assert.equal(fixture.queue.get(unsupported).completion.errorCode, 'UNSUPPORTED_ACTION')
  assert.equal(fixture.calls.length, 0)
})

test('deduplicates producer retries and atomically claims a version only once', async t => {
  const fixture = await setup(t)
  const submissionId = randomUUID()
  const id = fixture.enqueue(request, requester, submissionId)
  assert.notEqual(id, submissionId)
  assert.equal(id, fixture.enqueue(request, requester, submissionId))
  const signal = new AbortController().signal
  const item = await fixture.queue.nextQueued(fixture.workerId, signal)
  const claims = await Promise.all(Array.from({ length: 5 }, () =>
    fixture.queue.claim(item, { workerId: fixture.workerId, claimId: randomUUID(), startedAt: item.queuedAt }, signal)))
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal(fixture.queue.get(id).status, 'Running')
})

test('blocks queue I/O without an approved desktop and defers SAP while the Hub is busy', async t => {
  let scans = 0
  class CountingQueue extends InMemoryPahJobQueue {
    async listRunning(...args) { scans++; return super.listRunning(...args) }
  }
  const fixture = await setup(t, undefined, CountingQueue)
  const id = fixture.enqueue()
  await fixture.createWorker(async () => null).pollOnce()
  assert.equal(scans, 0)
  assert.equal(fixture.queue.get(id).status, 'Queued')
  const lock = fixture.guided.begin()
  const worker = fixture.createWorker()
  await worker.pollOnce()
  assert.equal(fixture.queue.get(id).status, 'Queued')
  assert.equal(fixture.calls.length, 0)
  fixture.guided.end(lock)
  await Promise.all([worker.pollOnce(), worker.pollOnce(), worker.pollOnce()])
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.queue.get(id).status, 'Succeeded')
})

test('rejects other tenants, requesters and projects using trusted operator grants', async t => {
  const fixture = await setup(t), worker = fixture.createWorker()
  for (const [input, identity] of [[request, { ...requester, objectId: randomUUID() }],
    [request, { ...requester, tenantId: randomUUID() }], [{ ...request, parameters: { project: '999' } }, requester]]) {
    const jobId = fixture.enqueue(input, identity)
    await worker.pollOnce()
    assert.equal(fixture.queue.get(jobId).completion.errorCode, 'UNAUTHORIZED')
  }
  assert.equal(fixture.calls.length, 0)
})

test('records a sanitized failure when SAP is unavailable', async t => {
  const fixture = await setup(t, { success: false, errorCode: 'SAP_GUI_UNAVAILABLE', message: 'local diagnostic detail' })
  const jobId = fixture.enqueue()
  await fixture.createWorker().pollOnce()
  const job = fixture.queue.get(jobId)
  assert.equal(job.status, 'Failed')
  assert.equal(job.completion.errorCode, 'SAP_UNAVAILABLE')
  assert.equal(job.completion.result, null)
  assert(!JSON.stringify(job).includes('local diagnostic detail'))
  const [entry] = await fixture.history.getEntries({})
  assert.equal(entry.status, 'Failed')
  assert.equal(entry.agentJobId, jobId)
})

test('records a read-only result and audit IDs without returning SAP identity or editable snapshots', async t => {
  const fixture = await setup(t), worker = fixture.createWorker()
  const submissionId = randomUUID(), jobId = fixture.enqueue(request, requester, submissionId)
  await worker.pollOnce()
  assert.equal(fixture.enqueue(request, requester, submissionId), jobId)
  await worker.pollOnce()
  assert.equal(fixture.calls.length, 1)
  assert.deepEqual(fixture.calls[0].input, { action: 'agent-query', query: { project: '775773', environment: 'PROD', userId: 'EE00221' },
    agentSapUser: 'BUYER_LOGIN' })
  const job = fixture.queue.get(jobId), [entry] = await fixture.history.getEntries({})
  assert.equal(job.completion.status, 'Succeeded')
  assert.deepEqual(job.completion.result.records, [{ apqp: record.apqp, dates }])
  assert.equal(job.completion.runId, entry.diagnosticRunId)
  assert.equal(job.completion.historyId, entry.id)
  assert.equal(entry.agentJobId, jobId)
  assert.equal(entry.apqpDateAction, 'query')
  assert.equal((await fixture.service.execute({ snapshotId: job.completion.runId, edits: [] })).errorCode, 'APQP_DATE_SNAPSHOT_EXPIRED')
  assert.deepEqual(await fixture.outbox().pending(fixture.workerId), [])
})

test('real runner, native date protocol and execution history work with fake SAP objects', async t => {
  const fixture = await setup(t, 'native')
  const jobId = fixture.enqueue()
  const worker = fixture.createWorker(async () => ({ ...approval(fixture.permit.signal), sapUser: 'MOCK_SAP_LOGIN' }))
  await worker.pollOnce()
  const { completion } = fixture.queue.get(jobId)
  assert.equal(completion.status, 'Succeeded', JSON.stringify(await fixture.history.getEntries({})))
  assert.equal(completion.result.records.length, 25)
  const [entry] = await fixture.history.getEntries({})
  const data = JSON.parse(await readFile(entry.resultPath, 'utf8'))
  assert.equal(data.readOnly, true)
  assert.equal(data.writesEnabled, false)
  assert.equal(data.queryEvidence.executeCount, 1)
  assert.equal(data.writeEvents, undefined)
  assert.equal(await fixture.cache.load({ project: '775773', userId: 'EE00221', environment: 'PROD' }), null)
})

for (const committed of [false, true]) {
  test(`retries only result writeback after restart, including commit before a lost reply (${committed})`, async t => {
    let attempts = 0
    class FlakyQueue extends InMemoryPahJobQueue {
      async complete(...args) {
        if (++attempts === 1) {
          if (committed) await super.complete(...args)
          throw new Error('mock timeout')
        }
        await super.complete(...args)
      }
    }
    const fixture = await setup(t, undefined, FlakyQueue)
    const jobId = fixture.enqueue()
    const worker = fixture.createWorker()
    await assert.rejects(worker.pollOnce(), /mock timeout/)
    await worker.stop()
    assert.equal(fixture.queue.get(jobId).status, committed ? 'Succeeded' : 'Running')
    assert.equal((await fixture.outbox().pending(fixture.workerId)).length, 1)
    await fixture.createWorker().pollOnce()
    assert.equal(fixture.queue.get(jobId).status, 'Succeeded')
    assert.equal(attempts, 2)
    assert.equal(fixture.calls.length, 1)
    assert.deepEqual(await fixture.outbox().pending(fixture.workerId), [])
  })
}

test('recovers an interrupted claim as Review Required without replaying it', async t => {
  const fixture = await setup(t)
  const jobId = fixture.enqueue()
  const signal = new AbortController().signal
  const item = await fixture.queue.nextQueued(fixture.workerId, signal)
  await fixture.queue.claim(item, { workerId: fixture.workerId, claimId: randomUUID(), startedAt: item.queuedAt }, signal)
  const worker = fixture.createWorker()
  await worker.pollOnce()
  await worker.pollOnce()
  const job = fixture.queue.get(jobId)
  assert.equal(job.status, 'Review Required')
  assert.equal(job.completion.errorCode, 'OUTCOME_UNCONFIRMED')
  assert.equal(fixture.calls.length, 0)
})

test('never dispatches when a claim committed but its acknowledgment was lost', async t => {
  class LostClaimReply extends InMemoryPahJobQueue {
    async claim(...args) {
      await super.claim(...args)
      throw new Error('claim response lost')
    }
  }
  const fixture = await setup(t, undefined, LostClaimReply)
  const id = fixture.enqueue(), worker = fixture.createWorker()
  await assert.rejects(worker.pollOnce(), /claim response lost/)
  assert.equal(fixture.queue.get(id).status, 'Running')
  await worker.pollOnce()
  assert.equal(fixture.queue.get(id).status, 'Review Required')
  assert.equal(fixture.calls.length, 0)
})

test('revoking desktop approval during the read cancels it and checkpoints Review Required', async t => {
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const fixture = await setup(t, signal => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ success: false, cancelled: true, message: 'Stopped' }), { once: true })
    ready()
  }))
  const jobId = fixture.enqueue(), worker = fixture.createWorker()
  const done = worker.pollOnce()
  await started
  assert.equal(fixture.queue.get(jobId).status, 'Running')
  fixture.permit.abort()
  await done
  assert.equal(fixture.queue.get(jobId).status, 'Running')
  await fixture.createWorker(async () => approval(new AbortController().signal)).pollOnce()
  assert.equal(fixture.queue.get(jobId).completion.errorCode, 'DESKTOP_UNAVAILABLE')
  assert.equal(fixture.calls.length, 1)
})
