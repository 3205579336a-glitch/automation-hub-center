/* global window, document */
// Isolated Electron acceptance; all SAP-start endpoints are mocked. Recovery/savings IPC is real.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'hub-recovery-smoke-')), artifacts = resolve('artifacts')
const data = join(directory, '.local-data', 'data'), ledger = join(data, 'rfq-recovery'), runRoot = join(directory, 'SAP Automation Toolbox', 'runs')
for (const path of [artifacts, ledger]) await mkdir(path, { recursive: true })
const aliveChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { windowsHide: true, stdio: 'ignore' })
await new Promise((ready, reject) => { aliveChild.once('spawn', ready); aliveChild.once('error', reject) })
const liveExit = new Promise(resolveExit => aliveChild.once('exit', resolveExit))
const id = randomUUID(), liveId = randomUUID(), completed = new Date().toISOString()
const output = join(runRoot, id, 'output', 'result.xlsx'), log = join(runRoot, id, 'logs', 'engine.log')
for (const path of [join(runRoot, id, 'output'), join(runRoot, id, 'logs')]) await mkdir(path, { recursive: true })
await writeFile(output, 'protected saved-result fixture'); await writeFile(log, 'protected recovery evidence')
const record = { version: 1, runId: id, environment: 'PROD', startedAt: completed, updatedAt: completed,
  engineClosed: true, phase: 'review', projects: ['775773'], project: '775773', plant: 'C100', supplier: '41889', materials: ['16808656'],
  totalGroups: 12, completedGroupKeys: Array.from({ length: 7 }, (_, i) => `g${i + 1}`), uncertainGroupKeys: ['g8'],
  lastConfirmedCheckpoint: 'BUYER_RECEIPT_SAVED', checkpointGroup: 'g8', groupKey: 'g8', rfqNumbers: ['MOCK-SAVED'], resultPath: output }
await writeFile(join(ledger, id + '.json'), JSON.stringify(record))
await writeFile(join(ledger, liveId + '.json'), JSON.stringify({ ...record, runId: liveId, engineClosed: false, phase: 'active', enginePid: aliveChild.pid, resultPath: undefined }))
const history = [
  { id, operation: 'create-rfq', label: 'Interrupted fixture', summary: 'unknown', startedAt: completed, status: 'Running', succeeded: 7, resultPath: output },
  { id: liveId, operation: 'create-rfq', label: 'Live orphan fixture', summary: 'unknown', startedAt: completed, status: 'Running' },
  { id: randomUUID(), operation: 'create-rfq', label: 'Confirmed fixture', summary: 'mock', startedAt: completed, completedAt: completed, status: 'Success', succeeded: 2, durationMs: 300000 },
  { id: randomUUID(), operation: 'me12-batch', label: 'Confirmed SLT fixture', summary: 'mock', startedAt: completed, completedAt: completed, status: 'Success', succeeded: 10, durationMs: 100000 }
]
const historyPath = join(data, 'execution-history.json')
await writeFile(historyPath, JSON.stringify(history))
let app
async function launch() {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${directory}`], env: { ...process.env, LOCALAPPDATA: directory } })
  app.process().stderr?.on('data', chunk => console.log('Electron:', chunk.toString()))
  // Window creation happens after real IPC registration; mocking earlier races startup.
  const page = await app.firstWindow({ timeout: 15000 })
  page.setDefaultTimeout(15000)
  await app.evaluate(({ ipcMain, shell }) => {
    globalThis.recoveryStartCalls = 0; globalThis.recoveryOpenCalls = []
    for (const name of ['rfq:start', 'me12:start', 'me01:start', 'apqp:start', 'automation:open-sap']) {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, () => { globalThis.recoveryStartCalls++; return { success: false, message: 'Mock boundary: no SAP access' } })
    }
    shell.openPath = async path => { globalThis.recoveryOpenCalls.push(path); return '' }
  })
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  return page
}
try {
  let page = await launch()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const panel = page.getByRole('region', { name: 'Safe Recovery', exact: true })
  await panel.waitFor()
  const interrupted = panel.locator('article').filter({ hasText: id }), alive = panel.locator('article').filter({ hasText: liveId })
  await interrupted.getByText('7 / 12', { exact: true }).waitFor()
  await interrupted.getByText('Buyer Receipt saved', { exact: true }).waitFor()
  assert(await alive.getByRole('button', { name: 'Mark Resolved', exact: true }).isDisabled())
  assert(await alive.getByRole('button', { name: 'Open Result', exact: true }).isDisabled())
  assert.equal(JSON.parse(await readFile(historyPath, 'utf8')).filter(e => e.status === 'Running').length, 0, 'Orphan runs become Interrupted, not Running')
  const savings = page.getByRole('region', { name: 'Estimated time saved', exact: true })
  await savings.getByText('1h 53m', { exact: true }).first().waitFor()
  await savings.getByText('Manual baseline: reference defaults, not yet calibrated', { exact: true }).waitFor()
  const summary = await page.evaluate(() => window.sapAutomation.getTimeSavings())
  assert.equal(summary.today.savedMs, 6800000); assert.equal(summary.today.successfulUnits, 12)
  await interrupted.getByRole('button', { name: 'Verify in SAP', exact: true }).click()
  const verification = page.getByRole('dialog', { name: 'Verify in SAP — manual checklist', exact: true })
  await verification.getByText(/Do not click Create or Save/).waitFor()
  await verification.getByRole('button', { name: 'Close', exact: true }).click()
  await interrupted.getByRole('button', { name: 'Open Result', exact: true }).click()
  assert.deepEqual(await app.evaluate(() => globalThis.recoveryOpenCalls), [output])
  assert.equal(await readFile(output, 'utf8'), 'protected saved-result fixture')
  // Existing calibrated data is preserved; technical fields are no longer user-editable.
  await page.evaluate(async () => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, manualTimeCalibrated: true,
      manualTimeBaselines: { ...settings.manualTimeBaselines, 'create-rfq': 900 } })
  })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  assert.equal(await page.getByText('Advanced / Key User Settings', { exact: true }).count(), 0)
  await page.getByLabel('Theme', { exact: true }).selectOption('dark')
  await page.getByLabel('Text Size', { exact: true }).selectOption('large')
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
  await page.getByText('Settings saved', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
  await page.getByRole('region', { name: 'Estimated time saved' }).getByText('1h 13m', { exact: true }).first().waitFor()
  await page.setViewportSize({ width: 1100, height: 950 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
  await page.screenshot({ path: join(artifacts, 'safe-recovery-dashboard-dark-large.png'), fullPage: true })
  // Clearing logs must retain unresolved history, ledger and diagnostic evidence.
  await page.getByRole('button', { name: 'Execution History', exact: true }).click()
  await page.getByRole('button', { name: 'Clear All Logs', exact: true }).click()
  await page.getByRole('dialog', { name: 'Clear all logs and execution history?', exact: true }).getByRole('button', { name: 'Confirm Clear All', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Cleanup complete. Unfinished or unsafe diagnostics were kept.' }).waitFor()
  assert.equal(JSON.parse(await readFile(historyPath, 'utf8')).length, 2)
  await stat(log); await stat(output); await stat(join(ledger, id + '.json'))
  await interrupted.getByRole('button', { name: 'Mark Resolved', exact: true }).click()
  const resolution = page.getByRole('dialog', { name: 'Mark Resolved — confirm review', exact: true })
  const confirm = resolution.getByRole('button', { name: 'Checked in SAP — Finish Review', exact: true })
  assert(await confirm.isEnabled())
  assert.equal(await resolution.getByRole('checkbox').count(), 0)
  assert.equal(await resolution.getByRole('textbox').count(), 0, 'One explicit confirmation; no mandatory audit form')
  await resolution.getByText(/Confirm only if this task has stopped/).waitFor()
  await page.screenshot({ path: join(artifacts, 'safe-recovery-resolution-dark-large.png'), fullPage: true })
  await confirm.click(); await resolution.waitFor({ state: 'hidden' })
  assert.equal(await interrupted.count(), 0)
  const reviewed = JSON.parse(await readFile(historyPath, 'utf8')).find(e => e.id === id)
  assert.equal(reviewed.status, 'Interrupted'); assert(reviewed.recoveryResolvedAt); assert.match(reviewed.recoveryResolutionNote, /User confirmed in Hub/)
  assert.equal(await app.evaluate(() => globalThis.recoveryStartCalls), 0)
  await app.close(); app = null
  page = await launch()
  const afterRestart = page.getByRole('region', { name: 'Safe Recovery' })
  assert.equal(await afterRestart.locator('article').filter({ hasText: id }).count(), 0, 'Resolved review must persist across Hub restart')
  const remaining = afterRestart.locator('article').filter({ hasText: liveId })
  await remaining.getByRole('button', { name: 'Mark Resolved', exact: true }).waitFor()
  assert(await remaining.getByRole('button', { name: 'Mark Resolved', exact: true }).isDisabled())
  aliveChild.kill() // Test-owned idle Node fixture only; never any SAP/Hub/user process.
  await liveExit
  await afterRestart.getByRole('button', { name: 'Refresh recovery', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Mark Resolved' && !b.disabled))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN')
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
  // Save notification uses the language active when Save was clicked; navigation uses the new one.
  await page.getByRole('button', { name: '仪表板', exact: true }).waitFor()
  await afterRestart.getByRole('button', { name: '标记已处理', exact: true }).click()
  const chinese = page.getByRole('dialog', { name: '确认标记已处理', exact: true })
  await chinese.getByText('无需填表。系统自动记录确认时间；不会重跑、撤销 SAP 修改或把任务改成成功。', { exact: true }).waitFor()
  await chinese.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '仪表板', exact: true }).click()
  await page.getByRole('region', { name: '预计节省时间', exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'safe-recovery-dashboard-zh-dark-large.png'), fullPage: true })
  assert.equal(await app.evaluate(() => globalThis.recoveryStartCalls), 0)
  assert.deepEqual(errors, [])
  console.log('Safe Recovery desktop smoke passed: real local savings and calibrated baselines; 7/12 + saved-Buyer checkpoint; live orphan guard; manual SAP checklist; safe owned-result open; protected cleanup; explicit review + note; resolution across restart; no resume/no SAP endpoints invoked; bilingual dark/large UI.')
} catch (error) {
  if (app?.windows()[0]) await app.windows()[0].screenshot({ path: join(artifacts, 'safe-recovery-smoke-failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  if (app) await app.close()
  if (aliveChild.exitCode === null) { aliveChild.kill(); await liveExit }
  console.log(`Isolated recovery fixtures retained at ${directory}`)
}
