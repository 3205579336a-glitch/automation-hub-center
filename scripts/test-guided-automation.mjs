import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { writeFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const broadcasts = []
const cache = new Map()
const mocks = {
  electron: { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...args) => broadcasts.push(args) }, flashFrame() {}, once() {} }] }, shell: { openPath: async () => '' } }
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
const { GuidedAutomationService, GuidedCancelled } = load('src/main/services/guided-automation-service.ts')
const { NativeInteractionBridge } = load('src/main/automation/native-interaction-bridge.ts')
const { validInteractionValues } = load('src/shared/automation-interaction.ts')
const { outcomeOf } = load('src/shared/guided-automation.ts')
const { isMe12BatchConfig } = load('src/shared/me12-types.ts')
const { Me12ExcelService } = load('src/main/services/me12-excel-service.ts')
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => globalThis.setTimeout(resolve, 10)) }
  throw new Error('Test state did not arrive')
}
test('Guided adapters (no SAP or browsers)', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'hub-guidance-test-'))
  try {
    const service = new GuidedAutomationService(folder, () => false)
    await t.test('exclusive lease and RFQ guard; end releases it', () => {
      const id = service.begin()
      assert.throws(() => service.begin(), /Another automation/)
      service.end(id)
      assert.equal(service.isRunning(), false)
      assert.throws(() => new GuidedAutomationService(folder, () => true).begin())
    })
    await t.test('stale responses cannot resume; failed read-only verification stays paused', async () => {
      const id = service.begin()
      let valid = false
      let writes = 0
      const waiting = service.wait('APQP', id, 'Sign in', '请登录', async () => { if (!valid) throw Error('not ready') }, () => false)
        .then(() => { writes++ })
      await until(() => service.getInteraction())
      const first = service.getInteraction()
      assert.equal(writes, 0)
      assert.equal(await service.respond({ runId: 'stale', requestId: first.requestId, action: 'continue' }), false)
      assert.equal(await service.respond({ runId: id, requestId: first.requestId, action: 'continue' }), true)
      assert.equal(await service.respond({ runId: id, requestId: first.requestId, action: 'continue' }), false)
      await until(() => service.getInteraction()?.requestId !== first.requestId && service.getInteraction())
      const second = service.getInteraction()
      assert.match(second.message, /still present/)
      assert.equal(writes, 0)
      assert.equal(await service.respond({ runId: id, requestId: first.requestId, action: 'continue' }), false)
      valid = true
      assert.equal(await service.respond({ runId: id, requestId: second.requestId, action: 'continue' }), true)
      await waiting
      assert.equal(writes, 1)
      assert.equal(service.getInteraction(), null)
      assert.equal(JSON.parse(await readFile(join(folder, id, 'checkpoint.json'), 'utf8')).state, 'RECOVERING')
      service.end(id)
    })
    await t.test('unknown boundary allows Stop only; no continuation', async () => {
      const id = service.begin()
      const waiting = service.wait('Source List', id, 'Unknown outcome', '无法确认', undefined, () => false)
      const rejected = assert.rejects(waiting, GuidedCancelled)
      await until(() => service.getInteraction())
      const request = service.getInteraction()
      assert.deepEqual(request.allowedActions, ['stop'])
      assert.equal(await service.respond({ runId: id, requestId: request.requestId, action: 'continue' }), false)
      assert.equal(await service.respond({ runId: id, requestId: request.requestId, action: 'stop' }), true)
      await rejected
      service.end(id)
    })
    await t.test('Stop wins during read-only recovery', async () => {
      const id = service.begin()
      let release
      const verification = new Promise(resolve => { release = resolve })
      const waiting = service.wait('Info Record', id, 'Sign in', '请登录', () => verification, () => false)
      const rejected = assert.rejects(waiting, GuidedCancelled)
      await until(() => service.getInteraction())
      const request = service.getInteraction()
      await service.respond({ runId: id, requestId: request.requestId, action: 'continue' })
      await until(() => service.getInteraction()?.state === 'RECOVERING')
      assert.equal(await service.respond({ runId: id, requestId: request.requestId, action: 'continue' }), false)
      await service.respond({ runId: id, requestId: request.requestId, action: 'stop' })
      release()
      await rejected
      service.end(id)
    })
    await t.test('native stdin bridge rejects duplicate/stale responses', async () => {
      const id = service.begin()
      const inputs = []
      const bridge = new NativeInteractionBridge({ service, runId: id }, { stdin: { destroyed: false, write: (line, callback) => { inputs.push(JSON.parse(line)); callback() } } })
      const request = { automation: 'APQP', runId: id, requestId: 'native-1', state: 'WAITING_FOR_USER', allowedActions: ['continue', 'stop'], message: 'Login' }
      await bridge.handle({ event: 'interaction', interaction: request })
      await service.respond({ runId: id, requestId: 'native-1', action: 'continue' })
      assert.equal(await service.respond({ runId: id, requestId: 'native-1', action: 'continue' }), false)
      await bridge.handle({ event: 'recovering', requestId: 'native-1' })
      assert.equal(service.getInteraction().state, 'RECOVERING')
      await service.respond({ runId: id, requestId: 'native-1', action: 'stop' })
      assert.deepEqual(inputs.map(input => input.action), ['continue', 'stop'])
      await bridge.handle({ event: 'interaction-resolved', requestId: 'native-1' })
      assert.equal(service.getInteraction(), null)
      service.end(id)
    })
    await t.test('five reusable field types validated against owned schema', () => {
      const request = { fields: [
        { id: 'text', type: 'text', required: true }, { id: 'date', type: 'date', required: true },
        { id: 'choice', type: 'dropdown', required: true, options: [{ value: 'a' }] },
        { id: 'yes', type: 'yes-no', required: true }, { id: 'check', type: 'checkbox', required: true }
      ] }
      const response = { action: 'continue', values: { text: 'ok', date: '2026-10-03', choice: 'a', yes: 'yes', check: true } }
      assert.equal(validInteractionValues(request, response), true)
      for (const [key, value] of [['text', ' '], ['date', '03.10.2026'], ['choice', 'b'], ['yes', 'maybe'], ['check', false]]) {
        assert.equal(validInteractionValues(request, { ...response, values: { ...response.values, [key]: value } }), false)
      }
      assert.equal(validInteractionValues(request, { ...response, values: { ...response.values, injected: 'bad' } }), false)
      assert.equal(validInteractionValues(request, { action: 'stop' }), true)
    })
    await t.test('result paths allowlist cannot open executables or arbitrary files', async () => {
      assert.equal((await service.openArtifact('C:/Windows/System32/cmd.exe')).success, false)
      service.registerArtifacts(join(folder, 'results.xlsx'))
      assert.equal((await service.openArtifact(join(folder, 'results.xlsx'))).success, true)
    })
    await t.test('business config rejects invalid plants and lead times', () => {
      const good = { excelPath: 'test.xlsx', sheetName: '', infoRecordColumn: 1, plantColumn: 2, dataStartRow: 2, targetPlant: 'C100', purchasingOrganization: 'C100', targetLeadTime: '1', infoCategory: 'consignment', infoRecordWidth: 10, dryRun: false, maxItems: 0, maxRetries: 2, saveEvery: 5, confirmed: true }
      assert(isMe12BatchConfig(good))
      assert(!isMe12BatchConfig({ ...good, targetLeadTime: '-1' }))
      assert(!isMe12BatchConfig({ ...good, purchasingOrganization: '' }))
    })
    await t.test('shared results preserve cancellation, partial counts and APQP existing dates', () => {
      assert.equal(outcomeOf({ success: true, message: '', succeeded: 39, failed: 1, skipped: 2 }, 42).state, 'COMPLETED_WITH_WARNINGS')
      assert.equal(outcomeOf({ success: true, message: '', succeeded: 0, failed: 2 }, 2).state, 'FAILED')
      assert.equal(outcomeOf({ success: false, message: '', errorCode: 'CANCELLED', succeeded: 1 }, 3).state, 'CANCELLED')
      assert.equal(outcomeOf({ success: true, message: '', total: 2, succeeded: 2, skipped: 3 }, 2).total, 5)
    })
    await t.test('prefixed Excel template auto-detects inputs and writes a valid namespaced result', async () => {
      const archive = unzipSync(await readFile('resources/templates/ME12_Supplier_Lead_Time_Template.xlsx'))
      const key = 'xl/worksheets/sheet1.xml'
      let xml = strFromU8(archive[key])
      xml = xml.replace(/<x:c r="A2"[^>]*\/>/, '<x:c r="A2" t="inlineStr"><x:is><x:t>0012345678</x:t></x:is></x:c>')
        .replace(/<x:c r="B2"[^>]*\/>/, '<x:c r="B2" t="inlineStr"><x:is><x:t>C100</x:t></x:is></x:c>')
      archive[key] = strToU8(xml)
      const path = join(folder, 'namespaced.xlsx')
      await writeFile(path, zipSync(archive))
      const config = { excelPath: path, sheetName: '', infoRecordColumn: 1, plantColumn: 2, dataStartRow: 2, targetPlant: 'C100', purchasingOrganization: 'C100', targetLeadTime: '1', infoCategory: 'standard', infoRecordWidth: 10, dryRun: false, maxItems: 0, maxRetries: 2, saveEvery: 5 }
      const excel = new Me12ExcelService()
      assert.equal((await excel.preview(config)).selectedInfoRecords, 1)
      const session = await excel.prepareRun(config)
      excel.writeTaskResult(session, session.tasks[0], '5', 'SUCCESS')
      const result = await excel.saveCheckpoint(session)
      const resultXml = strFromU8(unzipSync(await readFile(result))[key])
      assert.match(resultXml, /xmlns="http:\/\/schemas.openxmlformats.org\/spreadsheetml\/2006\/main"/)
      assert.match(resultXml, /ME12 Status/)
      assert.match(resultXml, /SUCCESS/)
      assert.equal((await excel.preview(config)).selectedInfoRecords, 1)
    })
    await t.test('Info Record adapter gates all workers and stops only at saved record boundaries', async () => {
      let windows = []
      const makeWindow = () => {
        const locator = { count: async () => 1, nth() { return this }, isVisible: async () => true }
        const frame = { getByRole: () => locator }
        const window = { signedIn: false, closed: false, page: { on() {}, goto: async () => {}, url: () => 'https://mock.sap/ME12', isClosed: () => window.closed, frames: () => window.signedIn ? [frame] : [] }, context: null }
        window.context = { pages: () => [window.page], close: async () => { window.closed = true } }
        return window
      }
      mocks['playwright-core'] = { chromium: { launchPersistentContext: async () => { const window = makeWindow(); windows.push(window); return window.context } } }
      const { Me12BatchRunner } = load('src/main/automation/me12-batch-runner.ts')
      const workbook = { savePath: join(folder, 'mock-result.xlsx'), backupPath: join(folder, 'mock-backup.xlsx'), tasks: [{ infoRecord: '1', excelRows: [2] }, { infoRecord: '2', excelRows: [3] }, { infoRecord: '3', excelRows: [4] }] }
      let saves = 0
      const excel = { preview: async () => ({ selectedInfoRecords: 3 }), prepareRun: async () => workbook, writeTaskResult() {}, saveCheckpoint: async () => { saves++; return workbook.savePath } }
      const runner = new Me12BatchRunner({ getSettings: async () => ({ maxConcurrentBrowsers: 2, browser: 'chrome', sapWebGuiUrl: 'https://mock.sap/{tcode}' }) }, excel, folder, folder,
        { info: async () => {}, error: async () => {} }, { acquire: () => 1, release() {} })
      const config = { confirmed: true, saveEvery: 5, maxRetries: 0, targetLeadTime: '1' }
      let writes = 0
      runner.runTaskWithRetries = async () => { writes++; return { kind: 'success', oldValue: '2', status: 'SUCCESS' } }
      const id = service.begin()
      const running = runner.run(config, () => {}, { service, runId: id })
      await until(() => service.getInteraction())
      assert.equal(writes, 0)
      windows[0].signedIn = true
      const first = service.getInteraction()
      await service.respond({ runId: id, requestId: first.requestId, action: 'continue' })
      await until(() => service.getInteraction()?.requestId !== first.requestId && service.getInteraction())
      assert.equal(writes, 0, 'One signed-in browser is not enough')
      windows[1].signedIn = true
      await service.respond({ runId: id, requestId: service.getInteraction().requestId, action: 'continue' })
      assert.equal((await running).succeeded, 3)
      assert.equal(writes, 3)
      assert(windows.every(window => window.closed))
      service.end(id)

      // Already-authenticated windows, with one unknown record outcome.
      windows = []
      mocks['playwright-core'].chromium.launchPersistentContext = async () => { const window = makeWindow(); window.signedIn = true; windows.push(window); return window.context }
      writes = 0
      runner.runTaskWithRetries = async () => { writes++; return { kind: writes === 1 ? 'failed' : 'success', oldValue: '', status: 'Mock outcome' } }
      const unsafeId = service.begin()
      const unsafe = runner.run(config, () => {}, { service, runId: unsafeId })
      await until(() => service.getInteraction())
      assert.equal(writes, 2, 'No third record scheduled after an unknown outcome')
      assert(saves > 0)
      assert.deepEqual(service.getInteraction().allowedActions, ['stop'])
      await service.respond({ runId: unsafeId, requestId: service.getInteraction().requestId, action: 'stop' })
      const partial = await unsafe
      assert.equal(partial.errorCode, 'CANCELLED')
      assert.equal(partial.processed, 2)
      assert.equal(partial.failed, 1)
      service.end(unsafeId)

      // Cancellation must not tear down a browser in a SAP Save.
      windows = []
      let release
      const activeSave = new Promise(resolve => { release = resolve })
      writes = 0
      runner.runTaskWithRetries = async () => { writes++; await activeSave; return { kind: 'success', oldValue: '', status: 'SUCCESS' } }
      const cancelId = service.begin()
      const cancelling = runner.run(config, () => {}, { service, runId: cancelId })
      await until(() => writes === 2)
      assert(runner.cancel())
      assert(windows.every(window => !window.closed))
      release()
      const stopped = await cancelling
      assert.equal(stopped.errorCode, 'CANCELLED')
      assert.equal(stopped.succeeded, 2)
      assert(windows.every(window => window.closed))
      service.end(cancelId)
    })
    assert(broadcasts.length > 0)
  } finally { await rm(folder, { recursive: true, force: true }) }
})
