// Test-only child process. No SAP, COM, or real RFQ engine imports.
import { readFile, access, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
const args = process.argv.slice(2)
const value = (key) => args[args.indexOf(key) + 1]
const scenario = JSON.parse(await readFile(value('--excel-path'), 'utf8'))
const emit = (type, data = {}) => console.log('HUB_EVENT:' + JSON.stringify({ type, ...data }))
console.log('📦 离线模拟 — ordinary output must not become a progress event')
if (args.includes('--validate-only')) {
  emit('VALIDATION_COMPLETED', { preview: { validRows: 2, invalidRows: 0, groupCount: 1, sample: [], groups: [], plants: ['C100'], warnings: [] } })
} else {
  if (!args.includes('--production-confirmed')) throw new Error('Missing production confirmation')
  if (scenario.mode === 'silent') process.exit(0)
  emit('GROUP_STARTED', { current: 1, total: 1, message: 'mock ready' })
  if (['interaction', 'unknown', 'attention-failure'].includes(scenario.mode)) {
    const runId = value('--run-id')
    let attempt = 0
    let resolved = false
    while (!resolved) {
      const requestId = 'mock-request-' + (++attempt)
      emit('ACTION_REQUIRED', { runId, requestId, state: 'WAITING_FOR_USER',
        step: 'PROD_RFQ_STAGING', recoveryPoint: 'PROD_RFQ_STAGING', materials: ['111'], rows: [2], groupKey: 'MOCK-GROUP',
        message: attempt === 1 ? 'Material has duplicate SAP rows' : 'The issue is still present.',
        allowedActions: scenario.mode === 'unknown' ? ['stop'] : ['continue', 'stop'] })
      const response = join(value('--control-dir'), requestId + '.json')
      const deadline = Date.now() + 10000
      while (true) {
        try {
          await access(value('--stop-file'))
          emit('RUN_CANCELLED', { runId, state: 'CANCELLED', resultPath: value('--excel-path'), rfqNumbers: ['KEEP-1'] })
          process.exit(3)
        } catch { /* no stop marker */ }
        let command
        try { command = JSON.parse(await readFile(response,'utf8')); await unlink(response) } catch { /* waiting */ }
        if (command?.runId === runId && command.requestId === requestId && command.action === 'continue' && scenario.mode !== 'unknown') {
          emit('RECOVERING', { runId, requestId, state: 'RECOVERING' })
          if (attempt > 1 || scenario.mode === 'attention-failure') {
            emit('INTERACTION_RESOLVED', { runId, requestId, state: 'RUNNING' })
            resolved = true
          }
          break
        }
        if (Date.now() > deadline) throw new Error('Interaction response never arrived')
        await setTimeout(20)
      }
    }
  }
  if (scenario.mode === 'wait') {
    const deadline = Date.now() + 5000
    let stopped = false
    while (Date.now() < deadline) {
      try { await access(value('--stop-file')); stopped = true; break } catch { /* wait */ }
      await setTimeout(25)
    }
    if (!stopped) throw new Error('Stop marker never arrived')
    emit('RUN_CANCELLED', { resultPath: value('--excel-path'), rfqNumbers: ['MOCK-1'] })
    process.exit(3)
  }
  emit('RFQ_CREATED', { rfqNumber: 'MOCK-1' })
  emit('RFQ_CREATED', { rfqNumber: 'MOCK-1' })
  emit('RUN_COMPLETED', { current: 1, total: 1, processed: 1, succeeded: 1, skipped: 0, failed: 0,
    rfqNumbers: ['MOCK-1'], resultPath: value('--excel-path'), materials: 2 })
  if (scenario.mode === 'nonzero') process.exit(1)
}
