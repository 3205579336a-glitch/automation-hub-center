import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import ts from 'typescript'
import { strToU8, zipSync } from 'fflate'
const require = createRequire(import.meta.url)
const code = ts.transpileModule(readFileSync('src/main/services/me01-excel-service.ts', 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText
const module = {exports:{}}
new Function('require','module','exports', code)(require, module, module.exports)
const service = new module.exports.Me01ExcelService()
const businessModule = {exports:{}}
new Function('require','module','exports',ts.transpileModule(readFileSync('src/shared/me01-types.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,businessModule,businessModule.exports)
const runnerModule = {exports:{}}
new Function('require','module','exports',ts.transpileModule(readFileSync('src/main/automation/me01-native-runner.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(
  name => name === '../../shared/me01-types' ? businessModule.exports : name === './native-interaction-bridge' ? {} : require(name), runnerModule, runnerModule.exports)
const escape = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;')
async function fixture(rows, run) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-me01-preview-'))
  try {
    const path = join(directory,'input.xlsx')
    const xml = rows.map((row, i) => `<row r="${i+1}">${row.map((value, j) => `<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('')
    await writeFile(path,zipSync({
      'xl/workbook.xml':strToU8('<workbook><sheets><sheet name="ME01_Input" r:id="r1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels':strToU8('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml':strToU8(`<worksheet><sheetData>${xml}</sheetData></worksheet>`)
    }))
    await run(path)
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()))
    assert(basename(directory).startsWith('hub-me01-preview-'))
    await rm(directory,{recursive:true,force:true})
  }
}
const headers = ['Material No.','Parma','Dual Sourcing','ME01 Status']

test('native runner preserves existing-source skip counts and Excel result-copy warnings', async () => {
  // Only a tiny Node process emits fake protocol events. No Python or SAP access.
  const resultPath = 'C:\\owned-logs\\run\\source_ME01_results.xlsx'
  const warning = 'Excel is read-only. Completed results are preserved; do not rerun SAP.'
  const event = { event: 'complete', processed: 2, succeeded: 1, skipped: 1, failed: 0, resultPath, backupPath: 'C:\\owned-logs\\backup.xlsx', warning }
  const runner = new runnerModule.exports.Me01NativeRunner({ executable: process.execPath, executableArgs: ['-e', `console.log('ME01_EVENT ' + ${JSON.stringify(JSON.stringify(event))})`], script: '' })
  const progress = []
  const result = await runner.run({ excelPath: 'C:\\input.xlsx', confirmed: true }, event => progress.push(event))
  assert.equal(result.success, true)
  assert.equal(result.skipped, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.resultPath, resultPath)
  assert.equal(result.warning, warning)
  assert.match(result.message, /1 successful and 1 skipped/)
  assert(result.message.includes(warning))
  assert.equal(progress.at(-1).stage, 'complete')
})
test('Yes/No preview includes modes and rechecks SUCCESS rather than filtering it out', async () => {
  await fixture([headers,['0016808656','00041889','No','SUCCESS'],['NEXT','101','Yes','']],async path => {
    const preview = await service.preview(path)
    assert.equal(preview.uniqueMaterials,2)
    assert.equal(preview.singleSourcingMaterials,1)
    assert.equal(preview.dualSourcingMaterials,1)
    assert.equal(preview.sample[0].dualSourcing,false)
    assert.equal(preview.sample[0].parma,'00041889')
  })
})
test('old template, blank and invalid modes fail closed', async () => {
  for(const rows of [[headers,['PART','41889','','']],[headers,['PART','41889','maybe','']],[['Material No.','Parma'],['PART','41889']]]) {
    await fixture(rows, async path => assert.rejects(service.preview(path),/Dual Sourcing/))
  }
})
test('duplicates must have the same supplier and mode; normalized matching deduplicates', async () => {
  for(const rows of [[headers,['PART','41889','Yes'],['PART','41889','No']],[headers,['PART','41889','Yes'],['PART','101','Yes']]]) {
    await fixture(rows, async path => assert.rejects(service.preview(path),/conflicting|more than one Parma/))
  }
  await fixture([headers,['PART','00041889','Yes'],['PART','41889','是']], async path => {
    const preview = await service.preview(path)
    assert.equal(preview.uniqueMaterials,1); assert.equal(preview.duplicateRows,1)
  })
})
test('downloadable template contains required three input headers and Yes/No validation', async () => {
  const previewFile = 'resources/templates/ME01_Source_List_Template.xlsx'
  const {unzipSync,strFromU8} = require('fflate')
  const archive = unzipSync(readFileSync(previewFile))
  const sheet = strFromU8(archive['xl/worksheets/sheet1.xml'])
  assert.match(sheet,/dataValidation/)
  assert.match(sheet,/Yes,No/)
  await assert.rejects(service.preview(previewFile),/No Material No/)
})
test('new row business options default locally and reject invalid dates/organizations', () => {
  const {resolveMe01Business,isMe01BatchConfig} = businessModule.exports
  const config = {excelPath:'input.xlsx',confirmed:true}
  assert.equal(resolveMe01Business(config).validTo,'2099-12-31')
  assert.equal(resolveMe01Business(config).purchasingOrganization,'C100')
  assert.equal(resolveMe01Business({...config,validFrom:'2026-10-12',validTo:'2099-12-31',purchasingOrganization:'c100'}).purchasingOrganization,'C100')
  assert(isMe01BatchConfig(config))
  for(const invalid of [{validFrom:'2026-02-30'},{validFrom:'2099-12-31',validTo:'2026-10-12'}, {purchasingOrganization:''},{purchasingOrganization:'TOOLONG'}, {validFrom:false}]) {
    assert.equal(isMe01BatchConfig({...config,...invalid}),false)
  }
})
