import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, copyFile, cp, mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import type { RfqBatchConfig, RfqBatchProgress, RfqBatchResult, RfqExcelPreview } from '../../shared/rfq-batch-types'
import type { AutomationInteraction, InteractionResponse } from '../../shared/automation-interaction'
import type { RfqRecoveryRecorder } from '../../shared/rfq-safe-recovery'
import type { GeneratedArtifacts } from '../services/generated-artifacts'

interface EnginePaths {
  executable: string
  executableArgs?: string[]
  script: string
  preferScript?: boolean
}

interface EngineEvent extends Partial<RfqBatchProgress> {
  type: string
  preview?: RfqExcelPreview
  resultPath?: string
  logPath?: string
  processed?: number
  withSkips?: number
  rfqNumbers?: string[]
}

export class RfqNativeRunner {
  private child: ChildProcessWithoutNullStreams | null = null
  private busy = false
  private stopFile = ''
  private controlDirectory = ''
  private interaction: AutomationInteraction | null = null
  private responding = false
  private launchPromise?: Promise<{ command: string; args: string[] }>
  private allowedPaths = new Set<string>()
  private sourcePaths = new Set<string>()

  constructor(private readonly enginePaths: EnginePaths, readonly runsDirectory: string, private readonly appVersion: string,
    private readonly recovery?: RfqRecoveryRecorder, private readonly artifacts?: GeneratedArtifacts) {}

  async preview(config: RfqBatchConfig): Promise<RfqExcelPreview> {
    const directory = await this.createRun('preview')
    try {
      const path = join(directory, 'input', basename(config.excelPath))
      await copyFile(config.excelPath, path)
      const launch = await this.resolveLaunch()
      const output = await this.invoke(launch, ['--hub', '--validate-only', '--excel-path', path, '--target-env', config.environment], directory)
      const preview = output.events.find((event) => event.type === 'VALIDATION_COMPLETED')?.preview
      if (output.code !== 0 || !preview) throw new Error(output.events.at(-1)?.message || output.error || 'Could not validate the RFQ workbook.')
      return { ...preview, fingerprint: createHash('sha256').update(await readFile(path)).digest('hex') }
    } finally { await this.artifacts?.finish(directory).catch(() => undefined) }
  }

  async run(config: RfqBatchConfig, report: (progress: RfqBatchProgress) => void, runId: string = randomUUID()): Promise<RfqBatchResult> {
    if (this.busy) return { success: false, errorCode: 'OPERATION_IN_PROGRESS', message: 'Another RFQ run is in progress.' }
    if (config.environment === 'PROD' && !config.productionConfirmed) return { success: false, errorCode: 'INVALID_CONFIG', message: 'Confirm Production execution first.' }
    this.busy = true
    let directory = ''
    let resultPath = ''
    let last: EngineEvent | undefined
    let diagnosticsPath = ''
    let recorded = false
    let closed = false
    let recoveryIssue = false
    try {
      directory = await this.createRun(runId)
      diagnosticsPath = join(directory, 'logs')
      this.stopFile = join(directory, 'temp', 'stop-requested')
      this.controlDirectory = join(directory, 'temp', 'interaction')
      await mkdir(this.controlDirectory, { recursive: true })
      const input = join(directory, 'input', basename(config.excelPath))
      resultPath = join(directory, 'output', basename(config.excelPath))
      await copyFile(config.excelPath, input)
      if (config.fingerprint !== createHash('sha256').update(await readFile(input)).digest('hex')) {
        throw new Error('The workbook changed after preview. Upload it again and review the new group summary.')
      }
      await copyFile(input, resultPath)
      // Failure to create durable review evidence blocks launch before SAP can be touched.
      this.recovery?.begin(runId, config.environment, resultPath)
      recorded = Boolean(this.recovery)
      report({ stage: 'preparing', status: 'running', runId, message: 'Validating a local working copy before connecting to SAP.' })
      const launch = await this.resolveLaunch()
      const args = ['--hub', '--excel-path', resultPath, '--source-excel-path', resolve(config.excelPath),
        '--source-baseline-path', input, '--run-id', runId, '--target-env', config.environment,
        '--event-mode', 'jsonl', '--stop-file', this.stopFile, '--control-dir', this.controlDirectory]
      const readyFile = this.recovery ? join(directory, 'temp', 'hub-ready.json') : undefined
      if (readyFile) args.push('--hub-ready-file', readyFile)
      if (config.productionConfirmed) args.push('--production-confirmed')
      const output = await this.invoke(launch, args, directory, (event) => {
        if (event.type === 'ENGINE_READY' && this.recovery && readyFile) {
          // py.exe/PyInstaller may launch a different PID. Track the actual engine before releasing the gate.
          const pid = (event as EngineEvent & { pid?: number }).pid
          if (!Number.isInteger(pid) || pid! <= 0) throw new Error('Invalid RFQ engine identity.')
          this.recovery.launched(runId, pid!)
          void writeFile(readyFile, JSON.stringify({ runId, pid }), 'utf8').catch(() => undefined)
          return
        }
        try { this.recovery?.observe(runId, { ...event }) }
        catch (error) {
          // A lost boundary cannot later be healed by a clean terminal event. Request normal safe stopping,
          // not a process kill or SAP rollback, and require review even if later ledger writes succeed.
          recoveryIssue = true
          void this.cancel().catch(() => undefined)
          throw error
        }
        last = event
        if (event.resultPath) resultPath = event.resultPath
        if (event.type === 'ACTION_REQUIRED' && event.state === 'WAITING_FOR_USER' && event.runId === runId
            && typeof event.requestId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(event.requestId)) {
          this.interaction = { automation: 'RFQ', runId, requestId: event.requestId, state: 'WAITING_FOR_USER',
            allowedActions: event.allowedActions?.includes('continue') ? ['continue', 'stop', ...(event.allowedActions.includes('open-fix-session') && event.recoveryPoint === 'COMMODITY_MISSING' ? ['open-fix-session' as const] : [])] : ['stop'],
            message: event.message || 'SAP correction required.', step: event.step,
            issueSummary: event.issueSummary, issueSummaryZh: event.issueSummaryZh,
            recoveryPoint: event.recoveryPoint, groupKey: event.groupKey, materials: event.materials, rows: event.rows,
            instructions: event.instructions, instructionsZh: event.instructionsZh }
          this.responding = false
          this.allowedPaths.add(resolve(diagnosticsPath))
        } else if (event.type === 'FIX_SESSION_RESULT' && this.interaction && this.interaction.requestId === event.requestId && event.runId === runId) {
          this.interaction = { ...this.interaction, message: event.message || this.interaction.message,
            allowedActions: this.interaction.allowedActions.filter(action => action !== 'open-fix-session') }
          this.responding = false
        } else if (event.type === 'RECOVERING' && this.interaction) {
          this.interaction = { ...this.interaction, state: 'RECOVERING' }
        } else if (['INTERACTION_RESOLVED', 'RUN_CANCELLED', 'RUN_FAILED', 'RUN_COMPLETED'].includes(event.type)) {
          this.interaction = null
          this.responding = false
        }
        try { report(toProgress(event)) } catch { /* Presentation must not affect engine state. */ }
      }, true, readyFile ? async pid => {
        this.recovery!.launched(runId, pid)
        // No marker yet: wait for the actual Python engine identity above.
      } : undefined)
      this.recovery?.close(runId, recoveryIssue ? null : output.code)
      closed = true
      const terminal = [...output.events].reverse().find((event) => ['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED'].includes(event.type))
      const sourceWriteback = [...output.events].reverse().find(event => event.sourceWriteback)?.sourceWriteback ?? {
        sourcePath: resolve(config.excelPath), status: 'pending' as const, writtenRows: 0, pendingRows: 0,
        message: 'Original Excel writeback was not confirmed. Review the result copy; do not rerun SAP to retry Excel writeback.' }
      // Only the exact file explicitly selected by the user is openable. An
      // engine event must not grant access to an arbitrary external file.
      if (resolve(sourceWriteback.sourcePath) !== resolve(config.excelPath)) throw new Error('Invalid source workbook writeback identity.')
      this.sourcePaths.add(resolve(config.excelPath))
      this.allowedPaths.add(resolve(config.excelPath))
      const completed = !recoveryIssue && terminal?.type === 'RUN_COMPLETED' && output.code === 0
      const recoveryMessage = recoveryIssue ? 'Recovery evidence could not be stored reliably. Safe stop was requested. Verify SAP and review Safe Recovery before retrying.' : undefined
      const metadata = { appVersion: this.appVersion, engineVersion: '32', runId, automationType: 'RFQ',
        timestamp: new Date().toISOString(), environment: config.environment,
        lastStage: last?.type, error: completed ? undefined : recoveryMessage || terminal?.message || output.error,
        terminal, resultPath, sourceWriteback }
      await writeFile(join(diagnosticsPath, 'run.json'), JSON.stringify(metadata, null, 2), 'utf8')
      for (const target of [resultPath, diagnosticsPath]) {
        if (this.isInsideRun(target) && await exists(target)) this.allowedPaths.add(resolve(target))
      }
      // Keep the engine-owned CSV in the local diagnostic folder too.
      const logPath = [...output.events].reverse().find((event) => event.logPath)?.logPath
      if (logPath && this.isInsideRun(logPath) && await exists(logPath)) await copyFile(logPath, join(diagnosticsPath, basename(logPath)))
      if (!completed) return { success: false, errorCode: terminal?.type === 'RUN_CANCELLED' ? 'CANCELLED' : 'EXECUTION_FAILED',
        message: recoveryMessage || terminal?.message || output.error || 'The engine stopped without a completion event. Review local logs before restarting.',
        runId, resultPath, logPath, diagnosticsPath, rfqNumbers: terminal?.rfqNumbers,
        processed: terminal?.processed, total: terminal?.total, succeeded: terminal?.succeeded,
        skipped: terminal?.skipped, failed: terminal?.failed, sourceWriteback }
      return { success: true, message: sourceWriteback.status === 'pending'
        ? `${terminal.message || 'RFQ run completed.'} ${sourceWriteback.message}` : terminal.message || 'RFQ run completed.', runId,
        processed: terminal.processed ?? 0, total: terminal.total ?? 0,
        succeeded: terminal.succeeded ?? 0, skipped: terminal.skipped ?? 0, failed: terminal.failed ?? 0,
        withSkips: terminal.withSkips ?? 0, materials: typeof terminal.materials === 'number' ? terminal.materials : 0,
        rfqNumbers: terminal.rfqNumbers ?? [], resultPath, logPath, diagnosticsPath, sourceWriteback }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (diagnosticsPath) {
        await writeFile(join(diagnosticsPath, 'run.json'), JSON.stringify({ appVersion: this.appVersion, runId, automationType: 'RFQ', timestamp: new Date().toISOString(), lastStage: last?.type, error: message }), 'utf8').catch(() => undefined)
        this.allowedPaths.add(resolve(diagnosticsPath))
      }
      return { success: false, errorCode: 'EXECUTION_FAILED', message, runId, diagnosticsPath }
    } finally {
      if (recorded && !closed) { try { this.recovery?.close(runId, null) } catch { /* Preserve the existing uncertain ledger, never erase evidence. */ } }
      if (directory) await this.artifacts?.finish(directory).catch(() => undefined)
      this.child = null
      this.busy = false
      this.stopFile = ''
      this.controlDirectory = ''
      this.interaction = null
      this.responding = false
    }
  }

  async cancel(): Promise<boolean> {
    if (!this.busy || !this.stopFile) return false
    await writeFile(this.stopFile, 'stop after current group', 'utf8')
    return true
  }

  getInteraction(): AutomationInteraction | null { return this.interaction ? structuredClone(this.interaction) : null }

  async respond(input: InteractionResponse): Promise<boolean> {
    const current = this.interaction
    if (!this.busy || !current || input.runId !== current.runId || input.requestId !== current.requestId
        || !current.allowedActions.includes(input.action)) return false
    if (input.action === 'stop') return this.cancel()
    if (this.responding || current.state !== 'WAITING_FOR_USER') return false
    this.responding = true
    try {
      const target = join(this.controlDirectory, current.requestId + '.json')
      await writeFile(target + '.tmp', JSON.stringify(input), 'utf8')
      await rename(target + '.tmp', target)
      if (input.action === 'continue' && this.interaction?.requestId === current.requestId) this.interaction.state = 'RECOVERING'
      return true
    } catch (error) {
      this.responding = false
      throw error
    }
  }

  isRunning(): boolean { return this.busy || this.child !== null }

  canOpen(path: string): boolean { return this.allowedPaths.has(resolve(path)) && (this.isInsideRun(path) || this.sourcePaths.has(resolve(path))) }

  private isInsideRun(path: string): boolean {
    const child = relative(resolve(this.runsDirectory), resolve(path))
    return Boolean(child) && !child.startsWith('..') && !isAbsolute(child)
  }

  private async createRun(id: string): Promise<string> {
    const runId = id === 'preview' ? 'preview-' + randomUUID() : id
    const directory = this.artifacts ? await this.artifacts.create('create-rfq', runId) : join(this.runsDirectory, runId)
    await Promise.all(['input', 'output', 'logs', 'temp'].map((name) => mkdir(join(directory, name), { recursive: true })))
    return directory
  }

  private async resolveLaunch(): Promise<{ command: string; args: string[] }> {
    if (!this.launchPromise) this.launchPromise = this.prepareLaunch().catch((error) => { this.launchPromise = undefined; throw error })
    return this.launchPromise
  }

  private async prepareLaunch(): Promise<{ command: string; args: string[] }> {
    if (this.enginePaths.preferScript) {
      if (!(await exists(this.enginePaths.script))) throw new Error('RFQ source engine is missing.')
      return { command: process.env.SAP_RFQ_PYTHON?.trim() || 'py',
        args: [...(process.env.SAP_RFQ_PYTHON?.trim() ? [] : ['-3']), this.enginePaths.script] }
    }
    if (!(await exists(this.enginePaths.executable))) throw new Error('The bundled automation engine is missing. Re-extract the complete application package.')
    // Always run the packaged runtime from LocalAppData, including packages
    // launched from mapped corporate drives. Reuse one cached shared runtime.
    const info = await stat(this.enginePaths.executable)
    const key = createHash('sha256').update(this.appVersion + this.enginePaths.executable + info.size + info.mtimeMs).digest('hex').slice(0, 20)
    const directory = join(dirname(this.runsDirectory), 'engine-cache', key)
    const ready = join(directory, '.ready')
    if (!(await exists(ready))) {
      await mkdir(directory, { recursive: true })
      await cp(dirname(this.enginePaths.executable), directory, { recursive: true })
      await writeFile(ready, '32', 'utf8')
    }
    return { command: join(directory, basename(this.enginePaths.executable)), args: this.enginePaths.executableArgs ?? [] }
  }

  private async invoke(launch: { command: string; args: string[] }, args: string[], directory: string,
    onEvent?: (event: EngineEvent) => void, active = false, onLaunch?: (pid: number) => Promise<void>): Promise<{ code: number | null; events: EngineEvent[]; error: string }> {
    return await new Promise((resolveOutput, reject) => {
      const log = createWriteStream(join(directory, 'logs', 'engine.log'), { encoding: 'utf8' })
      const events: EngineEvent[] = []
      let error = ''
      let logError = ''
      log.on('error', (reason) => { logError = reason.message })
      const child = spawn(launch.command, [...launch.args, ...args], { shell: false, windowsHide: true,
        cwd: join(directory, 'output'),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
          TEMP: join(directory, 'temp'), TMP: join(directory, 'temp') } })
      if (active) this.child = child
      if (onLaunch) child.once('spawn', () => {
        void onLaunch(child.pid!).catch(reason => {
          error = `Recovery launch handshake failed: ${String(reason)}`
          // No marker is issued on failure; the engine must exit before any SAP access.
        })
      })
      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })
      stdout.on('line', (line) => {
        log.write(line + '\n')
        if (!line.startsWith('HUB_EVENT:')) return
        try {
          const event = JSON.parse(line.slice(10)) as EngineEvent
          if (typeof event.type !== 'string') return
          events.push(event)
          onEvent?.(event)
        } catch (reason) {
          error = `RFQ event could not be processed: ${reason instanceof Error ? reason.message : String(reason)}`
          log.write(error + '\n')
        }
      })
      stderr.on('line', (line) => { error = line; log.write(line + '\n') })
      child.once('error', (reason) => { stdout.close(); stderr.close(); log.end(); reject(reason) })
      child.once('close', (code) => {
        stdout.close(); stderr.close()
        log.end(() => resolveOutput({ code, events, error: logError || error }))
      })
    })
  }
}

function toProgress(event: EngineEvent): RfqBatchProgress {
  const failed = ['RUN_FAILED', 'GROUP_FAILED', 'RECOVERABLE_ERROR'].includes(event.type)
  return { ...event, stage: event.state === 'WAITING_FOR_USER' ? 'waiting-for-user' : event.state === 'RECOVERING' ? 'recovering' : event.type === 'RUN_COMPLETED' ? 'complete' : event.type === 'RUN_FAILED' ? 'failed' : event.type === 'RUN_CANCELLED' ? 'cancelled' : 'processing',
    status: event.state === 'WAITING_FOR_USER' ? 'waiting' : event.state === 'RECOVERING' ? 'recovering' : failed ? 'failed' : event.type === 'MATERIAL_SKIPPED' || event.type === 'ACTION_REQUIRED' ? 'skipped' : event.type === 'RUN_COMPLETED' ? 'success' : 'running',
    message: event.message || event.type.replaceAll('_', ' ') }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}
