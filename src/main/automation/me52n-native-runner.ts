import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { Me52nBatchConfig, Me52nBatchProgress, Me52nBatchResult } from '../../shared/me52n-types'

interface EnginePaths { executable: string; executableArgs?: string[]; script: string; preferScript?: boolean }
interface FinalEvent {
  status?: string
  planned?: number
  completed?: number
  skipped?: number
  workers?: number
  logPath?: string
  checkpointPath?: string
  backupPath?: string
  counts?: Record<string, number>
}

const EVENT_PREFIX = 'ME52N_EVENT '

export class Me52nNativeRunner {
  private child: ChildProcessWithoutNullStreams | null = null
  private cancelRequested = false

  constructor(private readonly enginePaths: EnginePaths) {}

  async run(config: Me52nBatchConfig, report: (progress: Me52nBatchProgress) => void): Promise<Me52nBatchResult> {
    if (this.child) return { success: false, errorCode: 'OPERATION_IN_PROGRESS', message: 'Another ME52N run is already in progress.' }
    const launch = await this.resolveLaunch()
    if (!launch) return { success: false, errorCode: 'ENGINE_UNAVAILABLE', message: 'The ME52N Project Ref engine is unavailable.' }
    this.cancelRequested = false
    report({ stage: 'preparing', status: 'running', message: 'Reading the workbook and preparing ME52N workers.' })

    return await new Promise<Me52nBatchResult>((resolve) => {
      let settled = false
      let finalEvent: FinalEvent | null = null
      let planned = 0
      const errors: string[] = []
      const finish = (result: Me52nBatchResult): void => { if (settled) return; settled = true; this.child = null; resolve(result) }
      try {
        this.child = spawn(launch.command, launch.args, {
          shell: false,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            EXCEL_PATH: config.excelPath,
            SOURCE_SHEET_NAME: config.sheetName,
            PR_COLUMN: String(config.prColumn),
            DATA_START_ROW: String(config.dataStartRow),
            BATCH_START_ROW: String(config.batchStartRow),
            BATCH_SIZE: String(config.batchSize),
            TARGET_PROJECT_REF: config.targetProjectRef.trim(),
            ALLOWED_WBS: config.allowedWbs.map((wbs) => wbs.trim()).join(';'),
            OVERWRITE_EXISTING_PROJECT_REF: String(config.overwriteExisting),
            NUM_WORKERS: String(config.concurrency),
            FORCE_SINGLE_WORKER_FOR_WRITE: String(config.concurrency === 1),
            WORKER_START_DELAY_SEC: String(config.workerStartDelaySec),
            TASK_ERROR_RETRIES: String(config.taskErrorRetries),
            LOGIN_TIMEOUT_SEC: String(config.loginTimeoutSec),
            SAVE_VERIFY_TIMEOUT_SEC: '12',
            ENABLE_CHECKPOINT: String(config.checkpointEnabled),
            WRITEBACK_TO_SOURCE_EXCEL: String(config.writebackToSource),
            CREATE_SOURCE_BACKUP: String(config.writebackToSource),
            BROWSER_CHANNEL: 'chrome',
            HEADLESS: 'false'
          }
        })
      } catch (error) {
        finish({ success: false, errorCode: 'ENGINE_UNAVAILABLE', message: getErrorMessage(error) })
        return
      }
      const child = this.child
      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })
      stdout.on('line', (line) => {
        if (line.startsWith(EVENT_PREFIX)) {
          try { finalEvent = JSON.parse(line.slice(EVENT_PREFIX.length)) as FinalEvent } catch { /* ignore malformed protocol output */ }
          return
        }
        const planMatch = line.match(/最终SAP任务数:\s*(\d+)/)
        if (planMatch) {
          planned = Number(planMatch[1])
          report({ stage: 'connecting-sap', status: 'running', total: planned, message: `Opening ${Math.min(config.concurrency, Math.max(1, planned))} independent Chrome browser(s). Complete certificate selection and SAP sign-in in each browser.` })
          return
        }
        const progressMatch = line.match(/批次进度\s+(\d+)\/(\d+).*?PR\s+([0-9]+)/)
        if (progressMatch) {
          report({ stage: 'processing', status: line.includes('ERROR') || line.includes('SAVE_ERROR') ? 'failed' : line.includes('NO_MATCH') || line.includes('ALREADY_OK') ? 'skipped' : 'success', current: Number(progressMatch[1]), total: Number(progressMatch[2]), pr: progressMatch[3], message: line.replace(/^.*?批次进度/, 'Progress').trim() })
        }
      })
      stderr.on('line', (line) => { if (line.trim()) errors.push(line.trim()); if (errors.length > 12) errors.shift() })
      child.once('error', (error) => finish({ success: false, errorCode: 'ENGINE_UNAVAILABLE', message: getErrorMessage(error) }))
      child.once('close', (code) => {
        stdout.close(); stderr.close()
        if (this.cancelRequested) {
          report({ stage: 'cancelled', status: 'skipped', message: 'ME52N Project Ref batch was cancelled.' })
          finish({ success: false, errorCode: 'CANCELLED', message: 'ME52N Project Ref batch was cancelled.' }); return
        }
        const event = finalEvent as FinalEvent | null
        if (code !== 0 || !event) {
          const detail = errors.at(-1) || 'The ME52N engine stopped before returning a result.'
          report({ stage: 'failed', status: 'failed', message: detail })
          finish({ success: false, errorCode: 'EXECUTION_FAILED', message: detail }); return
        }
        const counts = event.counts ?? {}
        const succeeded = (counts.SUCCESS ?? 0) + (counts.ALREADY_OK ?? 0)
        const skipped = (event.skipped ?? 0) + (counts.NO_MATCH ?? 0)
        const failed = (counts.ERROR ?? 0) + (counts.SAVE_ERROR ?? 0) + (counts.PARTIAL ?? 0)
        const processed = event.completed ?? 0
        const message = event.status === 'NO_TASKS'
          ? `No pending ME52N task was found; ${event.skipped ?? 0} PR(s) were already complete in the checkpoint.`
          : `ME52N finished: ${succeeded} successful/already correct, ${skipped} skipped, and ${failed} requiring review.`
        report({ stage: 'complete', status: failed > 0 ? 'failed' : 'success', current: processed, total: event.planned ?? planned, message })
        finish({ success: true, message, processed, succeeded, skipped, failed, browserCount: event.workers ?? 0, resultPath: event.logPath ?? config.excelPath, checkpointPath: event.checkpointPath ?? '', backupPath: event.backupPath ?? '' })
      })
    })
  }

  cancel(): boolean { if (!this.child) return false; this.cancelRequested = true; return this.child.kill() }

  private async resolveLaunch(): Promise<{ command: string; args: string[] } | null> {
    const python = process.env.SAP_GUI_PYTHON?.trim() || 'py'
    const scriptArgs = process.env.SAP_GUI_PYTHON?.trim() ? [this.enginePaths.script] : ['-3', this.enginePaths.script]
    if (this.enginePaths.preferScript && await exists(this.enginePaths.script)) return { command: python, args: scriptArgs }
    if (await exists(this.enginePaths.executable)) return { command: this.enginePaths.executable, args: this.enginePaths.executableArgs ?? [] }
    if (await exists(this.enginePaths.script)) return { command: python, args: scriptArgs }
    return null
  }
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true } catch { return false } }
function getErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
