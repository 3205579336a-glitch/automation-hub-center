import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import type { AutomationProgress } from '../shared/automation-types'
import type { Me12BatchProgress } from '../shared/me12-types'
import type { RfqBatchProgress } from '../shared/rfq-batch-types'
import type { AutomationInteraction } from '../shared/automation-interaction'
import type { EtaSnapshot } from '../shared/local-intelligence'
import type { Me01BatchProgress } from '../shared/me01-types'
import type { SapAutomationApi } from './types'
import type { ApqpProgress } from '../shared/apqp-types'

const sapAutomationApi: SapAutomationApi = {
  getLocalIntelligence: () => ipcRenderer.invoke(IPC_CHANNELS.getLocalIntelligence),
  onAutomationEta: listener => {
    const handler = (_event: Electron.IpcRendererEvent, eta: EtaSnapshot): void => listener(eta)
    ipcRenderer.on(IPC_CHANNELS.automationEta, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.automationEta, handler)
  },
  downloadApqpTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadApqpTemplate),
  selectApqpExcel: () => ipcRenderer.invoke(IPC_CHANNELS.selectApqpExcel),
  previewApqp: (config) => ipcRenderer.invoke(IPC_CHANNELS.previewApqp, config),
  startApqp: (config) => ipcRenderer.invoke(IPC_CHANNELS.startApqp, config),
  cancelApqp: () => ipcRenderer.invoke(IPC_CHANNELS.cancelApqp),
  onApqpProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ApqpProgress): void => listener(progress)
    ipcRenderer.on(IPC_CHANNELS.apqpProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.apqpProgress, handler)
  },
  openSapWebGui: (request = {}) => ipcRenderer.invoke(IPC_CHANNELS.openSapWebGui, request),
  onAutomationProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: AutomationProgress): void => {
      listener(progress)
    }

    ipcRenderer.on(IPC_CHANNELS.automationProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.automationProgress, handler)
  },
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  getDiagnosticLogs: (query = {}) => ipcRenderer.invoke(IPC_CHANNELS.getDiagnosticLogs, query),
  getExecutionHistory: (query = {}) =>
    ipcRenderer.invoke(IPC_CHANNELS.getExecutionHistory, query),
  deleteExecutionHistory: () => ipcRenderer.invoke(IPC_CHANNELS.deleteExecutionHistory),
  openLogFolder: () => ipcRenderer.invoke(IPC_CHANNELS.openLogFolder),
  selectMe12ExcelFile: () => ipcRenderer.invoke(IPC_CHANNELS.selectMe12ExcelFile),
  downloadMe12Template: () => ipcRenderer.invoke(IPC_CHANNELS.downloadMe12Template),
  previewMe12Batch: (config) => ipcRenderer.invoke(IPC_CHANNELS.previewMe12Batch, config),
  startMe12Batch: (config) => ipcRenderer.invoke(IPC_CHANNELS.startMe12Batch, config),
  cancelMe12Batch: () => ipcRenderer.invoke(IPC_CHANNELS.cancelMe12Batch),
  onMe12Progress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Me12BatchProgress): void => {
      listener(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.me12Progress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.me12Progress, handler)
  },
  selectMe01ExcelFile: () => ipcRenderer.invoke(IPC_CHANNELS.selectMe01ExcelFile),
  downloadMe01Template: () => ipcRenderer.invoke(IPC_CHANNELS.downloadMe01Template),
  previewMe01Batch: (config) => ipcRenderer.invoke(IPC_CHANNELS.previewMe01Batch, config),
  startMe01Batch: (config) => ipcRenderer.invoke(IPC_CHANNELS.startMe01Batch, config),
  cancelMe01Batch: () => ipcRenderer.invoke(IPC_CHANNELS.cancelMe01Batch),
  onMe01Progress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Me01BatchProgress): void => {
      listener(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.me01Progress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.me01Progress, handler)
  },
  openAutomationArtifact: (path) => ipcRenderer.invoke(IPC_CHANNELS.openAutomationArtifact, path),
  selectRfqExcelFile: () => ipcRenderer.invoke(IPC_CHANNELS.selectRfqExcelFile),
  downloadRfqTemplate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadRfqTemplate),
  previewRfqBatch: (config) => ipcRenderer.invoke(IPC_CHANNELS.previewRfqBatch, config),
  startRfqBatch: (config) => ipcRenderer.invoke(IPC_CHANNELS.startRfqBatch, config),
  cancelRfqBatch: () => ipcRenderer.invoke(IPC_CHANNELS.cancelRfqBatch),
  getAutomationInteraction: () => ipcRenderer.invoke(IPC_CHANNELS.getAutomationInteraction),
  onAutomationInteraction: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, interaction: AutomationInteraction | null): void => listener(interaction)
    ipcRenderer.on(IPC_CHANNELS.automationInteraction, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.automationInteraction, handler)
  },
  respondAutomationInteraction: (input) => ipcRenderer.invoke(IPC_CHANNELS.respondAutomationInteraction, input),
  openRfqArtifact: (path) => ipcRenderer.invoke(IPC_CHANNELS.openRfqArtifact, path),
  onRfqProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: RfqBatchProgress): void => {
      listener(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.rfqProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.rfqProgress, handler)
  }
}

contextBridge.exposeInMainWorld('sapAutomation', sapAutomationApi)
