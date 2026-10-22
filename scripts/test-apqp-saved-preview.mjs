// Real XLSX bytes, offline only: no native engine, Excel or SAP is opened.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { strToU8, zipSync } from 'fflate'
import ts from 'typescript'

const require = createRequire(import.meta.url), modules = new Map()
function load(path) {
  const file = resolve(path)
  if (modules.has(file)) return modules.get(file)
  const module = { exports: {} }
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', compiled)(name => name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name), module, module.exports)
  modules.set(file, module.exports)
  return module.exports
}
const { ApqpSavedPreview, ApqpLivePreviewRequired } = load('src/main/services/apqp-saved-preview.ts')
const { ApqpRunner } = load('src/main/automation/apqp-runner.ts')
const directory = await mkdtemp(join(tmpdir(), 'hub-apqp-fast-preview-'))
let sequence = 0
const compact = ['Part No.', 'Vendor', 'APQP plan closure date']
const legacy = ['Part No.', 'Ver', 'Description', 'Vendor', 'APQP plan closure date']
const cell = (reference, value) => `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`
const row = (index, values) => `<row r="${index}">${values.map((value, column) => cell(String.fromCharCode(65 + column) + index, value)).join('')}</row>`
async function fixture(data, { headers = compact, prefix = '', shared = [], path } = {}) {
  const xml = `<worksheet><sheetData>${row(1, headers)}${data}</sheetData></worksheet>`
  const bytes = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="urn:rels"><sheets><sheet name="APQP_Input" r:id="r1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(prefix ? xml.replace(/<(\/?)(\w+)/g, `<$1${prefix}:$2`) : xml),
    'xl/sharedStrings.xml': strToU8(`<sst>${shared.map(text => `<si><t>${text}</t></si>`).join('')}</sst>`)
  })
  const target = path ?? join(directory, `input-${sequence++}.xlsx`)
  await writeFile(target, bytes)
  return target
}
const config = excelPath => ({ excelPath, sheetName: '', maxItems: 0, overwriteExisting: false })

test('compact and legacy layouts retain row numbers/leading zeros and both mode counts', async () => {
  for (const headers of [compact, legacy]) {
    const values = headers === compact ? ['00012345', '0041889', ''] : ['00012345', '02', 'part', '0041889', '']
    const dated = headers === compact ? ['00099999', '0041889', '14.09.2026'] : ['00099999', '02', 'dated', '0041889', '14.09.2026']
    const invalid = headers === compact ? ['777', '', ''] : ['777', '01', 'missing vendor', '', '']
    const path = await fixture(row(2, values) + row(5, dated) + row(8, invalid), { headers, prefix: 'x' })
    const before = await readFile(path)
    const result = await new ApqpSavedPreview().read(config(path))
    assert.deepEqual([result.selected, result.skipped, result.invalid], [1, 1, 1])
    assert.deepEqual(result.sample, [{ material: '00012345', vendor: '0041889', excelRow: 2 }])
    assert.deepEqual([result.modes.refreshExisting.selected, result.modes.refreshExisting.skipped, result.modes.refreshExisting.invalid], [2, 0, 1])
    assert.equal(result.source, 'saved-file')
    assert.deepEqual(await readFile(path), before)
  }
})

test('shared strings, entities, numeric cells and zero/false date values match live Value2 selection', async () => {
  const data = '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2"><v>0</v></c></row>' +
    '<row r="3"><c r="A3"><v>1.2345E7</v></c><c r="B3"><v>41889.0</v></c><c r="C3" t="b"><v>0</v></c></row>' +
    row(4, ['A&amp;B', '0041889', '0'])
  const result = await new ApqpSavedPreview().read(config(await fixture(data, { shared: ['00012345', '0041889'] })))
  assert.equal(result.selected, 2)
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.sample[1], { material: '12345000', vendor: '41889', excelRow: 3 })
  assert.equal(result.modes.refreshExisting.sample[2].material, 'A&B')
})

test('maxItems stops each mode independently using the native selection rules', async () => {
  const path = await fixture(row(2, ['1', '41889', 'dated']) + row(3, ['2', '', '']) + row(4, ['3', '41889', '']) + row(5, ['4', '41889', '']))
  const result = await new ApqpSavedPreview().read({ ...config(path), maxItems: 1 })
  assert.deepEqual([result.selected, result.skipped, result.invalid], [1, 1, 1])
  assert.deepEqual([result.modes.refreshExisting.selected, result.modes.refreshExisting.invalid], [1, 0])
  assert.equal(result.sample[0].excelRow, 4)
})

test('formula/error/unsupported cells fall back; duplicate cells and damaged files fail closed', async () => {
  for (const source of ['<c r="A2"><f>1+1</f><v>2</v></c>', '<c r="A2" t="e"><v>#VALUE!</v></c>', '<c r="A2"><v>12345678901234567890</v></c>']) {
    const path = await fixture(`<row r="2">${source}${cell('B2', '41889')}</row>`)
    await assert.rejects(new ApqpSavedPreview().read(config(path)), ApqpLivePreviewRequired)
  }
  const duplicate = await fixture(`<row r="2">${cell('A2', '1')}${cell('A2', '2')}${cell('B2', '41889')}</row>`)
  await assert.rejects(new ApqpSavedPreview().read(config(duplicate)), /Duplicate/)
  const bad = join(directory, 'bad.xlsx'); await writeFile(bad, 'not Excel')
  await assert.rejects(new ApqpSavedPreview().read(config(bad)))
})

test('cached counts cannot be mutated; changes to file content or maxItems invalidate the snapshot', async () => {
  const path = await fixture(row(2, ['1', '41889', '']))
  const reader = new ApqpSavedPreview()
  const first = await reader.read(config(path))
  first.modes.refreshExisting.sample[0].material = 'tampered'
  const second = await reader.read({ ...config(path), overwriteExisting: true })
  assert.equal(second.sample[0].material, '1')
  await fixture(row(2, ['2', '41889', '']) + row(3, ['3', '41889', '']), { path })
  assert.equal((await reader.read(config(path))).selected, 2)
  assert.equal((await reader.read({ ...config(path), maxItems: 1 })).selected, 1)
})

test('10,000-row APQP preview benchmark, including cache and mode switch; zero native starts', async () => {
  const path = await fixture(Array.from({ length: 10000 }, (_, index) => row(index + 2, [String(10000000 + index), '0041889', index % 2 ? '14.09.2026' : ''])).join(''))
  const runner = new ApqpRunner({ executable: 'FORBIDDEN', script: 'FORBIDDEN' })
  runner.execute = async () => { throw Error('Normal preview must not start Python/Excel') }
  const begin = performance.now()
  const cold = await runner.preview(config(path))
  const parsed = performance.now()
  const cached = await runner.preview({ ...config(path), overwriteExisting: true })
  const end = performance.now()
  assert(cold.success, cold.message)
  assert(cached.success, cached.message)
  assert.equal(cold.preview.selected, 5000)
  assert.equal(cached.preview.selected, 10000)
  console.log(`APQP XLSX benchmark: 10,000 rows; cold=${(parsed - begin).toFixed(1)}ms; cached/mode change=${(end - parsed).toFixed(1)}ms; Python/Excel starts=0`)
})
