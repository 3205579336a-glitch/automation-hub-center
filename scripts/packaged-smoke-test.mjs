import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const executablePath = process.argv[2]
if (!executablePath) throw new Error('Packaged executable path is required.')
await stat(executablePath)

const userData = await mkdtemp(join(tmpdir(), 'sap-toolbox-packaged-'))
let app
try {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`] })
  const window = await app.firstWindow({ timeout: 60_000 })
  const pageErrors = []
  window.on('pageerror', (error) => pageErrors.push(error.message))
  await window.getByText('Welcome back', { exact: true }).waitFor({ timeout: 20_000 })

  const bridge = await window.evaluate(() => ({
    rfq: typeof window.sapAutomation?.startRfqBatch,
    me12: typeof window.sapAutomation?.startMe12Batch,
    me01: typeof window.sapAutomation?.startMe01Batch,
    me52n: typeof window.sapAutomation?.startMe52nBatch,
    apqp: typeof window.sapAutomation?.startApqp
  }))
  if (Object.values(bridge).some((value) => value !== 'function')) {
    throw new Error(`Packaged preload bridge is incomplete: ${JSON.stringify(bridge)}`)
  }

  await window.evaluate(async (folder) => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, defaultDownloadFolder: folder })
  }, userData)
  await app.evaluate(({ dialog, shell }) => {
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1)
      return { canceled: false, filePath: options.defaultPath }
    }
    shell.showItemInFolder = () => undefined
  })

  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  const rfqCard = window.getByRole('heading', { name: 'Create RFQ', exact: true }).locator('..')
  await rfqCard.getByRole('button', { name: 'Open operation', exact: true }).click()
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

  await window.getByRole('button', { name: 'Back to Operations', exact: true }).click()
  const prCard = window.getByRole('heading', { name: 'ME52N Project Ref', exact: true }).locator('..')
  await prCard.getByRole('button', { name: 'Open operation', exact: true }).click()
  const concurrency = window.getByLabel('Concurrent browsers (1–5)')
  await concurrency.fill('3')
  if (await concurrency.inputValue() !== '3') throw new Error('ME52N concurrency did not accept three workers.')
  await window.getByText('3 independent Chrome browser(s) will open.', { exact: false }).waitFor()
  if (await window.getByRole('button', { name: 'Run ME52N', exact: true }).isEnabled()) {
    throw new Error('Live ME52N was enabled without a workbook preview and confirmation.')
  }

  if (pageErrors.length) throw new Error(`Packaged renderer errors: ${pageErrors.join(' | ')}`)
  console.log('Packaged smoke passed: startup, all four templates, offline bridges, and ME52N 3-browser guard.')
} finally {
  if (app) await app.close()
  await rm(userData, { recursive: true, force: true })
}
