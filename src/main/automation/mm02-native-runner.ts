import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { MM02_OPERATION, type Mm02Progress, type Mm02Result, type Mm02Task } from '../../shared/mm02-types'
import type { GeneratedArtifacts } from '../services/generated-artifacts'
import { NativeInteractionBridge, type GuidanceContext } from './native-interaction-bridge'

interface EnginePaths { executable: string; script: string; packaged: boolean }
type EngineEvent = Parameters<NativeInteractionBridge['handle']>[0] & Partial<Mm02Result & Mm02Progress> & { event?: string }
const PREFIX = 'MM02_EVENT '

export class Mm02NativeRunner {
  private child: ChildProcessWithoutNullStreams | null = null
  private active = false
  private stopped = false

  constructor(private readonly paths: EnginePaths, private readonly artifacts: GeneratedArtifacts) {}

  cancel(): boolean {
    if (!this.active) return false
    this.stopped = true
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.write('cancel\n')
    return true
  }

  async run(tasks: Mm02Task[], report: (progress: Mm02Progress) => void, guidance: GuidanceContext): Promise<Mm02Result> {
    if (this.active) return { success: false, errorCode: 'OPERATION_IN_PROGRESS', message: 'Another MM02 batch is running.' }
    this.active = true
    this.stopped = false
    let directory: string | undefined
    try {
      const target = this.paths.packaged ? this.paths.executable : this.paths.script
      await access(target)
      directory = await this.artifacts.create(MM02_OPERATION, guidance.runId)
      await writeFile(join(directory, 'mm02-input.json'), JSON.stringify(tasks), { encoding: 'utf8', flag: 'wx' })
      if (this.stopped) return { success: false, errorCode: 'CANCELLED', message: 'Stopped before connecting to SAP.' }
      const python = process.env.SAP_GUI_PYTHON?.trim()
      const command = this.paths.packaged ? target : python || 'py'
      const args = this.paths.packaged ? ['mm02'] : python ? [target] : ['-3', target]
      const child = spawn(command, args, { shell: false, windowsHide: true, cwd: directory,
        env: { ...process.env, HUB_RUN_ID: guidance.runId, HUB_ARTIFACT_DIR: directory,
          PYTHONIOENCODING: 'utf-8', TMP: directory, TEMP: directory } })
      this.child = child
      child.stdin.on('error', () => undefined)
      const bridge = new NativeInteractionBridge(guidance, child)
      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })
      const result = await new Promise<Mm02Result>(resolve => {
        let final: Mm02Result | null = null
        let detail = ''
        const counts = { processed: 0, succeeded: 0, skipped: 0, failed: 0 }
        stderr.on('line', line => { if (line.trim()) detail = line.trim().slice(0, 2_000) })
        stdout.on('line', line => {
          if (!line.startsWith(PREFIX)) return
          try {
            const event = JSON.parse(line.slice(PREFIX.length)) as EngineEvent
            if (event.event === 'interaction' || event.event === 'recovering' || event.event === 'interaction-resolved') {
              void bridge.handle(event).catch(() => this.cancel())
            } else if (event.event === 'complete' && typeof event.success === 'boolean' && typeof event.message === 'string') {
              final = { success: event.success, message: event.message, errorCode: event.errorCode || undefined, ...counts }
            } else if (event.event === 'record' && event.status && typeof event.message === 'string') {
              if (event.current === counts.processed + 1 && ['success', 'skipped', 'failed'].includes(event.status)) {
                counts.processed++
                if (event.status === 'success') counts.succeeded++
                if (event.status === 'skipped') counts.skipped++
                if (event.status === 'failed') counts.failed++
              }
              report({ stage: 'processing', status: event.status, message: event.message,
                current: counts.processed, total: tasks.length, material: event.material })
            } else if ((event.event === 'connecting' || event.event === 'saving') && typeof event.message === 'string') {
              report({ stage: event.event === 'connecting' ? 'connecting-sap' : 'saving', status: 'running', message: event.message, total: tasks.length })
            }
          } catch { /* Non-protocol output must not affect the write workflow. */ }
        })
        child.once('error', error => { detail = error.message })
        child.once('close', code => {
          stdout.close()
          stderr.close()
          resolve(code === 0 && final ? final : { ...counts, success: false, errorCode: 'MM02_ENGINE_INTERRUPTED',
            message: `MM02 stopped before returning a confirmed result. Verify SAP before retrying.${detail ? ` ${detail}` : ''}` })
        })
      })
      return { ...result, total: tasks.length, resultPath: await ownedFile(directory, 'MM02_Sub_commodity_Result.xlsx'),
        logPath: await ownedFile(directory, 'mm02-progress.jsonl') }
    } catch (error) {
      return { success: false, errorCode: 'MM02_ENGINE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
    } finally {
      this.child = null
      if (directory) await this.artifacts.finish(directory).catch(() => undefined)
      this.active = false
    }
  }
}

async function ownedFile(directory: string, name: string): Promise<string | undefined> {
  const path = join(directory, name)
  return await lstat(path).then(info => info.isFile() ? path : undefined, () => undefined)
}
