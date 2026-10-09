import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import type { AutomationInteraction, InteractionResponse } from '../../shared/automation-interaction'
import { validInteractionValues } from '../../shared/automation-interaction'
import { IPC_CHANNELS } from '../../shared/ipc-channels'

export class GuidedCancelled extends Error {}

/** Engine-owned pause requests. UI notifications can never release a pause. */
export class GuidedAutomationService {
  private requests = new Map<string, { request: AutomationInteraction; respond: (input: InteractionResponse) => Promise<boolean> }>()
  private artifacts = new Set<string>()
  private activeRun = ''
  private interactionListeners = new Set<(request: AutomationInteraction | null) => void>()
  constructor(private readonly directory: string, private readonly rfqBusy: () => boolean) {}

  begin(): string {
    if (this.activeRun || this.rfqBusy()) throw new Error('Another automation is running. Finish or stop it first.')
    this.activeRun = randomUUID()
    return this.activeRun
  }
  isRunning(): boolean { return Boolean(this.activeRun) }
  onInteraction(listener: (request: AutomationInteraction | null) => void): () => void {
    this.interactionListeners.add(listener)
    return () => this.interactionListeners.delete(listener)
  }
  end(runId: string): void {
    for (const [key, value] of this.requests) if (value.request.runId === runId) this.requests.delete(key)
    if (this.activeRun === runId) this.activeRun = ''
    this.broadcast()
  }
  getInteraction(): AutomationInteraction | null { return this.requests.values().next().value?.request ?? null }
  async respond(input: InteractionResponse): Promise<boolean> {
    const value = this.requests.get(input.requestId)
    if (!value || value.request.runId !== input.runId || !value.request.allowedActions.includes(input.action)) return false
    if (input.action === 'continue' && value.request.state === 'RECOVERING') return false
    if (!validInteractionValues(value.request, input)) return false
    return value.respond(input)
  }
  async publish(request: AutomationInteraction, respond: (input: InteractionResponse) => Promise<boolean>): Promise<void> {
    if (request.runId !== this.activeRun) throw new Error('Inactive automation interaction.')
    for (const [id, value] of this.requests) if (value.request.runId === request.runId && id !== request.requestId) this.requests.delete(id)
    this.requests.set(request.requestId, { request, respond })
    await this.persist(request)
    this.broadcast()
  }
  async change(requestId: string, state: AutomationInteraction['state']): Promise<void> {
    const entry = this.requests.get(requestId)
    if (!entry) return
    entry.request = { ...entry.request, state }
    await this.persist(entry.request)
    this.broadcast()
  }
  clear(requestId: string): void { this.requests.delete(requestId); this.broadcast() }
  registerArtifacts(...paths: (string | undefined)[]): void {
    paths.filter((path): path is string => Boolean(path)).forEach(path => this.artifacts.add(resolve(path)))
  }
  async openArtifact(path: string): Promise<{ success: boolean; message?: string }> {
    if (!this.artifacts.has(resolve(path))) return { success: false, message: 'Only files returned by this automation session can be opened.' }
    const message = await shell.openPath(path)
    return { success: !message, message }
  }
  async wait(automation: string, runId: string, issue: string, issueZh: string,
    verify: (() => Promise<void>) | undefined, stopped: () => boolean): Promise<void> {
    let message = issue
    while (true) {
      if (stopped()) throw new GuidedCancelled('Stopped by user.')
      const requestId = randomUUID()
      let chosen: InteractionResponse | undefined
      const stopChosen = (): boolean => chosen?.action === 'stop'
      await this.publish({ automation, runId, requestId, state: 'WAITING_FOR_USER',
        allowedActions: verify ? ['continue', 'stop'] : ['stop'], message, issueSummary: issue, issueSummaryZh: issueZh,
        recoveryPoint: verify ? 'SIGN_IN' : 'UNVERIFIED_STATE',
        instructions: verify ? 'Complete sign-in in every opened SAP window, then click Continue. The Hub will verify before starting.' : undefined,
        instructionsZh: verify ? '请完成每个已打开 SAP 窗口的登录，再点击继续。系统验证通过后才开始。' : undefined }, async input => {
        if (input.action === 'stop') { chosen = input; return true }
        if (chosen) return false
        chosen = input
        return true
      })
      while (!chosen && !stopped()) await new Promise(resolve => setTimeout(resolve, 150))
      if (stopped() || stopChosen()) { this.clear(requestId); throw new GuidedCancelled('Stopped by user.') }
      await this.change(requestId, 'RECOVERING')
      try {
        await verify?.()
        if (stopped() || stopChosen()) throw new GuidedCancelled('Stopped by user.')
        this.clear(requestId)
        return
      } catch (error) {
        this.clear(requestId)
        if (error instanceof GuidedCancelled) throw error
        message = 'The issue is still present. ' + (error instanceof Error ? error.message : String(error))
      }
    }
  }
  private async persist(request: AutomationInteraction): Promise<void> {
    const directory = join(this.directory, request.runId)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(request, null, 2), 'utf8')
  }
  private broadcast(): void {
    for (const listener of this.interactionListeners) {
      try { listener(this.getInteraction()) } catch { /* Advisory observers never own engine control. */ }
    }
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (window.isDestroyed()) continue
        window.webContents.send(IPC_CHANNELS.automationInteraction, this.getInteraction())
        if (this.getInteraction()?.state === 'WAITING_FOR_USER') {
          window.flashFrame(true)
          window.once('focus', () => { if (!window.isDestroyed()) window.flashFrame(false) })
        }
      } catch { /* Taskbar/toast failure does not change engine state. */ }
    }
  }
}
