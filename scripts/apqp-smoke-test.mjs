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
for (const [ref, value] of [['A2', '00012345'], ['B2', '0041889'], ['A3', '00099999'], ['B3', '0041889'], ['C3', '14.09.2026'], ['A4', '00077777']]) {
  const pattern = new RegExp(`<((?:\\w+:)?)c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</\\1c>)`)
  assert(pattern.test(xml), `Fixture cell ${ref} exists`)
  xml = xml.replace(pattern, (_, prefix) => `<${prefix}c r="${ref}" t="inlineStr"><${prefix}is><${prefix}t>${value}</${prefix}t></${prefix}is></${prefix}c>`)
}
archive[key] = strToU8(xml)
const fixture = join(directory, 'APQP_fixture.xlsx')
const bytes = zipSync(archive)
await writeFile(fixture, bytes)
// A header-only incompatible workbook must fail before any native preview.
const wrongArchive = unzipSync(bytes)
wrongArchive[key] = strToU8(xml.replace('Part No.', 'Unrelated column'))
const wrongFixture = join(directory, 'Wrong_headers.xlsx')
await writeFile(wrongFixture, zipSync(wrongArchive))
// Old five-column layout remains readable; generated only inside the isolated test directory.
const oldArchive = unzipSync(templateBytes)
const prefix = /<((?:\w+:)?)worksheet\b/.exec(strFromU8(oldArchive[key]))[1]
const row = (r, values) => `<${prefix}row r="${r}">${values.map((value,c) => `<${prefix}c r="${String.fromCharCode(65+c)}${r}" t="inlineStr"><${prefix}is><${prefix}t>${value}</${prefix}t></${prefix}is></${prefix}c>`).join('')}</${prefix}row>`
oldArchive[key] = strToU8(strFromU8(oldArchive[key]).replace(/<(?:\w+:)?sheetData\b[^>]*>[\s\S]*?<\/(?:\w+:)?sheetData>/,
  `<${prefix}sheetData>${row(1,['Part No.','Ver','Description','Vendor','APQP plan closure date'])}${row(2,['00012345','01','Legacy part','0041889',''])}${row(3,['00099999','02','Dated part','0041889','14.09.2026'])}</${prefix}sheetData>`))
const oldFixture = join(directory, 'Legacy_APQP.xlsx'), oldBytes = zipSync(oldArchive)
await writeFile(oldFixture, oldBytes)
const config = { excelPath: fixture, sheetName: '', plant: 'C100', system: '', client: '', maxWorkers: 3, createSessions: true, maxItems: 0, overwriteExisting: false, confirmed: false }
let app
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${directory}`], env: { ...process.env, LOCALAPPDATA: directory } })
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
  const card = window.getByRole('heading', { name: 'APQP Date Management', exact: true }).locator('..')
  await card.getByRole('button', { name: 'Info', exact: true }).click()
  await window.getByRole('dialog').waitFor()
  await window.getByRole('button', { name: 'Close', exact: true }).last().click()
  await card.getByRole('button', { name: 'Open', exact: true }).click()
  await window.getByRole('heading', { name: 'APQP Date Management', exact: true, level: 2 }).waitFor()
  await window.getByRole('tab', { name: 'Query Plan Closure Date', exact: true }).click()
  const run = window.getByRole('button', { name: 'Start query', exact: true })
  assert.equal(await run.isEnabled(), false)
  await window.getByRole('button', { name: 'Download template', exact: true }).click()
  await window.getByText('Template downloaded', { exact: true }).waitFor()
  await stat(join(directory, 'APQP_Plan_Closure_Template.xlsx'))
  const second = await window.evaluate(() => window.sapAutomation.downloadApqpTemplate())
  assert(second.success)
  assert.notEqual(second.path, join(directory, 'APQP_Plan_Closure_Template.xlsx'))
  assert.deepEqual(await readFile(join(directory, 'APQP_Plan_Closure_Template.xlsx')), templateBytes)
  const rejected = await window.evaluate((c) => window.sapAutomation.startApqp({ ...c, maxWorkers: 6 }), config)
  assert.equal(rejected.success, false, 'Invalid settings rejected without contacting SAP')
  const invalid = await window.evaluate((c) => window.sapAutomation.previewApqp({ ...c, maxWorkers: 6 }), config)
  assert.equal(invalid.success, false)
  const headerStart = Date.now()
  const wrong = await window.evaluate((c) => window.sapAutomation.previewApqp(c), {...config,excelPath:wrongFixture})
  assert.equal(wrong.success,false); assert.equal(wrong.errorCode,'APQP_TEMPLATE_INVALID')
  console.log(`Wrong headers rejected through desktop IPC in ${Date.now()-headerStart}ms.`)
  const legacy = await window.evaluate((c) => window.sapAutomation.previewApqp(c), {...config,excelPath:oldFixture})
  assert(legacy.success,legacy.message)
  assert.equal(legacy.preview.selected,1); assert.equal(legacy.preview.skipped,1)
  assert.equal(legacy.preview.sample[0].vendor,'0041889')
  assert.deepEqual(new Uint8Array(await readFile(oldFixture)),oldBytes,'Legacy preview does not alter the old workbook')
  const previewStarted = Date.now()
  const preview = await window.evaluate((c) => window.sapAutomation.previewApqp(c), config)
  console.log(`APQP saved-file preview via desktop IPC: ${Date.now()-previewStarted}ms; parse=${preview.preview?.parseMs?.toFixed(1)}ms.`)
  assert(preview.success, preview.message)
  assert.equal(preview.preview.source, 'saved-file')
  assert.equal(preview.preview.selected, 1)
  assert.equal(preview.preview.skipped, 1)
  assert.equal(preview.preview.invalid, 1)
  assert.equal(preview.preview.modes.keepExisting.selected, 1)
  assert.equal(preview.preview.modes.refreshExisting.selected, 2)
  assert.equal(preview.preview.modes.refreshExisting.skipped, 0)
  assert.equal(preview.preview.sample[0].material, '00012345')
  assert.equal(preview.preview.sample[0].vendor, '0041889')
  const overwrite = await window.evaluate((c) => window.sapAutomation.previewApqp({ ...c, overwriteExisting: true }), config)
  assert(overwrite.success, overwrite.message)
  assert.equal(overwrite.preview.selected, 2)
  assert.deepEqual(new Uint8Array(await readFile(fixture)), bytes, 'Preview must not save Excel changes')
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, fixture)
  await window.getByRole('button', { name: 'Upload completed template', exact: true }).click()
  await window.getByText('Fast preview uses the saved file. Before querying SAP, the app rechecks the current Excel data, including unsaved edits.', { exact: true }).waitFor()
  await window.getByText('00012345', { exact: true }).waitFor({ timeout: 30000 })
  assert.equal(await run.isEnabled(), false)
  await window.screenshot({ path: join(artifacts, 'apqp-operation.png'), animations: 'disabled', timeout: 10000 })
  assert.deepEqual(errors, [])
  console.log('APQP smoke passed: download, guide, upload, fast saved-file preview without Excel/Python, unchanged source, validation and authorization. No SAP query executed.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow()
    console.error('APQP smoke page state:', await page.evaluate(() => ({ hash: globalThis.location.hash,
      language: globalThis.document.documentElement.lang,
      visibleButtons: [...globalThis.document.querySelectorAll('button')].filter(button => button.offsetParent !== null).map(button => button.textContent.trim()) })).catch(() => 'Renderer unresponsive'))
    await page.screenshot({ path: join(artifacts, 'apqp-smoke-failure.png'), timeout: 5000, fullPage: true }).catch(() => undefined)
  }
  throw error
} finally {
  if (app) await app.close()
  console.log(`Isolated test workbook and profile retained at ${directory}`)
}
