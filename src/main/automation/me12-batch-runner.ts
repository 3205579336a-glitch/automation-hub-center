import { join } from 'node:path'
import type { BrowserContext, ElementHandle, Frame, Locator, Page } from 'playwright-core'
import type {
  Me12BatchConfig,
  Me12BatchProgress,
  Me12BatchResult,
  Me12InfoCategory
} from '../../shared/me12-types'
import { me12Categories } from '../../shared/me12-types'
import { resolveSapUrl } from '../../shared/settings-types'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import {
  Me12ExcelService,
  type Me12ExcelTask,
  type Me12WorkbookSession
} from '../services/me12-excel-service'
import type { SettingsService } from '../services/settings-service'
import type { BrowserSlotManager } from './browser-slot-manager'
import type { GuidanceContext } from './native-interaction-bridge'
import { GuidedCancelled } from '../services/guided-automation-service'
import { Me12StartupPending, verifyMe12Startup, waitForMe12Startup } from './me12-startup'

const NAVIGATION_TIMEOUT_MS = 30_000
const AUTO_SIGN_IN_WAIT_MS = 60_000

interface TaskOutcome {
  kind: 'success' | 'skipped' | 'failed'
  oldValue: string
  status: string
}

interface BrowserWorker {
  worker: number
  slot: number
  context: BrowserContext
  page: Page
}

class SapRecordLockedError extends Error {}
class BatchCancelledError extends Error {}
class SapSaveBoundaryError extends Error {}
class SapRecordNotMaintainedError extends Error {}

const INFO_RECORD_NAMES = ['Info Record', 'Purchasing Info Record']
const ORG_NAMES = ['Purchasing Org.', 'Purchasing Organization', 'Purch. Org.']
const SLT_NAMES = ['SLT', 'Supplier Lead Time', 'Supp. Lead Time']
const PDT_NAMES = ['PDT', 'Pl. Deliv. Time', 'Pl. Deliv. Time.', 'Planned Delivery Time']
const CONFIRMATION_NAMES = ['Conf. Ctrl.', 'Conf. Ctrl', 'Conf.Ctrl.', 'Conf.Ctrl', 'Confirmation Control', 'Confirmation Control Key']
const IR_DETAIL_NAMES = [...SLT_NAMES, ...PDT_NAMES, ...CONFIRMATION_NAMES]
const normalizeDays = (value: string): string => /^\d+$/.test(value) ? String(Number(value)) : value

export class Me12BatchRunner {
  private running = false
  private cancelRequested = false
  private artifactDirectory = ''
  private readonly contexts = new Set<BrowserContext>()

  constructor(
    private readonly settingsService: SettingsService,
    private readonly excelService: Me12ExcelService,
    private readonly browserProfilesDirectory: string,
    private readonly screenshotDirectory: string,
    private readonly logger: DiagnosticLogger,
    private readonly slotManager: BrowserSlotManager
  ) {}

  isRunning(): boolean {
    return this.running
  }

  cancel(): boolean {
    if (!this.running) {
      return false
    }
    this.cancelRequested = true
    // Do not close a browser in the middle of a SAP Save. Stop at the record boundary.
    return true
  }

  async run(
    config: Me12BatchConfig,
    reportProgress: (progress: Me12BatchProgress) => void,
    guidance?: GuidanceContext
  ): Promise<Me12BatchResult> {
    if (this.running) {
      return {
        success: false,
        errorCode: 'OPERATION_IN_PROGRESS',
        message: 'An ME12 batch is already running.'
      }
    }

    this.running = true
    this.cancelRequested = false
    let session: Me12WorkbookSession | null = null
    let processed = 0
    let succeeded = 0
    let skipped = 0
    let failed = 0
    const browserSlots: number[] = []
    let browserCount = 0

    try {
      reportProgress({ stage: 'preparing', message: 'Reading and validating the Excel workbook…' })
      const preview = await this.excelService.preview(config)
      if (preview.selectedInfoRecords === 0) {
        return {
          success: false,
          errorCode: 'NO_MATCHING_RECORDS',
          message: `No valid Info Records were found for Plant ${config.targetPlant}.`
        }
      }

      const settings = await this.settingsService.getSettings()
      const resolvedUrl = resolveSapUrl(settings.sapWebGuiUrl, 'ME12')
      if (!resolvedUrl.valid) {
        return {
          success: false,
          errorCode: 'INVALID_CONFIG',
          message: resolvedUrl.message
        }
      }
      const desiredBrowserCount = Math.min(
        settings.maxConcurrentBrowsers,
        preview.selectedInfoRecords
      )
      for (let index = 0; index < desiredBrowserCount; index += 1) {
        const slot = this.slotManager.acquire(settings.maxConcurrentBrowsers)
        if (slot === null) {
          break
        }
        browserSlots.push(slot)
      }
      if (browserSlots.length === 0) {
        return {
          success: false,
          errorCode: 'OPERATION_IN_PROGRESS',
          message: `The configured limit of ${settings.maxConcurrentBrowsers} concurrent browser window(s) has been reached.`
        }
      }
      reportProgress({ stage: 'backing-up', message: 'Creating a timestamped Excel backup…' })
      session = await this.excelService.prepareRun(config, guidance?.runId)
      this.artifactDirectory = session.artifactDirectory ?? ''
      const workbookSession = session

      const browserName = settings.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'
      reportProgress({
        stage: 'starting-browser',
        message: `Starting ${browserSlots.length} ${browserName} ME12 worker window(s)…`
      })
      const launchResults = await Promise.allSettled(
        browserSlots.map(async (slot, index): Promise<BrowserWorker> => {
          const worker = index + 1
          const { chromium } = await import('playwright-core')
          const context = await chromium.launchPersistentContext(
            join(
              this.browserProfilesDirectory,
              `${settings.browser}-me12-batch-profile-${slot}`
            ),
            {
              channel: settings.browser,
              headless: false,
              viewport: null,
              acceptDownloads: true,
              downloadsPath: this.artifactDirectory || settings.defaultDownloadFolder || undefined
            }
          )
          this.contexts.add(context)
          const page = context.pages()[0] ?? (await context.newPage())
          setMe12PageUrl(page, resolvedUrl.url.toString())
          return { worker, slot, context, page }
        })
      )
      const launchFailure = launchResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      const workers = launchResults
        .filter(
          (result): result is PromiseFulfilledResult<BrowserWorker> =>
            result.status === 'fulfilled'
        )
        .map((result) => result.value)
      if (launchFailure) {
        return {
          success: false,
          errorCode: 'BROWSER_LAUNCH_FAILED',
          message: `${browserName} worker browser could not be started: ${errorMessage(launchFailure.reason)}`
        }
      }
      browserCount = workers.length

      reportProgress({
        stage: 'waiting-for-login',
        message: `Waiting for ${browserCount} ME12 window(s). If prompted, select your certificate and sign in. The batch will start automatically when SAP is ready.`
      })
      if (guidance) {
        // No worker may change a record until all opened windows are signed in.
        await Promise.all(workers.map(async ({ page }) => {
          try { await page.goto(resolvedUrl.url.toString(), { waitUntil: 'commit', timeout: 10_000 }) }
          catch (error) { if (!/timeout/i.test(errorMessage(error))) throw error }
        }))
        const startupNavigated = new WeakSet<Page>()
        const stopped = (): void => this.assertNotCancelled()
        const checks = workers.map(({ page }) => () => verifyMe12Startup(page, resolvedUrl.url, startupNavigated,
          async () => {
            const found = await findTextboxAcrossFrames(page, INFO_RECORD_NAMES, 1_200)
            if (!found || !await found.locator.isEditable({ timeout: 500 }).catch(() => false)) return false
            const [plant, organization] = await Promise.all([
              findExactTextbox(found.frame, ['Plant']),
              findExactTextbox(found.frame, ORG_NAMES)
            ])
            return Boolean(plant && organization)
          },
          async () => Boolean(await findTextboxAcrossFrames(page, ['Transaction Code', 'Command Field', 'OK Code'], 600)),
          stopped))
        try {
          await waitForMe12Startup(checks, stopped, AUTO_SIGN_IN_WAIT_MS)
        } catch (error) {
          if (!(error instanceof Me12StartupPending)) throw error
          stopped()
          await guidance.service.wait('Info Record', guidance.runId,
            `${error.message} Complete certificate selection and SAP sign-in, or check SAP prompts and transaction permissions.`,
            '等待 SAP 登录超时。请确认所有工作窗口均已完成证书选择、登录并进入 ME12；如有 SAP 提示，请处理后点击继续。',
            () => waitForMe12Startup(checks, stopped, 0), () => this.cancelRequested)
        }
      }

      let nextTaskIndex = 0
      let unsafeRecord = false
      let nextCheckpoint = config.saveEvery
      let saveQueue: Promise<string> = Promise.resolve(workbookSession.savePath)
      const saveCheckpoint = (): Promise<string> => {
        saveQueue = saveQueue.then(() => this.excelService.saveCheckpoint(workbookSession))
        return saveQueue
      }

      const runWorker = async (browserWorker: BrowserWorker): Promise<void> => {
        let reuseReadyPage = Boolean(guidance)
        while (true) {
          this.assertNotCancelled()
          if (unsafeRecord) return
          const index = nextTaskIndex
          nextTaskIndex += 1
          if (index >= workbookSession.tasks.length) {
            return
          }
          const task = workbookSession.tasks[index]
          reportProgress({
            stage: 'processing',
            message: `Worker ${browserWorker.worker} processing Info Record ${task.infoRecord} (Excel row${task.excelRows.length > 1 ? 's' : ''} ${task.excelRows.join(', ')})…`,
            current: processed,
            total: workbookSession.tasks.length,
            excelRows: task.excelRows,
            infoRecord: task.infoRecord,
            worker: browserWorker.worker,
            status: 'running'
          })

          const taskResult = await this.runTaskWithRetries(
            browserWorker.page,
            task,
            config,
            reuseReadyPage,
            browserWorker.worker
          )
          reuseReadyPage = false
          processed += 1
          if (taskResult.kind === 'success') {
            succeeded += 1
          } else if (taskResult.kind === 'skipped') {
            skipped += 1
          } else {
            failed += 1
            unsafeRecord = true
          }
          this.excelService.writeTaskResult(
            workbookSession,
            task,
            taskResult.oldValue,
            taskResult.status
          )
          reportProgress({
            stage: 'processing',
            message: `IR ${task.infoRecord}: ${taskResult.status}`,
            current: processed,
            total: workbookSession.tasks.length,
            excelRows: task.excelRows,
            infoRecord: task.infoRecord,
            worker: browserWorker.worker,
            status: taskResult.kind
          })

          const logInput = {
            category: 'automation' as const,
            event: `me12.record.${taskResult.kind}`,
            message: `${task.infoRecord}: ${taskResult.status}`,
            tcode: 'ME12',
            details: {
              infoRecord: task.infoRecord,
              excelRows: task.excelRows.join(', '),
              worker: browserWorker.worker,
              current: processed,
              total: workbookSession.tasks.length
            }
          }
          if (taskResult.kind === 'failed') {
            await this.logger.error(logInput)
          } else {
            await this.logger.info(logInput)
          }

          if (processed >= nextCheckpoint) {
            while (processed >= nextCheckpoint) {
              nextCheckpoint += config.saveEvery
            }
            reportProgress({
              stage: 'saving',
              message: `Saving Excel checkpoint after ${processed} record(s)…`,
              current: processed,
              total: workbookSession.tasks.length,
              worker: browserWorker.worker
            })
            await saveCheckpoint()
          }
        }
      }

      const workerResults = await Promise.allSettled(workers.map(runWorker))
      const workerFailure = workerResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (workerFailure) {
        throw workerFailure.reason
      }
      await saveQueue

      reportProgress({ stage: 'saving', message: 'Saving final Excel results…' })
      const resultPath = await this.excelService.saveCheckpoint(session)
      if (unsafeRecord && guidance) {
        // All workers are now idle and partial results are durable. Unknown states are stop-only.
        await guidance.service.wait('Info Record', guidance.runId,
          'A record could not be verified. Partial results were saved; stop and review the details before trying again.',
          '有一条记录无法验证。已保存部分结果，请停止并查看详情后再处理。', undefined, () => this.cancelRequested)
      }
      reportProgress({
        stage: 'completed',
        message: `ME12 batch completed: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed.`,
        current: processed,
        total: session.tasks.length
      })
      return {
        success: true,
        message: config.dryRun
          ? 'ME12 dry run completed. No SAP records were saved.'
          : 'ME12 batch completed and Excel results were saved.',
        processed,
        succeeded,
        skipped,
        failed,
        browserCount,
        resultPath,
        backupPath: session.backupPath
      }
    } catch (error) {
      if (error instanceof BatchCancelledError || error instanceof GuidedCancelled) {
        if (session) {
          await this.excelService.saveCheckpoint(session).catch(() => undefined)
        }
        reportProgress({
          stage: 'cancelled',
          message: `ME12 batch cancelled after ${processed} record(s). Partial Excel results were saved.`,
          current: processed,
          total: session?.tasks.length
        })
        return {
          success: false,
          errorCode: 'CANCELLED',
          message: 'ME12 batch was cancelled. Completed rows were checkpointed.',
          processed, succeeded, skipped, failed, resultPath: session?.savePath, backupPath: session?.backupPath
        }
      }
      if (session) {
        await this.excelService.saveCheckpoint(session).catch(() => undefined)
      }
      const message = errorMessage(error)
      reportProgress({ stage: 'failed', message })
      return {
        success: false,
        errorCode: 'BATCH_FAILED',
        message,
        processed, succeeded, skipped, failed, resultPath: session?.savePath, backupPath: session?.backupPath
      }
    } finally {
      await Promise.all(
        [...this.contexts].map((context) => context.close().catch(() => undefined))
      )
      this.contexts.clear()
      if (session) await this.excelService.finishRun(session).catch(() => undefined)
      this.artifactDirectory = ''
      for (const slot of browserSlots) {
        this.slotManager.release(slot)
      }
      this.running = false
      this.cancelRequested = false
    }
  }

  private async runTaskWithRetries(
    page: Page,
    task: Me12ExcelTask,
    config: Me12BatchConfig,
    reuseReadyPage: boolean,
    worker: number
  ): Promise<TaskOutcome> {
    const results: Array<{ category: Me12InfoCategory; outcome: TaskOutcome }> = []
    const categories = me12Categories(config.infoCategory)
    // Process both views of the same IR in one worker, never concurrently.
    for (const category of categories) {
      if (results.length && (this.cancelRequested || results.some(({ outcome }) => outcome.kind === 'failed'))) break
      const outcome = await this.runCategoryWithRetries(page, task, config, category, reuseReadyPage, worker)
      results.push({ category, outcome })
      reuseReadyPage = false
    }
    const label = (category: Me12InfoCategory): string => category === 'standard' ? 'Standard' : 'Consignment'
    const status = categories.map(category => {
      const outcome = results.find(result => result.category === category)?.outcome
      return `${label(category)}: ${outcome?.status ?? 'Not attempted'}`
    }).join(' | ')
    return {
      kind: results.some(({ outcome }) => outcome.kind === 'failed') ? 'failed'
        : results.some(({ outcome }) => outcome.kind === 'success') ? 'success' : 'skipped',
      oldValue: results.filter(({ outcome }) => outcome.oldValue !== '').map(({ category, outcome }) => `${label(category)}: ${outcome.oldValue}`).join(' | '),
      status
    }
  }

  private async runCategoryWithRetries(
    page: Page, task: Me12ExcelTask, config: Me12BatchConfig, category: Me12InfoCategory,
    reuseReadyPage: boolean, worker: number
  ): Promise<TaskOutcome> {
    let lastError = ''
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      this.assertNotCancelled()
      try {
        return await updateOneInfoRecord(page, task, config, category, reuseReadyPage && attempt === 0, () => this.assertNotCancelled())
      } catch (error) {
        if (error instanceof SapRecordLockedError || error instanceof SapRecordNotMaintainedError) {
          return { kind: 'skipped', oldValue: '', status: `Skipped: ${error.message}` }
        }
        if (error instanceof BatchCancelledError) {
          throw error
        }
        lastError = errorMessage(error)
        const screenshotPath = join(
          this.artifactDirectory || this.screenshotDirectory,
          `ME12_${safeFilename(task.infoRecord)}_${category}_${timestampForFile()}_attempt-${attempt + 1}.png`
        )
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined)
        await this.logger.error({
          category: 'automation',
          event: 'me12.record.attempt-failed',
          message: `${task.infoRecord} (${category}) attempt ${attempt + 1} failed: ${lastError}`,
          errorCode: 'ME12_RECORD_FAILED',
          tcode: 'ME12',
          details: {
            excelRows: task.excelRows.join(', '),
            infoRecord: task.infoRecord,
            worker,
            attempt: attempt + 1,
            screenshotPath
          }
        })
        if (error instanceof SapSaveBoundaryError) {
          return { kind: 'failed', oldValue: '', status: lastError }
        }
        if (attempt < config.maxRetries) {
          await delay(800)
        }
      }
    }
    return {
      kind: 'failed',
      oldValue: '',
      status: `Failed after ${config.maxRetries + 1} attempt(s): ${lastError}`
    }
  }

  private assertNotCancelled(): void {
    if (this.cancelRequested) {
      throw new BatchCancelledError('ME12 batch cancelled.')
    }
  }
}

async function updateOneInfoRecord(
  page: Page,
  task: Me12ExcelTask,
  config: Me12BatchConfig,
  category: Me12InfoCategory,
  reuseReadyPage: boolean,
  stopped: () => void
): Promise<TaskOutcome> {
  const { infoRecord } = task
  const settingsUrl = await getCurrentMe12Url(page)
  const origin = new URL(settingsUrl).origin
  const detail = await openInfoRecordDetail(page, settingsUrl, infoRecord, config, category, reuseReadyPage, stopped)
  const controls = [
    { label: 'SLT', names: SLT_NAMES, target: task.targetLeadTime, normalize: normalizeDays },
    { label: 'PDT', names: PDT_NAMES, target: task.plannedDeliveryTime, normalize: normalizeDays },
    { label: 'Confirmation control', names: CONFIRMATION_NAMES, target: task.confirmationControl, normalize: (value: string) => value.toUpperCase() }
  ].map(control => ({ ...control, locator: exactUpdateTextbox(detail, control.names) }))
  const fields: Array<(typeof controls)[number] & { before: string; changed: boolean }> = []
  const untouched: Array<(typeof controls)[number] & { before: string }> = []
  for (const control of controls) {
    const { label, locator, target, normalize } = control
    const count = await locator.count()
    if (target === '') {
      if (count === 1) untouched.push({ ...control, before: (await locator.inputValue({ timeout: 1_000 })).trim() })
      continue
    }
    if (count !== 1) throw new Error(`${label} field is missing or ambiguous on Purch. Org. Data 1. No save was sent.`)
    for (const other of controls) {
      if (other !== control && await locator.and(other.locator).count()) {
        throw new Error(`${label} and ${other.label} point to the same SAP control. No save was sent.`)
      }
    }
    const before = (await locator.inputValue({ timeout: 1_000 })).trim()
    const changed = normalize(before) !== target
    if (changed && !await locator.isEditable({ timeout: 500 })) throw new Error(`${label} is read-only. No save was sent.`)
    fields.push({ ...control, before, changed })
  }
  const changes = fields.filter(field => field.changed)
  const oldValue = fields.find(field => field.label === 'SLT')?.before ?? ''
  const summary = fields.map(field => `${field.label}: ${field.before || '(blank)'} → ${field.target}`).join('; ')
  if (!changes.length || config.dryRun) {
    return { kind: 'skipped', oldValue, status: changes.length ? `DRY RUN: ${summary}; not saved` : `No change. ${summary}` }
  }
  stopped()
  for (const field of changes) await fillSapInput(field.locator, field.target)
  for (const field of fields) {
    if (field.normalize((await field.locator.inputValue({ timeout: 1_000 })).trim()) !== field.target) {
      throw new Error(`${field.label} failed SAP readback. No save was sent.`)
    }
  }
  for (const field of untouched) {
    if (field.normalize((await field.locator.inputValue({ timeout: 1_000 })).trim()) !== field.normalize(field.before)) {
      throw new Error(`SAP changed unrequested ${field.label}. No save was sent.`)
    }
  }
  await verifyPurchasingScope(detail, config)
  await verifyDetailCategory(detail, category)
  if (new URL(page.url()).origin !== origin) throw new Error('ME12 left the SAP origin before Save.')
  await saveRecord(page, detail, infoRecord, origin, async () => {
    // A numberless SAP notice is a hint, not proof. Reopen a fresh ME12
    // transaction and compare saved values, not the inputs we just filled.
    // Stop takes effect at the record boundary, after this read-only check.
    const reopened = await openInfoRecordDetail(page, settingsUrl, infoRecord, config, category, false, () => {}, true)
      .catch(error => {
        throw new Error(`Post-save readback could not reopen the record: ${errorMessage(error).replace(/ No save was sent\./g, '')}`)
      })
    const record = exactUpdateTextbox(reopened, INFO_RECORD_NAMES)
    if (await record.count() !== 1 || !sameInfoRecord(await inputValue(record), infoRecord)) {
      throw new Error('The reopened SAP detail did not confirm the same Info Record.')
    }
    const expected = [...fields.map(field => ({ ...field, value: field.target })),
      ...untouched.map(field => ({ ...field, value: field.normalize(field.before) }))]
    for (const field of expected) {
      const control = exactUpdateTextbox(reopened, field.names)
      if (await control.count() !== 1 || field.normalize(await inputValue(control)) !== field.value) {
        throw new Error(`Reopened SAP ${field.label} does not match the expected saved value.`)
      }
    }
  })
  return {
    kind: 'success',
    oldValue,
    status: `Saved. ${summary}`
  }
}

function sameInfoRecord(actual: string, expected: string): boolean {
  return /^\d{1,10}$/.test(actual) && Number(actual) === Number(expected)
}

async function openInfoRecordDetail(
  page: Page,
  settingsUrl: string,
  infoRecord: string,
  config: Me12BatchConfig,
  category: Me12InfoCategory,
  reuseReadyPage: boolean,
  stopped: () => void,
  freshReadback = false
): Promise<Frame> {
  const origin = new URL(settingsUrl).origin
  if (freshReadback) {
    // Hash-only navigation can keep the edited DOM. Force a new document
    // before entering the record again in that case.
    const response = await page.goto(settingsUrl, { waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS })
    if (!response) await page.reload({ waitUntil: 'commit', timeout: NAVIGATION_TIMEOUT_MS })
  } else if (!reuseReadyPage || new URL(page.url()).origin !== origin) {
    await gotoTcode(page, settingsUrl)
  }
  const found = await findTextboxAcrossFrames(page, INFO_RECORD_NAMES, reuseReadyPage ? 1_200 : 25_000,
    freshReadback ? origin : undefined)
  if (!found || new URL(page.url()).origin !== origin || !await found.locator.isEditable({ timeout: 500 }) ||
      (freshReadback && await exactUpdateTextbox(found.frame, IR_DETAIL_NAMES).count())) {
    throw new Error('An editable ME12 Info Record selection input was not found on the SAP origin.')
  }
  if (freshReadback && await hasSapModal(sapFrames(page, origin))) {
    throw new Error('A SAP dialog blocked the readback. No option was selected.')
  }

  stopped()
  const { frame, locator: infoRecordBox } = found
  await clearEditableInput(frame, ['Supplier', 'Vendor'])
  await clearEditableInput(frame, ['Material'])
  await fillEditableInput(frame, ['Plant'], config.targetPlant)
  await fillEditableInput(frame, ORG_NAMES, config.purchasingOrganization)
  await fillSapInput(infoRecordBox, infoRecord, false)
  await selectInfoCategory(page, frame, category, freshReadback ? origin : undefined)
  await verifyPurchasingScope(frame, config)
  if (!sameInfoRecord(await inputValue(infoRecordBox), infoRecord)) {
    throw new Error('ME12 did not retain the intended Info Record number.')
  }
  stopped()
  await infoRecordBox.press('Enter')
  const detail = await waitForPurchasingData(page, origin, stopped, freshReadback)
  await verifyPurchasingScope(detail, config)
  await verifyDetailCategory(detail, category)
  return detail
}

async function gotoTcode(page: Page, settingsUrl: string): Promise<void> {
  try {
    await page.goto(settingsUrl, {
      waitUntil: 'commit',
      timeout: NAVIGATION_TIMEOUT_MS
    })
  } catch (error) {
    if (!/timeout/i.test(errorMessage(error))) {
      throw error
    }
    // The transaction may still load after a timeout. Inspect it instead of replaying navigation.
  }
}

async function getCurrentMe12Url(page: Page): Promise<string> {
  const configuredUrl = (page as Page & { __me12Url?: string }).__me12Url
  if (!configuredUrl) {
    throw new Error('The configured ME12 URL is unavailable.')
  }
  return configuredUrl
}

type Me12Page = Page & { __me12Url?: string }

export function setMe12PageUrl(page: Page, url: string): void {
  ;(page as Me12Page).__me12Url = url
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count().catch(() => 0)
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index)
    if (await candidate.isVisible().catch(() => false)) {
      return candidate
    }
  }
  return null
}

async function findTextboxInFrame(frame: Frame, names: string[]): Promise<Locator | null> {
  for (const name of names) {
    const pattern = new RegExp(escapeRegExp(name), 'i')
    const roleMatch = await firstVisible(frame.getByRole('textbox', { name: pattern }))
    if (roleMatch) {
      return roleMatch
    }
    for (const selector of [
      `input[title*="${cssAttributeValue(name)}" i]`,
      `textarea[title*="${cssAttributeValue(name)}" i]`,
      `input[aria-label*="${cssAttributeValue(name)}" i]`,
      `textarea[aria-label*="${cssAttributeValue(name)}" i]`
    ]) {
      const match = await firstVisible(frame.locator(selector))
      if (match) {
        return match
      }
    }
    const label = await firstVisible(frame.getByText(pattern))
    if (label) {
      const followingInput = await firstVisible(label.locator('xpath=following::input[1]'))
      if (followingInput) {
        return followingInput
      }
    }
  }
  return null
}

/** SAP detail values are writable only through explicitly labelled controls. */
async function findExactTextbox(frame: Frame, names: string[]): Promise<Locator | null> {
  for (const name of names) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(name)}\\s*:?\\s*$`, 'i')
    const labelled = await firstVisible(frame.getByRole('textbox', { name: pattern })) ??
      await firstVisible(frame.getByLabel(pattern))
    if (labelled) return labelled
    for (const attribute of ['title', 'aria-label']) {
      const selector = [name, `${name}:`].map(value => `input[${attribute}="${cssAttributeValue(value)}" i]`).join(',')
      const control = await firstVisible(frame.locator(selector))
      if (control) return control
    }
  }
  return null
}

/** Never pick the first match for a writable field. A misleading or duplicate
 * label must fail closed, including overlap with an unrequested field. */
function exactUpdateTextbox(frame: Frame, names: string[]): Locator {
  const pattern = new RegExp(`^\\s*(?:${names.map(escapeRegExp).join('|')})\\s*:?\\s*$`, 'i')
  const selectors = names.flatMap(name => ['title', 'aria-label'].flatMap(attribute =>
    [name, `${name}:`].map(value => `input[${attribute}="${cssAttributeValue(value)}" i]`)
  ))
  return frame.getByRole('textbox', { name: pattern })
    .or(frame.getByLabel(pattern))
    .or(frame.locator(selectors.join(',')))
    .and(frame.locator('input:visible, textarea:visible'))
}

async function verifyPurchasingScope(frame: Frame, config: Me12BatchConfig): Promise<void> {
  for (const [names, target] of [[['Plant'], config.targetPlant], [ORG_NAMES, config.purchasingOrganization]] as const) {
    const control = await findExactTextbox(frame, [...names])
    if (!control || (await inputValue(control)).toUpperCase() !== target.toUpperCase()) {
      throw new Error(`SAP ${names[0]} could not be verified as ${target}. No save was sent.`)
    }
  }
}

async function verifyDetailCategory(frame: Frame, category: Me12InfoCategory): Promise<void> {
  const visible = async (label: string): Promise<boolean> =>
    Boolean(await firstVisible(frame.getByText(new RegExp(`^\\s*${label}\\s*$`, 'i'))) ??
      await firstVisible(frame.locator(`input[value="${label}" i]`)))
  const expected = category === 'standard' ? 'Standard' : 'Consignment'
  const other = category === 'standard' ? 'Consignment' : 'Standard'
  if (!await visible(expected) || await visible(other)) {
    throw new Error(`SAP detail does not confirm the ${expected} purchasing type. No save was sent.`)
  }
}

async function waitForPurchasingData(page: Page, origin: string, stopped: () => void, sameOriginOnly = false): Promise<Frame> {
  const deadline = Date.now() + 25_000
  let tabOpened = false
  while (Date.now() < deadline) {
    stopped()
    if (new URL(page.url()).origin !== origin) throw new Error('ME12 left the SAP origin.')
    if (sameOriginOnly && await hasSapModal(sapFrames(page, origin))) {
      throw new Error('A SAP dialog blocked the readback. No option was selected.')
    }
    for (const frame of page.frames()) {
      if (sameOriginOnly && new URL(frame.url()).origin !== origin) continue
      // If SAP opens this view directly, don't click the tab again.
      if (await findExactTextbox(frame, IR_DETAIL_NAMES)) return frame
    }
    const message = await readStatusMessage(page)
    if (/material\s+differs\s+from\s+material/i.test(message)) throw new Error(message)
    if (/info\s+record\s+\d+\s+already\s+being\s+processed/i.test(message)) throw new SapRecordLockedError(message)
    if (/\b(?:purchasing (?:organization )?data|(?:purchasing )?info record \d+)\s+(?:does not exist|(?:is )?not maintained)\b/i.test(message)) {
      throw new SapRecordNotMaintainedError(message)
    }
    if (!tabOpened) {
      const tab = await findPurchasingTab(page, sameOriginOnly ? origin : undefined)
      if (tab) {
        tabOpened = true
        await tab.click({ timeout: 2_000 })
      }
    }
    await delay(200)
  }
  const message = await readStatusMessage(page)
  throw new Error(`Purch. Org. Data 1 was not verified. No save was sent.${message ? ` SAP: ${message}` : ''}`)
}

async function findTextboxAcrossFrames(
  page: Page,
  names: string[],
  timeoutMs: number,
  origin?: string
): Promise<{ frame: Frame; locator: Locator } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (origin && new URL(frame.url()).origin !== origin) continue
      const locator = origin ? exactUpdateTextbox(frame, names) : await findTextboxInFrame(frame, names).catch(() => null)
      if (origin && await locator?.count() !== 1) continue
      if (locator) {
        return { frame, locator }
      }
    }
    await delay(400)
  }
  return null
}

async function fillEditableInput(frame: Frame, names: string[], value: string): Promise<void> {
  const locator = await findExactTextbox(frame, names)
  if (locator && (await inputValue(locator)).toUpperCase() !== value.toUpperCase() &&
      await locator.isEditable({ timeout: 500 }).catch(() => false)) {
    await fillSapInput(locator, value)
  }
}

async function selectInfoCategory(
  page: Page,
  preferredFrame: Frame,
  category: Me12InfoCategory,
  origin?: string
): Promise<void> {
  const label = category === 'consignment' ? 'Consignment' : 'Standard'
  const pattern = new RegExp(`^${label}$`, 'i')
  const frames = [preferredFrame, ...page.frames().filter(frame =>
    frame !== preferredFrame && (!origin || new URL(frame.url()).origin === origin))]

  for (const frame of frames) {
    const radio = await firstVisible(frame.getByRole('radio', { name: pattern }))
    if (radio) {
      const selected = await radio.isChecked().catch(async () =>
        (await radio.getAttribute('aria-checked')) === 'true'
      )
      if (!selected) {
        await radio.check().catch(async () => radio.click())
      }
      const verified = await radio.isChecked().catch(async () =>
        (await radio.getAttribute('aria-checked')) === 'true'
      )
      if (verified) return
    }

    const labelText = await firstVisible(frame.getByText(pattern, { exact: true }))
    if (labelText && (await labelText.click().then(() => true).catch(() => false))) {
      const selectedRadio = await firstVisible(frame.getByRole('radio', { name: pattern }))
      const verified = selectedRadio && await selectedRadio.isChecked().catch(async () =>
        (await selectedRadio.getAttribute('aria-checked')) === 'true'
      )
      if (verified) return
    }
  }

  throw new Error(`Info Category "${label}" could not be selected; this record was not changed.`)
}

async function clearEditableInput(frame: Frame, names: string[]): Promise<void> {
  const locator = await findTextboxInFrame(frame, names)
  if (!locator || !(await locator.isEditable().catch(() => false))) {
    return
  }
  if (!(await inputValue(locator))) return
  await locator.click()
  await locator.fill('').catch(async () => {
    await locator.press('Control+A')
    await locator.press('Backspace')
  })
  await locator.dispatchEvent('input')
  await locator.dispatchEvent('change')
  if (await inputValue(locator)) {
    await locator.press('Control+A')
    await locator.press('Delete')
    await locator.dispatchEvent('input')
    await locator.dispatchEvent('change')
  }
  await locator.press('Tab')
}

async function fillSapInput(locator: Locator, value: string, pressTab = true): Promise<void> {
  await locator.fill(value, { timeout: 2_000 }).catch(async () => {
    await locator.click({ timeout: 2_000 })
    await locator.press('Control+A')
    await locator.pressSequentially(value, { delay: 30 })
  })
  await locator.dispatchEvent('input')
  await locator.dispatchEvent('change')
  if (pressTab) {
    await locator.press('Tab')
  }
}

async function inputValue(locator: Locator): Promise<string> {
  return (await locator.inputValue().catch(async () => (await locator.getAttribute('value')) ?? '')).trim()
}

async function findPurchasingTab(page: Page, origin?: string): Promise<Locator | null> {
  for (const frame of page.frames()) {
    if (origin && new URL(frame.url()).origin !== origin) continue
    for (const pattern of [/^Purch\.?\s*Org\.?\s*Data\s*1$/i, /^Purchasing\s*Org.*Data\s*1$/i]) {
      const candidates = [
        frame.getByRole('tab', { name: pattern }),
        frame.getByRole('button', { name: pattern }),
        frame.getByText(pattern)
      ]
      for (const candidate of candidates) {
        const locator = await firstVisible(candidate)
        if (locator) return locator
      }
    }
  }
  return null
}

const SAVE_NAME = /^\s*Save(?:\s*\(\s*(?:(?:Ctrl|Control)\s*\+\s*S|F11)\s*\))?\s*$/i
const CLICKABLE_SAVE_CONTROL = 'button, input[type=button], input[type=submit], a[href], [role=button], [role=link], [onclick], [onmousedown], [onmouseup]'
const SAP_MODAL = '[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]'
const SAP_STATUS = [
  '[role=status]', '[role=alert]', '[aria-live=polite]', '[aria-live=assertive]',
  '.urMsgBar', '[class*="messagebar" i]', '[class*="messagearea" i]', '[class*="statusbar" i]',
  '[class*="toast" i]', '[id*="msg" i]', '[id*="statusbar" i]', '[id*="toast" i]'
].join(', ')
const SAVE_CONFIRMATION = /^(?:purchasing\s+info(?:rmation)?\s+record|purchase\s+info(?:r(?:mation)?)?(?:\s+record)?|info\s+record)(?:\s+(\d{1,10}))?\s+(?:has been\s+)?(?:changed|saved|updated)[.!]?$/i

function sapFrames(page: Page, origin: string): Frame[] {
  return page.frames().filter(frame => new URL(frame.url()).origin === origin)
}

async function hasSapModal(frames: Frame[]): Promise<boolean> {
  return (await Promise.all(frames.map(frame => frame.locator(SAP_MODAL).and(frame.locator(':visible')).count()))).some(Boolean)
}

async function findSaveControl(page: Page, detail: Frame): Promise<ElementHandle> {
  const origins = new Set([new URL(page.url()).origin, new URL(detail.url()).origin])
  const frames = [detail, ...page.frames().filter(frame => frame !== detail && origins.has(new URL(frame.url()).origin))]
  const matches: ElementHandle[] = []
  for (const frame of frames) {
    if (await frame.locator(SAP_MODAL).and(frame.locator(':visible')).count()) {
      throw new Error('A SAP dialog is open. Handle it before saving.')
    }
    const clickable = frame.locator(CLICKABLE_SAVE_CONTROL)
    const candidates = await frame.getByRole('button', { name: SAVE_NAME })
      .or(frame.getByRole('link', { name: SAVE_NAME }))
      .or(frame.getByTitle(SAVE_NAME).and(clickable))
      .or(frame.getByLabel(SAVE_NAME).and(clickable))
      .or(frame.getByText(SAVE_NAME))
      .and(frame.locator(':visible')).elementHandles()
    const distinct: ElementHandle[] = []
    for (const control of candidates) {
      const verified = await control.evaluate((element, { clickableSelector, modalSelector }) => {
        if (!(element instanceof Element) || !element.isConnected || element.closest(modalSelector)) return false
        if (element.matches(clickableSelector)) return true
        // The WebGUI footer can expose only a text span, with no button role.
        // Require its exact Save text and the adjacent Cancel in a compact
        // bottom action row. Never click an isolated "Save" text match.
        const rect = element.getBoundingClientRect()
        if (rect.bottom < window.innerHeight - 120 || rect.top < 0 ||
            rect.bottom > window.innerHeight + 2 || rect.width > 240 || rect.height > 70) return false
        for (let parent = element.parentElement, depth = 0; parent && depth < 5; parent = parent.parentElement, depth++) {
          if (parent.getBoundingClientRect().height > 96) break
          for (const sibling of parent.querySelectorAll<HTMLElement>('*')) {
            if ((sibling.innerText ?? '').trim().toLowerCase() !== 'cancel' ||
                sibling.contains(element) || getComputedStyle(sibling).visibility !== 'visible') continue
            const cancel = sibling.getBoundingClientRect()
            if (cancel.width > 0 && cancel.height > 0 && cancel.left >= rect.right - 2 &&
                cancel.left - rect.right <= 180 &&
                Math.abs(cancel.top + cancel.height / 2 - rect.top - rect.height / 2) <= 18) return true
          }
        }
        return false
      }, { clickableSelector: CLICKABLE_SAVE_CONTROL, modalSelector: SAP_MODAL })
      if (!verified) continue
      // Playwright returns these in document order. A label inside a matched
      // button is the same control, not a second Save.
      let nested = false
      for (const earlier of distinct) {
        if (await control.evaluate((element, outer) => outer.contains(element), earlier)) {
          nested = true
          break
        }
      }
      if (!nested) distinct.push(control)
    }
    matches.push(...distinct)
  }
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'Multiple visible SAP Save controls matched.' : 'The SAP Save button could not be verified.')
  }
  const [button] = matches
  if (!await button.isEnabled() || !await button.isVisible()) throw new Error('The SAP Save control is disabled or hidden.')
  return button
}

async function watchSaveStatus(frame: Frame) {
  return await frame.evaluateHandle(selector => {
    const collect = (): Set<string> => {
      const lines = new Set<string>()
      for (const item of document.querySelectorAll<HTMLElement>(selector)) {
        if (!item.getClientRects().length || getComputedStyle(item).visibility !== 'visible') continue
        const line = (item.innerText ?? '').replace(/\s+/g, ' ').trim()
        if (line && line.length <= 300) lines.add(line)
      }
      return lines
    }
    const baseline = collect()
    const fresh = new Set<string>()
    const scan = (): void => {
      for (const line of collect()) {
        if (!baseline.has(line) && fresh.size < 64) fresh.add(line)
      }
    }
    // WebGUI can clear the message before Playwright's click promise resolves.
    const observer = new MutationObserver(scan)
    observer.observe(document, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'role', 'aria-live', 'id']
    })
    return { baseline: [...baseline], read: () => { scan(); return [...fresh] }, disconnect: () => observer.disconnect() }
  }, SAP_STATUS)
}

async function saveRecord(
  page: Page, frame: Frame, infoRecord: string, origin: string, verifyPersisted: () => Promise<void>
): Promise<void> {
  const watches = new Map<Frame, Awaited<ReturnType<typeof watchSaveStatus>>>()
  let dispatched = false
  try {
    const button = await findSaveControl(page, frame)
    const previous = new Set((await Promise.all(sapFrames(page, origin).map(async candidate => {
      try {
        const watch = await watchSaveStatus(candidate)
        watches.set(candidate, watch)
        return await watch.evaluate(state => state.baseline)
      } catch {
        return await readStatusLines(candidate)
      }
    }))).flat())
    // A click error does not prove SAP never received the action.
    dispatched = true
    await button.click({ timeout: 2_000 })
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (new URL(page.url()).origin !== origin) throw new Error('ME12 left the SAP origin after Save.')
      const frames = sapFrames(page, origin)
      if (await hasSapModal(frames)) {
        throw new Error('A SAP dialog opened after Save. No option was selected.')
      }
      const lines = (await Promise.all(frames.map(async candidate => {
        const captured = await watches.get(candidate)?.evaluate(state => state.read()).catch(() => null)
        return captured ?? await readStatusLines(candidate)
      }))).flat().filter(line => !previous.has(line))
      const failure = lines.find(line => /\b(?:error|not saved|save rejected)\b/i.test(line))
      if (failure) throw new Error(failure)
      const confirmations = lines.map(line => SAVE_CONFIRMATION.exec(line)).filter(match => match !== null)
      if (confirmations.some(match => match[1] && !sameInfoRecord(match[1], infoRecord))) {
        throw new Error('SAP confirmed a different Info Record after Save.')
      }
      if (confirmations.some(match => match[1])) return
      if (confirmations.length) {
        await verifyPersisted()
        return
      }
      await delay(250)
    }
    throw new Error('SAP did not return a fresh save confirmation for this Info Record.')
  } catch (error) {
    throw new SapSaveBoundaryError(dispatched
      ? `Save outcome unverified. Check SAP before retrying. ${errorMessage(error)}`
      : `${errorMessage(error)} No save was sent.`)
  } finally {
    await Promise.all([...watches.values()].map(async watch => {
      await watch.evaluate(state => state.disconnect()).catch(() => {})
      await watch.dispose().catch(() => {})
    }))
  }
}

async function readStatusLines(frame: Frame): Promise<string[]> {
  return await frame.locator(SAP_STATUS).and(frame.locator(':visible')).evaluateAll(items =>
    [...new Set(items.map(item => (item as HTMLElement).innerText?.replace(/\s+/g, ' ').trim()).filter(Boolean))]
      .filter(line => line.length <= 300)
  ).catch(() => [])
}

async function readStatusMessage(page: Page): Promise<string> {
  return [...new Set((await Promise.all(page.frames().map(readStatusLines))).flat())].slice(-3).join(' | ')
}

function safeFilename(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]+/g, '_')
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/\D/g, '').slice(0, 14)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
