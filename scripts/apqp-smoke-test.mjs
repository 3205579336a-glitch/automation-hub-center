import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import { _electron as electron } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'apqp-smoke-'))
const artifacts = resolve('artifacts')
await mkdir(artifacts, { recursive: true })
const templateBytes = await readFile('resources/templates/APQP_Plan_Closure_Template.xlsx')
const archive = unzipSync(templateBytes)
const key = 'xl/worksheets/sheet1.xml'
let xml = strFromU8(archive[key])
for (const [ref, value] of [['A2', '00012345'], ['D2', '0041889'], ['A3', '00099999'], ['D3', '0041889'], ['E3', '14.09.2026'], ['A4', '00077777']]) {
  const pattern = new RegExp(`<x:c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</x:c>)`)
  assert(pattern.test(xml), `Fixture cell ${ref} exists`)
  xml = xml.replace(pattern, `<x:c r="${ref}" t="inlineStr"><x:is><x:t>${value}</x:t></x:is></x:c>`)
}
archive[key] = strToU8(xml)
const fixture = join(directory, 'APQP_fixture.xlsx')
const bytes = zipSync(archive)
await writeFile(fixture, bytes)
const config = { excelPath: fixture, sheetName: '', plant: 'C100', system: '', client: '', maxWorkers: 3, createSessions: true, maxItems: 0, overwriteExisting: false, confirmed: false }
let app
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${directory}`] })
  const window = await app.firstWindow()
  const errors = []
  window.on('pageerror', (error) => errors.push(error.message))
  await window.getByText('Welcome back', { exact: true }).waitFor()
  await window.evaluate(async (folder) => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({ ...settings, defaultDownloadFolder: folder })
  }, directory)
  await app.evaluate(({ dialog, shell }) => {
    let saveCount = 0
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1)
      saveCount += 1
      const filePath = saveCount === 1
        ? options.defaultPath
        : options.defaultPath.replace(/\.xlsx$/i, `_${saveCount}.xlsx`)
      return { canceled: false, filePath }
    }
    shell.showItemInFolder = () => undefined
  })
  await window.getByRole('button', { name: 'Operations', exact: true }).click()
  const card = window.getByRole('heading', { name: 'APQP Plan Closure Date', exact: true }).locator('..')
  await card.getByRole('button', { name: 'View guide', exact: true }).click()
  await window.getByRole('dialog').waitFor()
  await window.getByRole('button', { name: 'Close', exact: true }).last().click()
  await card.getByRole('button', { name: 'Open operation', exact: true }).click()
  await window.getByRole('heading', { name: 'Query APQP Plan Closure Date', exact: true }).waitFor()
  const run = window.getByRole('button', { name: 'Run APQP query', exact: true })
  assert.equal(await run.isEnabled(), false)
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).waitFor()
  await stat(join(directory, 'APQP_Plan_Closure_Template.xlsx'))
  const second = await window.evaluate(() => window.sapAutomation.downloadApqpTemplate())
  assert(second.success)
  assert.notEqual(second.path, join(directory, 'APQP_Plan_Closure_Template.xlsx'))
  assert.deepEqual(await readFile(join(directory, 'APQP_Plan_Closure_Template.xlsx')), templateBytes)
  const rejected = await window.evaluate((c) => window.sapAutomation.startApqp(c), config)
  assert.equal(rejected.success, false, 'Unconfirmed run rejected without contacting SAP')
  const invalid = await window.evaluate((c) => window.sapAutomation.previewApqp({ ...c, maxWorkers: 6 }), config)
  assert.equal(invalid.success, false)
  const preview = await window.evaluate((c) => window.sapAutomation.previewApqp(c), config)
  assert(preview.success, preview.message)
  assert.equal(preview.preview.selected, 1)
  assert.equal(preview.preview.skipped, 1)
  assert.equal(preview.preview.invalid, 1)
  assert.equal(preview.preview.sample[0].material, '00012345')
  assert.equal(preview.preview.sample[0].vendor, '0041889')
  const overwrite = await window.evaluate((c) => window.sapAutomation.previewApqp({ ...c, overwriteExisting: true }), config)
  assert(overwrite.success, overwrite.message)
  assert.equal(overwrite.preview.selected, 2)
  assert.deepEqual(new Uint8Array(await readFile(fixture)), bytes, 'Preview must not save Excel changes')
  await window.getByLabel('Create missing SAP session windows (subject to SAP limits)').check()
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, fixture)
  await window.getByRole('button', { name: 'Upload completed template', exact: true }).click()
  await window.getByText('00012345 / 0041889', { exact: true }).waitFor({ timeout: 30000 })
  assert.equal(await run.isEnabled(), false)
  await window.screenshot({ path: join(artifacts, 'apqp-operation.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log('APQP smoke passed: download, guide, upload, real Excel preview, unchanged source, validation and authorization. No SAP query executed.')
} finally {
  if (app) await app.close()
  console.log(`Isolated test workbook and profile retained at ${directory}`)
}
