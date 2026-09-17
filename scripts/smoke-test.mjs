import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const testUserData = await mkdtemp(join(tmpdir(), 'sap-toolbox-smoke-'))
const artifactDirectory = resolve('artifacts')
const me12WorkbookPath = 'C:\\Users\\A533700\\Downloads\\43888 SKF CHINA v2.xlsx'
const me12WorkbookBefore = await stat(me12WorkbookPath)
await mkdir(artifactDirectory, { recursive: true })

let electronApp
const pageErrors = []
const processErrors = []

try {
  electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${testUserData}`]
  })
  electronApp.process().stderr?.on('data', (chunk) => processErrors.push(String(chunk)))
  const window = await electronApp.firstWindow({ timeout: 60_000 })
  window.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    await window.getByText('Welcome back', { exact: true }).waitFor({ timeout: 15_000 })
  } catch (error) {
    await window.screenshot({ path: join(artifactDirectory, 'launch-failure.png'), fullPage: true })
    const diagnostics = {
      url: window.url(),
      title: await window.title(),
      body: (await window.locator('body').innerText()).slice(0, 1_000),
      pageErrors,
      processErrors
    }
    throw new Error(`Electron did not render the dashboard: ${JSON.stringify(diagnostics)}`, { cause: error })
  }
  const bridgeAvailable = await window.evaluate(
    () => typeof window.sapAutomation?.openSapWebGui === 'function'
  )
  if (!bridgeAvailable) {
    throw new Error('The typed preload bridge is not available.')
  }
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

  const routes = [
    ['Operations', 'Automation catalog'],
    ['Execution History', 'Execution history'],
    ['Settings', 'Application settings'],
    ['Dashboard', 'Welcome back']
  ]

  for (const [navigationLabel, pageHeading] of routes) {
    await window.getByRole('button', { name: navigationLabel, exact: true }).click()
    await window.getByText(pageHeading, { exact: true }).waitFor()
  }

  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  await window.getByRole('button', { name: 'View guide', exact: true }).first().click()
  await window.getByRole('dialog').waitFor()
  await window.screenshot({ path: join(artifactDirectory, 'operation-guide.png'), fullPage: true })
  await window.getByRole('button', { name: 'Close', exact: true }).last().click()
  await window.getByRole('heading', { name: 'ME12 Supplier Lead Time', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Open operation', exact: true })
    .click()
  await window.getByText('Batch maintain Supplier Lead Time', { exact: true }).waitFor()
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).last().waitFor()
  await stat(join(testUserData, 'ME12_Supplier_Lead_Time_Template.xlsx'))
  const infoCategorySelect = window.locator('select:has(option[value="consignment"])')
  await infoCategorySelect.selectOption('consignment')
  if (await infoCategorySelect.inputValue() !== 'consignment') {
    throw new Error('ME12 Consignment Info Category could not be selected.')
  }
  await window.screenshot({ path: join(artifactDirectory, 'me12-template-flow.png'), fullPage: true })
  const previewResult = await window.evaluate(
    async (excelPath) =>
      window.sapAutomation.previewMe12Batch({
        excelPath,
        sheetName: '',
        infoRecordColumn: 1,
        plantColumn: 2,
        dataStartRow: 2,
        targetPlant: 'C100',
        purchasingOrganization: 'C100',
        targetLeadTime: '1',
        infoCategory: 'standard',
        infoRecordWidth: 10,
        dryRun: false,
        maxItems: 0,
        maxRetries: 2,
        saveEvery: 5
      }),
    me12WorkbookPath
  )
  if (!previewResult.success || previewResult.preview.selectedInfoRecords < 1) {
    throw new Error('ME12 workbook preview did not select any Info Records.')
  }
  const runMe12Button = window.getByRole('button', { name: 'Run ME12 batch', exact: true })
  if (await runMe12Button.isEnabled()) {
    throw new Error('Live ME12 execution was enabled before explicit authorization.')
  }
  const me12WorkbookAfter = await stat(me12WorkbookPath)
  if (
    me12WorkbookAfter.size !== me12WorkbookBefore.size ||
    me12WorkbookAfter.mtimeMs !== me12WorkbookBefore.mtimeMs
  ) {
    throw new Error('ME12 preview unexpectedly modified the source workbook.')
  }

  await window.getByRole('button', { name: 'Back to Operations', exact: true }).click()
  await window.getByRole('heading', { name: 'ME01 Source List', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Open operation', exact: true })
    .click()
  await window.getByText('Batch maintain Source List', { exact: true }).waitFor()
  const me01BridgeAvailable = await window.evaluate(
    () => typeof window.sapAutomation?.startMe01Batch === 'function'
  )
  if (!me01BridgeAvailable) throw new Error('The ME01 preload bridge is not available.')
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).last().waitFor()
  await stat(join(testUserData, 'ME01_Source_List_Template.xlsx'))
  await window.screenshot({ path: join(artifactDirectory, 'me01-template-flow.png'), fullPage: true })
  const rejectedMe01Preview = await window.evaluate(() =>
    window.sapAutomation.previewMe01Batch({ excelPath: 'missing.xlsx', confirmed: false })
  )
  if (rejectedMe01Preview.success) throw new Error('ME01 preview accepted a missing workbook.')
  await window.getByRole('button', { name: 'Back to Operations', exact: true }).click()
  await window.getByRole('heading', { name: 'ME52N Project Ref', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Open operation', exact: true })
    .click()
  await window.getByText('Batch maintain Project Ref', { exact: true }).waitFor()
  const me52nBridgeAvailable = await window.evaluate(
    () => typeof window.sapAutomation?.startMe52nBatch === 'function'
  )
  if (!me52nBridgeAvailable) throw new Error('The ME52N preload bridge is not available.')
  const runMe52nButton = window.getByRole('button', { name: 'Run ME52N', exact: true })
  if (await runMe52nButton.isEnabled()) throw new Error('Live ME52N execution was enabled before preview and authorization.')
  const rejectedMe52nPreview = await window.evaluate(() =>
    window.sapAutomation.previewMe52nBatch({
      excelPath: 'missing.xlsx', sheetName: '', prColumn: 9, dataStartRow: 2,
      batchStartRow: 0, batchSize: 100, targetProjectRef: '775873',
      allowedWbs: ['JY415-03671-01-01-01'], overwriteExisting: true,
      concurrency: 2, workerStartDelaySec: 2, taskErrorRetries: 1,
      loginTimeoutSec: 180, checkpointEnabled: true, writebackToSource: true,
      confirmed: false, parallelConfirmed: false
    })
  )
  if (rejectedMe52nPreview.success) throw new Error('ME52N preview accepted a missing workbook.')
  await window.screenshot({ path: join(artifactDirectory, 'me52n-operation.png'), fullPage: true })
  await window.getByRole('button', { name: 'Back to Operations', exact: true }).click()
  await window.getByRole('heading', { name: 'Create RFQ', exact: true })
    .locator('..')
    .getByRole('button', { name: 'Open operation', exact: true })
    .click()
  await window.getByText('Create RFQ', { exact: true }).first().waitFor()
  const rfqBridgeAvailable = await window.evaluate(
    () => typeof window.sapAutomation?.startRfqBatch === 'function'
  )
  if (!rfqBridgeAvailable) throw new Error('The Create RFQ preload bridge is not available.')
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).last().waitFor()
  await stat(join(testUserData, 'Create_RFQ_Template.xlsx'))
  const runRfqButton = window.getByRole('button', { name: 'Start Create RFQ', exact: true })
  if (await runRfqButton.isEnabled()) {
    throw new Error('Create RFQ was enabled before a valid workbook preview.')
  }
  await window.screenshot({ path: join(artifactDirectory, 'rfq-template-flow.png'), fullPage: true })

  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  const diagnosticsHeading = window.getByText(/Diagnostics/).first()
  await diagnosticsHeading.waitFor()
  await window.screenshot({ path: join(artifactDirectory, 'settings-smoke.png'), fullPage: true })
  await diagnosticsHeading.scrollIntoViewIfNeeded()
  await window.screenshot({ path: join(artifactDirectory, 'diagnostics-smoke.png'), fullPage: true })
  await window.locator('input[placeholder^="https://"]').fill('https://127.0.0.1:1/{tcode}')
  await window.locator('select:has(option[value="zh-CN"])').selectOption('zh-CN')
  await window.locator('select:has(option[value="large"])').selectOption('large')
  await window.locator('select:has(option[value="dark"])').selectOption('dark')
  await window.getByRole('button', { name: 'Save Settings', exact: true }).click()
  await window.locator('.page-heading .button.primary').waitFor()
  const preferencesApplied = await window.evaluate(
    () => {
      const sample = globalThis.document.querySelector('p')
      return globalThis.document.documentElement.dataset.fontSize === 'large' &&
        globalThis.document.documentElement.dataset.theme === 'dark' &&
        globalThis.document.documentElement.lang === 'zh-CN' &&
        sample !== null && Number.parseFloat(globalThis.getComputedStyle(sample).fontSize) >= 14
    }
  )
  if (!preferencesApplied) {
    throw new Error('The language, font-size, and theme preferences were not applied.')
  }
  await window.screenshot({ path: join(artifactDirectory, 'settings-dark-large.png'), fullPage: true })
  await window.locator('select:has(option[value="zh-CN"])').selectOption('en')
  await window.locator('select:has(option[value="large"])').selectOption('medium')
  await window.locator('select:has(option[value="dark"])').selectOption('light')
  await window.locator('.page-heading .button.primary').click()
  await window.getByRole('button', { name: 'Dashboard', exact: true }).waitFor()

  await window.getByRole('button', { name: 'Dashboard', exact: true }).click()
  await window.screenshot({ path: join(artifactDirectory, 'dashboard-smoke.png'), fullPage: true })

  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  await window.getByRole('button', { name: 'Open SAP WebGUI', exact: true }).click()
  await window
    .getByText(/Failed to open SAP WebGUI|SAP WebGUI ready|Complete SAP sign-in/, { exact: true })
    .waitFor({ timeout: 45_000 })

  const diagnosticResult = await window.evaluate(() =>
    globalThis.window.sapAutomation.getDiagnosticLogs({ search: 'SMEN', limit: 20 })
  )
  if (!diagnosticResult.dataDirectory.includes('.local-data')) {
    throw new Error('Application data is not using the hidden local-data directory.')
  }
  if (diagnosticResult.entries.length === 0) {
    throw new Error('The SAP automation operation was not written to diagnostic logs.')
  }
  const historyResult = await window.evaluate(() =>
    globalThis.window.sapAutomation.getExecutionHistory({ search: 'SMEN', limit: 20 })
  )
  if (
    !historyResult.entries.some(
      (entry) => entry.operation === 'open-sap' && entry.tcode === 'SMEN'
    )
  ) {
    throw new Error('The SAP automation operation was not written to real execution history.')
  }
  await window.getByRole('button', { name: 'Execution History', exact: true }).click()
  await window.getByText('Source: .local-data/data/execution-history.json', { exact: true }).waitFor()
  await window.getByRole('button', { name: /View Open SAP WebGUI/ }).first().click()
  await window.screenshot({ path: join(artifactDirectory, 'history-real.png') })
  await window.getByRole('button', { name: 'Dashboard', exact: true }).click()
  const runsToday = Number(
    await window.getByText('Runs Today', { exact: true }).locator('..').locator('strong').innerText()
  )
  if (!Number.isInteger(runsToday) || runsToday < 1) {
    throw new Error('Dashboard did not load real execution-history metrics.')
  }
  await window.screenshot({ path: join(artifactDirectory, 'dashboard-smoke.png'), fullPage: true })
  await stat(diagnosticResult.dataDirectory)
  await stat(diagnosticResult.logDirectory)

  if (pageErrors.length > 0) {
    throw new Error(`Renderer errors: ${pageErrors.join('; ')}`)
  }

  console.log('Smoke test passed: app launch, preload bridge, all routes, settings IPC, and automation IPC.')
  console.log(`Screenshot: ${join(artifactDirectory, 'dashboard-smoke.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'settings-smoke.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'settings-dark-large.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'operation-guide.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'rfq-template-flow.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'diagnostics-smoke.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'me12-template-flow.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'me01-template-flow.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'me52n-operation.png')}`)
  console.log(`Screenshot: ${join(artifactDirectory, 'history-real.png')}`)
} catch (error) {
  console.error('Smoke test failed:', error)
  process.exitCode = 1
} finally {
  if (electronApp) {
    await electronApp.close()
  }
  await rm(testUserData, { recursive: true, force: true })
}
