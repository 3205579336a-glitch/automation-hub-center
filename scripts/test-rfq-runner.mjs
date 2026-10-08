import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile('src/main/automation/rfq-native-runner.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
const { RfqNativeRunner } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputText).toString('base64'))

test('Electron RFQ runner (mock child only)', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rfq-runner-test-'))
  const previous = process.env.SAP_RFQ_PYTHON
  process.env.SAP_RFQ_PYTHON = process.execPath
  try {
    const setup = async (mode = 'success') => {
      const input = join(directory, `source-${mode}.xlsx`)
      await writeFile(input, JSON.stringify({ mode }))
      const runner = new RfqNativeRunner({ executable: '', preferScript: true,
        script: resolve('scripts/fixtures/rfq-mock-engine.mjs') }, join(directory, 'runs'), 'test')
      const config = { excelPath: input, environment: 'PROD', productionConfirmed: true }
      const preview = await runner.preview(config)
      config.fingerprint = preview.fingerprint
      return { runner, config, input }
    }

    await t.test('copies input, preserves original, trusts terminal totals not row event counts, logs Unicode', async () => {
      const { runner, config, input } = await setup()
      const before = await readFile(input)
      const events = []
      const result = await runner.run(config, (e) => events.push(e))
      assert.equal(result.success, true)
      assert.equal(result.succeeded, 1)
      assert.deepEqual(result.rfqNumbers, ['MOCK-1'])
      assert.notEqual(result.resultPath, input)
      assert.deepEqual(await readFile(input), before)
      assert.equal(runner.canOpen(result.resultPath), true)
      assert.equal(runner.canOpen(result.diagnosticsPath), true)
      assert.equal(runner.canOpen(input), false)
      assert.match(await readFile(join(result.diagnosticsPath, 'engine.log'), 'utf8'), /离线模拟/)
      assert.equal(events.filter((e) => e.type === 'RFQ_CREATED').length, 2)
      assert.equal(events.some((e) => e.message.includes('ordinary output')), false)
    })
    await t.test('changed input requires a fresh preview', async () => {
      const { runner, config, input } = await setup()
      await writeFile(input, '{}')
      const result = await runner.run(config, () => assert.fail('must not launch'))
      assert.equal(result.success, false)
      assert.match(result.message, /changed after preview/)
    })
    await t.test('unconfirmed Production is blocked', async () => {
      const { runner, config } = await setup()
      const result = await runner.run({ ...config, productionConfirmed: false }, () => assert.fail('must not launch'))
      assert.equal(result.errorCode, 'INVALID_CONFIG')
    })
    for (const mode of ['silent', 'nonzero']) {
      await t.test(`${mode} cannot be reported as successful`, async () => {
        const { runner, config } = await setup(mode)
        const result = await runner.run(config, () => {})
        assert.equal(result.success, false)
        assert.equal(result.errorCode, 'EXECUTION_FAILED')
        assert.equal(runner.isRunning(), false)
      })
    }
    await t.test('blocks concurrent runs; Stop uses a marker and preserves saved results', async () => {
      const { runner, config } = await setup('wait')
      let ready
      const started = new Promise((resolveReady) => { ready = resolveReady })
      const running = runner.run(config, (e) => { if (e.type === 'GROUP_STARTED') ready() })
      await started
      assert.equal(runner.isRunning(), true)
      assert.equal((await runner.run(config, () => {})).errorCode, 'OPERATION_IN_PROGRESS')
      assert.equal(await runner.cancel(), true)
      const result = await running
      assert.equal(result.errorCode, 'CANCELLED')
      assert.deepEqual(result.rfqNumbers, ['MOCK-1'])
      assert.equal(runner.canOpen(result.resultPath), true)
      assert.equal(await runner.cancel(), false)
    })
    await t.test('interaction rejects stale responses, rechecks, resumes once and preserves original', async () => {
      const { runner, config, input } = await setup('interaction')
      const before = await readFile(input)
      const waits = []
      const tasks = []
      const result = await runner.run(config, (e) => {
        if (e.state !== 'WAITING_FOR_USER') return
        assert.equal(e.stage, 'waiting-for-user')
        assert.equal(e.status, 'waiting')
        const current = runner.getInteraction()
        waits.push(current)
        tasks.push((async () => {
          assert.equal(await runner.respond({ runId: 'wrong', requestId: current.requestId, action: 'continue' }), false)
          if (waits.length > 1) assert.equal(await runner.respond({ runId: current.runId, requestId: waits[0].requestId, action: 'continue' }), false)
          assert.equal(await runner.respond({ runId: current.runId, requestId: current.requestId, action: 'continue' }), true)
          assert.equal(await runner.respond({ runId: current.runId, requestId: current.requestId, action: 'continue' }), false)
        })())
      })
      await Promise.all(tasks)
      assert.equal(waits.length, 2)
      assert.notEqual(waits[0].requestId, waits[1].requestId)
      assert.equal(result.success, true)
      assert.equal(runner.getInteraction(), null)
      assert.deepEqual(await readFile(input), before)
    })
    await t.test('unknown interaction allows Stop only and preserves created objects', async () => {
      const { runner, config } = await setup('unknown')
      const tasks = []
      const result = await runner.run(config, (e) => {
        if (e.state !== 'WAITING_FOR_USER') return
        const current = runner.getInteraction()
        tasks.push((async () => {
          assert.equal(await runner.respond({ runId: current.runId, requestId: current.requestId, action: 'continue' }), false)
          assert.equal(await runner.respond({ runId: current.runId, requestId: current.requestId, action: 'stop' }), true)
        })())
      })
      await Promise.all(tasks)
      assert.equal(result.errorCode, 'CANCELLED')
      assert.deepEqual(result.rfqNumbers, ['KEEP-1'])
    })
    await t.test('notification callback failure cannot release or fail the paused engine', async () => {
      const { runner, config } = await setup('attention-failure')
      let ready
      const paused = new Promise((resolveReady) => { ready = resolveReady })
      const running = runner.run(config, (e) => {
        if (e.state === 'WAITING_FOR_USER') { ready(); throw new Error('Mock notification failure') }
      })
      await paused
      const current = runner.getInteraction()
      assert.equal(current.state, 'WAITING_FOR_USER')
      assert.equal(runner.isRunning(), true)
      assert.equal(await runner.respond({ runId: current.runId, requestId: current.requestId, action: 'continue' }), true)
      assert.equal((await running).success, true)
    })
  } finally {
    if (previous === undefined) delete process.env.SAP_RFQ_PYTHON
    else process.env.SAP_RFQ_PYTHON = previous
    await rm(directory, { recursive: true, force: true })
  }
})
