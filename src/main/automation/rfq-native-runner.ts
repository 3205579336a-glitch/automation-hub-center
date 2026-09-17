import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type {
  RfqBatchConfig,
  RfqBatchProgress,
  RfqBatchResult
} from '../../shared/rfq-batch-types'

interface EnginePaths {
  executable: string
  executableArgs?: string[]
  script: string
  preferScript?: boolean
}

export class RfqNativeRunner {
  private child: ChildProcessWithoutNullStreams | null = null
  private cancelRequested = false

  constructor(private readonly enginePaths: EnginePaths) {}

  async run(
    config: RfqBatchConfig,
    reportProgress: (progress: RfqBatchProgress) => void
  ): Promise<RfqBatchResult> {
    if (this.child) {
      return {
        success: false,
        errorCode: 'OPERATION_IN_PROGRESS',
        message: 'Another Create RFQ run is already in progress.'
      }
    }

    this.cancelRequested = false
    reportProgress({
      stage: 'preparing',
      status: 'running',
      message: `Preparing the ${config.environment === 'QA' ? 'Test (CEQ 321)' : 'Production (VCE 949)'} RFQ run.`
    })

    const launch = await this.resolveLaunch()
    if (!launch) {
      return {
        success: false,
        errorCode: 'ENGINE_UNAVAILABLE',
        message: 'The SAP RFQ engine is unavailable. Use the packaged engine or install Python with pywin32 and openpyxl.'
      }
    }

    const summary = new Map<string, number>()
    const errors: string[] = []
    let resultPath = config.excelPath
    let logPath = ''
    let current = 0
    let total = 0

    const environment = config.environment === 'PROD'
      ? {
          SAP_TARGET_ENV: 'PROD',
          EXPECTED_SAP_SYSTEM: 'VCE',
          EXPECTED_SAP_CLIENT: '100',
          ALLOW_PRODUCTION_WRITE: 'true'
        }
      : {
          SAP_TARGET_ENV: 'QA',
          EXPECTED_SAP_SYSTEM: 'CEQ',
          EXPECTED_SAP_CLIENT: '100',
          ALLOW_PRODUCTION_WRITE: 'false'
        }

    return await new Promise<RfqBatchResult>((resolve) => {
      let settled = false
      const finish = (result: RfqBatchResult): void => {
        if (settled) return
        settled = true
        this.child = null
        resolve(result)
      }

      try {
        this.child = spawn(launch.command, launch.args, {
          shell: false,
          windowsHide: true,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8',
            EXCEL_PATH: config.excelPath,
            SHEET_NAME: 'RPA_Input',
            DATA_START_ROW: '2',
            SAP_AUTO_LAUNCH: 'true',
            SAP_QA_CONNECTION_NAME: 'CEQ - One Digital Core - QA [321]',
            SAP_PROD_CONNECTION_NAME: 'VCE - One Digital Core [949]',
            SAP_ENVIRONMENT_GUARD: 'true',
            SAP_AUTO_SELECT_BY_SYSTEM: 'true',
            ALLOW_UNVERIFIED_SAP_ENVIRONMENT: 'false',
            DRY_RUN: 'false',
            TEST_GROUP_LIMIT: '0',
            PROCESS_MODE: 'ROW',
            CREATE_EXCEL_BACKUP: 'true',
            SKIP_SUCCESS_ROWS: 'true',
            SKIP_EXISTING_RFQ_ROWS: 'true',
            CONTINUE_AFTER_EXISTING_RFQ: 'true',
            REUSE_NPL_TRANSACTION: 'true',
            NPL_STRICT_REUSE: 'true',
            REUSE_SAME_PROJECT_NPL_RESULTS: 'true',
            NPL_FALLBACK_RESTART: 'false',
            PPAP_DATE_CHECK_ENABLED: 'true',
            AUTO_APPLY_EXCEL_PPAP_TO_BUYER_RECEIPT: 'true',
            CONTINUE_AFTER_PPAP_DATE_ERROR: 'true',
            ...environment
          }
        })
      } catch (error) {
        finish({
          success: false,
          errorCode: 'ENGINE_UNAVAILABLE',
          message: getErrorMessage(error)
        })
        return
      }

      const child = this.child
      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })

      stdout.on('line', (rawLine) => {
        const line = cleanLine(rawLine)
        if (!line) return
        const groupProgress = line.match(/Group进度\s+(\d+)\/(\d+)/i)
        if (groupProgress) {
          current = Number(groupProgress[1])
          total = Number(groupProgress[2])
        }
        const resultMatch = line.match(/Excel结果文件:\s*(.+)$/i)
        if (resultMatch) resultPath = resultMatch[1].trim()
        const logMatch = line.match(/CSV日志:\s*(.+)$/i)
        if (logMatch) logPath = logMatch[1].trim()
        const summaryMatch = line.match(/^([A-Z][A-Z_]+):\s*(\d+)$/)
        if (summaryMatch) summary.set(summaryMatch[1], Number(summaryMatch[2]))

        const progress = progressFromLine(line, current, total)
        if (progress) reportProgress(progress)
      })

      stderr.on('line', (rawLine) => {
        const line = cleanLine(rawLine)
        if (!line) return
        errors.push(line)
        if (errors.length > 12) errors.shift()
      })

      child.once('error', (error) => {
        finish({
          success: false,
          errorCode: 'ENGINE_UNAVAILABLE',
          message: `The SAP RFQ engine could not be started: ${getErrorMessage(error)}`
        })
      })

      child.once('close', (code) => {
        stdout.close()
        stderr.close()
        if (this.cancelRequested) {
          reportProgress({ stage: 'cancelled', status: 'skipped', message: 'Create RFQ was cancelled.' })
          finish({ success: false, errorCode: 'CANCELLED', message: 'Create RFQ was cancelled.' })
          return
        }
        if (code !== 0) {
          const detail = errors.at(-1) || `Engine exited with code ${code ?? 'unknown'}.`
          reportProgress({ stage: 'failed', status: 'failed', message: detail })
          finish({ success: false, errorCode: 'EXECUTION_FAILED', message: detail })
          return
        }

        const succeeded = (summary.get('SUCCESS') ?? 0) + (summary.get('SUCCESS_WITH_SKIPS') ?? 0)
        const failed = summary.get('ERROR') ?? 0
        const skipped = [...summary.entries()]
          .filter(([status]) => status.includes('SKIP') || status.includes('INPUT_REQUIRED'))
          .reduce((count, [, value]) => count + value, 0)
        const processed = succeeded + failed + skipped
        const message = failed > 0
          ? `RFQ run finished with ${succeeded} successful, ${skipped} skipped, and ${failed} failed unit(s).`
          : `RFQ run completed: ${succeeded} successful and ${skipped} skipped unit(s).`
        reportProgress({ stage: 'complete', status: failed > 0 ? 'failed' : 'success', message, current: total || processed, total: total || processed })
        finish({ success: true, message, processed, succeeded, skipped, failed, resultPath, ...(logPath ? { logPath } : {}) })
      })
    })
  }

  cancel(): boolean {
    if (!this.child) return false
    this.cancelRequested = true
    return this.child.kill()
  }

  private async resolveLaunch(): Promise<{ command: string; args: string[] } | null> {
    if (this.enginePaths.preferScript && await exists(this.enginePaths.script)) {
      const configuredPython = process.env.SAP_RFQ_PYTHON?.trim()
      if (configuredPython) return { command: configuredPython, args: [this.enginePaths.script] }
      return { command: 'py', args: ['-3', this.enginePaths.script] }
    }
    if (await exists(this.enginePaths.executable)) {
      return { command: this.enginePaths.executable, args: this.enginePaths.executableArgs ?? [] }
    }
    if (!(await exists(this.enginePaths.script))) return null
    const configuredPython = process.env.SAP_RFQ_PYTHON?.trim()
    if (configuredPython) return { command: configuredPython, args: [this.enginePaths.script] }
    return { command: 'py', args: ['-3', this.enginePaths.script] }
  }
}

function progressFromLine(line: string, current: number, total: number): RfqBatchProgress | null {
  if (/SAP auto launch\/target|正在启动SAP|连接SAP|SAP Logon|Environment=/i.test(line)) {
    return { stage: 'connecting-sap', status: 'running', message: line, current, total }
  }
  if (/Group进度|▶ Group=|NPL|Buyer Receipt|RFQ/i.test(line)) {
    const failed = /❌|失败|error/i.test(line)
    const skipped = /⏭|跳过|待补充/i.test(line)
    const success = /✅|🎉|成功/.test(line)
    return {
      stage: 'processing',
      status: failed ? 'failed' : skipped ? 'skipped' : success ? 'success' : 'running',
      message: line,
      current,
      total
    }
  }
  if (/Excel结果文件|CSV日志|保存/i.test(line)) {
    return { stage: 'saving', status: 'running', message: line, current, total }
  }
  return null
}

function cleanLine(line: string): string {
  return line.trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
