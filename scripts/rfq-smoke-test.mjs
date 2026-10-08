import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { _electron as electron } from 'playwright-core'

const testUserData = await mkdtemp(join(tmpdir(), 'sap-rfq-smoke-'))
const artifactDirectory = resolve('artifacts')
const sampleWorkbook = join(testUserData, 'rfq-test.xlsx')
execFileSync(process.env.SAP_RFQ_PYTHON || 'py', [...(process.env.SAP_RFQ_PYTHON ? [] : ['-3']), 'scripts/rfq-smoke-fixture.py', sampleWorkbook])
await mkdir(artifactDirectory, { recursive: true })
let electronApp
try {
  electronApp = await electron.launch(process.env.RFQ_PACKAGED_EXE
    ? { executablePath: process.env.RFQ_PACKAGED_EXE, args: [`--user-data-dir=${testUserData}`] }
    : { args: ['.', '--disable-gpu', `--user-data-dir=${testUserData}`] })
  const window = await electronApp.firstWindow()
  await window.getByText('Welcome back', { exact: true }).waitFor({ timeout: 30000 })
  await window.evaluate(async (downloadFolder) => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, defaultDownloadFolder: downloadFolder })
  }, testUserData)
  await electronApp.evaluate(({ dialog, shell }, file) => {
    dialog.showSaveDialog = async (...args) => ({ canceled: false, filePath: args.at(-1).defaultPath })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    shell.showItemInFolder = () => undefined
  }, sampleWorkbook)
  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  await window.getByRole('heading', { name: 'Create Buyer Receipt / RFQ', exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).waitFor()
  await stat(join(testUserData, 'Create_RFQ_Template.xlsx'))
  const run = window.getByRole('button', { name: 'Start Automation', exact: true })
  if (await run.isEnabled()) throw new Error('Start was enabled before preview')
  await window.getByRole('button', { name: 'Upload completed template', exact: true }).click()
  await window.getByText('RFQ file ready', { exact: true }).waitFor({ timeout: 120000 })
  await window.getByText('Parma 12345', { exact: true }).waitFor()
  await window.getByText(/Input rows: 3.*Unique ready rows: 2.*Duplicates automatically ignored: 1/).waitFor()
  if (!(await run.isEnabled())) throw new Error('Start not enabled after valid preview')
  await window.getByText('View details', { exact: false }).first().click()
  const rows = window.locator('tbody tr')
  if ((await rows.nth(0).locator('td').allTextContents()).slice(4,8).join('|') !== '120|0|25|No') throw new Error('First-row quantities or Cost Breakdown are not visible')
  if ((await rows.nth(1).locator('td').allTextContents()).slice(4,8).join('|') !== '300|10|50|Yes') throw new Error('Second-row quantities or Cost Breakdown are not visible')
  const rejected = await window.evaluate((excelPath) => window.sapAutomation.startRfqBatch({ excelPath, environment: 'PROD', productionConfirmed: false }), sampleWorkbook)
  if (rejected.success || rejected.errorCode !== 'INVALID_CONFIG') throw new Error('Production confirmation guard failed')
  const forbidden = await window.evaluate(() => window.sapAutomation.openRfqArtifact('C:/Windows/System32/cmd.exe'))
  if (forbidden.success) throw new Error('Untrusted file-open request was accepted')
  await window.screenshot({ path: join(artifactDirectory, 'rfq-v32-preview.png'), fullPage: true })
  await run.click()
  await window.getByRole('dialog').waitFor()
  await window.getByText('Ready to Start', { exact: true }).waitFor()
  await window.screenshot({ path: join(artifactDirectory, 'rfq-v32-confirmation.png'), fullPage: true })
  // Never confirm PROD in a test. Cancel before injecting a purely UI mock.
  await window.getByRole('button', { name: 'Cancel', exact: true }).click()
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('rfq:start')
    ipcMain.handle('rfq:start', (event) => {
      for (const update of [
        { type: 'GROUP_STARTED', current: 1, total: 1, groupKey: 'test', supplier: '12345', plant: 'C100', project: 'TEST-P1', materials: ['10000001', '10000002'], message: 'Mock group started' },
        { type: 'RFQ_CREATED', current: 1, total: 1, rfqNumber: 'MOCK-10001', message: 'Mock result saved' },
        { type: 'RUN_COMPLETED', current: 1, total: 1, succeeded: 1, skipped: 0, failed: 0, message: 'Mock run completed' }
      ]) event.sender.send('rfq:progress', { stage: 'processing', status: 'running', ...update })
      return { success: true, message: 'Mock run completed', processed: 1, succeeded: 1, skipped: 0, failed: 0, total: 1, withSkips: 0, materials: 2, rfqNumbers: ['MOCK-10001'], resultPath: '' }
    })
  })
  await run.click()
  await window.getByRole('button', { name: 'Confirm and Start', exact: true }).click()
  await window.getByText(/MOCK-10001/).first().waitFor()
  await window.getByRole('button', { name: 'Run Another Task', exact: true }).waitFor()
  await window.screenshot({ path: join(artifactDirectory, 'rfq-v32-result-mock.png'), fullPage: true })
  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  await window.getByRole('heading', { name: 'Create Buyer Receipt / RFQ', exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
  await window.getByText(/MOCK-10001/).first().waitFor()
  await window.evaluate(() => {
    globalThis.document.documentElement.dataset.theme = 'dark'
    globalThis.document.documentElement.dataset.fontSize = 'large'
  })
  await window.setViewportSize({ width: 1100, height: 900 })
  if (await window.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.document.documentElement.clientWidth)) throw new Error('RFQ layout overflows at large font size')
  await window.screenshot({ path: join(artifactDirectory, 'rfq-v32-dark-large.png'), fullPage: true })
  // Shared app modal must remain visible outside the RFQ route, even when audio
  // is unavailable. These are UI-only requests; no native SAP engine is run.
  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  await window.evaluate(() => {
    globalThis.AudioContext = class { constructor() { throw new Error('Mock audio policy denial') } }
  })
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows()[0]
    let attempt = 0
    let current = { automation: 'RFQ',runId: 'UI-MOCK',requestId: 'ui-request-1',state: 'WAITING_FOR_USER',
      allowedActions: ['continue','stop'],materials: ['53720956'],rows: [3],groupKey: 'UI-GROUP',
      recoveryPoint: 'PROD_RFQ_STAGING',step: 'PROD_RFQ_STAGING',message: 'Material 53720956 has two SAP rows' }
    ipcMain.removeHandler('automation:interaction:get')
    ipcMain.removeHandler('automation:interaction:respond')
    ipcMain.handle('automation:interaction:get', () => current)
    ipcMain.handle('automation:interaction:respond', (_event,input) => {
      if (!current || input.runId !== current.runId || input.requestId !== current.requestId) return { success: false }
      if (input.action === 'stop') {
        current = null
        owner.webContents.send('automation:interaction',null)
      } else if (++attempt === 1) {
        current = { ...current, requestId: 'ui-request-2', message: 'The issue is still present. Duplicate SAP rows remain.' }
        owner.webContents.send('automation:interaction',current)
      } else {
        current = null
        owner.webContents.send('automation:interaction',null)
      }
      return { success: true }
    })
    owner.webContents.send('automation:interaction',current)
  })
  const actionModal = window.getByRole('dialog', { name: 'Action Required', exact: true })
  await actionModal.waitFor()
  await window.keyboard.press('Escape')
  if (!(await actionModal.isVisible())) throw new Error('Escape dismissed the paused action modal')
  await actionModal.getByRole('button',{name:'Continue',exact:true}).click()
  await actionModal.getByRole('button',{name:'Check Again',exact:true}).waitFor()
  await window.screenshot({ path: join(artifactDirectory,'rfq-v32-recovery-dark-large.png'), fullPage:true })
  await actionModal.getByRole('button',{name:'Check Again',exact:true}).click()
  await actionModal.waitFor({state:'hidden'})
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('automation:interaction', {
      automation:'RFQ',runId:'UI-MOCK',requestId:'ui-request-unknown',state:'WAITING_FOR_USER',allowedActions:['stop'],
      materials:['53720956'],rows:[3],step:'RFQ_NUMBER',message:'Unknown outcome; no safe Continue.'
    })
  })
  const unsafe = window.getByRole('dialog',{name:'Automation Paused',exact:true})
  await unsafe.waitFor()
  if (await unsafe.getByRole('button',{name:'Continue',exact:true}).count()) throw new Error('Unsafe error offered blind Continue')
  // Restore a matching stop-only request to the mock main owner.
  await electronApp.evaluate(({ipcMain,BrowserWindow}) => {
    ipcMain.removeHandler('automation:interaction:respond')
    ipcMain.handle('automation:interaction:respond',(_event,input) => {
      if (input.action !== 'stop') return {success:false}
      BrowserWindow.getAllWindows()[0].webContents.send('automation:interaction',null)
      return {success:true}
    })
  })
  await unsafe.getByRole('button',{name:'Stop Automation',exact:true}).click()
  await unsafe.waitFor({state:'hidden'})
  console.log('RFQ smoke passed: download, real offline validation, grouping, PROD guard, confirmation, mocked results, global action modal, failed check, Continue/Stop, unsafe error, audio failure, dark/large layout. No SAP writes.')
} finally {
  if (electronApp) await electronApp.close()
  await rm(testUserData, { recursive: true, force: true })
}
