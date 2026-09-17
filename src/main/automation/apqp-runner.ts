import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { ApqpConfig, ApqpPreview, ApqpPreviewResult, ApqpProgress, ApqpResult } from '../../shared/apqp-types'

interface EngineEvent extends ApqpProgress {
  preview?: ApqpPreview
  processed?: number
  succeeded?: number
  skipped?: number
  failed?: number
  cancelled?: boolean
  resultPath?: string
  backupPath?: string
  logPath?: string
}

interface ApqpEnginePaths {
  executable: string
  executableArgs?: string[]
  script: string
  preferScript?: boolean
}

export class ApqpRunner {
  private child: ChildProcessWithoutNullStreams | null = null
  private busy = false
  private previewing = false
  constructor(private readonly enginePaths: ApqpEnginePaths) {}

  async preview(config: ApqpConfig): Promise<ApqpPreviewResult> {
    try {
      const event = await this.execute(config, true, () => undefined)
      if (!event.preview) throw new Error('The engine did not return a workbook preview.')
      return { success: true, preview: event.preview }
    } catch (error) { return { success: false, message: messageOf(error) } }
  }

  async run(config: ApqpConfig, report: (event: ApqpProgress) => void): Promise<ApqpResult> {
    try {
      const e = await this.execute(config, false, report)
      return { success: true, message: e.message, total: e.total ?? 0, processed: e.processed ?? 0,
        succeeded: e.succeeded ?? 0, skipped: e.skipped ?? 0, failed: e.failed ?? 0,
        workers: e.workers ?? 0, cancelled: e.cancelled ?? false, resultPath: e.resultPath ?? '',
        backupPath: e.backupPath ?? '', logPath: e.logPath ?? '' }
    } catch (error) { return { success: false, message: messageOf(error) } }
  }

  cancel(): boolean {
    if (!this.child || this.previewing || this.child.stdin.destroyed) return false
    this.child.stdin.write('cancel\n')
    return true
  }

  private async execute(config: ApqpConfig, preview: boolean, report: (event: ApqpProgress) => void): Promise<EngineEvent> {
    if (this.busy) throw new Error('An APQP preview or run is already active.')
    this.busy = true
    this.previewing = preview
    try {
      const launch = await this.resolveLaunch(preview)
      if (!launch) throw new Error('The packaged APQP engine is unavailable.')
      return await new Promise<EngineEvent>((resolve, reject) => {
        let final: EngineEvent | undefined
        const errors: string[] = []
        const child = spawn(launch.command, launch.args, {
          shell: false, windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', EXCEL_PATH: config.excelPath,
            SHEET_NAME: config.sheetName, PLANT: config.plant, TARGET_SYSTEM: config.system,
            TARGET_CLIENT: config.client, MAX_WORKERS: String(config.maxWorkers),
            CREATE_SESSIONS: String(config.createSessions), MAX_ITEMS: String(config.maxItems),
            OVERWRITE_EXISTING_DATE: String(config.overwriteExisting) }
        })
        this.child = child
        const stdout = createInterface({ input: child.stdout })
        const stderr = createInterface({ input: child.stderr })
        stdout.on('line', (line) => {
          if (!line.startsWith('APQP_EVENT ')) return
          try {
            const e = JSON.parse(line.slice('APQP_EVENT '.length)) as EngineEvent
            if (e.event === 'preview' || e.event === 'complete') final = e
            if (e.event === 'fatal') errors.push(e.message)
            if (!preview) report(e)
          } catch { /* Ignore non-protocol output. */ }
        })
        stderr.on('line', (line) => { errors.push(line); if (errors.length > 10) errors.shift() })
        child.stdin.on('error', () => undefined)
        child.once('error', reject)
        child.once('close', (code) => {
          stdout.close(); stderr.close()
          if (code !== 0 || !final) reject(new Error(errors.at(-1) || 'APQP stopped without a result. Check Excel, SAP GUI and SAP GUI Scripting.'))
          else resolve(final)
        })
      })
    } finally { this.child = null; this.busy = false; this.previewing = false }
  }

  private async resolveLaunch(preview: boolean): Promise<{ command: string; args: string[] } | null> {
    const suffix = preview ? ['--preview'] : []
    if (!this.enginePaths.preferScript && await exists(this.enginePaths.executable)) {
      return { command: this.enginePaths.executable, args: [...(this.enginePaths.executableArgs ?? []), ...suffix] }
    }
    if (!(await exists(this.enginePaths.script))) return null
    const customPython = process.env.SAP_GUI_PYTHON?.trim()
    return {
      command: customPython || 'py',
      args: [...(customPython ? [] : ['-3']), '-u', this.enginePaths.script, ...suffix]
    }
  }
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}
