/* global document */
// Isolated UI acceptance. All RFQ/SAP launch, preview and stop boundaries are mocked.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'hub-rfq-stop-smoke-')), artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
let app
try {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${directory}`], env: { ...process.env, LOCALAPPDATA: directory } })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0]
    const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
    const emit = event => owner.webContents.send('rfq:progress', { stage: 'processing', status: 'running', ...event })
    globalThis.stopMode = 'read'; globalThis.stopCalls = 0; globalThis.startCalls = 0
    globalThis.stopEmit = emit
    replace('rfq:select-excel-file', () => ({ success: true, path: 'C:/MOCK/stop-input.xlsx' }))
    replace('rfq:preview', () => ({ success: true, preview: { sheetName: 'RPA_Input', totalRows: 1, validRows: 1, invalidRows: 0, skippedBlankRows: 0, skippedRows: 0,
      sample: [], fingerprint: 'mock', groupCount: 1, groups: [{ key: 'STOP-TEST', plant: 'C100', project: '775773', supplier: '41889', materials: ['16808656'] }], plants: ['C100'], warnings: [] } }))
    replace('rfq:start', () => new Promise(finish => {
      globalThis.startCalls++
      globalThis.stopFinish = () => {
        const numbers = globalThis.stopMode === 'protected' ? ['MOCK-SAVED-1'] : []
        if (numbers.length) emit({ type: 'RFQ_CREATED', rfqNumber: numbers[0], message: 'Mock saved RFQ number retained' })
        emit({ type: 'RUN_CANCELLED', stage: 'cancelled', state: 'CANCELLED', message: 'Mock stopped; existing results retained' })
        finish({ success: false, errorCode: 'CANCELLED', message: 'Mock stopped; existing results retained', processed: numbers.length, total: 1,
          succeeded: numbers.length, skipped: 0, failed: 0, rfqNumbers: numbers })
      }
      emit({ type: 'GROUP_STARTED', groupKey: 'STOP-TEST', project: '775773', plant: 'C100', supplier: '41889', materials: ['16808656'] })
      for (const seconds of [35, 40, 45]) emit({ type: 'SAP_SLOW', state: 'SAP_SLOW', step: 'Creating Buyer Receipt', waitDetail: 'wnd[0]/tbar[1]/btn[13]', waitSeconds: seconds,
        message: 'Mock polling for btn[13]' })
    }))
    replace('rfq:cancel', () => {
      globalThis.stopCalls++
      emit({ type: globalThis.stopMode === 'protected' ? 'STOP_DEFERRED' : 'STOP_ACKNOWLEDGED', state: 'RUNNING', step: 'Creating Buyer Receipt', message: 'Mock stop accepted' })
      return { success: true, message: 'Mock request accepted; not yet finished' }
    })
    replace('automation:open-sap', () => { throw new Error('No SAP access allowed by this test') })
  })
  const openRfq = async () => {
    await page.getByRole('button', { name: 'Operations', exact: true }).click()
    await page.getByRole('heading', { name: 'Automatically Create Buyer Receipts and RFQs in Batch from NPL', exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
  }
  const start = async () => {
    await page.getByRole('button', { name: 'Upload completed template', exact: true }).click()
    await page.getByText('RFQ file ready', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Start Automation', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm and Start', exact: true }).click()
    await page.locator('header').getByText('Running', { exact: true }).waitFor()
    await page.getByText('View execution details', { exact: true }).click()
    await page.getByText('Mock polling for btn[13]', { exact: true }).waitFor()
    assert.equal(await page.getByText('Mock polling for btn[13]', { exact: true }).count(), 1, 'Repeated live waits update one log entry')
  }
  await openRfq(); await start()
  await page.getByRole('button', { name: 'Stop safely', exact: true }).click()
  await page.getByText('Stop request received', { exact: true }).waitFor()
  assert(await page.getByRole('button', { name: 'Stopping safely…', exact: true }).isDisabled())
  assert.equal(await page.getByText('The automation is still waiting for SAP. No action is required yet.', { exact: true }).count(), 0)
  await page.getByText(/Read-only waits before a new create\/save action stop promptly/).waitFor()
  await page.screenshot({ path: join(artifacts, 'rfq-stop-read-wait.png'), fullPage: true })
  assert.equal(await app.evaluate(() => globalThis.stopCalls), 1)
  await app.evaluate(() => globalThis.stopFinish())
  await page.locator('header').getByText('Ready', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Run Another Task', exact: true }).click()
  await app.evaluate(() => { globalThis.stopMode = 'protected' })
  await start()
  await page.getByRole('button', { name: 'Stop safely', exact: true }).click()
  await page.getByText(/A SAP action was issued for this group/).waitFor()
  assert(await page.getByRole('button', { name: 'Stopping safely…', exact: true }).isDisabled())
  // Changing routes/language does not discard the pending stop or its protection notice.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN')
  await page.getByLabel('Theme', { exact: true }).selectOption('dark')
  await page.getByLabel('Text Size', { exact: true }).selectOption('large')
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
  await page.getByRole('button', { name: '操作中心', exact: true }).click()
  await page.getByRole('heading', { name: '在 NPL 中自动批量创建 Buyer Receipt 和 RFQ', exact: true }).locator('..').getByRole('button', { name: '打开', exact: true }).click()
  await page.getByText('停止请求已接收', { exact: true }).waitFor()
  await page.getByText(/当前组已发出 SAP 操作，正在保护其完成及 Excel 结果回写/).waitFor()
  assert(await page.getByRole('button', { name: '正在安全停止…', exact: true }).isDisabled())
  await page.setViewportSize({ width: 1100, height: 900 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
  await page.screenshot({ path: join(artifacts, 'rfq-stop-protected-dark-large-zh.png'), fullPage: true })
  await app.evaluate(() => globalThis.stopFinish())
  await page.locator('header').getByText('就绪', { exact: true }).waitFor()
  await page.getByText(/已创建 RFQ 编号.*MOCK-SAVED-1/).waitFor()
  assert.equal(await app.evaluate(() => globalThis.stopCalls), 2)
  assert.equal(await app.evaluate(() => globalThis.startCalls), 2)
  assert.deepEqual(errors, [])
  console.log('RFQ stop desktop smoke passed: wait-log dedup; read-wait acknowledgement; protected-action notice; no false Ready before finish; duplicate-stop guard; saved RFQ number retained; bilingual dark/large route persistence. No SAP accessed.')
} catch (error) {
  if (app?.windows()[0]) await app.windows()[0].screenshot({ path: join(artifacts, 'rfq-stop-smoke-failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  if (app) await app.close()
  console.log(`Isolated fixtures retained at ${directory}`)
}
