// Test-only engine protocol; no SAP/Excel application access.
import assert from 'node:assert/strict'
import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const directory = process.env.HUB_ARTIFACT_DIR
if (!process.argv.includes('--apqp')) {
  assert.equal(process.env.ME01_VALID_FROM,'2026-10-12')
  assert.equal(process.env.ME01_VALID_TO,'2099-12-31')
  assert.equal(process.env.ME01_PURCH_ORG,'C100')
}
assert(directory); assert.equal(process.cwd().toLowerCase(), directory.toLowerCase())
const backup = join(directory, 'backup.xlsx'), log = join(directory, 'query.csv')
await copyFile(process.env.EXCEL_PATH, backup); await writeFile(log, 'mock log')
const event = { event: 'complete', message: 'mock completed', total: 1, processed: 1, succeeded: 1, skipped: 0, failed: 0,
  resultPath: process.env.EXCEL_PATH, backupPath: backup, logPath: log }
process.stdout.write((process.argv.includes('--apqp') ? 'APQP_EVENT ' : 'ME01_EVENT ') + JSON.stringify(event) + '\n')
