/* global window, document */
// Desktop UX regression. Real template downloads/previews; every SAP run is mocked.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { _electron as electron } from 'playwright-core'

const folder = await mkdtemp(join(tmpdir(), 'hub-guided-smoke-'))
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const modules = [
  { card: 'Update Info Record', title: 'Update Info Record', template: 'ME12_Supplier_Lead_Time_Template.xlsx', channel: 'me12', cells: [['A', '0012345678'], ['B', 'C100']], name: 'Info Record' },
  { card: 'APQP', title: 'APQP Plan Close Dates', template: 'APQP_Plan_Closure_Template.xlsx', channel: 'apqp', cells: [['A', '16808656'], ['D', '41889']], name: 'APQP' },
  { card: 'Update Source List', title: 'Update Source List', template: 'ME01_Source_List_Template.xlsx', channel: 'me01', cells: [['A', '16808656'], ['B', '41889']], name: 'Source List' }
]
for (const module of modules) {
  const archive = unzipSync(await readFile(join('resources/templates', module.template)))
  const key = 'xl/worksheets/sheet1.xml'
  const xml = strFromU8(archive[key])
  const prefix = xml.match(/<((?:\w+:)?)sheetData\b/)[1]
  const header = xml.match(new RegExp(`<${prefix}row\\b[^>]*\\br="1"[^>]*>[\\s\\S]*?</${prefix}row>`))[0]
  const row = `<${prefix}row r="2">${module.cells.map(([column, value]) => `<${prefix}c r="${column}2" t="inlineStr"><${prefix}is><${prefix}t>${value}</${prefix}t></${prefix}is></${prefix}c>`).join('')}</${prefix}row>`
  archive[key] = strToU8(xml.replace(new RegExp(`<${prefix}sheetData[^>]*>[\\s\\S]*?</${prefix}sheetData>`), `<${prefix}sheetData>${header}${row}</${prefix}sheetData>`))
  module.path = join(folder, module.template.replace('.xlsx', '_filled.xlsx'))
  await writeFile(module.path, zipSync(archive))
}
let app
try {
  app = await electron.launch({ args: ['.', '--disable-gpu', `--user-data-dir=${folder}`] })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  await page.evaluate(async folder => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, defaultDownloadFolder: folder })
    window.__tones = []
    window.AudioContext = class {
      currentTime = 0
      destination = {}
      resume() { return Promise.resolve() }
      createOscillator() { const value = { frequency: { value: 0 }, connect() {}, disconnect() {}, stop() {}, start() { window.__tones.push(value.frequency.value) } }; return value }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} } }
    }
  }, folder)
  await app.evaluate(({ dialog, shell }) => {
    dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: args.at(-1).defaultPath })
    shell.showItemInFolder = () => undefined
  })
  const operations = async () => { await page.getByRole('button', { name: 'Operations', exact: true }).click() }
  const open = async module => {
    await operations()
    await page.getByRole('heading', { name: module.card, exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
    await page.getByRole('heading', { name: module.title, exact: true, level: 2 }).waitFor()
  }
  await operations()
  assert.equal(await page.getByRole('button', { name: 'Open', exact: true }).count(), 4)
  assert.equal(await page.getByText(/ME52N|PR Modification|Project Ref/).count(), 0)
  assert.equal(await page.evaluate(() => Object.keys(window.sapAutomation).some(key => key.toLowerCase().includes('me52'))), false)
  await page.getByRole('button', { name: 'Info', exact: true }).first().click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: 'Close', exact: true }).last().click()
  for (const module of modules) {
    await open(module)
    await page.getByRole('button', { name: 'Download template', exact: true }).click()
    await stat(join(folder, module.template))
    const before = await readFile(module.path)
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, module.path)
    await page.getByRole('button', { name: 'Upload completed template', exact: true }).click()
    const run = page.getByRole('button', { name: module.channel === 'apqp' ? 'Start query' : 'Start Automation', exact: true })
    await run.waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => ['Start Automation', 'Start query'].includes(button.textContent.trim()) && !button.disabled && button.offsetParent !== null), { timeout: 45000 })
    assert.deepEqual(await readFile(module.path), before, 'Real preview must not modify the uploaded workbook')
    assert.equal(await page.getByLabel(/Sheet name|Session|Python|Starting row|Retry/).count(), 0)
    if (module.channel !== 'apqp') {
      await run.click()
      const confirmation = page.getByRole('dialog', { name: 'Ready to update', exact: true })
      await confirmation.waitFor()
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      assert.equal(await confirmation.isVisible(), false)
    }
    // Replace the entire start boundary before any confirmed execution.
    await app.evaluate(({ ipcMain, BrowserWindow }, module) => {
      const start = module.channel + ':start'
      ipcMain.removeHandler(start)
      ipcMain.removeHandler('automation:interaction:get')
      ipcMain.removeHandler('automation:interaction:respond')
      let current = null
      let finish
      let checks = 0
      const owner = BrowserWindow.getAllWindows()[0]
      ipcMain.handle('automation:interaction:get', () => current)
      ipcMain.handle(start, (_event, input) => {
        if (module.channel !== 'apqp' && !input.confirmed) return { success: false, message: 'Mock confirmation required' }
        current = { automation: module.name, runId: 'GUIDED-MOCK', requestId: 'request-1', state: 'WAITING_FOR_USER',
          allowedActions: module.channel === 'me01' ? ['stop'] : ['continue', 'stop'],
          recoveryPoint: 'SIGN_IN', issueSummary: 'Complete SAP sign-in.', message: 'Raw details only: MOCK_SAP_STATE',
          fields: module.channel === 'apqp' ? [
            { id: 'text', label: 'Text input', type: 'text', required: true },
            { id: 'date', label: 'Date input', type: 'date', required: true },
            { id: 'drop', label: 'Dropdown input', type: 'dropdown', required: true, options: [{ value: 'a', label: 'Choice A' }] },
            { id: 'yes', label: 'Yes/no input', type: 'yes-no', required: true },
            { id: 'check', label: 'Checkbox input', type: 'checkbox', required: true }
          ] : [] }
        owner.webContents.send('automation:interaction', current)
        return new Promise(resolve => { finish = resolve })
      })
      ipcMain.handle('automation:interaction:respond', (_event, input) => {
        if (!current || input.requestId !== current.requestId || input.runId !== current.runId) return { success: false }
        if (input.action === 'continue' && ++checks === 1) {
          current = { ...current, state: 'RECOVERING' }
          owner.webContents.send('automation:interaction', current)
          globalThis.setTimeout(() => { current = { ...current, state: 'WAITING_FOR_USER', requestId: 'request-2', message: 'The issue is still present. Not ready.', fields: [] }; owner.webContents.send('automation:interaction', current) }, 50)
        } else {
          current = null
          owner.webContents.send('automation:interaction', null)
          finish({ success: true, message: 'Mock completed safely', total: 1, processed: 1, succeeded: input.action === 'stop' ? 0 : 1, skipped: 0, failed: 0,
            cancelled: input.action === 'stop', resultPath: module.path, backupPath: '' })
        }
        return { success: true }
      })
      ipcMain.removeHandler('automation:open-artifact')
      ipcMain.handle('automation:open-artifact', (_event, path) => ({ success: path === module.path }))
    }, module)
    await run.click()
    if (module.channel !== 'apqp') await page.getByRole('dialog', { name: 'Ready to update' }).getByRole('button', { name: 'Start Automation', exact: true }).click()
    const prompt = page.getByRole('dialog', { name: module.channel === 'me01' ? 'Automation Paused' : 'Action Required', exact: true })
    await prompt.waitFor()
    await page.evaluate(() => { window.location.hash = '/operations' }) // A route change must not dismiss the global pause.
    assert.equal(await prompt.isVisible(), true)
    if (module.channel === 'me01') {
      assert.equal(await prompt.getByRole('button', { name: 'Continue', exact: true }).count(), 0)
      await prompt.getByRole('button', { name: 'Stop Automation', exact: true }).click()
    } else {
      if (module.channel === 'apqp') {
        await prompt.getByRole('button', { name: 'Continue', exact: true }).click()
        await prompt.getByRole('alert').waitFor()
        await prompt.getByLabel('Text input').fill('Business input')
        await prompt.getByLabel('Date input').fill('2026-10-03')
        await prompt.getByLabel('Dropdown input').selectOption('a')
        await prompt.getByLabel('Yes/no input').selectOption('yes')
        await prompt.getByLabel('Checkbox input').check()
      }
      await prompt.getByRole('button', { name: 'Continue', exact: true }).click()
      await prompt.getByRole('button', { name: 'Check Again', exact: true }).waitFor()
      await prompt.getByRole('button', { name: 'Check Again', exact: true }).click()
    }
    await prompt.waitFor({ state: 'hidden' })
    await open(module)
    const result = page.getByRole('region', { name: 'Automation result', exact: true })
    await result.waitFor()
    await result.getByRole('button', { name: 'Open Result', exact: true }).click()
    await result.getByText('View Details', { exact: true }).click()
    await result.getByText(/Mock completed safely/).waitFor()
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.fontSize = 'large' })
    await page.setViewportSize({ width: 1100, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
    await page.screenshot({ path: join(artifacts, `guided-${module.channel}-dark-large.png`), fullPage: true })
    await result.getByRole('button', { name: 'Run Another Task', exact: true }).click()
    assert.equal(await run.isEnabled(), false)
  }
  // Error feedback uses a friendly primary message and a local error tone.
  await open(modules[0])
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['C:/missing-input.xlsx'] }) })
  await page.getByRole('button', { name: 'Upload completed template', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'We could not validate' }).waitFor()
  const tones = await page.evaluate(() => window.__tones)
  assert(tones.includes(523), 'SUCCESS tone')
  assert(tones.includes(660), 'ATTENTION tone')
  assert(tones.includes(330), 'ERROR tone')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  assert.equal(await page.getByLabel('SAP WebGUI URL Template').count(), 0)
  await page.getByLabel('Notification Sounds', { exact: true }).uncheck()
  await page.getByLabel('Theme', { exact: true }).selectOption('dark')
  await page.getByLabel('Text Size', { exact: true }).selectOption('large')
  const count = await page.evaluate(() => window.__tones.length)
  await page.getByRole('button', { name: 'Save Settings', exact: true }).click()
  await page.getByText('Settings saved', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__tones.length), count, 'Sound disabled must be silent')
  await page.getByText('Advanced / Key User Settings', { exact: true }).click()
  await page.getByLabel('SAP WebGUI URL Template').waitFor()
  await page.screenshot({ path: join(artifacts, 'guided-settings-advanced.png'), fullPage: true })
  await page.getByRole('button', { name: 'Execution History', exact: true }).click()
  await page.getByRole('heading', { name: 'Execution history', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click()
  assert.equal(await page.getByText('Available Operations', { exact: true }).locator('..').locator('strong').innerText(), '4')
  assert.deepEqual(errors, [])
  console.log('Guided desktop smoke passed: real downloads/previews; ME52N removed; confirmation; APQP no SAP-write confirmation; global WAIT/recheck/stop; five input types; shared results; sounds/mute; dark/large layout; Advanced hidden. No SAP accessed.')
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: join(artifacts, 'guided-smoke-failure.png'), fullPage: true }).catch(() => undefined)
  throw error
} finally {
  if (app) await app.close()
  console.log(`Isolated smoke fixtures retained at ${folder}`)
}
