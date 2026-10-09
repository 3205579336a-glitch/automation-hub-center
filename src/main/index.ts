import { join } from 'node:path'
import { homedir } from 'node:os'
import { app, BrowserWindow, shell } from 'electron'
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

let mainWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
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
  const storagePaths = new LocalStoragePaths(app.getPath('userData'))
  await storagePaths.initialize()
  const logger = new DiagnosticLogger(storagePaths.logsDirectory)
  const runsDirectory = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SAP Automation Toolbox', 'runs')
  const diagnosticCleanup = new RunDiagnosticCleanup(runsDirectory, join(storagePaths.dataDirectory, 'interactions'))
  const history = new ExecutionHistoryService(storagePaths.executionHistoryPath, logger, (entry, protectedPaths) => diagnosticCleanup.remove(entry, protectedPaths))
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
  const me12ExcelService = new Me12ExcelService()
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
  }, join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SAP Automation Toolbox', 'runs'), app.getVersion())
  const rfqExcelService = new RfqExcelService(rfqRunner)
  const me01ExcelService = new Me01ExcelService()
  const me01Runner = new Me01NativeRunner({
    executable: sharedEngine,
    executableArgs: ['me01'],
    script: join(resourceRoot, 'rpa', 'me01_source_list.py'),
    preferScript: !app.isPackaged
  })
  const guided = new GuidedAutomationService(join(storagePaths.dataDirectory, 'interactions'), () => rfqRunner.isRunning() || history.isCleaning())
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
    intelligence
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
  })
  registerApqpHandlers(apqpRunner, logger, history, settingsService, join(resourceRoot, 'templates', 'APQP_Plan_Closure_Template.xlsx'), guided, intelligence)
  registerHistoryHandlers(history, intelligence, () => guided.isRunning() || rfqRunner.isRunning())
  // Run locally at startup and daily while idle; no external scheduler needed.
  const pruneOldLogs = async (): Promise<void> => {
    if (guided.isRunning() || rfqRunner.isRunning() || history.isCleaning()) return
    try { await history.clear(Date.now() - 60 * 24 * 60 * 60 * 1000) }
    catch (error) { console.warn('Automatic log retention skipped; existing data preserved:', error) }
  }
  await pruneOldLogs()
  const retentionTimer = setInterval(() => { void pruneOldLogs() }, 24 * 60 * 60 * 1000)
  retentionTimer.unref()
  app.once('will-quit', () => clearInterval(retentionTimer))
  await logger.info({
    category: 'application',
    event: 'application.started',
    message: `SAP Automation Toolbox started on ${process.platform}.`,
    details: { version: app.getVersion() }
  })
  createMainWindow()

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
