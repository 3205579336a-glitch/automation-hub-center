import { join } from 'node:path'
import { app, powerMonitor, type BrowserWindow } from 'electron'
import type { ApqpDateQueryOperation } from './apqp-date-query-operation'
import { PahJobDispatcher, type PahDesktopApproval } from './pah-job-dispatcher'
import { PahJobOutbox } from './pah-job-outbox'
import type { PahJobQueue } from './pah-job-queue'
import { PahJobWorker } from './pah-job-worker'

interface PahDesktopBridgeOptions {
  workerId: string
  window: BrowserWindow
  query: ApqpDateQueryOperation
  queue: PahJobQueue
  /** Must positively verify the Windows session, workstation and local operator policy. */
  verifyOperator: (signal: AbortSignal) => Promise<PahDesktopApproval | null>
  onPollError: (code: 'PAH_POLL_FAILED') => void
}

/** Opt-in main-process bootstrap for an IT-provisioned queue and operator verifier. */
export function startPahDesktopBridge(options: PahDesktopBridgeOptions): PahJobWorker | null {
  if (process.platform !== 'win32' || !app.isReady() || options.window.isDestroyed()) return null
  let desktop = new AbortController()
  let locked = false
  let suspended = false
  const revoke = (): void => { desktop.abort(); desktop = new AbortController() }
  const lock = (): void => { locked = true; revoke() }
  const unlock = (): void => { locked = false }
  const suspend = (): void => { suspended = true; revoke() }
  const resume = (): void => { suspended = false }
  const available = (): boolean => !locked && !suspended && !options.window.isDestroyed() && options.window.isVisible()
  const worker = new PahJobWorker({
    workerId: options.workerId,
    queue: options.queue,
    outbox: new PahJobOutbox(join(app.getPath('userData'), 'pah-job-outbox', options.workerId)),
    dispatcher: new PahJobDispatcher(options.query),
    onPollError: options.onPollError,
    approveDesktop: async signal => {
      if (!available()) return null
      const check = AbortSignal.any([signal, desktop.signal])
      const approval = await options.verifyOperator(check)
      return !approval || check.aborted || !available() ? null
        : { ...approval, signal: AbortSignal.any([check, approval.signal]) }
    }
  })
  powerMonitor.on('lock-screen', lock)
  powerMonitor.on('unlock-screen', unlock)
  powerMonitor.on('suspend', suspend)
  powerMonitor.on('resume', resume)
  options.window.on('hide', revoke)
  options.window.once('closed', () => {
    powerMonitor.off('lock-screen', lock)
    powerMonitor.off('unlock-screen', unlock)
    powerMonitor.off('suspend', suspend)
    powerMonitor.off('resume', resume)
    revoke()
    void worker.stop()
  })
  worker.start()
  return worker
}
