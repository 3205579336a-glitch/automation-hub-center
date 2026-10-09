// Isolated desktop acceptance: every SAP boundary is mocked. Never creates a PROD object.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'hub-rfq-runtime-smoke-'))
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
// Startup retention fixture is wholly inside this isolated profile.
const oldId = randomUUID(), oldRun = join(directory, 'SAP Automation Toolbox', 'runs', oldId)
const seedData = join(directory, '.local-data', 'data'), seedLogs = join(directory, '.local-data', 'logs')
for (const path of [seedData, seedLogs, join(oldRun, 'logs'), join(oldRun, 'output')]) await mkdir(path, { recursive: true })
await writeFile(join(oldRun, 'logs', 'engine.log'), 'expired fixture')
await writeFile(join(oldRun, 'output', 'result.xlsx'), 'keep')
await writeFile(join(seedData, 'execution-history.json'), JSON.stringify([{ id: oldId, operation: 'create-rfq', label: 'Expired fixture', summary: 'offline', status: 'Success',
  startedAt: '2000-01-01T00:00:00Z', completedAt: '2000-01-01T00:00:00Z', resultPath: join(oldRun, 'output', 'result.xlsx') }]))
await writeFile(join(seedLogs, 'sap-toolbox-2000-01-01.jsonl'), JSON.stringify({ id: 'expired', timestamp: '2000-01-01T00:00:00Z', level: 'info', category: 'application', event: 'expired', message: 'expired' }) + '\n')
let app
try {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${directory}`], env: { ...process.env, LOCALAPPDATA: directory } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(join(seedData, 'execution-history.json'), 'utf8')), [])
  await assert.rejects(stat(join(oldRun, 'logs', 'engine.log')))
  await assert.rejects(stat(join(seedLogs, 'sap-toolbox-2000-01-01.jsonl')))
  await stat(join(oldRun, 'output', 'result.xlsx'))
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0]
    const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
    replace('rfq:select-excel-file', () => ({ success: true, path: 'C:/MOCK/input.xlsx' }))
    replace('rfq:preview', () => ({ success: true, preview: { sheetName: 'RPA_Input', totalRows: 2, validRows: 2, invalidRows: 0, skippedBlankRows: 0, skippedRows: 0, sample: [], fingerprint: 'mock', groupCount: 1,
      groups: [{ key: 'TEST', plant: 'C100', project: 'TEST', supplier: '12345', materials: ['16068054', '17453599'] }], plants: ['C100'], warnings: [] } }))
    replace('rfq:start', () => new Promise(resolve => {
      globalThis.mockFinish = resolve
      owner.webContents.send('rfq:progress', { type: 'SAP_SLOW', state: 'SAP_SLOW', step: 'Creating Buyer Receipt', waitSeconds: 42, stage: 'processing', status: 'running', message: 'SAP is responding slowly' })
    }))
    globalThis.mockInteraction = null
    globalThis.mockRechecks = 0
    replace('automation:interaction:get', () => globalThis.mockInteraction)
    replace('automation:interaction:respond', (_event, input) => {
      const current = globalThis.mockInteraction
      if (!current || current.runId !== input.runId || current.requestId !== input.requestId || !current.allowedActions.includes(input.action)) return { success: false }
      if (input.action === 'open-fix-session') {
        // Failure must keep the very same request paused and permit manual repair.
        globalThis.mockInteraction = { ...current, allowedActions: ['continue', 'stop'], message: 'Open Fix Session unavailable: SAP session limit' }
        owner.webContents.send('automation:interaction', globalThis.mockInteraction)
      } else if (input.action === 'stop') {
        globalThis.mockInteraction = null
        owner.webContents.send('automation:interaction', null)
      } else if (++globalThis.mockRechecks === 1) {
        globalThis.mockInteraction = { ...current, requestId: 'commodity-2', message: 'The issue is still present. Commodity remains blank.' }
        owner.webContents.send('automation:interaction', globalThis.mockInteraction)
      } else {
        globalThis.mockInteraction = null
        owner.webContents.send('automation:interaction', null)
        owner.webContents.send('rfq:progress', { type: 'RUN_COMPLETED', stage: 'complete', state: 'RUNNING', current: 1, total: 1, message: 'Mock completed' })
        globalThis.mockFinish({ success: true, message: 'Mock completed', processed: 1, total: 1, succeeded: 1, failed: 0, skipped: 0, rfqNumbers: ['MOCK-ONLY'], resultPath: '' })
      }
      return { success: true }
    })
  })
  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  await page.getByRole('heading', { name: 'Automatically Create Buyer Receipts and RFQs in Batch from NPL', exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
  await page.getByRole('button', { name: 'Upload completed template', exact: true }).click()
  await page.getByText('RFQ file ready', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Start Automation', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm and Start', exact: true }).click()
  await page.locator('header').getByText('Running', { exact: true }).waitFor()
  await page.getByText('The automation is still waiting for SAP. No action is required yet.', { exact: true }).waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await page.screenshot({ path: join(artifacts, 'rfq-runtime-slow.png'), fullPage: true })
  // Global modal survives route changes, audio failure, dark theme and large fonts.
  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  await page.locator('header').getByText('Running', { exact: true }).waitFor()
  await page.evaluate(() => {
    globalThis.document.documentElement.dataset.theme = 'dark'
    globalThis.document.documentElement.dataset.fontSize = 'large'
    globalThis.AudioContext = class { constructor() { throw new Error('Mock unavailable audio') } }
  })
  await page.setViewportSize({ width: 1100, height: 900 })
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.mockInteraction = { automation: 'RFQ', runId: 'MOCK-RUNTIME', requestId: 'commodity-1', state: 'WAITING_FOR_USER', severity: 'ATTENTION',
      recoveryPoint: 'COMMODITY_MISSING', step: 'COMMODITY', materials: ['16068054', '17453599'], rows: [2, 3], allowedActions: ['continue', 'stop', 'open-fix-session'],
      issueSummary: 'Commodity must be maintained in SAP before Buyer Receipt creation.', message: 'Commodity missing: 16068054, 17453599',
      instructions: 'Use another SAP session to correct master data. Keep the original NPL screen unchanged, then Recheck.' }
    BrowserWindow.getAllWindows()[0].webContents.send('automation:interaction', globalThis.mockInteraction)
  })
  const modal = page.getByRole('dialog', { name: 'Commodity Information Required', exact: true })
  await modal.waitFor()
  await modal.getByText('16068054, 17453599', { exact: true }).waitFor()
  assert.equal(await modal.locator('input').count(), 0, 'Commodity is maintained in SAP, not entered in Hub')
  await page.keyboard.press('Escape'); assert(await modal.isVisible())
  await modal.getByRole('button', { name: 'Open Fix Session', exact: true }).click()
  await modal.getByText('An additional session is unavailable. Use another existing SAP session to correct master data, then Recheck.', { exact: true }).waitFor()
  assert.equal(await modal.getByRole('button', { name: 'Open Fix Session', exact: true }).count(), 0)
  await modal.getByRole('button', { name: "I've Fixed It – Recheck", exact: true }).click()
  await modal.getByText('The issue is still present. SAP could not be verified; correct it and check again.', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'rfq-runtime-commodity-dark-large.png'), fullPage: true })
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.document.documentElement.clientWidth), false)
  await modal.getByRole('button', { name: "I've Fixed It – Recheck", exact: true }).click()
  await modal.waitFor({ state: 'hidden' })
  await page.locator('header').getByText('Ready', { exact: true }).waitFor()
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.mockInteraction = { automation: 'RFQ', runId: 'MOCK-RUNTIME', requestId: 'hard-stop', state: 'WAITING_FOR_USER', recoveryPoint: 'SAP_SLOW_HARD_TIMEOUT', allowedActions: ['stop'], message: 'Unknown post-commit screen' }
    BrowserWindow.getAllWindows()[0].webContents.send('automation:interaction', globalThis.mockInteraction)
  })
  const hard = page.getByRole('dialog', { name: 'SAP Needs Attention', exact: true })
  await hard.waitFor()
  assert.equal(await hard.getByRole('button', { name: 'Check Again', exact: true }).count(), 0, 'Unknown screen must not offer Continue')
  await hard.getByRole('button', { name: 'Stop Automation', exact: true }).click()
  await hard.waitFor({ state: 'hidden' })

  // A technical read error must never tell users to change Commodity master data.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.mockInteraction = { automation: 'RFQ', runId: 'MOCK-RUNTIME', requestId: 'read-failure', state: 'WAITING_FOR_USER',
      recoveryPoint: 'NPL_READ_FAILED', step: 'NPL_READ_FAILED', materials: ['53762733', '11145413', '11418052'], rows: [2, 21, 22], allowedActions: ['continue', 'stop'],
      issueSummary: 'NPL data could not be read or verified. Commodity has not been confirmed missing.',
      instructions: 'Keep the original NPL screen open, resolve any SAP dialog, then Recheck NPL Data.',
      message: 'NPL read failed: material 53762733, SAP row 3, field ZPSPID: E_INVALIDARG' }
    BrowserWindow.getAllWindows()[0].webContents.send('automation:interaction', globalThis.mockInteraction)
  })
  const readFailure = page.getByRole('dialog', { name: 'NPL Data Could Not Be Read', exact: true })
  await readFailure.waitFor()
  await readFailure.getByText('NPL field verification', { exact: true }).waitFor()
  await readFailure.getByRole('button', { name: 'Recheck NPL Data', exact: true }).waitFor()
  assert.equal(await readFailure.getByRole('button', { name: 'Open Fix Session', exact: true }).count(), 0)
  assert.equal(await readFailure.getByText('Commodity must be maintained in SAP before Buyer Receipt creation.', { exact: true }).count(), 0)
  await readFailure.getByText('View Details', { exact: true }).click()
  await readFailure.getByText('NPL read failed: material 53762733, SAP row 3, field ZPSPID: E_INVALIDARG', { exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'rfq-runtime-read-failure-dark-large.png'), fullPage: true })
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.document.documentElement.clientWidth), false)
  await readFailure.getByRole('button', { name: 'Stop Automation', exact: true }).click()
  await readFailure.waitFor({ state: 'hidden' })

  // Use real history IPC against isolated app-owned fixture files.
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(resolve(userData), resolve(directory))
  const id = randomUUID(), run = join(directory, 'SAP Automation Toolbox', 'runs', id)
  for (const part of ['logs', 'temp', 'output']) await mkdir(join(run, part), { recursive: true })
  const resultPath = join(run, 'output', 'result.xlsx')
  for (const path of [join(run, 'logs', 'engine.log'), join(run, 'temp', 'checkpoint.json'), resultPath]) await writeFile(path, 'mock fixture')
  const historyPath = join(userData, '.local-data', 'data', 'execution-history.json')
  const fixtures = Array.from({ length: 31 }, (_, index) => ({ id: index === 0 ? id : randomUUID(), operation: 'create-rfq', label: `Runtime fixture ${index}`, summary: `Offline fixture ${index}`,
    startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: 'Success', ...(index === 0 ? { resultPath } : {}) }))
  await writeFile(historyPath, JSON.stringify(fixtures))
  await page.getByRole('button', { name: 'Execution History', exact: true }).click()
  await page.getByText('31 total, 25 on this page', { exact: true }).waitFor()
  assert.equal(await page.locator('tbody tr').count(), 25)
  assert.equal(await page.locator('tbody').getByRole('button', { name: /^Delete / }).count(), 0)
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await page.getByText('31 total, 6 on this page', { exact: true }).waitFor()
  assert.equal(await page.locator('tbody tr').count(), 6)
  await page.getByLabel('Search operations', { exact: true }).fill('Offline fixture 30')
  await page.getByText('1 total, 1 on this page', { exact: true }).waitFor()
  await page.getByText('Page 1 / 1', { exact: true }).waitFor()
  const deletion = page.getByRole('button', { name: 'Clear All Logs', exact: true })
  await deletion.waitFor(); await deletion.click()
  const confirm = page.getByRole('dialog', { name: 'Clear all logs and execution history?', exact: true })
  await confirm.waitFor()
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(JSON.parse(await readFile(historyPath, 'utf8')).length, 31)
  await stat(join(run, 'logs', 'engine.log'))
  await deletion.click()
  await page.screenshot({ path: join(artifacts, 'history-delete-confirmation-dark-large.png'), fullPage: true })
  await confirm.getByRole('button', { name: 'Confirm Clear All', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'All logs and execution history cleared' }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(historyPath, 'utf8')), [])
  await stat(resultPath)
  await assert.rejects(stat(join(run, 'logs', 'engine.log')))
  await assert.rejects(stat(join(run, 'temp', 'checkpoint.json')))

  // Real diagnostic IPC pagination: 20 entries per page and reset on filtering.
  const logPath = join(seedLogs, 'sap-toolbox-' + new Date().toISOString().slice(0, 10) + '.jsonl')
  await writeFile(logPath, Array.from({ length: 41 }, (_, index) => JSON.stringify({ id: `log-${index}`, timestamp: new Date().toISOString(),
    level: 'info', category: 'application', event: `mock.log.${index}`, message: 'offline diagnostic' })).join('\n') + '\n')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByText('Advanced / Key User Settings', { exact: true }).click()
  await page.getByText('mock.log.40', { exact: true }).waitFor()
  assert.equal(await page.locator('article').filter({ hasText: 'offline diagnostic' }).count(), 20)
  await page.getByRole('button', { name: 'Next page', exact: true }).click()
  await page.getByText('mock.log.20', { exact: true }).waitFor()
  assert.equal(await page.locator('article').filter({ hasText: 'offline diagnostic' }).count(), 20)
  await page.getByLabel('Search diagnostic logs', { exact: true }).fill('mock.log.0')
  await page.getByText('mock.log.0', { exact: true }).waitFor()
  await page.getByText('Page 1', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Next page', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: 'Clear All Logs', exact: true }).click()
  await page.getByRole('dialog', { name: 'Clear all logs and execution history?', exact: true }).getByRole('button', { name: 'Confirm Clear All', exact: true }).click()
  await page.getByText('No matching diagnostic entries / 没有匹配的诊断记录', { exact: true }).waitFor()
  await assert.rejects(stat(logPath))
  await stat(resultPath)
  assert.deepEqual(errors, [])
  console.log('RFQ runtime smoke passed: Running/Ready across routes, startup retention, history and diagnostic pagination/filter reset, confirmed Clear All despite filters, protected results, RFQ pause/rechecks. No SAP writes.')
} finally {
  if (app) await app.close()
  await rm(directory, { recursive: true, force: true })
}
