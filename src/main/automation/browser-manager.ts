import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'
import type {
  AutomationProgress,
  AutomationResult,
  OpenSapRequest
} from '../../shared/automation-types'
import { resolveSapUrl } from '../../shared/settings-types'
import type { SettingsService } from '../services/settings-service'
import type { BrowserSlotManager } from './browser-slot-manager'

const USER_LOGIN_TIMEOUT_MS = 180_000
const LOGIN_PROMPT_DETECTION_MS = 1_500

export class BrowserManager {
  private readonly contexts = new Map<number, BrowserContext>()

  constructor(
    private readonly settingsService: SettingsService,
    private readonly userDataDirectory: string,
    private readonly slotManager: BrowserSlotManager
  ) {}

  async openSapWebGui(
    request: OpenSapRequest,
    reportProgress: (progress: AutomationProgress) => void
  ): Promise<AutomationResult> {
    const settings = await this.settingsService.getSettings()
    const existingContext = this.contexts.values().next().value as BrowserContext | undefined

    if (!request.newBrowser && existingContext) {
      const existingPage = existingContext.pages().at(0)
      if (existingPage) {
        await existingPage.bringToFront()
      }
      return { success: true, message: 'SAP WebGUI is already open in the automation browser.' }
    }

    const slot = this.slotManager.acquire(settings.maxConcurrentBrowsers)
    if (slot === null) {
      return {
        success: false,
        errorCode: 'OPERATION_IN_PROGRESS',
        message: `The configured limit of ${settings.maxConcurrentBrowsers} concurrent browser window(s) has been reached.`
      }
    }

    let launchedContext: BrowserContext | null = null
    let retainSlot = false

    try {
      const tcode = request.tcode?.trim().toUpperCase() || 'SMEN'
      const validation = resolveSapUrl(settings.sapWebGuiUrl, tcode)
      if (!validation.valid) {
        return {
          success: false,
          errorCode: settings.sapWebGuiUrl.trim() ? 'INVALID_SAP_URL' : 'SAP_URL_EMPTY',
          message: validation.message
        }
      }

      const browserName = settings.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'
      reportProgress({ stage: 'starting-browser', message: `Starting ${browserName}…` })
      reportProgress({
        stage: 'waiting-for-login',
        message: 'User action required: confirm the Windows certificate in the browser when prompted.'
      })
      const profileDirectory = join(
        this.userDataDirectory,
        `${settings.browser}-automation-profile-${slot}`
      )

      try {
        launchedContext = await chromium.launchPersistentContext(profileDirectory, {
          channel: settings.browser,
          headless: false,
          viewport: null,
          acceptDownloads: true,
          downloadsPath: settings.defaultDownloadFolder || undefined
        })
      } catch (error) {
        const message = getErrorMessage(error)
        const browserUnavailable = /executable|chrome|msedge|browser.*not found/i.test(message)
        return {
          success: false,
          errorCode: browserUnavailable ? 'BROWSER_UNAVAILABLE' : 'BROWSER_LAUNCH_FAILED',
          message: browserUnavailable
            ? `${browserName} could not be found. Install it or select another browser in Settings.`
            : `${browserName} could not be started: ${message}`
        }
      }

      reportProgress({ stage: 'opening-sap', message: `Opening SAP WebGUI transaction ${tcode}…` })
      const pages = launchedContext.pages()
      const page = pages[0] ?? (await launchedContext.newPage())

      const navigationOutcome = page
        .goto(validation.url.toString(), {
          waitUntil: 'domcontentloaded',
          timeout: USER_LOGIN_TIMEOUT_MS
        })
        .then(() => ({ kind: 'navigated' as const }))
        .catch((error: unknown) => ({ kind: 'failed' as const, error }))
      const initialOutcome = await Promise.race([
        navigationOutcome,
        delay(LOGIN_PROMPT_DETECTION_MS).then(() => ({ kind: 'waiting' as const }))
      ])

      if (initialOutcome.kind === 'failed') {
        const result = createNavigationFailure(initialOutcome.error)
        await launchedContext.close().catch(() => undefined)
        launchedContext = null
        return result
      }

      if (initialOutcome.kind === 'waiting') {
        this.registerContext(slot, launchedContext)
        retainSlot = true
        reportProgress({
          stage: 'waiting-for-login',
          message: 'ACTION REQUIRED: Select your Windows certificate, click OK, and complete SAP sign-in.'
        })
        void navigationOutcome.then((outcome) => {
          if (outcome.kind === 'navigated') {
            reportProgress({ stage: 'complete', message: `SAP transaction ${tcode} is ready.` })
          } else {
            reportProgress({
              stage: 'failed',
              message: createNavigationFailure(outcome.error).message
            })
          }
        })
        return {
          success: true,
          requiresUserAction: true,
          message: 'Browser opened. ACTION REQUIRED: confirm the Windows certificate and SAP sign-in.'
        }
      }

      this.registerContext(slot, launchedContext)
      retainSlot = true
      reportProgress({ stage: 'complete', message: 'SAP WebGUI opened successfully.' })
      return { success: true, message: `SAP WebGUI opened successfully in ${browserName}.` }
    } catch (error) {
      if (launchedContext) {
        await launchedContext.close().catch(() => undefined)
      }
      return {
        success: false,
        errorCode: 'UNKNOWN_ERROR',
        message: `An unexpected error occurred: ${getErrorMessage(error)}`
      }
    } finally {
      if (!retainSlot) {
        this.slotManager.release(slot)
      }
    }
  }

  private registerContext(slot: number, context: BrowserContext): void {
    this.contexts.set(slot, context)
    context.once('close', () => {
      this.contexts.delete(slot)
      this.slotManager.release(slot)
    })
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function createNavigationFailure(error: unknown): AutomationResult {
  const message = getErrorMessage(error)
  const timedOut = /timeout/i.test(message)
  if (timedOut) {
    return {
      success: false,
      errorCode: 'NAVIGATION_TIMEOUT',
      message: 'SAP sign-in was not completed within 3 minutes. Select the Windows certificate and finish login in the browser.'
    }
  }
  return {
    success: false,
    errorCode: 'NAVIGATION_FAILED',
    message: `SAP WebGUI could not be opened. Verify the URL template, DNS, VPN, and network access. (${message})`
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
