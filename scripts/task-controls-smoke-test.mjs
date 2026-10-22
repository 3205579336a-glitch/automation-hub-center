/* global document */
// UI-only acceptance: all file/preview/run/cancel boundaries mocked before use. No SAP access.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'hub-task-controls-'))
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const input = join(directory, 'input.xlsx'), output = join(directory, 'result.xlsx')
await writeFile(input, 'protected input fixture')
await writeFile(output, 'protected result fixture')
const modules = [
  { channel: 'rfq', title: 'Automatically Create Buyer Receipts and RFQs in Batch from NPL' },
  { channel: 'me12', title: 'Automatically Update Supplier Lead Times (SLT) in Batch' },
  { channel: 'apqp', title: 'APQP Date Management' },
  { channel: 'me01', title: 'Automatically Maintain Source Lists in Batch' }
]
let app
try {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${directory}`], env: { ...process.env, LOCALAPPDATA: directory } })
  const page = await app.firstWindow(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  await app.evaluate(({ ipcMain, BrowserWindow }, { input, output }) => {
    const replace = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler) }
    const owner = BrowserWindow.getAllWindows()[0]
    const previews = {
      rfq: { sheetName: 'Mock', totalRows: 1, validRows: 1, invalidRows: 0, skippedRows: 0, skippedBlankRows: 0, groupCount: 1,
        groups: [{ key: 'MOCK', plant: 'C100', supplier: '41889', project: '775773', materials: ['16808656'] }], plants: ['C100'], warnings: [], sample: [], fingerprint: 'MOCK' },
      me12: { selectedInfoRecords: 1, duplicateRows: 0, sample: [{ infoRecord: '0012345678', plant: 'C100', excelRows: [2] }] },
      apqp: { selected: 1, skipped: 0, invalid: 0, sample: [{ material: '16808656', vendor: '41889', excelRow: 2 }] },
      me01: { uniqueMaterials: 1, uniqueSuppliers: 1, duplicateRows: 0, dualSourcingMaterials: 0, singleSourcingMaterials: 1, sample: [{ material: '16808656', parma: '41889', dualSourcing: false, excelRows: [2] }] }
    }
    globalThis.controls = { calls: {}, pending: {}, previews: {}, mode: '', deferred: null, stops: {} }
    for (const channel of ['rfq', 'me12', 'apqp', 'me01']) {
      replace(channel + (channel === 'apqp' ? ':select-excel' : ':select-excel-file'), () => ({ success: true, path: input }))
      replace(channel + ':download-template', () => ({ success: true, path: input }))
      replace(channel + ':preview', () => {
        globalThis.controls.previews[channel] = (globalThis.controls.previews[channel] || 0) + 1
        if (globalThis.controls.mode === 'error') return { success: false, message: 'MOCK_INVALID' }
        if (globalThis.controls.mode === 'defer') return new Promise(resolve => { globalThis.controls.deferred = () => resolve({ success: true, preview: previews[channel] }) })
        return { success: true, preview: previews[channel] }
      })
      replace(channel + ':start', (_event, config) => {
        assertGuard(config, channel)
        globalThis.controls.calls[channel] = (globalThis.controls.calls[channel] || 0) + 1
        if (channel === 'me01' && globalThis.controls.mode === 'run-error') return { success: false, errorCode: 'EXECUTION_FAILED', message: 'ME01_TEST_ERROR: supplier 41889 could not be read; no Save was replayed. C:\\owned-logs\\automation-runs\\7007e773-2918-4ec5-8002-75050a458ca3\\me01-errors.log' }
        if (channel === 'me01' && globalThis.controls.mode === 'cancelled') return { success: false, errorCode: 'CANCELLED', message: 'Stopped after the blocking error was acknowledged.', processed: 1, succeeded: 0, failed: 1, skipped: 0, resultPath: output }
        if (channel === 'me01' && ['copy', 'skip'].includes(globalThis.controls.mode)) return {
          success: true, message: globalThis.controls.mode === 'skip' ? 'SOURCE_EXISTS: target supplier already exists; no SAP changes.' : 'Results preserved',
          processed: 1, succeeded: 0, skipped: 1, failed: 0, resultPath: output, backupPath: input,
          ...(globalThis.controls.mode === 'copy' ? { warning: 'EXCEL_TEST_LOCKED: completed results saved in the log folder; do not rerun SAP.' } : {})
        }
        return new Promise(resolve => { globalThis.controls.pending[channel] = () => {
          owner.webContents.send(channel + ':progress', { type: 'RUN_COMPLETED', stage: 'complete', message: 'Mock finished', current: 1, total: 1 })
          resolve({ success: true, message: 'Mock finished', processed: 1, total: 1, succeeded: 1, failed: 0, skipped: 0, resultPath: output, rfqNumbers: ['MOCK-RFQ'] })
        } })
      })
      replace(channel + ':cancel', () => {
        globalThis.controls.stops[channel] = (globalThis.controls.stops[channel] || 0) + 1
        return { success: false, message: 'Mock stop rejected; retry is safe' }
      })
    }
    function assertGuard(config, channel) {
      if (config.excelPath !== input || (channel === 'rfq' ? !config.productionConfirmed : channel !== 'apqp' && !config.confirmed)) throw new Error('Mock production confirmation guard')
    }
    replace('rfq:open-artifact', () => ({ success: true }))
    replace('automation:open-artifact', () => ({ success: true }))
    globalThis.emitLateProgress = channel => owner.webContents.send(channel + ':progress', { type: 'RFQ_CREATED', stage: 'processing', message: 'STALE_EVENT', rfqNumber: 'STALE-RFQ' })
  }, { input, output })
  const open = async module => {
    await page.getByRole('button', { name: 'Operations', exact: true }).click()
    await page.getByRole('heading', { name: module.title, exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
    await page.getByRole('heading', { name: module.title, exact: true, level: 2 }).waitFor()
    if (module.channel === 'apqp') {
      const tab = page.getByRole('tab', { name: 'Query Plan Closure Date', exact: true })
      if (await tab.getAttribute('aria-selected') !== 'true') await tab.click()
    }
  }
  const toolbar = page.getByRole('region', { name: 'Task controls', exact: true })
  const clear = toolbar.getByRole('button', { name: 'Clear this page', exact: true })
  const clearDialog = page.getByRole('dialog', { name: 'Clear this task page?', exact: true })
  const upload = page.getByRole('button', { name: 'Upload completed template', exact: true })
  const reset = async () => {
    await clear.click()
    await clearDialog.getByText(/Excel files, downloaded templates/).waitFor()
    await clearDialog.getByRole('button', { name: 'Confirm Clear', exact: true }).click()
    await clearDialog.waitFor({ state: 'hidden' })
  }
  for (const module of modules) {
    await open(module)
    const run = toolbar.getByRole('button', { name: module.channel === 'apqp' ? 'Start query' : 'Start Automation', exact: true })
    assert(await clear.isDisabled(), 'Empty task cannot be cleared')
    assert(await run.isDisabled(), 'Missing upload blocks Start')
    assert((await toolbar.boundingBox()).y < (await upload.boundingBox()).y, 'Task actions must be above file preparation')
    await page.getByRole('button', { name: 'Download template', exact: true }).click()
    await upload.click()
    await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="Task controls"] button')].some(button => button.offsetParent !== null && /Start /.test(button.textContent) && !button.disabled))
    if (module.channel === 'me12') {
      await page.getByLabel(/^Supplier Lead Time \(days\)/).fill('9')
      await page.getByLabel(/^Purchasing Type/).selectOption('consignment')
    } else if (module.channel === 'apqp') await page.getByLabel(/^Refresh dates already in Excel/).selectOption('yes')
    await open(module)
    assert(await clear.isEnabled(), 'Navigation preserves task data')
    await clear.click()
    await clearDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert(await clear.isEnabled(), 'Cancel Clear preserves data')
    await reset()
    assert(await run.isDisabled())
    assert(await clear.isDisabled())
    assert.equal(await page.getByText(/Uploaded file:|Template saved:|Downloaded:/).count(), 0)
    if (module.channel === 'me12') {
      assert.equal(await page.getByLabel(/^Supplier Lead Time \(days\)/).inputValue(), '1')
      assert.equal(await page.getByLabel(/^Purchasing Type/).inputValue(), 'standard')
      assert.equal(await page.getByLabel('Plant *', { exact: true }).inputValue(), 'C100')
    } else if (module.channel === 'apqp') assert.equal(await page.getByLabel(/^Refresh dates already in Excel/).inputValue(), 'no')
    await upload.click()
    await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="Task controls"] button')].some(button => button.offsetParent !== null && /Start /.test(button.textContent) && !button.disabled))
    const previewCount = await app.evaluate((_electron, channel) => globalThis.controls.previews[channel], module.channel)
    await upload.click() // Re-upload exactly the same file must revalidate.
    await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="Task controls"] button')].some(button => button.offsetParent !== null && /Start /.test(button.textContent) && !button.disabled))
    assert((await app.evaluate((_electron, channel) => globalThis.controls.previews[channel], module.channel)) > previewCount)
    // The existing desktop shell deliberately has a 1100px minimum width.
    for (const [theme, width] of [['light', 1480], ['dark', 1100], ['dark', 1280]]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.fontSize = 'large' }, theme)
      await page.setViewportSize({ width, height: 950 })
      await toolbar.scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `${module.channel} ${theme} ${width} must not overflow`)
      const startBox = await run.boundingBox(), clearBox = await clear.boundingBox()
      assert(startBox.x >= clearBox.x + clearBox.width || startBox.y >= clearBox.y + clearBox.height, 'Actions must not overlap')
      await page.screenshot({ path: join(artifacts, `task-controls-${module.channel}-${theme}-${width}.png`), fullPage: true })
    }
    await page.setViewportSize({ width: 1280, height: 950 })
    await run.click()
    if (module.channel === 'rfq') await page.getByRole('button', { name: 'Confirm and Start', exact: true }).click()
    else if (module.channel !== 'apqp') await page.getByRole('dialog', { name: 'Ready to update', exact: true }).getByRole('button', { name: 'Start Automation', exact: true }).click()
    await page.locator('header').getByText('Running', { exact: true }).waitFor()
    assert(await clear.isDisabled(), 'Active task cannot be cleared')
    await toolbar.getByRole('button', { name: 'Stop safely', exact: true }).click()
    await toolbar.getByRole('button', { name: 'Stop safely', exact: true }).waitFor()
    assert(await toolbar.getByRole('button', { name: 'Stop safely', exact: true }).isEnabled(), 'Rejected stop permits safe retry')
    await open(module)
    assert(await clear.isDisabled(), 'Navigation cannot reset an active task')
    await app.evaluate((_electron, channel) => globalThis.controls.pending[channel](), module.channel)
    await page.locator('header').getByText('Ready', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Run Another Task', exact: true }).waitFor()
    if (module.channel === 'rfq') await page.getByText('MOCK-RFQ', { exact: false }).waitFor()
    await reset()
    assert.equal(await page.getByRole('button', { name: 'Run Another Task', exact: true }).count(), 0)
    assert(await clear.isDisabled())
    await app.evaluate((_electron, channel) => globalThis.emitLateProgress(channel), module.channel)
    // IPC round trip drains the late event before assertions.
    await page.evaluate(() => globalThis.window.sapAutomation.getSettings())
    assert.equal(await page.getByText(/STALE_EVENT|STALE-RFQ|MOCK-RFQ/).count(), 0, 'Late progress must not repopulate cleared results')
    assert.equal(await readFile(input, 'utf8'), 'protected input fixture')
    assert.equal(await readFile(output, 'utf8'), 'protected result fixture')
    assert.equal(await app.evaluate((_electron, channel) => globalThis.controls.calls[channel], module.channel), 1, 'Clear must not start or retry SAP')
  }
  // A preview already in flight must not return stale data after Clear.
  await open(modules[1])
  await app.evaluate(() => { globalThis.controls.mode = 'defer' })
  await upload.click()
  const deadline = Date.now() + 10000
  while (!await app.evaluate(() => Boolean(globalThis.controls.deferred))) {
    assert(Date.now() < deadline, 'Deferred preview must be requested')
    await page.waitForTimeout(50)
  }
  await reset()
  await app.evaluate(() => { globalThis.controls.deferred(); globalThis.controls.mode = '' })
  await page.evaluate(() => globalThis.window.sapAutomation.getSettings())
  assert(await clear.isDisabled())
  assert.equal(await page.locator('table:visible').count(), 0)
  await app.evaluate(() => { globalThis.controls.mode = 'error' })
  await upload.click()
  await page.getByRole('alert').filter({ hasText: 'We could not validate' }).waitFor()
  await reset()
  assert.equal(await page.getByRole('alert').filter({ hasText: 'We could not validate' }).count(), 0)
  await app.evaluate(() => { globalThis.controls.mode = '' })
  // Source List errors and Excel fallback notices must show full reasons without View Details.
  await open(modules[3])
  await app.evaluate(() => { globalThis.controls.mode = 'error' })
  await upload.click()
  let notice = page.getByRole('dialog', { name: 'Source List file could not be validated', exact: true })
  await notice.getByText(/MOCK_INVALID/).waitFor()
  assert.equal(await notice.locator('details').count(), 0)
  await notice.getByRole('button', { name: 'OK, understood', exact: true }).click()
  await reset()
  for (const mode of ['run-error', 'copy', 'skip', 'cancelled']) {
    await app.evaluate((_electron, mode) => { globalThis.controls.mode = mode }, mode)
    await upload.click()
    await toolbar.getByText('1 records ready to process', { exact: true }).waitFor()
    await toolbar.getByRole('button', { name: 'Start Automation', exact: true }).click()
    await page.getByRole('dialog', { name: 'Ready to update', exact: true }).getByRole('button', { name: 'Start Automation', exact: true }).click()
    await page.getByRole('region', { name: 'Automation result', exact: true }).waitFor()
    if (mode === 'skip' || mode === 'cancelled') {
      assert.equal(await page.getByRole('dialog').count(), 0, 'Existing-target skips and acknowledged stops do not prompt again')
      await page.getByRole('region', { name: 'Automation result', exact: true }).getByText(mode === 'skip' ? /SOURCE_EXISTS/ : /Stopped after/).waitFor()
    } else {
      notice = page.getByRole('dialog', { name: mode === 'copy' ? 'Results saved in the log folder' : 'Source List could not finish', exact: true })
      await notice.getByText(mode === 'copy' ? /EXCEL_TEST_LOCKED/ : /ME01_TEST_ERROR/).waitFor()
      assert.equal(await notice.locator('details').count(), 0)
      if (mode === 'copy') await notice.getByText(output, { exact: false }).waitFor()
      await page.setViewportSize({ width: 1024, height: 768 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
      assert.equal(await notice.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false, 'Long error/log paths must wrap inside the popup')
      await page.screenshot({ path: join(artifacts, `source-list-${mode}-popup.png`), fullPage: true })
      await notice.getByRole('button', { name: 'OK, understood', exact: true }).click()
    }
    await reset()
  }
  await app.evaluate(() => { globalThis.controls.mode = '' })
  // Clearing one page must not clear another page's saved upload.
  await open(modules[1])
  await upload.click()
  await toolbar.getByText('1 records ready to process', { exact: true }).waitFor()
  await open(modules[3]); await upload.click()
  await toolbar.getByText('1 records ready to process', { exact: true }).waitFor()
  await reset(); await open(modules[1])
  await toolbar.getByText('1 records ready to process', { exact: true }).waitFor()
  assert(await clear.isEnabled())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN')
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
  await page.getByRole('button', { name: '操作中心', exact: true }).click()
  await page.getByRole('heading', { name: '自动批量更新供应商交货时间（SLT）', exact: true }).locator('..').getByRole('button', { name: '打开', exact: true }).click()
  await page.getByRole('button', { name: '清空本页', exact: true }).click()
  await page.getByRole('dialog', { name: '清空当前页面？', exact: true }).getByRole('button', { name: '确认清空', exact: true }).click()
  assert(await page.getByRole('button', { name: '开始自动化', exact: true }).isDisabled())
  assert.deepEqual(errors, [])
  console.log('Task controls smoke passed: all four top toolbars; bilingual confirmed reset; default business options; route persistence and page isolation; same-file re-upload; active-run reset lock; rejected stop retry; stale preview/progress protection; error/result reset; light/dark/large responsive layouts. No SAP accessed or files deleted.')
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: join(artifacts, 'task-controls-failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  if (app) await app.close()
  console.log(`Isolated fixtures retained at ${directory}`)
}
