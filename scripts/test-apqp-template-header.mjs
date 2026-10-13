// Offline saved-file header tests. Never open Excel or connect to SAP.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { strToU8, zipSync } from 'fflate'
import ts from 'typescript'

const require = createRequire(import.meta.url), cache = new Map()
function load(path) {
  const file = resolve(path)
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name), module, module.exports)
  cache.set(file, module.exports); return module.exports
}
const { checkApqpTemplateHeaders, checkRfqTemplateHeaders, ApqpTemplateError } = load('src/main/services/excel-template-header.ts')
const { RfqExcelService } = load('src/main/services/rfq-excel-service.ts')
const { ApqpRunner } = load('src/main/automation/apqp-runner.ts')
const root = await mkdtemp(join(tmpdir(), 'hub-apqp-headers-'))
const compact = ['Part No.', 'Vendor', 'APQP plan closure date']
const legacy = ['Part No.', 'Ver', 'Description', 'Vendor', 'APQP plan closure date']
let sequence = 0
async function fixture(headers, { prefix = '', shared = false, names = ['APQP_Input'], external = false, extraRows = '' } = {}) {
  const p = prefix ? `${prefix}:` : ''
  const namespace = prefix ? `xmlns:${prefix}="urn:test"` : 'xmlns="urn:test"'
  const archive = {
    'xl/workbook.xml': strToU8(`<${p}workbook ${namespace} xmlns:r="urn:rels"><${p}sheets>${names.map((name,i) => `<${p}sheet name="${name}" r:id="rId${i+1}"/>`).join('')}</${p}sheets></${p}workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<Relationships>${names.map((_,i) => `<Relationship Id="rId${i+1}" Target="${i ? '/xl/worksheets/' : 'worksheets/'}sheet${i+1}.xml"${external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`)
  }
  const header = headers.map((name,i) => shared ? `<${p}c r="${String.fromCharCode(65+i)}1" t="s"><${p}v>${i}</${p}v></${p}c>` :
    `<${p}c r="${String.fromCharCode(65+i)}1" t="inlineStr"><${p}is><${p}t>${name}</${p}t></${p}is></${p}c>`).join('')
  for (let i=0;i<names.length;i++) archive[`xl/worksheets/sheet${i+1}.xml`] = strToU8(`<${p}worksheet ${namespace}><${p}sheetData><${p}row r="1">${header}</${p}row>${extraRows}</${p}sheetData></${p}worksheet>`)
  if (shared) archive['xl/sharedStrings.xml'] = strToU8(`<${p}sst ${namespace}>${headers.map(h => `<${p}si><${p}t>${h}</${p}t></${p}si>`).join('')}</${p}sst>`)
  const path = join(root, `fixture-${sequence++}.xlsx`)
  await writeFile(path, zipSync(archive)); return path
}
test('new three-column template and legacy five-column aliases are accepted', async () => {
  await checkApqpTemplateHeaders(resolve('resources/templates/APQP_Plan_Closure_Template.xlsx'))
  await checkApqpTemplateHeaders(await fixture(compact))
  await checkApqpTemplateHeaders(await fixture(legacy))
  await checkApqpTemplateHeaders(await fixture([' Material ', 'Supplier', 'APQP plan closure date']))
})
test('namespace prefixes, shared strings, entities and absolute relationships', async () => {
  await checkApqpTemplateHeaders(await fixture(compact,{prefix:'x',shared:true,names:['Input']}))
  await checkApqpTemplateHeaders(await fixture(['Part No.', 'Ven&#100;or', 'APQP plan closure date']))
  await checkApqpTemplateHeaders(await fixture(compact,{names:['First','APQP_Input']}))
})
test('incorrect, mixed, duplicated and swapped required headers fail closed', async () => {
  for (const headers of [['Hello'], ['Vendor','Part No.','APQP plan closure date'],
    ['Part No.','Ver','Vendor','APQP plan closure date'], [...compact, 'Vendor'], [...compact,'','APQP plan closure date']]) {
    await assert.rejects(checkApqpTemplateHeaders(await fixture(headers)), ApqpTemplateError)
  }
})
test('sheet selection matches native rules; ambiguous and external input is rejected', async () => {
  const multiple = await fixture(compact,{names:['One','Two']})
  await assert.rejects(checkApqpTemplateHeaders(multiple), ApqpTemplateError)
  await checkApqpTemplateHeaders(multiple,'Two')
  await assert.rejects(checkApqpTemplateHeaders(multiple,'Missing'), ApqpTemplateError)
  await assert.rejects(checkApqpTemplateHeaders(await fixture(compact,{external:true})), ApqpTemplateError)
})
test('invalid file fails without launching engine; valid header proceeds to live validation', async () => {
  const runner = new ApqpRunner({executable:'DO_NOT_LAUNCH',script:'DO_NOT_LAUNCH'})
  let executions = 0
  runner.execute = async () => { executions++; return {preview:{sheetName:'APQP_Input',selected:0,invalid:0,skipped:0,sample:[]}} }
  const wrong = await fixture(['Not an APQP template'],{extraRows:Array.from({length:10000},(_,i)=>`<row r="${i+2}"><c r="A${i+2}" t="inlineStr"><is><t>training data</t></is></c></row>`).join('')})
  const before = await readFile(wrong), start = performance.now()
  const rejected = await runner.preview({excelPath:wrong,sheetName:''})
  console.log(`Wrong-header rejection (10,000-row saved workbook): ${Math.round(performance.now()-start)}ms; engine starts = ${executions}`)
  assert.equal(rejected.success,false); assert.equal(rejected.errorCode,'APQP_TEMPLATE_INVALID'); assert.equal(executions,0)
  assert.deepEqual(await readFile(wrong),before)
  const accepted = await runner.preview({excelPath:await fixture(compact),sheetName:''})
  assert.equal(accepted.success,true); assert.equal(executions,1)
  const corrupt = join(root,'corrupt.xlsx'); await writeFile(corrupt,'not Excel')
  await assert.rejects(checkApqpTemplateHeaders(corrupt), ApqpTemplateError)
  await assert.rejects(checkApqpTemplateHeaders(join(root,'missing.xlsx')), ApqpTemplateError)
})
test('RFQ also rejects wrong headers before native preview while preserving legacy aliases', async () => {
  await checkRfqTemplateHeaders(resolve('resources/templates/Create_RFQ_Template.xlsx'))
  await checkRfqTemplateHeaders(await fixture(['Plant','MPP Project No.','Material','Vendor1'],{names:['Legacy Input']}))
  let executions = 0
  const service = new RfqExcelService({preview:async()=>{executions++;return {validRows:0}}})
  await assert.rejects(service.preview({excelPath:await fixture(['Not RFQ'])}), /表头不匹配/)
  assert.equal(executions,0)
  await service.preview({excelPath:await fixture(['Material No.','Supplier Parma','Plant','Project No'])})
  assert.equal(executions,1)
})
