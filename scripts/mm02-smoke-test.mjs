// Offline desktop smoke: real download + preview + stale-token gate. Execution IPC is mocked.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { row, workbookFixture } from './fixtures/mm02-workbook.mjs'

const folder = await mkdtemp(join(tmpdir(), 'hub-mm02-smoke-'))
const fixture = join(folder, 'filled.xlsx')
const template = 'MM02_Sub_commodity_Template.xlsx'
const writeFixture = code => writeFile(fixture, workbookFixture(row(2, '000123', code)))
await writeFixture('012345')
let app
try {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${folder}`], env: { ...process.env, LOCALAPPDATA: folder } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await app.evaluate(({ dialog, shell }, paths) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.download })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.fixture] })
    shell.showItemInFolder = () => undefined
  }, { download: join(folder, template), fixture })
  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  const card = page.getByRole('heading', { name: 'Automatically Update Material Sub-commodity in Batch', exact: true }).locator('..')
  await card.getByRole('button', { name: 'Info', exact: true }).click()
  await page.getByRole('dialog').getByText(/Requires SAP GUI Scripting/).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click()
  await card.getByRole('button', { name: 'Open', exact: true }).click()
  const start = page.getByRole('button', { name: 'Start Update', exact: true })
  assert.equal(await start.isEnabled(), false)
  await page.getByRole('button', { name: 'Download template', exact: true }).click()
  await page.getByText(`Downloaded: ${template}`, { exact: true }).waitFor()
  assert((await stat(join(folder, template))).size > 0)
  const before = await readFile(fixture)
  await page.getByRole('button', { name: 'Upload completed template', exact: true }).click()
  await page.getByRole('cell', { name: '012345', exact: true }).waitFor()
  assert.deepEqual(await readFile(fixture), before)

  // A change to the saved file after preview must not reach the runner.
  const preview = await page.evaluate(path => globalThis.window.sapAutomation.previewMm02Batch(path), fixture)
  assert.equal(preview.success, true)
  await writeFixture('112345')
  const changed = await page.evaluate(config => globalThis.window.sapAutomation.startMm02Batch(config),
    { excelPath: fixture, confirmed: true, previewToken: preview.preview.token })
  assert.equal(changed.errorCode, 'MM02_UPLOAD_CHANGED')
  await writeFixture('012345')

  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    ipcMain.removeHandler('mm02:start')
    ipcMain.removeHandler('mm02:cancel')
    let finish
    ipcMain.handle('mm02:start', async (_event, input) => {
      if (!input.confirmed || !/^[a-f0-9]{64}$/.test(input.previewToken)) throw new Error('Preview/confirmation missing')
      BrowserWindow.getAllWindows()[0].webContents.send('mm02:progress', { stage: 'processing', status: 'running', current: 0,
        total: 1, material: '000123', message: 'Processing material 000123.' })
      return await new Promise(resolve => { finish = resolve })
    })
    ipcMain.handle('mm02:cancel', () => {
      finish({ success: false, errorCode: 'CANCELLED', message: 'Stopped safely.', total: 1, processed: 0 })
      return { success: true }
    })
  })
  await start.click()
  const confirmation = page.getByRole('dialog', { name: 'Update SAP Sub-commodity?' })
  await confirmation.getByText(/Production 949/).waitFor()
  await confirmation.getByRole('button', { name: 'Start Automation', exact: true }).click()
  await page.getByText('Processing material 000123.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Stop safely', exact: true }).click()
  await page.getByText('Stopped safely.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Run Another Task', exact: true }).click()
  assert.equal(await start.isEnabled(), false)
  assert.deepEqual(errors, [])
  console.log('MM02 desktop smoke passed: Operations, Info, download, preview, changed-file gate, confirmation, progress, stop and reset. No SAP access.')
} finally {
  if (app) await app.close()
}
