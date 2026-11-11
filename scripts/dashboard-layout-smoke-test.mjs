/* global window, document */
// Isolated Electron profile. Only simulated account/history appear in screenshots.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = await mkdtemp(join(tmpdir(), 'hub-dashboard-layout-'))
const artifacts = resolve('artifacts/dashboard-design')
await mkdir(artifacts, { recursive: true })
let app
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${root}`], env: { ...process.env, LOCALAPPDATA: root } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const dashboard = page.getByRole('heading', { name: 'Welcome back', exact: true })
  await dashboard.waitFor()
  const expected = process.platform === 'win32' ? userInfo().username : null
  const observed = await page.evaluate(() => window.sapAutomation.getLocalUsername())
  assert(observed === expected, 'Main process exposes only the current Windows username')

  const data = await app.evaluate(({ app }) => app.getPath('userData'))
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const completed = Math.max(start, today.getTime() - 1_000)
  const records = [
    ['create-rfq', 'Success', 3, 160_000],
    ['me12-batch', 'Success', 16, 210_000],
    ['mm02-sub-commodity', 'Failed', 0, 33_000]
  ].map(([operation, status, succeeded, durationMs], index) => ({
    id: `layout-fixture-${index}`, operation, label: 'Layout fixture', summary: 'Simulated local run', status,
    startedAt: new Date(Math.max(start, completed - (index + 1) * 60_000)).toISOString(),
    completedAt: new Date(completed).toISOString(), durationMs, succeeded
  }))
  const earlier = new Date(today.getTime() - 45 * 86400000).toISOString()
  records.push({ ...records[1], id: 'older-than-30-days', startedAt: earlier, completedAt: earlier })
  await writeFile(join(data, '.local-data', 'data', 'execution-history.json'), JSON.stringify(records))
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('dashboard:local-username')
    ipcMain.handle('dashboard:local-username', () => 'a100001')
    for (const name of ['rfq:start', 'me12:start', 'me01:start', 'apqp:start', 'mm02:start', 'automation:open-sap', 'apqp:dates:query', 'apqp:dates:execute']) {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, () => { throw new Error('SAP writes are not permitted in this UI test') })
    }
  })
  const resize = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
    await page.waitForFunction(w => Math.abs(window.innerWidth - w) <= 1, width)
  }
  await resize(1440, 900)
  const startupScripts = new Set()
  const captureScript = request => {
    if (request.resourceType() === 'script') startupScripts.add(request.url())
  }
  page.on('request', captureScript)
  await page.reload()
  await page.getByText('a100001', { exact: true }).waitFor()
  assert(await page.evaluate(() => !JSON.stringify(window.localStorage).toUpperCase().includes('A100001')), 'Username is not persisted')
  const overview = page.getByRole('region', { name: 'Automation summary' })
  assert.equal(await overview.locator('article').count(), 4)
  const available = overview.locator('article').filter({ hasText: 'Available Operations' })
  await available.getByText('5', { exact: true }).waitFor()
  await available.getByText('Purchasing workflows', { exact: true }).waitFor()
  assert(!/currently running/i.test(await available.innerText()))
  await overview.locator('article').filter({ hasText: 'Runs Today' }).getByText('3', { exact: true }).waitFor()
  await page.getByRole('region', { name: 'Recent Activity' }).getByText('Batch Update Sub-commodity', { exact: true }).waitFor()
  assert.equal(await page.locator('[aria-label="Task shortcuts"] button').count(), 5)
  page.off('request', captureScript)
  assert([...startupScripts].some(url => /\/assets\/index-.*\.js$/.test(url)), 'Observe the actual renderer entry request')
  assert(![...startupScripts].some(url => /\/(?:Operations|Settings|History|CreateRfq|Me12LeadTime|Me01SourceList|Mm02SubCommodity|ApqpPlanClosure)Page-/.test(url)), 'Dashboard does not fetch unvisited pages')
  const snapshot = await page.evaluate(() => window.sapAutomation.getDashboardSnapshot())
  assert.deepEqual(snapshot.counts, { today: 3, yesterday: 0, successful: 2, failed: 1, finalized: 3 })
  assert.equal(snapshot.recent.length, 3)
  assert.equal(snapshot.savings.today.runs, 2)
  assert.equal(snapshot.savings.allTime.runs, 3)
  await page.getByText('All time', { exact: true }).waitFor()
  startupScripts.clear()
  page.on('request', captureScript)
  const prefetched = page.waitForEvent('request', request => /\/OperationsPage-.*\.js$/.test(request.url()))
  await page.getByRole('navigation').getByRole('button', { name: 'Operations', exact: true }).hover()
  await prefetched
  await dashboard.waitFor()
  page.off('request', captureScript)
  assert([...startupScripts].some(url => /\/OperationsPage-.*\.js$/.test(url)), 'Navigation intent preloads the target before it opens')
  const status = page.getByRole('status', { name: 'Application status' })
  assert.equal(await status.getAttribute('data-state'), 'ready')
  const noOverflow = async () => {
    const widths = await page.evaluate(() => {
      const main = document.querySelector('main')
      return { available: main.clientWidth, rendered: main.scrollWidth, viewport: window.innerWidth, document: document.documentElement.scrollWidth }
    })
    assert(widths.rendered <= widths.available + 1 && widths.document <= widths.viewport + 1, JSON.stringify(widths))
  }
  await noOverflow()
  await page.screenshot({ path: join(artifacts, 'dashboard-light.png'), animations: 'disabled' })

  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
  const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true })
  const sidebar = page.locator('aside#workspace-sidebar')
  const footer = sidebar.locator('footer')
  assert.equal(await footer.getByRole('button', { name: 'Collapse sidebar', exact: true }).count(), 1)
  await collapse.focus()
  await collapse.press('Enter')
  assert.equal(await expand.getAttribute('aria-expanded'), 'false')
  assert.equal(await footer.getByRole('button', { name: 'Expand sidebar', exact: true }).count(), 1)
  await page.reload()
  await expand.waitFor()
  await page.getByRole('navigation').getByRole('button', { name: 'Operations', exact: true }).click()
  await page.getByRole('heading', { name: 'Purchasing Automation Hub', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Open', exact: true }).first().waitFor()
  await page.screenshot({ path: join(artifacts, 'operations-light.png'), animations: 'disabled' })
  await page.getByRole('navigation').getByRole('button', { name: 'Execution History', exact: true }).click()
  await page.getByRole('row', { name: /Batch Update Sub-commodity/ }).waitFor()
  await page.screenshot({ path: join(artifacts, 'history-light.png'), animations: 'disabled' })
  await app.evaluate(({ ipcMain }) => {
    globalThis.historySearchCalls = []
    ipcMain.removeHandler('history:get')
    ipcMain.handle('history:get', (_event, query) => {
      globalThis.historySearchCalls.push(query.search)
      return { entries: [], total: 0 }
    })
  })
  const search = page.getByRole('textbox', { name: 'Search operations', exact: true })
  await search.pressSequentially('RFQ', { delay: 20 })
  await page.getByText('No matching real execution records yet.', { exact: true }).waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.historySearchCalls), ['RFQ'], 'One history request for a typing burst')
  await page.getByRole('navigation').getByRole('button', { name: 'Dashboard', exact: true }).click()
  await dashboard.waitFor()
  await expand.click()
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true')

  startupScripts.clear()
  page.on('request', captureScript)
  await page.evaluate(() => {
    window.localStorage.setItem('apqp-last-business-user', 'OLD_OWNER')
    window.location.hash = '/apqp-plan-closure'
  })
  const owner = page.getByLabel('User ID *', { exact: true })
  await page.waitForFunction(() => document.querySelector('#apqp-dates-panel label input')?.value === 'A100001')
  assert.equal(await owner.inputValue(), 'A100001')
  assert(![...startupScripts].some(url => /\/GuidedAutomationPage-/.test(url)), 'APQP editor does not fetch the unopened Excel workflow')
  await owner.fill('E000001')
  await page.getByRole('tab', { name: 'Query Plan Closure Date', exact: true }).click()
  await page.getByRole('button', { name: 'Upload completed template', exact: true }).waitFor()
  assert([...startupScripts].some(url => /\/GuidedAutomationPage-/.test(url)), 'Excel workflow loads on intent')
  await page.getByRole('tab', { name: 'Find APQPs & Edit Dates', exact: true }).click()
  assert.equal(await owner.inputValue(), 'E000001')
  page.off('request', captureScript)
  await page.getByRole('navigation').getByRole('button', { name: 'Dashboard', exact: true }).click()
  await dashboard.waitFor()

  await page.evaluate(async () => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, language: 'zh-CN', fontSize: 'large', theme: 'dark' })
    window.localStorage.removeItem('purchasing-hub.sidebar')
  })
  await resize(1024, 700)
  await page.reload()
  await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor()
  await page.getByText('a100001', { exact: true }).waitFor()
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).waitFor()
  await noOverflow()
  await page.screenshot({ path: join(artifacts, 'dashboard-dark-compact.png'), animations: 'disabled' })
  await resize(640, 520)
  await noOverflow()
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click()
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).waitFor()
  await noOverflow()
  await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { name: '提醒与结果', exact: true }).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: '提示音', exact: true }).isChecked(), true)
  await noOverflow()
  await page.screenshot({ path: join(artifacts, 'settings-dark-compact.png'), animations: 'disabled' })
  await page.getByRole('navigation').getByRole('button', { name: '仪表板', exact: true }).click()

  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('dashboard:local-username')
    ipcMain.handle('dashboard:local-username', () => null)
  })
  await page.reload()
  await page.getByText('此设备', { exact: true }).waitFor()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('dashboard:local-username')
    ipcMain.handle('dashboard:local-username', () => new Promise(resolve => { globalThis.deliverLateAccount = resolve }))
  })
  await page.evaluate(() => { window.location.hash = '/apqp-plan-closure' })
  await page.reload()
  await owner.fill('EE00999')
  await app.evaluate(() => globalThis.deliverLateAccount('a100001'))
  await page.evaluate(async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))) })
  assert.equal(await owner.inputValue(), 'EE00999', 'A late Windows account must not replace typed input')
  assert.deepEqual(errors, [])
  console.log('Workspace UI passed: deferred page assets, aggregated history, search debounce, sidebar keyboard/navigation/persistence, large text, dark mode and 640px layout. No SAP actions.')
} finally {
  if (app) await app.close()
}
