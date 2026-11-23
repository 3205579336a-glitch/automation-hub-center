/* global AbortController */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { loadPahModule } from './fixtures/load-pah-module.mjs'

const service = name => loadPahModule(`src/main/services/${name}.ts`)
const { ApqpRunner } = loadPahModule('src/main/automation/apqp-runner.ts')
const { PAH_QUERY_APQP, parsePahRequest } = loadPahModule('src/shared/pah-job-types.ts')
const { ApqpDateQueryOperation } = service('apqp-date-query-operation')
const { ApqpDateService } = service('apqp-date-service')
const { ExecutionHistoryService } = service('execution-history-service')
const { GeneratedArtifacts } = service('generated-artifacts')
const { GuidedAutomationService } = service('guided-automation-service')
const { PahJobDispatcher } = service('pah-job-dispatcher')
const { PahJobOutbox } = service('pah-job-outbox')
const { InMemoryPahJobQueue } = service('pah-job-queue')
const { PahJobWorker } = service('pah-job-worker')

class DemoQueue extends InMemoryPahJobQueue {
  async claim(item, claim, signal) {
    const claimed = await super.claim(item, claim, signal)
    if (claimed) {
      assert.equal(this.get(item.jobId).status, 'Running')
      console.log(`[3] Claimed ${item.jobId} as Running (claim ${claim.claimId})`)
    }
    return claimed
  }
}

class DemoDispatcher extends PahJobDispatcher {
  permits(request, requester, approval) {
    const permitted = super.permits(request, requester, approval)
    assert(permitted, 'Expected the demo requester to match the synthetic operator approval')
    console.log(`[2] Validated ${request.action} for project ${request.parameters.project} and authorized the demo requester`)
    return permitted
  }
}

// This standalone process selects the Windows Python launcher and a fixed Fake SAP fixture.
delete process.env.SAP_GUI_PYTHON
const directory = await mkdtemp(join(tmpdir(), 'pah-agent-demo-'))
const historyPath = join(directory, 'execution-history.json')
const resultPath = join(directory, 'queue-result.json')
const logger = {
  info: async entry => {
    if (entry.event === 'apqp.dates.query-started') console.log('[4] Running the read-only APQP query against Fake SAP')
  },
  error: async entry => console.error(entry.message),
  warning: async entry => console.error(entry.message),
  getEntries: async () => []
}
const guided = new GuidedAutomationService(join(directory, 'interactions'), () => false)
const runner = new ApqpRunner({
  executable: '',
  preferScript: true,
  script: fileURLToPath(new URL('./fixtures/apqp-dates-fake-engine.py', import.meta.url))
}, new GeneratedArtifacts(join(directory, 'runs')))
const history = new ExecutionHistoryService(historyPath, logger)
const dispatcher = new DemoDispatcher(new ApqpDateQueryOperation(new ApqpDateService(runner), guided, history, logger))
const queue = new DemoQueue()
const outbox = new PahJobOutbox(join(directory, 'outbox'))
const workerId = randomUUID()
const requester = { tenantId: randomUUID(), objectId: randomUUID() }
const desktop = new AbortController()
const worker = new PahJobWorker({
  workerId, queue, dispatcher, outbox,
  approveDesktop: async () => ({
    requester, projects: ['775773'], sdUser: 'EE00221', sapUser: 'MOCK_SAP_LOGIN', signal: desktop.signal
  })
})

console.log('Offline Agent Bridge demo. In-memory queue and Fake SAP. No network or credentials.')
console.log(`Local evidence directory: ${directory}`)
try {
  const payload = { action: PAH_QUERY_APQP, parameters: { project: '775773' }, caseKey: 'DEMO-APQP-01' }
  const jobId = queue.enqueue(payload, { submissionId: randomUUID(), requester, workerId })
  assert.equal(queue.get(jobId).status, 'Queued')
  console.log(`[1] Submitted ${payload.action}. Job ${jobId} is Queued`)
  assert.equal(parsePahRequest({ ...payload, parameters: { ...payload.parameters, userId: 'INJECTED' } }), 'INVALID_JOB')
  console.log('    Validation rejected a caller-supplied SAP user')
  await worker.pollOnce()

  const { status, completion } = queue.get(jobId)
  assert.equal(status, 'Succeeded', completion?.errorCode)
  assert.equal(completion.result.records.length, 25)
  assert.deepEqual(await outbox.pending(workerId), [])
  await writeFile(resultPath, JSON.stringify({ jobId, ...payload, ...completion }, null, 2) + '\n', { flag: 'wx' })
  console.log(`[5] Returned ${completion.result.records.length} APQP records. Job is ${status}`)
  console.log(JSON.stringify(completion.result.records[0], null, 2))
  console.log(`    Full queue result: ${resultPath}`)

  const [entry] = JSON.parse(await readFile(historyPath, 'utf8'))
  assert.equal(entry.agentJobId, jobId)
  assert.equal(entry.id, completion.historyId)
  assert.equal(entry.diagnosticRunId, completion.runId)
  assert.equal(entry.status, 'Success')
  assert.equal(entry.succeeded, completion.result.records.length)
  const native = JSON.parse(await readFile(entry.resultPath, 'utf8'))
  assert.equal(native.readOnly, true)
  assert.equal(native.writesEnabled, false)
  assert.equal(native.queryEvidence.executeCount, 1)
  assert.equal(native.writeEvents, undefined)
  console.log(`[6] Verified persisted history ${entry.id} and matching Hub run ${entry.diagnosticRunId}`)
  console.log(`    History: ${historyPath}`)
  console.log('Demo passed. The native trace recorded one query and zero SAP write events.')
} finally {
  await worker.stop()
}
