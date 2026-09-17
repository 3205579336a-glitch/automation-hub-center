import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const testUserData = await mkdtemp(join(tmpdir(), 'sap-rfq-smoke-'))
const artifactDirectory = resolve('artifacts')
const sampleWorkbook = resolve('.codex-spreadsheet-work/rfq-smoke-sample.xlsx')
await mkdir(artifactDirectory, { recursive: true })
let electronApp

try {
  electronApp = await electron.launch(
    process.env.RFQ_PACKAGED_EXE
      ? { executablePath: process.env.RFQ_PACKAGED_EXE, args: [`--user-data-dir=${testUserData}`] }
      : { args: ['.', `--user-data-dir=${testUserData}`] }
  )
  const window = await electronApp.firstWindow()
  await window.getByText('Welcome back', { exact: true }).waitFor({ timeout: 15_000 })
  await window.evaluate(async (downloadFolder) => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, defaultDownloadFolder: downloadFolder })
  }, testUserData)
  await electronApp.evaluate(({ dialog, shell }) => {
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1)
      return { canceled: false, filePath: options.defaultPath }
    }
    shell.showItemInFolder = () => undefined
  })

  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  await window.getByRole('button', { name: 'Open operation', exact: true }).first().click()
  await window.getByText('Create RFQ', { exact: true }).first().waitFor()
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).waitFor()
  await stat(join(testUserData, 'Create_RFQ_Template.xlsx'))

  const preview = await window.evaluate(
    (excelPath) => window.sapAutomation.previewRfqBatch({
      excelPath,
      environment: 'QA',
      productionConfirmed: false
    }),
    sampleWorkbook
  )
  if (!preview.success || preview.preview.validRows !== 1 || preview.preview.invalidRows !== 0) {
    throw new Error(`RFQ template preview failed: ${JSON.stringify(preview)}`)
  }

  const runButton = window.getByRole('button', { name: 'Start Create RFQ', exact: true })
  if (await runButton.isEnabled()) throw new Error('RFQ execution was enabled before a workbook was selected in the UI.')
  await window.screenshot({ path: join(artifactDirectory, 'create-rfq-qa.png'), fullPage: true })

  await window.getByRole('button', { name: /Production system/ }).click()
  await window.getByText('You selected Production', { exact: true }).waitFor()
  await window.screenshot({ path: join(artifactDirectory, 'create-rfq-production.png'), fullPage: true })
  console.log('RFQ smoke test passed: template download, real workbook validation, environment split, and production guard.')
} finally {
  if (electronApp) await electronApp.close()
  await rm(testUserData, { recursive: true, force: true })
}
