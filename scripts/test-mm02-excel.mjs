import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import { cell, row, workbookFixture } from './fixtures/mm02-workbook.mjs'

const require = createRequire(import.meta.url)
function load(file) {
  file = resolve(file)
  const module = { exports: {} }
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function('require', 'module', 'exports', compiled)(name => name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name), module, module.exports)
  return module.exports
}

test('MM02 validates two-column saved workbooks before any native SAP engine is involved', async t => {
  const { readMm02Input } = load('src/main/services/mm02-excel-service.ts')
  const folder = await mkdtemp(join(tmpdir(), 'mm02-preview-fixture-'))
  const read = async (xml, header) => {
    const path = join(folder, 'test.xlsx')
    const bytes = workbookFixture(xml, header)
    await writeFile(path, bytes)
    const result = await readMm02Input(path)
    assert.deepEqual(new Uint8Array(await readFile(path)), bytes, 'Preview never modifies Excel')
    return result
  }
  await t.test('keeps leading zeros, combines identical duplicates, and returns original Excel rows', async () => {
    const first = row(2, '000123', '012345') + '<row r="3"/>' + row(4, '123', '012345')
    const result = await read(first)
    assert.equal(result.preview.uniqueMaterials, 1)
    assert.equal(result.preview.duplicateRows, 1)
    assert.deepEqual(result.tasks, [{ material: '000123', subCommodity: '012345', excelRows: [2, 4] }])
    const next = await read(row(2, '000123', '012346'))
    assert.notEqual(next.preview.token, result.preview.token, 'Saved changes invalidate the confirmed preview')
  })
  await t.test('rejects old headers, conflicts, short/blank values, formulas and numeric precision loss', async () => {
    await assert.rejects(read(row(2, '123', '123456'), 'Commodity'), /requires A1 = Material/)
    await assert.rejects(read(row(2, '000123', '012345') + row(3, '123', '112345')), /rows 2 and 3.*conflicting/)
    await assert.rejects(read(row(2, '123', '12345')), /row 2.*exactly 6 digits/)
    await assert.rejects(read(row(8, '', '123456')), /row 8.*valid Material/)
    await assert.rejects(read(`<row r="2">${cell('A2', '123')}<c r="B2"><f>1</f><v>123456</v></c></row>`), /row 2.*not a formula/)
    await assert.rejects(read(`<row r="2"><c r="A2"><v>1234567890123456</v></c>${cell('B2', '123456')}</row>`), /row 2.*as text/)
  })
  await t.test('the exact shipped blank template has valid headers and no fake input rows', async () => {
    await assert.rejects(readMm02Input(resolve('resources/templates/MM02_Sub_commodity_Template.xlsx')), /^Error: Fill at least one/)
  })
})
