/* global AbortController, Response, ReadableStream */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { URL } from 'node:url'
import { loadPahModule as load } from './fixtures/load-pah-module.mjs'

const service = name => load(`src/main/services/${name}.ts`)
const { PahGraphJobQueue } = service('pah-graph-job-queue')
const { PahJobWorker } = service('pah-job-worker')
const { PahJobOutbox } = service('pah-job-outbox')
const { PahJobDispatcher } = service('pah-job-dispatcher')
const { APQP_DATE_SCHEMA } = load('src/shared/apqp-date-types.ts')
const { PAH_QUERY_APQP } = load('src/shared/pah-job-types.ts')

const host = 'pah-test.sharepoint.com'
const siteCollectionId = randomUUID(), webId = randomUUID()
const siteId = [host, siteCollectionId, webId].join(',')
const listId = randomUUID(), workerId = randomUUID(), ingressApplicationId = randomUUID()
const requester = { tenantId: randomUUID(), objectId: randomUUID() }
const listPath = `/v1.0/sites/${siteId}/lists/${listId}/items`
const token = 'fixture-token'
const starts = '2026-11-23T06:10:06.123Z'
const completed = '2026-11-23T06:10:10.456Z'
const jobRequest = { action: PAH_QUERY_APQP, caseKey: 'CASE-401', parameters: { project: '775773' } }
const result = { schema: APQP_DATE_SCHEMA, readAt: completed, records: [{
  apqp: '2000000000', dates: { fPlanDate: null, gPlanDate: '2026-11-20', hPlanDate: '2026-12-01', mPlanDate: null }
}] }
const finish = { status: 'Succeeded', errorCode: null, completedAt: completed, result, runId: randomUUID(), historyId: randomUUID() }
const makeClaim = () => ({ workerId, claimId: randomUUID(), startedAt: starts })
const signal = () => new AbortController().signal
const code = name => { return { code: name } }
const json = (body, status = 200) => Response.json(body, { status })
const digest = invocationId => createHash('sha256').update(JSON.stringify([requester.tenantId, requester.objectId, invocationId])).digest('hex')

function queueRow(id, overrides = {}) {
  const jobId = randomUUID()
  return {
    id: String(id), eTag: `"{${randomUUID()}},1"`, createdBy: { application: { id: ingressApplicationId } },
    sharepointIds: { siteId: siteCollectionId, webId, siteUrl: `https://${host}/sites/pah`, listId, listItemId: String(id), tenantId: requester.tenantId },
    fields: { Title: jobId, JobId: jobId, SubmissionKey: digest(randomUUID()), Action: jobRequest.action, CaseKey: jobRequest.caseKey,
      ParametersJson: JSON.stringify(jobRequest.parameters), RequesterTenantId: requester.tenantId, RequesterObjectId: requester.objectId,
      WorkerId: workerId, JobStatus: 'Queued', QueuedAt: '2026-11-23T06:10:02.321Z', ...overrides }
  }
}

class MockGraph {
  rows = []
  calls = []
  auth = []
  pageSize = 25
  middleware = (_call, forward) => forward()

  create(fields = {}) {
    const row = queueRow(this.rows.length + 1, fields)
    this.rows.push(row)
    return row
  }

  queue(options = {}) {
    return new PahGraphJobQueue({
      siteId, listId, workerId, requester, ingressApplicationId, client: this,
      authentication: { getAccessToken: async input => {
        input.signal.throwIfAborted()
        this.auth.push({ tenantId: input.tenantId, scope: input.scope })
        return token
      } },
      ...options
    })
  }

  async fetch(address, options) {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    options.signal.throwIfAborted()
    const url = new URL(address)
    assert.equal(url.origin, 'https://graph.microsoft.com')
    const call = { method: options.method, url, etag: options.headers['If-Match'],
      fields: options.body ? JSON.parse(options.body) : null, signal: options.signal }
    this.calls.push(call)
    const response = await this.middleware(call, () => this.respond(call))
    call.status = response.status
    return response
  }

  respond({ method, url, etag, fields, signal: active }) {
    active.throwIfAborted()
    if (method === 'GET') {
      if (url.pathname !== listPath) return json({ error: 'Pinned queue not found' }, 404)
      const filter = url.searchParams.get('$filter')
      const match = /^fields\/(JobStatus|JobId|SubmissionKey) eq '([^']+)'$/.exec(filter)
      assert(match, 'Use a single indexed field in Graph filters')
      const [, key, value] = match
      const offset = Number(url.searchParams.get('$skiptoken') ?? 0)
      const matching = this.rows.filter(row => row.fields[key] === value)
      const page = { value: matching.slice(offset, offset + this.pageSize) }
      if (offset + this.pageSize < matching.length) {
        const next = new URL(url)
        next.pathname = next.pathname.replaceAll(',', '%2C')
        next.searchParams.set('$skiptoken', String(offset + this.pageSize))
        page['@odata.nextLink'] = next.href
      }
      return json(page)
    }
    assert.equal(method, 'PATCH')
    const match = /\/items\/([1-9][0-9]*)\/fields$/.exec(url.pathname)
    assert(match)
    assert.equal(url.pathname, `${listPath}/${match[1]}/fields`)
    const row = this.rows.find(item => item.id === match[1])
    if (!row) return json({}, 404)
    if (etag !== row.eTag) return json({}, 412)
    row.fields = { ...row.fields, ...fields }
    row.eTag = `"{${randomUUID()}},2"`
    return json(row.fields)
  }

  patches() { return this.calls.filter(call => call.method === 'PATCH') }
}

test('gets the oldest eligible queued item across pages and maps Running claims', async () => {
  const graph = new MockGraph()
  graph.pageSize = 1
  graph.create({ QueuedAt: '2026-11-23T06:10:05.987Z' })
  const older = graph.create()
  const claim = makeClaim()
  const running = graph.create({ JobStatus: 'Running', ClaimId: claim.claimId, StartedAt: claim.startedAt })
  const queue = graph.queue()
  assert.deepEqual(await queue.nextQueued(workerId, signal()), { jobId: older.fields.JobId, requester,
    request: jobRequest, queuedAt: older.fields.QueuedAt, status: 'Queued', revision: older.eTag })
  assert.deepEqual(await queue.listRunning(workerId, signal()), [{ jobId: running.fields.JobId, requester,
    request: jobRequest, queuedAt: running.fields.QueuedAt, status: 'Running', claim }])
  assert.equal(graph.calls.length, 3)
  assert.deepEqual(graph.auth[0], { tenantId: requester.tenantId, scope: 'https://graph.microsoft.com/.default' })
  assert.match(graph.calls[0].url.searchParams.get('$expand'), /SubmissionKey/)
})

test('concurrent workers have one conditional claim winner and never reclaim a running job', async () => {
  const graph = new MockGraph(), row = graph.create(), first = graph.queue(), second = graph.queue()
  const item = await first.nextQueued(workerId, signal())
  const etag = row.eTag
  let release
  const bothAtPatch = new Promise(resolve => { release = resolve })
  graph.middleware = async (call, forward) => {
    if (call.method === 'PATCH') {
      if (graph.patches().length === 2) release()
      await bothAtPatch
    }
    return forward()
  }
  const claims = [makeClaim(), makeClaim()]
  const winners = await Promise.all([first.claim(item, claims[0], signal()), second.claim(item, claims[1], signal())])
  assert.equal(winners.filter(Boolean).length, 1)
  assert.deepEqual(graph.patches().map(call => call.status).sort(), [200, 412])
  for (const call of graph.patches()) assert.equal(call.etag, etag)
  assert.equal(row.fields.ClaimId, claims[winners.indexOf(true)].claimId)
  assert.equal(await first.nextQueued(workerId, signal()), null)
  assert.equal(await first.claim(item, makeClaim(), signal()), false)
  assert.equal(graph.patches().length, 2)
})

test('rejects a fabricated queue item and refuses an unconfirmed claim response', async () => {
  const graph = new MockGraph(), row = graph.create(), queue = graph.queue()
  const item = await queue.nextQueued(workerId, signal())
  await assert.rejects(queue.claim({ ...item, request: { ...jobRequest, caseKey: 'CHANGED' } }, makeClaim(), signal()), code('INVALID_ITEM'))
  assert.equal(graph.patches().length, 0)
  graph.middleware = (call, forward) => {
    if (call.method !== 'PATCH') return forward()
    forward()
    return json({ JobStatus: 'Running' })
  }
  await assert.rejects(queue.claim(item, makeClaim(), signal()), code('INVALID_RESPONSE'))
  assert.equal(row.fields.JobStatus, 'Running')
})

test('rejects malformed SharePoint records and disallowed fields/actions', async () => {
  for (const mutate of [
    row => { row.eTag = '*' },
    row => { row.eTag = '"safe"\r\nIf-Match: *' },
    row => { row.fields.ParametersJson = { project: '775773' } },
    row => { row.fields.ParametersJson = '{broken' },
    row => { row.fields.ParametersJson = JSON.stringify({ project: '775773', sapUser: 'ADMIN', approved: true }) },
    row => { row.fields.ParametersJson = JSON.stringify({ project: '775773', workerId, requester }) },
    row => { row.fields.ParametersJson = JSON.stringify({ project: '775773', transaction: 'ME21N' }) },
    row => { row.fields.Action = 'WRITE_APQP_DATES' },
    row => { row.fields.QueuedAt = '2026-11-23T06:10:02Z' },
    row => { row.fields.ClaimId = randomUUID() },
    row => { row.fields.ResultJson = 'false' }
  ]) {
    const graph = new MockGraph(), row = graph.create()
    mutate(row)
    await assert.rejects(graph.queue().nextQueued(workerId, signal()), code('INVALID_ITEM'))
    assert.equal(graph.patches().length, 0)
  }
})

test('rejects untrusted ingress, requester and routing metadata independently of request fields', async () => {
  for (const mutate of [
    row => { row.createdBy = { user: { id: requester.objectId } } },
    row => { row.createdBy.application.id = randomUUID() },
    row => { row.fields.RequesterObjectId = randomUUID() },
    row => { row.fields.RequesterTenantId = randomUUID() },
    row => { row.fields.WorkerId = randomUUID() },
    row => { row.sharepointIds.siteId = randomUUID() },
    row => { row.sharepointIds.listId = randomUUID() },
    row => { row.sharepointIds.tenantId = randomUUID() }
  ]) {
    const graph = new MockGraph(), row = graph.create()
    mutate(row)
    await assert.rejects(graph.queue().nextQueued(workerId, signal()), code('UNTRUSTED_ITEM'))
    assert.equal(graph.patches().length, 0)
  }
  const graph = new MockGraph(), queue = graph.queue()
  for (const call of [() => queue.nextQueued(randomUUID(), signal()), () => queue.listRunning(randomUUID(), signal()),
    () => queue.claim({}, { ...makeClaim(), workerId: randomUUID() }, signal()),
    () => queue.complete(randomUUID(), { ...makeClaim(), workerId: randomUUID() }, finish, signal())]) {
    await assert.rejects(call(), code('UNAUTHORIZED_WORKER'))
  }
  assert.deepEqual(graph.calls, [])
})

test('detects duplicate job IDs and duplicate submission keys, including a prior terminal submission', async () => {
  const historicalClaim = makeClaim()
  for (const duplicate of ['JobId', 'SubmissionKey']) {
    const graph = new MockGraph(), original = graph.create()
    const queue = graph.queue()
    const item = await queue.nextQueued(workerId, signal())
    const copy = graph.create({ JobStatus: 'Failed', ClaimId: historicalClaim.claimId, StartedAt: historicalClaim.startedAt,
      CompletedAt: completed, ErrorCode: 'QUERY_FAILED', [duplicate]: original.fields[duplicate] })
    if (duplicate === 'JobId') copy.fields.Title = copy.fields.JobId
    await assert.rejects(queue.claim(item, makeClaim(), signal()), code('DUPLICATE_ITEM'))
    assert.equal(graph.patches().length, 0)
    copy.fields.JobStatus = 'Queued'
    for (const key of ['ClaimId', 'StartedAt', 'CompletedAt', 'ErrorCode']) delete copy.fields[key]
    await assert.rejects(queue.nextQueued(workerId, signal()), code('DUPLICATE_ITEM'))
  }
})

test('fails closed on bad configuration, unknown site/list and untrusted pagination', async () => {
  const graph = new MockGraph()
  for (const options of [
    { siteId: 'pah-test.sharepoint.com,invalid,invalid' }, { siteId: siteId + ',extra' }, { listId: '../other' },
    { authentication: null }, { requester: { ...requester, objectId: 'world' } }, { operationTimeoutMs: Infinity }
  ]) assert.throws(() => graph.queue(options), code('INVALID_CONFIGURATION'))
  for (const options of [{ siteId: [host, randomUUID(), webId].join(',') }, { listId: randomUUID() }]) {
    await assert.rejects(graph.queue(options).nextQueued(workerId, signal()), code('RESOURCE_UNAVAILABLE'))
  }
  for (const nextLink of [`https://unexpected.example${listPath}?$skip=x`,
    `https://graph.microsoft.com${listPath.replace(listId, randomUUID())}?$skip=x`,
    `https://wrong@graph.microsoft.com${listPath}?$skip=x`]) {
    graph.calls.length = 0
    graph.middleware = () => json({ value: [], '@odata.nextLink': nextLink })
    await assert.rejects(graph.queue().nextQueued(workerId, signal()), code('UNSAFE_PAGE'))
    assert.equal(graph.calls.length, 1)
  }
  graph.middleware = call => json({ value: [], '@odata.nextLink': call.url.href })
  await assert.rejects(graph.queue().nextQueued(workerId, signal()), code('UNSAFE_PAGE'))
  graph.middleware = () => json({ value: [], '@odata.nextLink': `https://graph.microsoft.com${listPath}?$skip=x` })
  await assert.rejects(graph.queue({ maxPages: 1 }).nextQueued(workerId, signal()), code('PAGE_LIMIT'))
})

test('honors Retry-After for reads and explicitly throttled conditional writes', async () => {
  const graph = new MockGraph()
  const row = graph.create()
  let firstRead
  let retriedRead
  graph.middleware = (_call, forward) => {
    if (firstRead === undefined) {
      firstRead = Date.now()
      return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
    }
    retriedRead = Date.now()
    return forward()
  }
  const queue = graph.queue()
  const item = await queue.nextQueued(workerId, signal())
  assert(retriedRead - firstRead >= 950)
  graph.middleware = (call, forward) => {
    if (call.method === 'PATCH' && graph.patches().length === 1) {
      return new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
    }
    return forward()
  }
  assert.equal(await queue.claim(item, makeClaim(), signal()), true)
  assert.equal(row.fields.JobStatus, 'Running')
  assert.equal(graph.patches().length, 2)
  assert.equal(graph.patches()[0].etag, graph.patches()[1].etag)
  graph.calls.length = 0
  graph.middleware = () => new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
  await assert.rejects(queue.nextQueued(workerId, signal()), code('THROTTLED'))
  assert.equal(graph.calls.length, 3)
})

test('retains a server cooldown across polls and can abort while waiting for a retry', async () => {
  const graph = new MockGraph(), queue = graph.queue()
  graph.middleware = () => new Response(null, { status: 429, headers: { 'Retry-After': new Date(Date.now() + 60_000).toUTCString() } })
  await assert.rejects(queue.nextQueued(workerId, signal()), code('THROTTLED'))
  await assert.rejects(queue.nextQueued(workerId, signal()), code('THROTTLED'))
  assert.equal(graph.calls.length, 1)

  const controller = new AbortController()
  graph.calls.length = 0
  graph.middleware = () => new Response(null, { status: 429, headers: { 'Retry-After': '5' } })
  const query = graph.queue().nextQueued(workerId, controller.signal)
  await delay(20)
  controller.abort()
  await assert.rejects(query, code('ABORTED'))
  assert.equal(graph.calls.length, 1)
})

test('bounds unresponsive authentication, Graph requests and response streams', async () => {
  const graph = new MockGraph()
  const timed = { requestTimeoutMs: 25 }
  let finishToken
  const authentication = { getAccessToken: () => new Promise(resolve => { finishToken = resolve }) }
  await assert.rejects(graph.queue({ ...timed, authentication }).nextQueued(workerId, signal()), code('TIMEOUT'))
  finishToken(token)
  await delay(0)
  assert.equal(graph.calls.length, 0)
  graph.middleware = () => new Promise(() => undefined)
  await assert.rejects(graph.queue(timed).nextQueued(workerId, signal()), code('TIMEOUT'))
  assert(graph.calls.at(-1).signal.aborted)
  let cancelled = false
  graph.middleware = () => new Response(new ReadableStream({ cancel() { cancelled = true } }))
  await assert.rejects(graph.queue(timed).nextQueued(workerId, signal()), code('TIMEOUT'))
  assert(cancelled)
  graph.middleware = () => new Response(null, { status: 200, headers: { 'Content-Length': '4000001' } })
  await assert.rejects(graph.queue().nextQueued(workerId, signal()), code('INVALID_RESPONSE'))
})

test('does not retry expired credentials, aborted calls, or uncertain PATCH responses', async () => {
  const graph = new MockGraph(), queue = graph.queue(), row = graph.create()
  graph.middleware = () => json({ error: token }, 401)
  await assert.rejects(queue.nextQueued(workerId, signal()), code('ACCESS_DENIED'))
  assert.equal(graph.calls.length, 1)
  graph.middleware = (_call, forward) => forward()
  const item = await queue.nextQueued(workerId, signal())
  const controller = new AbortController()
  controller.abort(new Error(token))
  await assert.rejects(queue.claim(item, makeClaim(), controller.signal), error => error.code === 'ABORTED' && !error.message.includes(token))
  assert.equal(graph.patches().length, 0)
  graph.middleware = (call, forward) => {
    if (call.method !== 'PATCH') return forward()
    forward()
    throw new Error(token)
  }
  await assert.rejects(queue.claim(item, makeClaim(), signal()), error => error.code === 'REQUEST_FAILED' && !error.message.includes(token))
  assert.equal(graph.patches().length, 1)
  assert.equal(row.fields.JobStatus, 'Running')
  assert.equal(await queue.claim(item, makeClaim(), signal()), false)
})

test('completion requires the exact claim and is idempotent across restarts and JSON key order', async () => {
  const graph = new MockGraph(), row = graph.create(), queue = graph.queue()
  const item = await queue.nextQueued(workerId, signal())
  const claim = makeClaim()
  await queue.claim(item, claim, signal())
  await assert.rejects(queue.complete(item.jobId, { ...claim, startedAt: '2026-11-23T06:10:01.000Z' }, finish, signal()), code('CONFLICT'))
  await queue.complete(item.jobId, claim, finish, signal())
  assert.equal(row.fields.JobStatus, 'Succeeded')
  assert.equal(row.fields.CompletedAt, finish.completedAt)
  assert.deepEqual(JSON.parse(row.fields.ResultJson), result)
  row.fields.ResultJson = JSON.stringify({ records: result.records, readAt: result.readAt, schema: result.schema })
  await graph.queue().complete(item.jobId, claim, finish, signal())
  await assert.rejects(queue.complete(item.jobId, claim, { ...finish, result: { ...result, records: [] } }, signal()), code('CONFLICT'))
  assert.equal(graph.patches().length, 2)
})

test('a completion ETag conflict accepts only a matching winner', async () => {
  for (const matching of [true, false]) {
    const graph = new MockGraph(), row = graph.create(), queue = graph.queue()
    const item = await queue.nextQueued(workerId, signal()), claim = makeClaim()
    await queue.claim(item, claim, signal())
    graph.middleware = (call, forward) => {
      if (call.method !== 'PATCH') return forward()
      forward()
      if (!matching) row.fields.HubRunId = randomUUID()
      return json({}, 412)
    }
    const completion = queue.complete(item.jobId, claim, finish, signal())
    if (matching) await completion
    else await assert.rejects(completion, code('CONFLICT'))
    assert.equal(graph.patches().length, 2)
  }
})

test('an incomplete successful PATCH response needs a terminal read before acknowledging an outcome', async () => {
  const graph = new MockGraph(), queue = graph.queue()
  graph.create()
  const item = await queue.nextQueued(workerId, signal()), claim = makeClaim()
  await queue.claim(item, claim, signal())
  graph.middleware = (call, forward) => {
    if (call.method !== 'PATCH') return forward()
    forward()
    return json({ JobStatus: 'Succeeded' })
  }
  await assert.rejects(queue.complete(item.jobId, claim, finish, signal()), code('INVALID_RESPONSE'))
  await graph.queue().complete(item.jobId, claim, finish, signal())
  assert.equal(graph.patches().length, 2)
})

async function workerSetup(t, graph) {
  const path = await mkdtemp(join(tmpdir(), 'pah-graph-outbox-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  const outbox = new PahJobOutbox(path), calls = []
  const dispatcher = new PahJobDispatcher({ reserveAgentQuery: (input, jobId, read) => ({
    release: () => undefined,
    run: async () => {
      calls.push({ input, jobId, sapUser: read.sapUser })
      return {
        runId: finish.runId, historyId: finish.historyId,
        result: { success: true, snapshot: { createdAt: result.readAt, records: result.records } }
      }
    }
  }) })
  return { calls, outbox, worker: (identity = requester) => new PahJobWorker({ outbox, queue: graph.queue(), dispatcher,
    workerId, approveDesktop: async () => ({ requester: identity, sapUser: 'FAKE_OPERATOR', sdUser: 'FAKE_SD',
      projects: ['775773'], signal: signal() }), now: () => Date.parse(completed) }) }
}

test('an approved queue requester still needs matching desktop authorization', async t => {
  const graph = new MockGraph(), row = graph.create()
  const { calls, worker } = await workerSetup(t, graph)
  await worker({ ...requester, objectId: randomUUID() }).pollOnce()
  assert.equal(row.fields.JobStatus, 'Failed')
  assert.equal(row.fields.ErrorCode, 'UNAUTHORIZED')
  assert.deepEqual(calls, [])
})

test('two polling workers that race for the same row dispatch exactly one APQP query', async t => {
  const graph = new MockGraph(), row = graph.create()
  const { calls, worker } = await workerSetup(t, graph)
  let attempts = 0, release
  const bothReady = new Promise(resolve => { release = resolve })
  graph.middleware = async (call, forward) => {
    if (call.method === 'PATCH' && call.fields.JobStatus === 'Running') {
      if (++attempts === 2) release()
      await bothReady
    }
    return forward()
  }
  await Promise.all([worker().pollOnce(), worker().pollOnce()])
  assert.equal(attempts, 2)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].input, { project: '775773', userId: 'FAKE_SD', environment: 'PROD' })
  assert.equal(row.fields.JobStatus, 'Succeeded')
})

for (const committed of [false, true]) {
  test(`worker restart retries writeback alone after a failed PATCH (server committed: ${committed})`, async t => {
    const graph = new MockGraph(), row = graph.create()
    const { calls, outbox, worker } = await workerSetup(t, graph)
    graph.middleware = (call, forward) => {
      if (call.method !== 'PATCH' || call.fields.JobStatus !== 'Succeeded') return forward()
      if (committed) forward()
      return json({ error: 'Temporary error' }, 503)
    }
    const originalWorker = worker()
    await assert.rejects(originalWorker.pollOnce(), code('REQUEST_FAILED'))
    assert.equal((await outbox.pending(workerId)).length, 1)
    assert.equal(row.fields.JobStatus, committed ? 'Succeeded' : 'Running')
    assert.equal(graph.patches().length, 2)
    await originalWorker.stop()
    graph.middleware = (_call, forward) => forward()
    await worker().pollOnce()
    assert.equal(row.fields.JobStatus, 'Succeeded')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].sapUser, 'FAKE_OPERATOR')
    assert.equal(graph.patches().length, committed ? 2 : 3)
    assert.deepEqual(await outbox.pending(workerId), [])
  })
}

test('worker restart marks an ambiguous claim Review Required without executing it', async t => {
  const graph = new MockGraph(), row = graph.create()
  const { calls, worker } = await workerSetup(t, graph)
  graph.middleware = (call, forward) => {
    if (call.method !== 'PATCH') return forward()
    forward()
    throw new Error('Lost claim response')
  }
  const originalWorker = worker()
  await assert.rejects(originalWorker.pollOnce(), code('REQUEST_FAILED'))
  assert.equal(row.fields.JobStatus, 'Running')
  await originalWorker.stop()
  graph.middleware = (_call, forward) => forward()
  await worker().pollOnce()
  assert.deepEqual(calls, [])
  assert.equal(row.fields.JobStatus, 'Review Required')
  assert.equal(row.fields.ErrorCode, 'OUTCOME_UNCONFIRMED')
})
