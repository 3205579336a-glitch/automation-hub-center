import { join } from 'node:path'
import { chromium, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core'
import type {
  Me12BatchConfig,
  Me12BatchProgress,
  Me12BatchResult
} from '../../shared/me12-types'
import { resolveSapUrl } from '../../shared/settings-types'
import type { DiagnosticLogger } from '../services/diagnostic-logger'
import {
  Me12ExcelService,
  type Me12ExcelTask,
  type Me12WorkbookSession
} from '../services/me12-excel-service'
import type { SettingsService } from '../services/settings-service'
import type { BrowserSlotManager } from './browser-slot-manager'

const LOGIN_TIMEOUT_MS = 180_000
const NAVIGATION_TIMEOUT_MS = 30_000

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

export class Me12BatchRunner {
  private running = false
  private cancelRequested = false
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
    for (const context of this.contexts) {
      void context.close().catch(() => undefined)
    }
    return true
  }

  async run(
    config: Me12BatchConfig,
    reportProgress: (progress: Me12BatchProgress) => void
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
      session = await this.excelService.prepareRun(config)
      const workbookSession = session

      const browserName = settings.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'
      reportProgress({
        stage: 'starting-browser',
        message: `Starting ${browserSlots.length} ${browserName} ME12 worker window(s)…`
      })
      const launchResults = await Promise.allSettled(
        browserSlots.map(async (slot, index): Promise<BrowserWorker> => {
          const worker = index + 1
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
              downloadsPath: settings.defaultDownloadFolder || undefined
            }
          )
          this.contexts.add(context)
          const page = context.pages()[0] ?? (await context.newPage())
          setMe12PageUrl(page, resolvedUrl.url.toString())
          page.on('dialog', (dialog) => void dialog.accept().catch(() => undefined))
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
        message: `User confirmation required: select the Windows certificate in all ${browserCount} browser window(s).`
      })
      let nextTaskIndex = 0
      let nextCheckpoint = config.saveEvery
      let saveQueue: Promise<string> = Promise.resolve(workbookSession.savePath)
      const saveCheckpoint = (): Promise<string> => {
        saveQueue = saveQueue.then(() => this.excelService.saveCheckpoint(workbookSession))
        return saveQueue
      }

      const runWorker = async (browserWorker: BrowserWorker): Promise<void> => {
        let firstRecord = true
        while (true) {
          this.assertNotCancelled()
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
            firstRecord,
            browserWorker.worker
          )
          firstRecord = false
          processed += 1
          if (taskResult.kind === 'success') {
            succeeded += 1
          } else if (taskResult.kind === 'skipped') {
            skipped += 1
          } else {
            failed += 1
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
      if (error instanceof BatchCancelledError) {
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
          message: 'ME12 batch was cancelled. Completed rows were checkpointed.'
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
        message
      }
    } finally {
      await Promise.all(
        [...this.contexts].map((context) => context.close().catch(() => undefined))
      )
      this.contexts.clear()
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
    firstRecord: boolean,
    worker: number
  ): Promise<TaskOutcome> {
    let lastError = ''
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      this.assertNotCancelled()
      try {
        return await updateOneInfoRecord(page, task.infoRecord, config, firstRecord && attempt === 0)
      } catch (error) {
        if (error instanceof SapRecordLockedError) {
          await leaveCurrentRecord(page)
          return { kind: 'skipped', oldValue: '', status: `Skipped: ${error.message}` }
        }
        if (error instanceof BatchCancelledError) {
          throw error
        }
        lastError = errorMessage(error)
        const screenshotPath = join(
          this.screenshotDirectory,
          `ME12_${safeFilename(task.infoRecord)}_${timestampForFile()}_attempt-${attempt + 1}.png`
        )
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined)
        await this.logger.error({
          category: 'automation',
          event: 'me12.record.attempt-failed',
          message: `${task.infoRecord} attempt ${attempt + 1} failed: ${lastError}`,
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
  infoRecord: string,
  config: Me12BatchConfig,
  firstRecord: boolean
): Promise<TaskOutcome> {
  await gotoTcode(page, infoRecord, firstRecord)
  const found = await findTextboxAcrossFrames(
    page,
    ['Info Record', 'Purchasing Info Record'],
    firstRecord ? LOGIN_TIMEOUT_MS : 25_000
  )
  if (!found) {
    throw new Error(
      firstRecord
        ? 'ME12 did not become ready within 3 minutes. Complete certificate selection and SAP sign-in, then retry.'
        : 'Info Record input was not found after opening ME12.'
    )
  }

  const { frame, locator: infoRecordBox } = found
  await clearEditableInput(frame, ['Supplier', 'Vendor'])
  await clearEditableInput(frame, ['Material'])
  await fillEditableInput(frame, ['Plant'], config.targetPlant)
  if (config.purchasingOrganization) {
    await fillEditableInput(
      frame,
      ['Purchasing Org.', 'Purchasing Organization', 'Purch. Org.'],
      config.purchasingOrganization
    )
  }

  await selectInfoCategory(page, frame, config.infoCategory)

  await fillSapInput(infoRecordBox, infoRecord, false)
  await infoRecordBox.press('Enter')
  await delay(800)
  await dismissSapPopups(page)

  const mismatch = await findVisiblePageMessage(
    page,
    /Material\s+differs\s+from\s+material.*from\s+the\s+info\s+record/i,
    1_200
  )
  if (mismatch) {
    throw new Error(`${mismatch} (SAP did not accept clearing the remembered Material.)`)
  }

  const escapedRecord = escapeRegExp(infoRecord)
  const lockMessage = await findVisiblePageMessage(
    page,
    new RegExp(`Info\\s+record\\s+${escapedRecord}\\s+already\\s+being\\s+processed`, 'i'),
    2_500
  )
  if (lockMessage) {
    throw new SapRecordLockedError(
      `${lockMessage} (close other ME12/SAP sessions or ask an administrator to check SM12 locks)`
    )
  }

  const tabClicked = await clickFirstVisibleText(
    page,
    [/Purch\.?\s*Org\.?\s*Data\s*1/i, /Purchasing\s*Org.*Data\s*1/i],
    25_000
  )
  if (!tabClicked) {
    const status = await readStatusMessage(page)
    throw new Error(
      `Purch. Org. Data 1 tab was not found${status ? `; SAP status: ${status}` : ''}`
    )
  }

  await delay(700)
  const leadTime = await findTextboxAcrossFrames(
    page,
    ['Supplier Lead Time', 'Supp. Lead Time'],
    25_000
  )
  if (!leadTime) {
    throw new Error('Supplier Lead Time field was not found on Purch. Org. Data 1.')
  }

  const plantBox = await findTextboxInFrame(leadTime.frame, ['Plant'])
  if (plantBox) {
    const actualPlant = (await inputValue(plantBox)).toUpperCase()
    if (actualPlant && actualPlant !== config.targetPlant.toUpperCase()) {
      throw new Error(
        `SAP currently shows Plant ${actualPlant}, not ${config.targetPlant}; update refused.`
      )
    }
  }

  const oldValue = await inputValue(leadTime.locator)
  if (oldValue === config.targetLeadTime) {
    await leaveCurrentRecord(page)
    return {
      kind: 'skipped',
      oldValue,
      status: `No change: Supplier Lead Time is already ${config.targetLeadTime}`
    }
  }

  if (config.dryRun) {
    await leaveCurrentRecord(page)
    return {
      kind: 'skipped',
      oldValue,
      status: `DRY RUN: current=${oldValue || '<blank>'}, target=${config.targetLeadTime}; not saved`
    }
  }

  await fillSapInput(leadTime.locator, config.targetLeadTime)
  const newValue = await inputValue(leadTime.locator)
  if (newValue !== config.targetLeadTime) {
    throw new Error(
      `Supplier Lead Time readback failed: expected ${config.targetLeadTime}, actual ${newValue || '<blank>'}.`
    )
  }

  await saveRecord(page, leadTime.frame)
  await delay(1_200)
  const sapMessage = await readStatusMessage(page)
  return {
    kind: 'success',
    oldValue,
    status: `Success: Supplier Lead Time ${oldValue || '<blank>'} -> ${config.targetLeadTime}${sapMessage ? `; SAP: ${sapMessage}` : ''}`
  }
}

async function gotoTcode(page: Page, _infoRecord: string, firstRecord: boolean): Promise<void> {
  const settingsUrl = await getCurrentMe12Url(page)
  try {
    await page.goto(settingsUrl, {
      waitUntil: 'domcontentloaded',
      timeout: firstRecord ? LOGIN_TIMEOUT_MS : NAVIGATION_TIMEOUT_MS
    })
  } catch (error) {
    if (!/timeout/i.test(errorMessage(error))) {
      throw error
    }
    if (firstRecord) {
      throw new Error('SAP sign-in was not completed within 3 minutes.')
    }
    await page.reload({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'commit' }).catch(() => undefined)
    await page.goto(settingsUrl, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'commit' })
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

async function findTextboxAcrossFrames(
  page: Page,
  names: string[],
  timeoutMs: number
): Promise<{ frame: Frame; locator: Locator } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const locator = await findTextboxInFrame(frame, names).catch(() => null)
      if (locator) {
        return { frame, locator }
      }
    }
    await delay(400)
  }
  return null
}

async function fillEditableInput(frame: Frame, names: string[], value: string): Promise<void> {
  const locator = await findTextboxInFrame(frame, names)
  if (locator && (await locator.isEditable().catch(() => false))) {
    await fillSapInput(locator, value)
  }
}

async function selectInfoCategory(
  page: Page,
  preferredFrame: Frame,
  category: Me12BatchConfig['infoCategory']
): Promise<void> {
  const label = category === 'consignment' ? 'Consignment' : 'Standard'
  const pattern = new RegExp(`^${label}$`, 'i')
  const frames = [preferredFrame, ...page.frames().filter((frame) => frame !== preferredFrame)]

  for (const frame of frames) {
    const radio = await firstVisible(frame.getByRole('radio', { name: pattern }))
    if (radio) {
      const selected = await radio.isChecked().catch(async () =>
        (await radio.getAttribute('aria-checked')) === 'true'
      )
      if (!selected) {
        await radio.check().catch(async () => radio.click())
        await delay(250)
      }
      const verified = await radio.isChecked().catch(async () =>
        (await radio.getAttribute('aria-checked')) === 'true'
      )
      if (verified) return
    }

    const labelText = await firstVisible(frame.getByText(pattern, { exact: true }))
    if (labelText && (await labelText.click().then(() => true).catch(() => false))) {
      await delay(250)
      const selectedRadio = await firstVisible(frame.getByRole('radio', { name: pattern }))
      if (!selectedRadio) return
      const verified = await selectedRadio.isChecked().catch(async () =>
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
  await delay(250)
}

async function fillSapInput(locator: Locator, value: string, pressTab = true): Promise<void> {
  await locator.click()
  await locator.fill(value).catch(async () => {
    await locator.press('Control+A')
    await locator.pressSequentially(value, { delay: 30 })
  })
  await locator.dispatchEvent('input')
  await locator.dispatchEvent('change')
  if (pressTab) {
    await locator.press('Tab')
  }
  await delay(250)
}

async function inputValue(locator: Locator): Promise<string> {
  return (await locator.inputValue().catch(async () => (await locator.getAttribute('value')) ?? '')).trim()
}

async function clickFirstVisibleText(
  page: Page,
  patterns: RegExp[],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const pattern of patterns) {
        const candidates = [
          frame.getByRole('tab', { name: pattern }),
          frame.getByRole('button', { name: pattern }),
          frame.getByText(pattern)
        ]
        for (const candidate of candidates) {
          const locator = await firstVisible(candidate)
          if (locator && (await locator.click().then(() => true).catch(() => false))) {
            return true
          }
        }
      }
    }
    await delay(350)
  }
  return false
}

async function dismissSapPopups(page: Page): Promise<void> {
  const patterns = [/^(Continue|Yes|OK|Enter)$/i, /Continue/i]
  for (let round = 0; round < 4; round += 1) {
    let clicked = false
    for (const frame of page.frames()) {
      for (const pattern of patterns) {
        const button = await firstVisible(frame.getByRole('button', { name: pattern }))
        if (button && (await button.click().then(() => true).catch(() => false))) {
          clicked = true
          await delay(400)
          break
        }
      }
      if (clicked) {
        break
      }
    }
    if (!clicked) {
      return
    }
  }
}

async function saveRecord(page: Page, frame: Frame): Promise<void> {
  for (const pattern of [/^Save/i, /Save.*Ctrl\+S/i]) {
    const button = await firstVisible(frame.getByRole('button', { name: pattern }))
    if (button && (await button.click().then(() => true).catch(() => false))) {
      await delay(800)
      await dismissSapPopups(page)
      return
    }
  }
  await page.keyboard.press('Control+S')
  await delay(800)
  await dismissSapPopups(page)
}

async function readStatusMessage(page: Page): Promise<string> {
  const selectors = [
    "[role='status']",
    "[aria-live='polite']",
    "[aria-live='assertive']",
    '.urMsgBar',
    "[class*='MessageBar']",
    "[id*='msg']",
    "[id*='Msg']"
  ]
  const messages: string[] = []
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const locator = frame.locator(selector)
      const count = Math.min(await locator.count().catch(() => 0), 8)
      for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index)
        if (!(await item.isVisible().catch(() => false))) {
          continue
        }
        const message = (await item.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
        if (message && !messages.includes(message)) {
          messages.push(message)
        }
      }
    }
  }
  return messages.slice(-3).join(' | ')
}

async function findVisiblePageMessage(
  page: Page,
  pattern: RegExp,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const body = frame.locator('body')
      if ((await body.count().catch(() => 0)) === 0) {
        continue
      }
      const text = (await body.innerText({ timeout: 800 }).catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim()
      const match = text.match(pattern)
      if (match) {
        return match[0]
      }
    }
    await delay(250)
  }
  return ''
}

async function leaveCurrentRecord(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    for (const pattern of [/^Back/i, /Back.*F3/i]) {
      const button = await firstVisible(frame.getByRole('button', { name: pattern }))
      if (button && (await button.click().then(() => true).catch(() => false))) {
        await delay(700)
        await dismissSapPopups(page)
        return
      }
    }
  }
  await page.keyboard.press('F3').catch(() => undefined)
  await delay(700)
  await dismissSapPopups(page)
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
