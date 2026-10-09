// Isolated desktop/UI regression. All SAP preview and execution boundaries below are mocked.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'hub-intelligence-smoke-'))
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const titles = [
  'Automatically Create Buyer Receipts and RFQs in Batch from NPL',
  'Automatically Update Supplier Lead Times (SLT) in Batch',
  'Automatically Query APQP Plan Close Dates in Batch',
  'Automatically Maintain Source Lists in Batch'
]
let app
try {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${directory}`], env: { ...process.env, LOCALAPPDATA: directory } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  const operations = async () => { await page.getByRole('button', { name: 'Operations', exact: true }).click(); await page.locator('article h3').first().waitFor() }
  const cardTitles = () => page.locator('article h3').allTextContents()
  await operations()
  assert.deepEqual(await cardTitles(), titles, 'Cold start must retain business ordering')
  await page.screenshot({ path: join(artifacts, 'intelligence-cold-start.png'), fullPage: true })
  const data = await app.evaluate(({ app }) => app.getPath('userData'))
  const historyPath = join(data, '.local-data', 'data', 'execution-history.json')
  const history = Array.from({ length: 8 }, (_, i) => ({ id: `local-${i}`, operation: 'me01-source-list', label: 'Source List', summary: 'Test fixture',
    startedAt: new Date(Date.now() - i * 3600000).toISOString(), completedAt: new Date(Date.now() - i * 3600000 + 1).toISOString(), status: 'Success' }))
  await writeFile(historyPath, JSON.stringify(history))
  assert.deepEqual(await cardTitles(), titles, 'Changing history cannot shuffle the current page session')
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  const shortcuts = page.locator('[aria-label="Task shortcuts"] button')
  await shortcuts.first().waitFor()
  assert.match(await shortcuts.first().innerText(), /Batch Source List Maintenance/)
  await operations()
  assert.equal((await cardTitles())[0], titles[3])
  await page.getByText('Frequently used', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'intelligence-personalized.png'), fullPage: true })
  await writeFile(historyPath, '{corrupt')
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click(); await operations()
  assert.deepEqual(await cardTitles(), titles, 'Corrupt history must not break task access')
  // Deliberately late ranking must freeze the default order after the initial-load timeout.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('intelligence:get')
    ipcMain.handle('intelligence:get', () => new Promise(resolve => {
      globalThis.__lateRanking = () => resolve({ ranking: { order: ['me01-source-list', 'create-rfq', 'me12-batch', 'apqp-plan-closure'], personalized: true, frequentlyUsed: [] }, eta: null })
    }))
  })
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click(); await operations()
  assert.deepEqual(await cardTitles(), titles)
  await app.evaluate(() => globalThis.__lateRanking())
  await page.getByRole('heading', { name: titles[0], exact: true }).waitFor()
  assert.deepEqual(await cardTitles(), titles, 'Late response must not move visible cards')
  // Replace *all* preview/start boundaries before uploading or confirming any RFQ.
  await app.evaluate(({ ipcMain, dialog, BrowserWindow }) => {
    ipcMain.removeHandler('intelligence:get')
    ipcMain.handle('intelligence:get', () => ({ ranking: { order: ['create-rfq', 'me12-batch', 'apqp-plan-closure', 'me01-source-list'], personalized: false, frequentlyUsed: [] }, eta: null }))
    ipcMain.removeHandler('rfq:preview')
    ipcMain.handle('rfq:preview', () => ({ success: true, preview: { sheetName: 'UI-MOCK', totalRows: 10, validRows: 10, invalidRows: 0,
      skippedBlankRows: 0, sample: [], groupCount: 10, groups: [], plants: ['C100'], warnings: [], skippedRows: 0, fingerprint: 'UI-MOCK' } }))
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['C:/UI-MOCK.xlsx'] })
    ipcMain.removeHandler('rfq:start')
    ipcMain.handle('rfq:start', () => new Promise(resolve => { globalThis.__finishEtaMock = resolve }))
    globalThis.__emitEtaMock = (eta, progress) => {
      const owner = BrowserWindow.getAllWindows()[0]
      if (progress) owner.webContents.send('rfq:progress', { stage: 'processing', status: 'running', message: 'Mock progress', ...progress })
      if (eta) owner.webContents.send('intelligence:eta', { automationId: 'create-rfq', runId: 'UI-MOCK', active: true,
        state: 'running', total: 10, completed: 0, unit: 'groups', confidence: 'learning', historicalRuns: 0, ...eta })
    }
  })
  await page.getByRole('heading', { name: titles[0], exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
  await page.getByRole('button', { name: 'Upload completed template', exact: true }).click()
  await page.getByRole('button', { name: 'Start Automation', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm and Start', exact: true }).click()
  const eta = page.getByLabel('Estimated time remaining', { exact: true })
  await eta.getByText('Learning from this device; approximate estimate.', { exact: true }).waitFor()
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: 615000 }, { type: 'GROUP_STARTED', current: 1, total: 10 }))
  await page.getByText('0 / 10 · 0%', { exact: true }).waitFor()
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: 404000, completed: 1, confidence: 'high', historicalRuns: 8 }, { type: 'GROUP_COMPLETED', current: 1, total: 10, succeeded: 1, skipped: 0, failed: 0 }))
  await eta.getByText('~6 min 44 sec', { exact: true }).waitFor()
  await page.getByText('1 / 10 · 10%', { exact: true }).waitFor()
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: 298000, completed: 3, confidence: 'high', historicalRuns: 8 }, { type: 'GROUP_COMPLETED', current: 3, total: 10, succeeded: 3, skipped: 0, failed: 0 }))
  await eta.getByText('~4 min 58 sec', { exact: true }).waitFor()
  await page.getByText('3 / 10 · 30%', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'intelligence-rfq-eta.png'), fullPage: true })
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: null, state: 'waiting', completed: 3 }, { type: 'ACTION_REQUIRED', state: 'WAITING_FOR_USER' }))
  await eta.getByText('Waiting for your action', { exact: true }).waitFor()
  assert.equal(await eta.getByText(/~.*sec/).count(), 0)
  await page.screenshot({ path: join(artifacts, 'intelligence-rfq-paused.png'), fullPage: true })
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: null, state: 'recovering', completed: 3 }, { type: 'ACTION_REQUIRED', state: 'RECOVERING' }))
  await eta.getByText('Checking; estimate resumes after verification', { exact: true }).waitFor()
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: 300000, completed: 3 }, { type: 'INTERACTION_RESOLVED', state: 'RUNNING' }))
  await eta.getByText('~5 min 0 sec', { exact: true }).waitFor()
  // A corrupt ETA is advisory only: Stop remains available and execution continues.
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: -1 }))
  await eta.getByText('ETA unavailable', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(), true)
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: 300000, completed: 3, confidence: 'high', historicalRuns: 8 }))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN')
  await page.getByLabel('Theme', { exact: true }).selectOption('dark')
  await page.getByLabel('Text Size', { exact: true }).selectOption('large')
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
  await page.getByRole('button', { name: '操作中心', exact: true }).click()
  await page.getByRole('heading', { name: '在 NPL 中自动批量创建 Buyer Receipt 和 RFQ', exact: true }).locator('..').getByRole('button', { name: '打开', exact: true }).click()
  const chineseEta = page.getByLabel('预计剩余时间', { exact: true })
  await chineseEta.getByText('~5 分 0 秒', { exact: true }).waitFor()
  await page.setViewportSize({ width: 1100, height: 900 })
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.document.documentElement.clientWidth), false)
  await chineseEta.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifacts, 'intelligence-rfq-eta-zh-dark-large.png'), fullPage: true })
  await app.evaluate(() => globalThis.__emitEtaMock({ remainingMs: null, state: 'waiting', completed: 3 }, { type: 'ACTION_REQUIRED', state: 'WAITING_FOR_USER' }))
  await chineseEta.getByText('等待你处理', { exact: true }).waitFor()
  await chineseEta.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifacts, 'intelligence-rfq-paused-zh-dark-large.png'), fullPage: true })
  await app.evaluate(() => globalThis.__finishEtaMock({ success: true, message: 'UI mock completed', processed: 10,
    succeeded: 10, total: 10, skipped: 0, failed: 0, resultPath: '' }))
  await page.getByRole('button', { name: '运行另一任务', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('Intelligence desktop smoke passed: cold start; local personalized Home/Operations; no in-session card jumps; corrupt/late history fallback; RFQ real-unit progress; learning/device ETA; WAIT/recheck/resume; corrupt ETA cannot stop execution. No SAP accessed.')
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: join(artifacts, 'intelligence-smoke-failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  if (app) await app.close()
  console.log(`Isolated fixtures retained at ${directory}`)
}
