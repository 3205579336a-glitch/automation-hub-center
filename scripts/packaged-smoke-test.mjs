import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'
import assert from 'node:assert/strict'
import { basename, dirname, resolve } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'

const executablePath = process.argv[2]
if (!executablePath) throw new Error('Packaged executable path is required.')
await stat(executablePath)

const userData = await mkdtemp(join(tmpdir(), 'sap-toolbox-packaged-'))
let app
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], env: { ...process.env, LOCALAPPDATA: userData } })
  const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), expectedVersion, 'Packaged EXE must match the frozen release version')
  const window = await app.firstWindow({ timeout: 60_000 })
  const pageErrors = []
  window.on('pageerror', (error) => pageErrors.push(error.message))
  await window.getByText('Welcome back', { exact: true }).waitFor({ timeout: 20_000 })

  const bridge = await window.evaluate(() => ({
    rfq: typeof window.sapAutomation?.startRfqBatch,
    me12: typeof window.sapAutomation?.startMe12Batch,
    me01: typeof window.sapAutomation?.startMe01Batch,
    apqp: typeof window.sapAutomation?.startApqp
  }))
  if (Object.values(bridge).some((value) => value !== 'function')) {
    throw new Error(`Packaged preload bridge is incomplete: ${JSON.stringify(bridge)}`)
  }
  assert.equal(await window.evaluate(() => Object.keys(window.sapAutomation).some(key => key.toLowerCase().includes('me52n'))), false)

  await window.evaluate(async (folder) => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, defaultDownloadFolder: folder, maxConcurrentBrowsers: 3, maxConcurrentSapSessions: 3 })
  }, userData)
  await app.evaluate(({ dialog, shell }) => {
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1)
      return { canceled: false, filePath: options.defaultPath }
    }
    shell.showItemInFolder = () => undefined
  })

  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  assert.equal(await window.getByRole('button', { name: 'Open', exact: true }).count(), 4)
  const rfqCard = window.getByRole('heading', { name: 'Automatically Create Buyer Receipts and RFQs in Batch from NPL', exact: true }).locator('..')
  await rfqCard.getByRole('button', { name: 'Open', exact: true }).click()
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).waitFor()
  await stat(join(userData, 'Create_RFQ_Template.xlsx'))
  const remainingTemplateDownloads = await window.evaluate(async () => Promise.all([
    window.sapAutomation.downloadMe12Template(),
    window.sapAutomation.downloadMe01Template(),
    window.sapAutomation.downloadApqpTemplate()
  ]))
  if (remainingTemplateDownloads.some((result) => !result.success)) {
    throw new Error(`A packaged template download failed: ${JSON.stringify(remainingTemplateDownloads)}`)
  }
  await Promise.all([
    stat(join(userData, 'ME12_Supplier_Lead_Time_Template.xlsx')),
    stat(join(userData, 'ME01_Source_List_Template.xlsx')),
    stat(join(userData, 'APQP_Plan_Closure_Template.xlsx'))
  ])

  const archive = unzipSync(await readFile(join(userData, 'ME01_Source_List_Template.xlsx')))
  const xml = strFromU8(archive['xl/worksheets/sheet1.xml'])
  assert.match(xml, /Dual Sourcing/)
  assert.match(xml, /Yes,No/)
  const modules = [
    ['Automatically Create Buyer Receipts and RFQs in Batch from NPL', 'Start Automation'],
    ['Automatically Update Supplier Lead Times (SLT) in Batch', 'Start Automation'],
    ['Automatically Query APQP Plan Close Dates in Batch', 'Start query'],
    ['Automatically Maintain Source Lists in Batch', 'Start Automation']
  ]
  for (const [title, action] of modules) {
    await window.getByRole('button', { name: 'Operations', exact: true }).click()
    await window.getByRole('heading', { name: title, exact: true }).locator('..').getByRole('button', { name: 'Open', exact: true }).click()
    await window.getByRole('heading', { name: title, level: 2, exact: true }).waitFor()
    assert(await window.getByRole('button', { name: action, exact: true }).isDisabled(), `${title}: no live run without a validated input`)
  }
  const savedSettings = await window.evaluate(() => window.sapAutomation.getSettings())
  assert.equal(savedSettings.maxConcurrentBrowsers, 3)
  assert.equal(savedSettings.maxConcurrentSapSessions, 3)

  if (pageErrors.length) throw new Error(`Packaged renderer errors: ${pageErrors.join(' | ')}`)
  console.log('Packaged smoke passed: startup, four templates, required Source List Yes/No, four task pages, persisted 3-worker settings, removed ME52N, and no-input execution guards. No SAP/browser run was started.')
} finally {
  if (app) await app.close()
  assert.equal(dirname(resolve(userData)), resolve(tmpdir()))
  assert(basename(userData).startsWith('sap-toolbox-packaged-'))
  await rm(userData, { recursive: true, force: true })
}
