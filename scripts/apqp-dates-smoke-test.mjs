/* global window, document */
// Real renderer/preload/IPC/service/runner/native API. Only SAP objects are fake.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { _electron as electron } from 'playwright-core'

const root = resolve('.'), folder = await mkdtemp(join(tmpdir(), 'apqp-dates-ui-'))
const screenshots = resolve('artifacts/apqp-date-management')
await mkdir(screenshots, { recursive: true })
const modules = {}
async function compile(path) {
  const file = resolve(path)
  if (modules[file]) return
  const code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  modules[file] = code
  for (const match of code.matchAll(/require\("([^"]+)"\)/g)) if (match[1].startsWith('.')) await compile(join(dirname(file), match[1] + '.ts'))
}
for (const path of ['src/main/ipc/apqp-date-handlers.ts', 'src/main/ipc/history-handlers.ts', 'src/main/services/execution-history-service.ts', 'src/main/services/local-intelligence-service.ts', 'src/main/services/apqp-date-service.ts', 'src/main/services/apqp-date-cache.ts', 'src/main/automation/apqp-runner.ts', 'src/main/services/generated-artifacts.ts', 'src/main/services/guided-automation-service.ts']) await compile(path)
await compile('src/shared/time-savings.ts')
let app
try {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${folder}`], env: { ...process.env, LOCALAPPDATA: folder } })
  const page = await app.firstWindow(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  await mkdir(join(folder, 'logs'), { recursive: true })
  await app.evaluate(({ ipcMain, BrowserWindow }, { modules, root, folder }) => {
    const require = process.getBuiltinModule('module').createRequire(root + '/package.json')
    const cache = new Map(), path = require('node:path')
    const load = file => {
      if (cache.has(file)) return cache.get(file).exports
      const module = { exports: {} }; cache.set(file, module)
      if (!modules[file]) throw new Error('Unapproved smoke module: ' + file)
      new Function('require', 'module', 'exports', modules[file])(name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name), module, module.exports)
      return module.exports
    }
    const get = file => load(path.join(root, file))
    const { ApqpRunner } = get('src/main/automation/apqp-runner.ts')
    const { ApqpDateService } = get('src/main/services/apqp-date-service.ts')
    const { ApqpDateCache } = get('src/main/services/apqp-date-cache.ts')
    const { GeneratedArtifacts } = get('src/main/services/generated-artifacts.ts')
    const { GuidedAutomationService } = get('src/main/services/guided-automation-service.ts')
    const { registerApqpDateHandlers } = get('src/main/ipc/apqp-date-handlers.ts')
    const { registerHistoryHandlers } = get('src/main/ipc/history-handlers.ts')
    const { ExecutionHistoryService } = get('src/main/services/execution-history-service.ts')
    const { LocalIntelligenceService } = get('src/main/services/local-intelligence-service.ts')
    const runner = new ApqpRunner({ executable: 'not-used', script: path.join(root, 'scripts/fixtures/apqp-dates-fake-engine.py'), preferScript: true }, new GeneratedArtifacts(path.join(folder, 'logs/automation-runs')))
    const starts = [], finished = []
    const logger = { error: async () => undefined, info: async () => undefined, warning: async () => undefined, getEntries: async () => [] }
    const history = new ExecutionHistoryService(path.join(folder, 'history.json'), logger)
    const service = new ApqpDateService(runner, Date.now, new ApqpDateCache(path.join(folder, 'logs/automation-runs'), history))
    const start = history.start.bind(history), finish = history.finish.bind(history)
    history.start = async input => { const entry = await start(input); starts.push(entry); return entry }
    history.finish = async (id, update) => { await finish(id, update); finished.push({ id, ...update }) }
    const intelligence = new LocalIntelligenceService(history, eta => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('intelligence:eta', eta) })
    const guided = new GuidedAutomationService(path.join(folder, 'logs/interactions'), () => false)
    for (const channel of ['apqp:dates:capabilities', 'apqp:dates:query', 'apqp:dates:cache', 'apqp:dates:preview', 'apqp:dates:execute', 'apqp:cancel', 'intelligence:get', 'history:get', 'history:delete']) ipcMain.removeHandler(channel)
    registerApqpDateHandlers(service, guided, history, logger, intelligence)
    registerHistoryHandlers(history, intelligence, () => guided.isRunning())
    const { timeSavings } = get('src/shared/time-savings.ts')
    ipcMain.removeHandler('dashboard:time-savings')
    ipcMain.handle('dashboard:time-savings', async () => timeSavings(await history.getEntries({ limit: 500 })))
    ipcMain.handle('apqp:cancel', () => ({ success: runner.cancel() }))
    // All other business starts remain forbidden in this isolated smoke profile.
    for (const channel of ['rfq:start', 'me01:start', 'me12:start', 'apqp:start', 'automation:open-sap']) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, () => { throw new Error('Real SAP starts are forbidden in smoke tests') })
    }
    globalThis.apqpDatesSmoke = { service, history: starts, finished, store: history }
  }, { modules, root, folder })
const observeAudio = () => {
    window.apqpSoundCount = 0
    const original = window.AudioContext.prototype.createOscillator
    window.AudioContext.prototype.createOscillator = function (...args) { window.apqpSoundCount++; return original.apply(this, args) }
  }
  await page.addInitScript(observeAudio)
  await page.evaluate(observeAudio)
  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  await page.getByRole('heading', { name: 'APQP Date Management', exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
  const find = page.getByRole('button', { name: 'Find APQPs', exact: true })
  assert.equal(await page.getByLabel('SAP environment', { exact: true }).count(), 0, '949 is fixed, not an end-user choice')
  assert.equal(await page.getByTitle('0.2.5', { exact: true }).count(), 1)
  assert.equal(await page.getByLabel('NPL / Project Code *', { exact: true }).inputValue(), '775773')
  await page.getByLabel('User ID *', { exact: true }).fill('EE00221')
  await find.evaluate(button => { button.click(); button.click() })
  await page.getByText('Running', { exact: true }).waitFor()
  await page.getByLabel('Estimated time remaining', { exact: true }).waitFor()
  const edit = page.getByRole('region', { name: 'Edit APQP dates', exact: true })
  await edit.waitFor({ timeout: 45000 })
  assert.equal(await page.getByRole('button', { name: 'Open read result', exact: true }).count(), 0)
  assert.equal(await app.evaluate(() => globalThis.apqpDatesSmoke.history.length), 1)
  assert.equal(await edit.getByRole('row').count(), 21)
  const fDate = page.getByLabel('2000000000 RTS Confirmation Planned Date', { exact: true })
  const gDate = page.getByLabel('2000000000 RTS Action & Closure Planned Date', { exact: true })
  assert(await fDate.isDisabled(), 'Grey SAP fields must be disabled in Hub')
  await fDate.locator('..').getByText('Cannot be changed in SAP', { exact: true }).waitFor()
  assert.equal(await gDate.inputValue(), '2026-10-20')
  assert.equal(await page.getByLabel('2000000000 Total PPAP Planned Date', { exact: true }).inputValue(), '2026-12-25')
  assert.equal(await page.getByLabel('2000000000 APQP Closure Plan Date', { exact: true }).inputValue(), '')
  assert.equal(await edit.getByRole('columnheader', { name: /Actual Date/ }).count(), 0)
  assert.equal(await page.getByText('SD Comment (optional)', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: /Test fill/ }).count(), 0)
  await gDate.fill('2026-10-28')
  await page.getByLabel('2000000001 APQP Closure Plan Date', { exact: true }).fill('2026-12-30')
  const search = page.getByLabel('Search APQPs', { exact: true })
  await search.fill('2000000001')
  assert.equal(await edit.getByRole('row').count(), 2)
  await search.fill('')
  await page.getByLabel('Sort by', { exact: true }).selectOption('supplier-asc')
  assert.equal(await edit.getByRole('row').nth(1).getByRole('cell').nth(2).innerText(), '0000101')
  await page.getByLabel('Sort by', { exact: true }).selectOption('original')
  await page.getByRole('button', { name: 'Save dates (2)', exact: true }).click()
  const result = page.getByRole('region', { name: 'Date update result', exact: true })
  await result.waitFor({ timeout: 45000 })
  const finished = await app.evaluate(() => globalThis.apqpDatesSmoke.finished.at(-1))
  assert.equal(finished.succeeded, 2)
  assert.equal(finished.apqpDateFieldsSaved, 2)
  assert.equal(finished.failed, 0)
  assert.equal(finished.status, 'Success')
  assert.notEqual(finished.dryRun, true, 'Official saved updates are not labelled input-only tests')
  const audit = JSON.parse(await readFile(finished.resultPath, 'utf8'))
  assert.equal(audit.fieldSchema, 'APQP_PLANNED_FGHM_V1')
  assert.equal(audit.update.savedFields, 2)
  assert(audit.performance.bulkDetailReads > 0, 'Write verification uses the checked bulk date-read path')
  assert.equal(audit.writePolicy.stageOnly, false)
  assert.equal(audit.writeEvents.filter(e => e.event === 'SAVE_DISPATCHED').length, 2)
  assert.equal(audit.writeEvents.filter(e => e.event === 'UPDATE_VERIFIED').length, 2)
  assert.equal(audit.writeEvents.filter(e => e.event === 'SAVE_CONFIRMATION_DISPATCHED').length, 2)
  assert(!audit.writeEvents.some(e => e.event.startsWith('SD_')))
  assert(audit.records.every(r => r.saved === true))
  assert.equal(await gDate.inputValue(), '2026-10-28')
  assert(await page.getByRole('button', { name: 'Save dates (0)', exact: true }).isDisabled())
  assert(await page.evaluate(() => window.apqpSoundCount > 0))
  // One-click local reset keeps query scope so the matching historical read is available.
  await page.getByRole('button', { name: 'Clear this page', exact: true }).click()
  await page.getByRole('dialog', { name: 'Clear this task page?', exact: true }).getByRole('button', { name: 'Confirm Clear', exact: true }).click()
  assert.equal(await edit.count(), 0)
  assert.equal(await page.getByLabel('NPL / Project Code *', { exact: true }).inputValue(), '775773')
  assert.equal(await page.getByLabel('User ID *', { exact: true }).inputValue(), 'EE00221')
  const historyCount = await app.evaluate(() => globalThis.apqpDatesSmoke.history.length)
  await page.getByRole('button', { name: 'Use previous results', exact: true }).click()
  await edit.waitFor()
  await page.getByRole('note').getByText('Results from', { exact: false }).waitFor()
  assert.equal(await app.evaluate(() => globalThis.apqpDatesSmoke.history.length), historyCount)
  assert.equal(await gDate.inputValue(), '2026-10-20', 'Historical read is not relabelled as fresh saved data')
  // A fresh SAP status can become read-only after the query: skip first, save remaining.
  await page.getByLabel('User ID *', { exact: true }).fill('DYNAMIC_LOCK')
  await page.getByRole('button', { name: 'Find APQPs', exact: true }).click()
  await edit.waitFor({ timeout: 45000 })
  for (const apqp of ['2000000000', '2000000001', '2000000002']) {
    await page.getByLabel(apqp + ' RTS Action & Closure Planned Date', { exact: true }).fill('2026-10-29')
  }
  await page.getByRole('button', { name: 'Save dates (3)', exact: true }).click()
  const notice = page.getByRole('dialog', { name: 'Some records were skipped', exact: true })
  await notice.waitFor({ timeout: 45000 })
  await notice.getByText('2 APQPs saved', { exact: false }).waitFor()
  await notice.getByRole('button', { name: 'OK, understood', exact: true }).click()
  const reasons = page.getByRole('region', { name: 'Skipped record reasons', exact: true })
  await reasons.getByText('SAP does not allow this date to be changed.', { exact: true }).waitFor()
  await reasons.getByRole('cell', { name: '10000000', exact: true }).waitFor()
  const partial = await app.evaluate(() => globalThis.apqpDatesSmoke.finished.at(-1))
  assert.equal(partial.succeeded, 2)
  assert.equal(partial.apqpDateFieldsSaved, 2)
  assert.equal(partial.failed, 1)
  assert.equal(partial.status, 'Partial')
  const partialAudit = JSON.parse(await readFile(partial.resultPath, 'utf8'))
  assert.equal(partialAudit.writeEvents.filter(e => e.event === 'SAVE_DISPATCHED').length, 2)
  assert(!partialAudit.writeEvents.some(e => e.event === 'DATE_INPUT_DISPATCHED' && e.apqp === '2000000000'))
  assert(await page.getByRole('button', { name: 'Save dates (1)', exact: true }).isEnabled(), 'Only the skipped draft remains pending')
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN')
  await page.getByLabel('Text Size', { exact: true }).selectOption('large')
  await page.getByLabel('Theme', { exact: true }).selectOption('dark')
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
  await page.getByRole('button', { name: '操作中心', exact: true }).click()
  await page.getByRole('heading', { name: 'APQP 日期管理', exact: true }).locator('..').getByRole('button', { name: '打开', exact: true }).click()
  await page.getByRole('region', { name: '跳过原因', exact: true }).waitFor()
  assert(await page.evaluate(() => { const main = document.querySelector('main'); return main.scrollWidth <= main.clientWidth + 1 }))
  await page.getByRole('region', { name: '编辑 APQP 日期', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'planned-dates-readonly-zh-dark-1024.png') })
  await page.getByRole('region', { name: '跳过原因', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'planned-dates-saved-skip-zh-dark-1024.png') })
  await page.getByLabel('User ID *', { exact: true }).fill('MISMATCH')
  await page.getByRole('button', { name: '查找 APQP', exact: true }).click()
  await page.getByRole('dialog', { name: 'APQP 读取未完成', exact: true }).waitFor({ timeout: 45000 })
  await page.getByRole('button', { name: '我知道了', exact: true }).click()
  await page.getByRole('region', { name: '查询条件对比', exact: true }).waitFor()
  await page.getByRole('button', { name: '执行历史', exact: true }).click()
  await page.getByText('APQP 日期修改', { exact: true }).first().waitFor()
  const stored = await app.evaluate(() => globalThis.apqpDatesSmoke.store.getEntries({ operations: ['apqp-date-management'] }))
  assert(stored.some(e => e.apqpDateAction === 'update' && e.status === 'Success' && e.succeeded === 2 && !e.dryRun))
  assert(stored.some(e => e.apqpDateAction === 'update' && e.status === 'Partial' && e.failed === 1 && e.succeeded === 2))
  await page.getByRole('button', { name: '仪表板', exact: true }).click()
  await page.getByRole('region', { name: '预计节省时间', exact: true }).waitFor()
  await page.getByText('计算依据与基准', { exact: true }).click()
  await page.getByText('最近 30 天已完成 4 个日期字段。', { exact: false }).waitFor()
  assert.deepEqual(errors, [])
  console.log('V0.2.5 APQP smoke passed: fixed 949, no read-result button, simple copy, saved-field history and dashboard savings, first-target hash index, bulk reads, exact planned dates, grey field, batch Save verification, safe skips, search/sort, cache/reset and responsive bilingual UI. Fake SAP only; no live SAP access.')
} catch (error) {
  if (app) { const page = await app.firstWindow(); console.error(await page.locator('main').innerText().catch(() => 'No main')); await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true }).catch(() => undefined) }
  throw error
} finally { if (app) await app.close(); console.log('Isolated smoke profile:', folder) }
