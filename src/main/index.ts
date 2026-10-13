import { join } from 'node:path'
import { homedir } from 'node:os'
import { app, BrowserWindow, screen, shell } from 'electron'
import { BrowserManager } from './automation/browser-manager'
import { Me12BatchRunner } from './automation/me12-batch-runner'
import { RfqNativeRunner } from './automation/rfq-native-runner'
import { Me01NativeRunner } from './automation/me01-native-runner'
import { BrowserSlotManager } from './automation/browser-slot-manager'
import { registerAutomationHandlers } from './ipc/automation-handlers'
import { registerDiagnosticHandlers } from './ipc/diagnostic-handlers'
import { registerSettingsHandlers } from './ipc/settings-handlers'
import { registerMe12Handlers } from './ipc/me12-handlers'
import { registerHistoryHandlers } from './ipc/history-handlers'
import { RunDiagnosticCleanup } from './services/run-diagnostic-cleanup'
import { registerRfqHandlers } from './ipc/rfq-handlers'
import { registerMe01Handlers } from './ipc/me01-handlers'
import { DiagnosticLogger } from './services/diagnostic-logger'
import { LocalStoragePaths } from './services/local-storage-paths'
import { SettingsService } from './services/settings-service'
import { Me12ExcelService } from './services/me12-excel-service'
import { ExecutionHistoryService } from './services/execution-history-service'
import { LocalIntelligenceService } from './services/local-intelligence-service'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { RfqExcelService } from './services/rfq-excel-service'
import { Me01ExcelService } from './services/me01-excel-service'
import { GuidedAutomationService } from './services/guided-automation-service'
import { ApqpRunner } from './automation/apqp-runner'
import { registerApqpHandlers } from './ipc/apqp-handlers'
import { RfqSafeRecoveryService } from './services/rfq-safe-recovery-service'
import { registerSafeRecoveryHandlers } from './ipc/safe-recovery-handlers'
import { GeneratedArtifacts } from './services/generated-artifacts'

let mainWindow: BrowserWindow | null = null
const startupStarted = performance.now()
// Two Hubs must never independently control the same local SAP run ledger.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() } })

function createMainWindow(): void {
  // Electron sizes are logical pixels: account for small/high-DPI laptop work areas.
  const workArea = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width: Math.min(1440, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: Math.min(640, workArea.width),
    minHeight: Math.min(480, workArea.height),
    show: false,
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  const startupPhases: Record<string, number> = { electronReadyMs: Math.round(performance.now() - startupStarted) }
  const storagePaths = new LocalStoragePaths(app.getPath('userData'))
  await storagePaths.initialize()
  startupPhases.storageReadyMs = Math.round(performance.now() - startupStarted)
  const logger = new DiagnosticLogger(storagePaths.logsDirectory)
  const legacyRunsDirectory = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SAP Automation Toolbox', 'runs')
  const runsDirectory = join(storagePaths.logsDirectory, 'rfq-runs')
  const artifacts = new GeneratedArtifacts(join(storagePaths.logsDirectory, 'automation-runs'))
  const rfqArtifacts = new GeneratedArtifacts(runsDirectory)
  let artifactCleanupActive = false
  const recovery = new RfqSafeRecoveryService(join(storagePaths.dataDirectory, 'rfq-recovery'), runsDirectory, undefined, [legacyRunsDirectory])
  const interactionsDirectory = join(storagePaths.logsDirectory, 'interactions')
  const diagnosticCleanup = new RunDiagnosticCleanup(runsDirectory, interactionsDirectory)
  const legacyCleanup = new RunDiagnosticCleanup(legacyRunsDirectory, join(storagePaths.dataDirectory, 'interactions'))
  const history = new ExecutionHistoryService(storagePaths.executionHistoryPath, logger, async (entry, protectedPaths) => [...await diagnosticCleanup.remove(entry, protectedPaths), ...await legacyCleanup.remove(entry, protectedPaths)], () => recovery.protectedIds())
  recovery.importLegacy(await history.getEntries({ operations: ['create-rfq'], statuses: ['Running', 'Interrupted'], limit: 500 }))
  await history.markInterruptedRfqRuns(recovery.protectedIds()).catch(() => {
    // Preserve malformed history, but still open the Hub so users can inspect its recovery evidence.
    console.warn('Interrupted history could not be updated; original history and recovery evidence were preserved.')
  })
  startupPhases.recoveryReadyMs = Math.round(performance.now() - startupStarted)
  const intelligence = new LocalIntelligenceService(history, eta => {
    for (const window of BrowserWindow.getAllWindows()) {
      try { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.automationEta, eta) } catch { /* Optional UI hint. */ }
    }
  })
  const settingsService = new SettingsService(
    storagePaths,
    app.getPath('downloads'),
    logger
  )
  const browserSlotManager = new BrowserSlotManager()
  const browserManager = new BrowserManager(
    settingsService,
    storagePaths.browserProfilesDirectory,
    browserSlotManager
  )
  const me12ExcelService = new Me12ExcelService(artifacts)
  const me12Runner = new Me12BatchRunner(
    settingsService,
    me12ExcelService,
    storagePaths.browserProfilesDirectory,
    storagePaths.me12ScreenshotsDirectory,
    logger,
    browserSlotManager
  )
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const sharedEngine = join(resourceRoot, 'rpa-engine', 'automation-engine', 'automation-engine.exe')
  const rfqRunner = new RfqNativeRunner({
    executable: sharedEngine,
    executableArgs: ['rfq'],
    script: join(resourceRoot, 'rpa', 'rfq_engine.py'),
    preferScript: !app.isPackaged
  }, runsDirectory, app.getVersion(), recovery, rfqArtifacts)
  const rfqExcelService = new RfqExcelService(rfqRunner)
  const me01ExcelService = new Me01ExcelService()
  const me01Runner = new Me01NativeRunner({
    executable: sharedEngine,
    executableArgs: ['me01'],
    script: join(resourceRoot, 'rpa', 'me01_source_list.py'),
    preferScript: !app.isPackaged
  }, artifacts)
  const guided = new GuidedAutomationService(interactionsDirectory, () => {
    if (rfqRunner.isRunning() || history.isCleaning() || artifactCleanupActive) return true
    if (recovery.pending().some(record => record.processStatus === 'alive')) throw new Error('An older RFQ engine may still be running. Review Safe Recovery and stop that engine safely before starting another task.')
    return false
  })
  guided.onInteraction(request => intelligence.interaction(request))
  registerSettingsHandlers(settingsService, logger)
  registerAutomationHandlers(browserManager, logger, history)
  registerDiagnosticHandlers(logger, storagePaths)
  registerMe12Handlers(
    me12ExcelService,
    me12Runner,
    logger,
    history,
    join(resourceRoot, 'templates', 'ME12_Supplier_Lead_Time_Template.xlsx'),
    settingsService,
    guided,
    intelligence
  )
  registerRfqHandlers(
    rfqExcelService,
    rfqRunner,
    logger,
    history,
    join(resourceRoot, 'templates', 'Create_RFQ_Template.xlsx'),
    settingsService,
    guided,
    intelligence,
    recovery
  )
  registerMe01Handlers(
    me01ExcelService,
    me01Runner,
    logger,
    history,
    join(resourceRoot, 'templates', 'ME01_Source_List_Template.xlsx'),
    settingsService,
    guided,
    intelligence
  )
  const apqpRunner = new ApqpRunner({
    executable: sharedEngine,
    executableArgs: ['apqp'],
    script: join(resourceRoot, 'rpa', 'apqp_plan_closure.py'),
    preferScript: !app.isPackaged
  }, artifacts)
  registerApqpHandlers(apqpRunner, logger, history, settingsService, join(resourceRoot, 'templates', 'APQP_Plan_Closure_Template.xlsx'), guided, intelligence)
  registerHistoryHandlers(history, intelligence, () => guided.isRunning() || rfqRunner.isRunning() || artifactCleanupActive)
  registerSafeRecoveryHandlers(recovery, history, settingsService, () => guided.isRunning() || rfqRunner.isRunning() || artifactCleanupActive)
  // Run locally at startup and daily while idle; no external scheduler needed.
  const pruneOldLogs = async (): Promise<void> => {
    if (guided.isRunning() || rfqRunner.isRunning() || history.isCleaning() || artifactCleanupActive) return
    artifactCleanupActive = true
    try {
      const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000
      const protectedIds = recovery.protectedIds()
      for (const entry of await history.getEntries({ statuses: ['Running', 'Interrupted'], limit: 100000 })) {
        if (entry.status === 'Interrupted' && entry.recoveryResolvedAt) continue
        protectedIds.add(entry.id)
        if (entry.diagnosticRunId) protectedIds.add(entry.diagnosticRunId)
      }
      const warnings = [...await artifacts.prune(cutoff, protectedIds), ...await rfqArtifacts.prune(cutoff, protectedIds)]
      await history.clear(cutoff)
      if (warnings.length) console.warn('Some generated files were kept:', [...new Set(warnings)])
    }
    catch (error) { console.warn('Automatic log retention skipped; existing data preserved:', error) }
    finally { artifactCleanupActive = false }
  }
  // Retention is maintenance, not a prerequisite for opening the UI. Recovery
  // checks above still complete before handlers/window are usable.
  let initialRetentionTimer: NodeJS.Timeout
  const initialRetention = (): void => {
    if (guided.isRunning() || rfqRunner.isRunning() || history.isCleaning() || artifactCleanupActive) {
      initialRetentionTimer = setTimeout(initialRetention, 60_000)
      initialRetentionTimer.unref()
      return
    }
    void pruneOldLogs()
  }
  initialRetentionTimer = setTimeout(initialRetention, 30_000)
  initialRetentionTimer.unref()
  const retentionTimer = setInterval(() => { void pruneOldLogs() }, 24 * 60 * 60 * 1000)
  retentionTimer.unref()
  app.once('will-quit', () => { clearTimeout(initialRetentionTimer); clearInterval(retentionTimer) })
  startupPhases.servicesReadyMs = Math.round(performance.now() - startupStarted)
  createMainWindow()
  mainWindow?.once('ready-to-show', () => {
    void logger.info({ category: 'application', event: 'application.window-ready',
      message: 'Main window is ready.', details: { startupMs: Math.round(performance.now() - startupStarted),
        processAgeMs: Math.round(process.uptime() * 1000), ...startupPhases, version: app.getVersion() } })
  })
  void logger.info({
    category: 'application',
    event: 'application.started',
    message: `SAP Automation Toolbox started on ${process.platform}.`,
    details: { version: app.getVersion() }
  })

  process.on('unhandledRejection', (reason) => {
    void logger.error({
      category: 'application',
      event: 'application.unhandled-rejection',
      message: reason instanceof Error ? reason.message : String(reason)
    })
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })

  let waitingForRfq = false
  app.on('before-quit', (event) => {
    if (rfqRunner.isRunning() || guided.isRunning()) {
      event.preventDefault()
      void rfqRunner.cancel()
      me12Runner.cancel()
      me01Runner.cancel()
      apqpRunner.cancel()
      if (!waitingForRfq) {
        waitingForRfq = true
        const timer = setInterval(() => {
          if (!rfqRunner.isRunning() && !guided.isRunning()) { clearInterval(timer); app.quit() }
        }, 1000)
      }
      return
    }
    apqpRunner.cancel()
    void logger.info({
      category: 'application',
      event: 'application.stopping',
      message: 'SAP Automation Toolbox is closing.'
    })
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
