import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { Me01BatchConfig, Me01BatchProgress, Me01BatchResult } from '../../shared/me01-types'

interface EnginePaths {
  executable: string
  executableArgs?: string[]
  script: string
  preferScript?: boolean
}

interface EngineEvent {
  event?: string
  message?: string
  current?: number
  total?: number
  material?: string
  parma?: string
  status?: Me01BatchProgress['status']
  processed?: number
  succeeded?: number
  skipped?: number
  failed?: number
  resultPath?: string
  backupPath?: string
}

const EVENT_PREFIX = 'ME01_EVENT '

export class Me01NativeRunner {
  private child: ChildProcessWithoutNullStreams | null = null
  private cancelRequested = false

  constructor(private readonly enginePaths: EnginePaths) {}

  async run(config: Me01BatchConfig, reportProgress: (progress: Me01BatchProgress) => void): Promise<Me01BatchResult> {
    if (this.child) {
      return { success: false, errorCode: 'OPERATION_IN_PROGRESS', message: 'Another ME01 run is already in progress.' }
    }
    const launch = await this.resolveLaunch()
    if (!launch) {
      return { success: false, errorCode: 'ENGINE_UNAVAILABLE', message: 'The ME01 SAP GUI engine is unavailable.' }
    }
    this.cancelRequested = false
    reportProgress({ stage: 'preparing', status: 'running', message: 'Preparing the ME01 source-list batch.' })

    return await new Promise<Me01BatchResult>((resolve) => {
      let settled = false
      let finalEvent: EngineEvent | null = null
      const errors: string[] = []
      const finish = (result: Me01BatchResult): void => {
        if (settled) return
        settled = true
        this.child = null
        resolve(result)
      }
      try {
        this.child = spawn(launch.command, launch.args, {
          shell: false,
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', EXCEL_PATH: config.excelPath }
        })
      } catch (error) {
        finish({ success: false, errorCode: 'ENGINE_UNAVAILABLE', message: getErrorMessage(error) })
        return
      }
      const child = this.child
      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })
      stdout.on('line', (line) => {
        if (!line.startsWith(EVENT_PREFIX)) return
        try {
          const event = JSON.parse(line.slice(EVENT_PREFIX.length)) as EngineEvent
          if (event.event === 'complete') finalEvent = event
          if (event.event === 'fatal' && event.message) errors.push(event.message)
          const progress = progressFromEvent(event)
          if (progress) reportProgress(progress)
        } catch {
          // Ignore non-protocol output from Python dependencies.
        }
      })
      stderr.on('line', (line) => {
        if (line.trim()) errors.push(line.trim())
        if (errors.length > 10) errors.shift()
      })
      child.once('error', (error) => finish({ success: false, errorCode: 'ENGINE_UNAVAILABLE', message: getErrorMessage(error) }))
      child.once('close', (code) => {
        stdout.close()
        stderr.close()
        if (this.cancelRequested) {
          reportProgress({ stage: 'cancelled', status: 'skipped', message: 'ME01 source-list batch was cancelled.' })
          finish({ success: false, errorCode: 'CANCELLED', message: 'ME01 source-list batch was cancelled.' })
          return
        }
        if (code !== 0 || !finalEvent) {
          const detail = errors.at(-1) || 'The ME01 engine stopped before returning a result.'
          reportProgress({ stage: 'failed', status: 'failed', message: detail })
          finish({ success: false, errorCode: 'EXECUTION_FAILED', message: detail })
          return
        }
        const result = finalEvent
        const processed = result.processed ?? 0
        const succeeded = result.succeeded ?? 0
        const skipped = result.skipped ?? 0
        const failed = result.failed ?? 0
        const message = failed > 0
          ? `ME01 finished with ${succeeded} successful, ${skipped} skipped, and ${failed} failed material(s).`
          : `ME01 completed: ${succeeded} successful and ${skipped} skipped material(s).`
        finish({
          success: true,
          message,
          processed,
          succeeded,
          skipped,
          failed,
          resultPath: result.resultPath ?? config.excelPath,
          backupPath: result.backupPath ?? ''
        })
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
      return { command: process.env.SAP_GUI_PYTHON?.trim() || 'py', args: process.env.SAP_GUI_PYTHON?.trim() ? [this.enginePaths.script] : ['-3', this.enginePaths.script] }
    }
    if (await exists(this.enginePaths.executable)) return { command: this.enginePaths.executable, args: this.enginePaths.executableArgs ?? [] }
    if (!(await exists(this.enginePaths.script))) return null
    return { command: process.env.SAP_GUI_PYTHON?.trim() || 'py', args: process.env.SAP_GUI_PYTHON?.trim() ? [this.enginePaths.script] : ['-3', this.enginePaths.script] }
  }
}

function progressFromEvent(event: EngineEvent): Me01BatchProgress | null {
  const message = event.message ?? ''
  if (event.event === 'preparing') return { stage: 'preparing', status: 'running', message }
  if (event.event === 'connecting') return { stage: 'connecting-sap', status: 'running', message, total: event.total }
  if (event.event === 'waiting-for-sap') return { stage: 'connecting-sap', status: 'running', message, total: event.total }
  if (event.event === 'record') return { stage: 'processing', message, current: event.current, total: event.total, material: event.material, status: event.status ?? 'running' }
  if (event.event === 'complete') return { stage: 'complete', status: (event.failed ?? 0) > 0 ? 'failed' : 'success', message, current: event.processed, total: event.processed }
  if (event.event === 'fatal') return { stage: 'failed', status: 'failed', message }
  return null
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
