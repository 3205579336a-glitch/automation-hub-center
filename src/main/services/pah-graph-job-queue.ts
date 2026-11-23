import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { isObject, isPahClaim, isPahCompletion, isPahId, isPahRequester, isPahTimestamp, PAH_MAX_RESULT_BYTES,
  parsePahRequest, type PahClaim, type PahCompletion, type PahJobIdentity, type PahJobRequest,
  type PahRequester } from '../../shared/pah-job-types'
import type { PahJobQueue, PahQueuedItem, PahRunningItem } from './pah-job-queue'

const GRAPH_ORIGIN = 'https://graph.microsoft.com'
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
const MAX_RESPONSE_BYTES = 4_000_000
const MAX_PAGE_ITEMS = 100
const MAX_PARAMETERS_BYTES = 1_024
const MAX_RETRIES = 2
const WORK_FIELDS = ['Title', 'JobId', 'SubmissionKey', 'CaseKey', 'Action', 'ParametersJson', 'RequesterTenantId',
  'RequesterObjectId', 'WorkerId', 'QueuedAt', 'JobStatus', 'ClaimId', 'StartedAt', 'CompletedAt',
  'ResultJson', 'ErrorCode', 'HubRunId', 'HubHistoryId']
const COMPLETION_FIELDS = ['CompletedAt', 'ResultJson', 'ErrorCode', 'HubRunId', 'HubHistoryId'] as const

export interface PahEntraTokenProvider {
  getAccessToken(input: { tenantId: string; scope: typeof GRAPH_SCOPE; signal: AbortSignal }): Promise<string>
}

/** Use a transport that honors request cancellation and redirect policy, without SDK mutation retries. */
export interface PahGraphClient {
  fetch(url: string, request: RequestInit): Promise<Response>
}

export interface PahGraphJobQueueOptions {
  siteId: string
  listId: string
  workerId: string
  requester: PahRequester
  ingressApplicationId: string
  client: PahGraphClient
  authentication: PahEntraTokenProvider
  requestTimeoutMs?: number
  operationTimeoutMs?: number
  maxPages?: number
}

type QueueErrorCode = 'INVALID_CONFIGURATION' | 'UNAUTHORIZED_WORKER' | 'UNTRUSTED_ITEM' | 'INVALID_ITEM'
  | 'DUPLICATE_ITEM' | 'UNSAFE_PAGE' | 'PAGE_LIMIT' | 'INVALID_RESPONSE' | 'CONFLICT'
  | 'AUTHENTICATION_FAILED' | 'ACCESS_DENIED' | 'RESOURCE_UNAVAILABLE' | 'REQUEST_FAILED' | 'TIMEOUT'
  | 'ABORTED' | 'THROTTLED'

export class PahGraphQueueError extends Error {
  constructor(readonly code: QueueErrorCode) {
    super(`PAH Graph queue: ${code}`)
    this.name = 'PahGraphQueueError'
  }
}

interface GraphItem extends PahJobIdentity {
  id: string
  revision: string
  submissionKey: string
  request: PahJobRequest
}

type GraphRow = GraphItem & (
  | { status: 'Queued' }
  | { status: 'Running'; claim: PahClaim }
  | { status: PahCompletion['status']; claim: PahClaim; outcome: PahCompletion }
)
type FilterField = 'JobStatus' | 'JobId' | 'SubmissionKey'
type PatchFields = Record<string, string | null>

/** A single private SharePoint list for one trusted ingress and one provisioned worker/operator. */
export class PahGraphJobQueue implements PahJobQueue {
  private readonly collection: URL
  private readonly siteCollectionId: string
  private readonly webId: string
  private readonly siteHost: string
  private readonly options: Required<PahGraphJobQueueOptions>
  private retryAfterUntil = 0

  constructor(options: PahGraphJobQueueOptions) {
    const [host, siteCollectionId, webId, extra] = typeof options.siteId === 'string' ? options.siteId.split(',') : []
    const { listId, workerId, requester, ingressApplicationId, client, authentication,
      requestTimeoutMs = 5_000, operationTimeoutMs = 30_000, maxPages = 8 } = options
    if (!host || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.sharepoint\.com$/.test(host)
      || !isPahId(siteCollectionId) || !isPahId(webId) || extra !== undefined
      || !isPahId(listId) || !isPahId(workerId) || !isPahRequester(requester) || !isPahId(ingressApplicationId)
      || typeof client?.fetch !== 'function' || typeof authentication?.getAccessToken !== 'function'
      || !boundedInteger(requestTimeoutMs, 1, 30_000) || !boundedInteger(operationTimeoutMs, requestTimeoutMs, 60_000)
      || !boundedInteger(maxPages, 1, 20)) throw new PahGraphQueueError('INVALID_CONFIGURATION')
    this.siteCollectionId = siteCollectionId
    this.webId = webId
    this.siteHost = host
    this.options = { ...options, requester: { ...requester }, requestTimeoutMs, operationTimeoutMs, maxPages }
    this.collection = new URL(`/v1.0/sites/${options.siteId}/lists/${listId}/items`, GRAPH_ORIGIN)
  }

  async nextQueued(workerId: string, signal: AbortSignal): Promise<PahQueuedItem | null> {
    this.requireWorker(workerId)
    return this.operation(signal, async active => {
      const rows = await this.readRows('JobStatus', 'Queued', active)
      rows.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || Number(a.id) - Number(b.id))
      const first = rows[0]
      return first ? { ...jobFields(first), status: 'Queued', revision: first.revision } : null
    })
  }

  async listRunning(workerId: string, signal: AbortSignal): Promise<PahRunningItem[]> {
    this.requireWorker(workerId)
    return this.operation(signal, async active => {
      const rows = await this.readRows('JobStatus', 'Running', active)
      return rows.map(row => {
        if (row.status !== 'Running') throw new PahGraphQueueError('INVALID_ITEM')
        return { ...jobFields(row), status: 'Running', claim: row.claim }
      })
    })
  }

  async claim(item: PahQueuedItem, claim: PahClaim, signal: AbortSignal): Promise<boolean> {
    this.requireWorker(claim.workerId)
    if (item.status !== 'Queued' || !isPahId(item.jobId) || !isETag(item.revision) || !isPahClaim(claim)) {
      throw new PahGraphQueueError('INVALID_ITEM')
    }
    return this.operation(signal, async active => {
      const row = await this.unique('JobId', item.jobId, active)
      if (!row || row.status !== 'Queued' || row.revision !== item.revision) return false
      if (claim.startedAt < row.queuedAt || !isDeepStrictEqual(jobFields(row), jobFields(item))) {
        throw new PahGraphQueueError('INVALID_ITEM')
      }
      const submission = await this.unique('SubmissionKey', row.submissionKey, active)
      if (!submission || submission.id !== row.id || submission.revision !== row.revision) return false
      const fields = { JobStatus: 'Running', ClaimId: claim.claimId, StartedAt: claim.startedAt }
      const response = await this.patch(row, fields, active)
      if (response === null) return false
      if (!Object.entries(fields).every(([key, value]) => response[key] === value)) {
        throw new PahGraphQueueError('INVALID_RESPONSE')
      }
      return true
    })
  }

  async complete(jobId: string, claim: PahClaim, outcome: PahCompletion, signal: AbortSignal): Promise<void> {
    this.requireWorker(claim.workerId)
    if (!isPahId(jobId) || !isPahClaim(claim) || !isPahCompletion(outcome) || outcome.completedAt < claim.startedAt) {
      throw new PahGraphQueueError('INVALID_ITEM')
    }
    const fields = encodeCompletion(outcome)
    await this.operation(signal, async active => {
      const row = await this.unique('JobId', jobId, active)
      if (!row || row.status === 'Queued' || !isDeepStrictEqual(row.claim, claim)) throw new PahGraphQueueError('CONFLICT')
      if (row.status !== 'Running') {
        if (!sameCompletion(row, claim, outcome)) throw new PahGraphQueueError('CONFLICT')
        return
      }
      const acknowledged = await this.patch(row, fields, active)
      if (acknowledged !== null) {
        try {
          if (sameOutcome(decodeCompletion(acknowledged, claim), outcome)) return
        } catch { /* Keep the outbox until a later read can verify the terminal state. */ }
        throw new PahGraphQueueError('INVALID_RESPONSE')
      }
      // An overlapping retry can legitimately win. Accept only the identical terminal outcome.
      const winner = await this.unique('JobId', jobId, active)
      if (!winner || !sameCompletion(winner, claim, outcome)) throw new PahGraphQueueError('CONFLICT')
    })
  }

  private async unique(field: 'JobId' | 'SubmissionKey', value: string, signal: AbortSignal): Promise<GraphRow | undefined> {
    const rows = await this.readRows(field, value, signal)
    if (rows.length > 1) throw new PahGraphQueueError('DUPLICATE_ITEM')
    return rows[0]
  }

  private async readRows(field: FilterField, value: string, signal: AbortSignal): Promise<GraphRow[]> {
    let url = new URL(this.collection)
    url.searchParams.set('$select', 'id,eTag,createdBy,sharepointIds')
    url.searchParams.set('$expand', `fields(select=${WORK_FIELDS.join(',')})`)
    url.searchParams.set('$filter', `fields/${field} eq '${value}'`)
    url.searchParams.set('$top', '25')
    const rows: GraphRow[] = [], itemIds = new Set<string>(), jobIds = new Set<string>(), submissions = new Set<string>()
    const visited = new Set<string>()
    for (let page = 0; page < this.options.maxPages; page++) {
      if (visited.has(url.href)) throw new PahGraphQueueError('UNSAFE_PAGE')
      visited.add(url.href)
      const response = await this.request(url, null, signal)
      if (!response || !Array.isArray(response.value) || response.value.length > MAX_PAGE_ITEMS) {
        throw new PahGraphQueueError('INVALID_RESPONSE')
      }
      for (const valueFromGraph of response.value) {
        const row = this.decode(valueFromGraph)
        const filteredValue = field === 'JobStatus' ? row.status : field === 'JobId' ? row.jobId : row.submissionKey
        if (filteredValue !== value) throw new PahGraphQueueError('INVALID_ITEM')
        if (itemIds.has(row.id) || jobIds.has(row.jobId) || submissions.has(row.submissionKey)) {
          throw new PahGraphQueueError('DUPLICATE_ITEM')
        }
        itemIds.add(row.id)
        jobIds.add(row.jobId)
        submissions.add(row.submissionKey)
        rows.push(row)
      }
      if (response['@odata.nextLink'] === undefined) return rows
      url = this.nextPage(response['@odata.nextLink'])
    }
    throw new PahGraphQueueError('PAGE_LIMIT')
  }

  private nextPage(value: unknown): URL {
    if (typeof value !== 'string' || value.length > 8_192) throw new PahGraphQueueError('UNSAFE_PAGE')
    let url: URL
    try { url = new URL(value) } catch { throw new PahGraphQueueError('UNSAFE_PAGE') }
    const path = url.pathname.replace(/%2c/gi, ',')
    if (url.origin !== GRAPH_ORIGIN || url.username || url.password || url.hash
      || path !== this.collection.pathname || !url.search) throw new PahGraphQueueError('UNSAFE_PAGE')
    url.pathname = path
    return url
  }

  private decode(item: unknown): GraphRow {
    if (!isObject(item) || typeof item.id !== 'string' || !/^[1-9][0-9]{0,9}$/.test(item.id)
      || !isObject(item.fields)) throw new PahGraphQueueError('INVALID_ITEM')
    const tag = item.eTag ?? item['@odata.etag']
    if (!isETag(tag) || (item['@odata.etag'] !== undefined && item['@odata.etag'] !== tag)) {
      throw new PahGraphQueueError('INVALID_ITEM')
    }
    const { requester, listId, workerId, ingressApplicationId } = this.options
    const ids = item.sharepointIds
    const fields = item.fields
    if (!isObject(ids) || !sameUuid(ids.tenantId, requester.tenantId) || !sameUuid(ids.listId, listId)
      || !sameUuid(ids.siteId, this.siteCollectionId) || !sameUuid(ids.webId, this.webId)
      || ids.listItemId !== item.id || !siteMatches(ids.siteUrl, this.siteHost)
      || !isObject(item.createdBy) || !isObject(item.createdBy.application)
      || !sameUuid(item.createdBy.application.id, ingressApplicationId)
      || fields.WorkerId !== workerId || fields.RequesterTenantId !== requester.tenantId
      || fields.RequesterObjectId !== requester.objectId) throw new PahGraphQueueError('UNTRUSTED_ITEM')
    const { JobId, Title, QueuedAt, SubmissionKey, JobStatus, ClaimId, StartedAt } = fields
    const request = parsePahRequest({ action: fields.Action, caseKey: fields.CaseKey, parameters: parseJson(fields.ParametersJson, MAX_PARAMETERS_BYTES) })
    if (!isPahId(JobId) || Title !== JobId || !isPahTimestamp(QueuedAt) || typeof SubmissionKey !== 'string'
      || !/^[a-f0-9]{64}$/.test(SubmissionKey) || typeof request === 'string') throw new PahGraphQueueError('INVALID_ITEM')
    const row = { id: item.id, revision: tag, submissionKey: SubmissionKey, jobId: JobId, requester: { ...requester }, queuedAt: QueuedAt, request }
    if (JobStatus === 'Queued') {
      if (![ClaimId, StartedAt, ...COMPLETION_FIELDS.map(key => fields[key])].every(empty)) throw new PahGraphQueueError('INVALID_ITEM')
      return { ...row, status: JobStatus }
    }
    const claim = { workerId, claimId: ClaimId, startedAt: StartedAt }
    if (!isPahClaim(claim) || claim.startedAt < QueuedAt) throw new PahGraphQueueError('INVALID_ITEM')
    if (JobStatus === 'Running') {
      if (!COMPLETION_FIELDS.every(key => empty(fields[key]))) throw new PahGraphQueueError('INVALID_ITEM')
      return { ...row, status: JobStatus, claim }
    }
    const outcome = decodeCompletion(fields, claim)
    return { ...row, claim, outcome, status: outcome.status }
  }

  private patch(row: GraphRow, fields: PatchFields, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const url = new URL(`${this.collection.pathname}/${row.id}/fields`, GRAPH_ORIGIN)
    return this.request(url, { revision: row.revision, fields }, signal)
  }

  private async request(url: URL, patch: { revision: string; fields: PatchFields } | null, signal: AbortSignal):
    Promise<Record<string, unknown> | null> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const wait = this.retryAfterUntil - Date.now()
      if (wait > this.options.operationTimeoutMs) throw new PahGraphQueueError('THROTTLED')
      if (wait > 0) await delay(wait, undefined, { signal })
      const reply = await this.withTimeout(signal, this.options.requestTimeoutMs, async active => {
        const { authentication, requester, client } = this.options
        let token: string
        try { token = await authentication.getAccessToken({ tenantId: requester.tenantId, scope: GRAPH_SCOPE, signal: active }) }
        catch { throw new PahGraphQueueError('AUTHENTICATION_FAILED') }
        active.throwIfAborted()
        if (typeof token !== 'string' || token.length > 65_536 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
          throw new PahGraphQueueError('AUTHENTICATION_FAILED')
        }
        const response = await client.fetch(url.href, {
          method: patch ? 'PATCH' : 'GET', redirect: 'error', signal: active,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`,
            ...(patch ? { 'Content-Type': 'application/json', 'If-Match': patch.revision } : {}) },
          body: patch ? JSON.stringify(patch.fields) : undefined
        })
        if (active.aborted || response.redirected) {
          void response.body?.cancel().catch(() => undefined)
          active.throwIfAborted()
          throw new PahGraphQueueError('INVALID_RESPONSE')
        }
        const retryAfter = response.headers.get('Retry-After')
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined)
          return { status: response.status, retryAfter }
        }
        return { status: 200, body: await readResponse(response, active) }
      })
      if (reply.body) return reply.body
      if (reply.status === 429) {
        this.retryAfterUntil = Math.max(this.retryAfterUntil, retryAt(reply.retryAfter, attempt))
        if (attempt < MAX_RETRIES) continue
        throw new PahGraphQueueError('THROTTLED')
      }
      if (reply.status === 412 && patch) return null
      if (reply.status === 401 || reply.status === 403) throw new PahGraphQueueError('ACCESS_DENIED')
      if (reply.status === 404) throw new PahGraphQueueError('RESOURCE_UNAVAILABLE')
      throw new PahGraphQueueError('REQUEST_FAILED')
    }
  }

  private requireWorker(workerId: string): void {
    if (workerId !== this.options.workerId) throw new PahGraphQueueError('UNAUTHORIZED_WORKER')
  }

  private operation<T>(signal: AbortSignal, run: (active: AbortSignal) => Promise<T>): Promise<T> {
    return this.withTimeout(signal, this.options.operationTimeoutMs, run)
  }

  private async withTimeout<T>(signal: AbortSignal, milliseconds: number, run: (active: AbortSignal) => Promise<T>): Promise<T> {
    const elapsed = new AbortController()
    const active = AbortSignal.any([signal, elapsed.signal])
    const timer = setTimeout(() => elapsed.abort(new PahGraphQueueError('TIMEOUT')), milliseconds)
    let onAbort: (() => void) | undefined
    try {
      active.throwIfAborted()
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(active.reason)
        active.addEventListener('abort', onAbort, { once: true })
      })
      const result = await Promise.race([aborted, run(active)])
      active.throwIfAborted()
      return result
    } catch (error) {
      if (active.aborted) {
        throw new PahGraphQueueError(elapsed.signal.aborted || (signal.reason instanceof PahGraphQueueError
          && signal.reason.code === 'TIMEOUT') ? 'TIMEOUT' : 'ABORTED')
      }
      if (error instanceof PahGraphQueueError) throw error
      throw new PahGraphQueueError('REQUEST_FAILED')
    } finally {
      clearTimeout(timer)
      if (onAbort) active.removeEventListener('abort', onAbort)
    }
  }
}

function jobFields(item: PahJobIdentity & { request: unknown }) {
  return { jobId: item.jobId, requester: item.requester, queuedAt: item.queuedAt, request: item.request }
}

function encodeCompletion(outcome: PahCompletion): PatchFields {
  const result = outcome.result === null ? null : JSON.stringify(outcome.result)
  if (result !== null && Buffer.byteLength(result, 'utf8') > PAH_MAX_RESULT_BYTES) throw new PahGraphQueueError('INVALID_ITEM')
  return { JobStatus: outcome.status, CompletedAt: outcome.completedAt, ResultJson: result,
    ErrorCode: outcome.errorCode, HubRunId: outcome.runId ?? null, HubHistoryId: outcome.historyId ?? null }
}

function decodeCompletion(fields: Record<string, unknown>, claim: PahClaim): PahCompletion {
  const outcome = {
    status: fields.JobStatus, completedAt: fields.CompletedAt,
    result: empty(fields.ResultJson) ? null : parseJson(fields.ResultJson, PAH_MAX_RESULT_BYTES),
    errorCode: empty(fields.ErrorCode) ? null : fields.ErrorCode,
    runId: empty(fields.HubRunId) ? undefined : fields.HubRunId,
    historyId: empty(fields.HubHistoryId) ? undefined : fields.HubHistoryId
  }
  if (!isPahCompletion(outcome) || outcome.completedAt < claim.startedAt
    || (outcome.status !== 'Succeeded' && !empty(fields.ResultJson))) throw new PahGraphQueueError('INVALID_ITEM')
  return outcome
}

function sameCompletion(row: GraphRow, claim: PahClaim, outcome: PahCompletion): boolean {
  return 'outcome' in row && isDeepStrictEqual(row.claim, claim) && sameOutcome(row.outcome, outcome)
}

function sameOutcome(actual: PahCompletion, expected: PahCompletion): boolean {
  return isDeepStrictEqual(actual, { ...expected, runId: expected.runId, historyId: expected.historyId })
}

function boundedInteger(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max
}

function isETag(value: unknown): value is string {
  return typeof value === 'string' && /^(?:W\/)?"[\x21\x23-\x7e]{1,255}"$/.test(value)
}

function sameUuid(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === expected
}

function siteMatches(value: unknown, hostname: string): boolean {
  if (typeof value !== 'string' || value.length > 2_048) return false
  try { return new URL(value).origin === `https://${hostname}` } catch { return false }
}

function empty(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function parseJson(value: unknown, maxBytes: number): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) throw new PahGraphQueueError('INVALID_ITEM')
  try { return JSON.parse(value) as unknown } catch { throw new PahGraphQueueError('INVALID_ITEM') }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body || Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw new PahGraphQueueError('INVALID_RESPONSE')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const cancel = (): void => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new PahGraphQueueError('INVALID_RESPONSE')
      chunks.push(value)
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    if (isObject(parsed)) return parsed
    throw new PahGraphQueueError('INVALID_RESPONSE')
  } catch {
    cancel()
    throw new PahGraphQueueError('INVALID_RESPONSE')
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

function retryAt(header: string | null, attempt: number): number {
  const now = Date.now()
  if (header && /^\d+$/.test(header)) return now + Math.min(Number(header) * 1_000, Number.MAX_SAFE_INTEGER - now)
  const date = header ? Date.parse(header) : NaN
  return Number.isFinite(date) ? Math.max(now, date) : now + 1_000 * 2 ** attempt
}
