import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const module = { exports: {} }
const source = readFileSync('src/renderer/src/components/automation/apqp-date-view.ts', 'utf8')
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText)(module.exports)
const { APQP_PROJECTS_KEY, readApqpProjects, rememberApqpProject, visibleApqpRecords } = module.exports
function storage(initial) {
  const values = new Map(initial === undefined ? [] : [[APQP_PROJECTS_KEY, initial]])
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('project history starts with 775773 and remembers most recent submitted projects without duplicates', () => {
  const store = storage()
  assert.deepEqual(readApqpProjects(store), ['775773'])
  const next = rememberApqpProject(readApqpProjects(store), '775260', store)
  assert.deepEqual(next, ['775260', '775773'])
  assert.deepEqual(readApqpProjects(store), next, 'Available after a reload')
  assert.deepEqual(rememberApqpProject(next, '775773', store), ['775773', '775260'])
  assert.deepEqual(readApqpProjects(store), ['775773', '775260'])
})

test('project history is bounded and ignores malformed persisted/input values', () => {
  const store = storage(JSON.stringify(['775773', '775773', null, 775260, '', 'invalid project', 'X'.repeat(33), '775260']))
  assert.deepEqual(readApqpProjects(store), ['775773', '775260'])
  const previous = Array.from({ length: 15 }, (_, i) => String(700000 + i))
  const next = rememberApqpProject(previous, '775773', store)
  assert.equal(next.length, 10)
  assert.equal(next[0], '775773')
  assert.deepEqual(rememberApqpProject(next, 'not valid', store), next)
  for (const raw of ['bad json', '{}', 'null', JSON.stringify([null, ''])]) assert.deepEqual(readApqpProjects(storage(raw)), ['775773'])
})

test('unavailable/quota-full local storage never prevents entering/querying a project', () => {
  const unavailable = { getItem: () => { throw new Error('unavailable') }, setItem: () => { throw new Error('full') } }
  assert.deepEqual(readApqpProjects(unavailable), ['775773'])
  assert.deepEqual(rememberApqpProject(['775773'], '775260', unavailable), ['775260', '775773'])
})

const records = [
  { apqp: '2000000000', material: '10000000', vendor: '0041889' },
  { apqp: '2000000001', material: '10000001', vendor: '101' },
  { apqp: '2000000002', material: '10000002', vendor: '6587' },
  { apqp: '2000000003', material: '10000003', vendor: '41889' },
  { apqp: '2000000004', material: '10000004', vendor: '100000' }
].map(row => Object.freeze({ ...row, dates: Object.freeze({ gActualDate: '2026-10-22' }) }))
Object.freeze(records)

test('search covers material, Supplier Parma and APQP; terms are ANDed across identity fields', () => {
  assert.deepEqual(visibleApqpRecords(records, '  10000002 ', 'original'), [records[2]])
  assert.deepEqual(visibleApqpRecords(records, '41889', 'original'), [records[0], records[3]])
  assert.deepEqual(visibleApqpRecords(records, '2000000004', 'original'), [records[4]])
  assert.deepEqual(visibleApqpRecords(records, '10000000 41889', 'original'), [records[0]])
  assert.deepEqual(visibleApqpRecords(records, 'not-found', 'original'), [])
})

test('supplier order is numeric, stable for zero-padded ties, and does not mutate original SAP order/dates', () => {
  assert.deepEqual(visibleApqpRecords(records, '', 'supplier-asc').map(row => row.vendor), ['101', '6587', '0041889', '41889', '100000'])
  assert.deepEqual(visibleApqpRecords(records, '', 'supplier-desc').map(row => row.vendor), ['100000', '0041889', '41889', '6587', '101'])
  assert.deepEqual(visibleApqpRecords(records, '', 'original'), records)
  assert.equal(records[0].vendor, '0041889')
  assert.equal(visibleApqpRecords(records, '41889', 'supplier-desc')[0], records[0], 'Row identity and edit keys are preserved')
  assert.equal(records[0].dates.gActualDate, '2026-10-22')
})
