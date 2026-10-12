import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const require = createRequire(import.meta.url), cache = new Map()
let blockedCopy = '', lockedFile = ''
const fs = require('node:fs/promises')
const mocks = { 'node:fs/promises': { ...fs,
  copyFile: (...args) => { if (args[1] === blockedCopy) return Promise.reject(Object.assign(new Error('mock Excel lock'), { code: 'EPERM' })); return fs.copyFile(...args) },
  unlink: path => { if (path === lockedFile) return Promise.reject(Object.assign(new Error('mock lock'), { code: 'EBUSY' })); return fs.unlink(path) }
} }
function load(path) {
  const file = resolve(path)
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => mocks[name] ?? (name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name)), module, module.exports)
  cache.set(file, module.exports); return module.exports
}
const { GeneratedArtifacts } = load('src/main/services/generated-artifacts.ts')
const { Me12ExcelService } = load('src/main/services/me12-excel-service.ts')
const { RfqNativeRunner } = load('src/main/automation/rfq-native-runner.ts')
const { Me01NativeRunner } = load('src/main/automation/me01-native-runner.ts')
const { ApqpRunner } = load('src/main/automation/apqp-runner.ts')
const { RfqSafeRecoveryService } = load('src/main/services/rfq-safe-recovery-service.ts')
const { LocalStoragePaths } = load('src/main/services/local-storage-paths.ts')
const { SettingsService } = load('src/main/services/settings-service.ts')
const { DEFAULT_MANUAL_SECONDS } = load('src/shared/time-savings.ts')
const day = 86400000, before = Date.now() - 60 * day
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-generated-test-')), logs = join(root, 'logs', 'runs'), inputs = join(root, 'user-excel')
  await mkdir(inputs); return { root, logs, inputs, store: new GeneratedArtifacts(logs), close: () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('hub-generated-test-')) throw new Error('Test cleanup path is not an owned temp fixture.')
    return rm(root, { recursive: true, force: true })
  } }
}
async function age(path, finishedAt = new Date(before - 1).toISOString()) {
  const file = join(path, 'artifacts.json'), record = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...record, startedAt: new Date(Date.parse(finishedAt) - day).toISOString(), finishedAt }))
}
test('60-day retention removes only finished owned files; protects live/review, boundary and original input', async () => {
  const f = await fixture()
  try {
    const old = await f.store.create('me12-batch'), active = await f.store.create('apqp'), review = await f.store.create('create-rfq'), boundary = await f.store.create('me01')
    for (const path of [old, active, review, boundary]) await writeFile(join(path, 'backup.xlsx'), 'generated workbook')
    await writeFile(join(old, 'query.csv'), 'generated log'); await mkdir(join(old, 'temp')); await writeFile(join(old, 'temp', 'error.png'), 'screenshot')
    await f.store.finish(old); await age(old); await f.store.finish(review); await age(review); await f.store.finish(boundary); await age(boundary, new Date(before).toISOString())
    const original = join(f.inputs, 'input.xlsx'); await writeFile(original, 'original')
    await f.store.prune(before, new Set([review.split(/[\\/]/).pop()]))
    await assert.rejects(stat(old), { code: 'ENOENT' }); await stat(active); await stat(review); await stat(boundary)
    assert.equal(await readFile(original, 'utf8'), 'original')
    await assert.rejects(f.store.create('x', '../user-excel'))
    await assert.rejects(f.store.prune(NaN)); await stat(review)
  } finally { await f.close() }
})
test('unreadable manifests, missing completion and links are kept without deleting sibling evidence', async () => {
  const f = await fixture()
  try {
    const broken = await f.store.create('rfq'), linked = await f.store.create('rfq')
    await writeFile(join(broken, 'artifacts.json'), 'not-json'); await writeFile(join(broken, 'evidence.log'), 'keep')
    await age(linked); await writeFile(join(linked, 'evidence.log'), 'keep')
    await symlink(f.inputs, join(linked, 'external'), 'junction')
    await writeFile(join(f.inputs, 'source.xlsx'), 'keep')
    assert((await f.store.prune(before)).length)
    assert.equal(await readFile(join(linked, 'evidence.log'), 'utf8'), 'keep'); await stat(join(broken, 'evidence.log'))
    assert.equal(await readFile(join(f.inputs, 'source.xlsx'), 'utf8'), 'keep')
    assert((await lstat(join(linked, 'external'))).isSymbolicLink())
  } finally { await f.close() }
})
test('locked expired files retain manifest for next idle retry', async () => {
  const f = await fixture()
  try {
    const path = await f.store.create('apqp'); await age(path); lockedFile = join(path, 'backup.xlsx'); await writeFile(lockedFile, 'locked')
    assert((await f.store.prune(before)).length); await stat(join(path, 'artifacts.json')); await stat(lockedFile)
    lockedFile = ''; await f.store.prune(before); await assert.rejects(stat(path), { code: 'ENOENT' })
  } finally { lockedFile = ''; await f.close() }
})
test('ME12 keeps backup/temp/locked-file fallback under logs, never beside user Excel', async () => {
  const f = await fixture()
  try {
    const archive = unzipSync(await readFile('resources/templates/ME12_Supplier_Lead_Time_Template.xlsx')), key = 'xl/worksheets/sheet1.xml'
    archive[key] = strToU8(strFromU8(archive[key]).replace(/<x:c r="A2"[^>]*\/>/, '<x:c r="A2" t="inlineStr"><x:is><x:t>0012345678</x:t></x:is></x:c>')
      .replace(/<x:c r="B2"[^>]*\/>/, '<x:c r="B2" t="inlineStr"><x:is><x:t>C100</x:t></x:is></x:c>'))
    const input = join(f.inputs, 'source.xlsx'); await writeFile(input, zipSync(archive)); const original = await readFile(input)
    const service = new Me12ExcelService(f.store), id = randomUUID()
    const session = await service.prepareRun({ excelPath: input, sheetName: '', infoRecordColumn: 1, plantColumn: 2, dataStartRow: 2, targetPlant: 'C100', infoRecordWidth: 10, maxItems: 0 }, id)
    assert.equal(dirname(session.backupPath), join(f.logs, id)); assert.equal(session.tasks.length, 1)
    service.writeTaskResult(session, session.tasks[0], '2', 'SUCCESS'); blockedCopy = input
    const result = await service.saveCheckpoint(session); blockedCopy = ''
    assert.equal(dirname(result), session.artifactDirectory); assert.deepEqual(await readdir(f.inputs), ['source.xlsx']); assert.deepEqual(await readFile(input), original)
    assert.match(strFromU8(unzipSync(await readFile(result))[key]), /SUCCESS/); await service.finishRun(session)
    assert(JSON.parse(await readFile(join(session.artifactDirectory, 'artifacts.json'), 'utf8')).finishedAt)
  } finally { blockedCopy = ''; await f.close() }
})
test('ME01 / APQP real mock children receive managed path; original remains open-compatible result target', async () => {
  const f = await fixture(), previous = process.env.SAP_GUI_PYTHON
  process.env.SAP_GUI_PYTHON = process.execPath
  try {
    const input = join(f.inputs, 'source.xlsx'); await writeFile(input, 'original')
    const engine = { executable: process.execPath, executableArgs: [resolve('scripts/fixtures/native-artifacts-mock.mjs')], preferScript: false, script: '' }
    const one = await new Me01NativeRunner(engine, f.store).run({ excelPath: input, validFrom:'2026-10-12',validTo:'2099-12-31',purchasingOrganization:'C100' }, () => {})
    const two = await new ApqpRunner({ ...engine, executableArgs: [...engine.executableArgs, '--apqp'] }, f.store).run({ excelPath: input, plant: 'C100', sheetName: '', system: '', client: '', maxWorkers: 3, maxItems: 0, createSessions: true, overwriteExisting: false }, () => {})
    assert(one.success); assert(two.success); assert.equal(one.resultPath, input); assert.equal(two.resultPath, input)
    for (const result of [one, two]) { assert(result.backupPath.startsWith(f.logs)); assert(JSON.parse(await readFile(join(dirname(result.backupPath), 'artifacts.json'), 'utf8')).finishedAt) }
    assert(two.logPath.startsWith(f.logs)); assert.deepEqual(await readdir(f.inputs), ['source.xlsx']); assert.equal(await readFile(input, 'utf8'), 'original')
  } finally { if (previous === undefined) delete process.env.SAP_GUI_PYTHON; else process.env.SAP_GUI_PYTHON = previous; await f.close() }
})
test('RFQ preview/run snapshots and results are managed; legacy Safe Recovery result still opens safely', async () => {
  const f = await fixture(), previous = process.env.SAP_RFQ_PYTHON
  process.env.SAP_RFQ_PYTHON = process.execPath
  try {
    const input = join(f.inputs, 'source.xlsx'); await writeFile(input, JSON.stringify({ mode: 'success' }))
    const runner = new RfqNativeRunner({ executable: '', preferScript: true, script: resolve('scripts/fixtures/rfq-mock-engine.mjs') }, f.logs, 'test', undefined, f.store)
    const config = { excelPath: input, environment: 'PROD', productionConfirmed: true }, preview = await runner.preview(config)
    const result = await runner.run({ ...config, fingerprint: preview.fingerprint }, () => {})
    assert(result.success); assert(result.resultPath.startsWith(f.logs)); assert.deepEqual(await readdir(f.inputs), ['source.xlsx'])
    for (const id of await readdir(f.logs)) assert(JSON.parse(await readFile(join(f.logs, id, 'artifacts.json'), 'utf8')).finishedAt)
    const legacy = join(f.root, 'legacy'), id = randomUUID(), output = join(legacy, id, 'output', 'result.xlsx')
    await mkdir(dirname(output), { recursive: true }); await copyFile(input, output)
    const recovery = new RfqSafeRecoveryService(join(f.root, 'ledger'), f.logs, () => 'dead', [legacy])
    recovery.begin(id, 'PROD', output); recovery.close(id, null); assert.equal(recovery.result(id), output)
    assert.equal(recovery.pending()[0].resultAvailable, true)
  } finally { if (previous === undefined) delete process.env.SAP_RFQ_PYTHON; else process.env.SAP_RFQ_PYTHON = previous; await f.close() }
})
test('new owner baselines migrate untouched old defaults, but preserve custom/calibrated settings', async () => {
  const f = await fixture()
  try {
    const paths = new LocalStoragePaths(f.root); await mkdir(paths.dataDirectory, { recursive: true })
    const logger = { info: async () => {}, error: async () => {}, warning: async () => {} }, service = new SettingsService(paths, f.inputs, logger)
    const defaults = await service.getSettings(), old = { 'create-rfq': 600, 'me12-batch': 60, 'apqp-plan-closure': 60, 'me01-source-list': 90 }
    await writeFile(paths.settingsPath, JSON.stringify({ ...defaults, schemaVersion: 8, manualTimeBaselines: old }))
    assert.deepEqual((await service.getSettings()).manualTimeBaselines, DEFAULT_MANUAL_SECONDS)
    const custom = { ...old, 'create-rfq': 1200 }
    await writeFile(paths.settingsPath, JSON.stringify({ ...defaults, schemaVersion: 8, manualTimeBaselines: custom }))
    assert.deepEqual((await service.getSettings()).manualTimeBaselines, custom)
    await writeFile(paths.settingsPath, JSON.stringify({ ...defaults, schemaVersion: 8, manualTimeBaselines: old, manualTimeCalibrated: true }))
    assert.deepEqual((await service.getSettings()).manualTimeBaselines, old)
    await Promise.all([service.saveSettings(defaults), service.saveSettings(defaults)])
    assert.deepEqual((await service.getSettings()).manualTimeBaselines, DEFAULT_MANUAL_SECONDS)
  } finally { await f.close() }
})
