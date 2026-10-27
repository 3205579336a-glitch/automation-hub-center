import type { AutomationProgress, AutomationResult, OpenSapRequest } from '../shared/automation-types'
import type { TimeSavingsSummary } from '../shared/time-savings'
import type { RfqRecoveryResult, RfqRecoveryView } from '../shared/rfq-safe-recovery'
import type { AutomationInteraction, InteractionResponse } from '../shared/automation-interaction'
import type { EtaSnapshot, LocalIntelligenceSnapshot } from '../shared/local-intelligence'
import type {
  DiagnosticLogQuery,
  DiagnosticLogResult,
  OpenLogFolderResult
} from '../shared/diagnostic-types'
import type { AppSettings, SaveSettingsResult } from '../shared/settings-types'
import type {
  Me12BatchConfig,
  Me12BatchProgress,
  Me12BatchResult,
  Me12CancelResult,
  DownloadMe12TemplateResult,
  Me12PreviewResult,
  SelectExcelFileResult
} from '../shared/me12-types'
import type {
  ExecutionHistoryQuery,
  ExecutionHistoryResult,
  DeleteHistoryResult
} from '../shared/execution-history-types'
import type {
  DownloadRfqTemplateResult,
  RfqBatchConfig,
  RfqBatchProgress,
  RfqBatchResult,
  RfqCancelResult,
  RfqPreviewResult,
  SelectRfqExcelResult
} from '../shared/rfq-batch-types'
import type {
  DownloadMe01TemplateResult,
  Me01BatchConfig,
  Me01BatchProgress,
  Me01BatchResult,
  Me01CancelResult,
  Me01PreviewResult,
  SelectMe01ExcelResult
} from '../shared/me01-types'

import type { ApqpConfig, ApqpFileResult, ApqpPreviewResult, ApqpProgress, ApqpResult } from '../shared/apqp-types'
import type { ApqpDateCapabilities, ApqpDateQuery, ApqpDateQueryResult, ApqpDatePreviewRequest, ApqpDatePreviewResult,
  ApqpDateExecuteRequest, ApqpDateExecuteResult } from '../shared/apqp-date-types'

export interface SapAutomationApi {
  getApqpDateCapabilities: () => Promise<ApqpDateCapabilities | null>
  queryApqpDates: (input: ApqpDateQuery) => Promise<ApqpDateQueryResult>
  loadCachedApqpDates: (input: ApqpDateQuery) => Promise<ApqpDateQueryResult>
  previewApqpDateChanges: (input: ApqpDatePreviewRequest) => Promise<ApqpDatePreviewResult>
  executeApqpDateChanges: (input: ApqpDateExecuteRequest) => Promise<ApqpDateExecuteResult>
  getTimeSavings: () => Promise<TimeSavingsSummary>
  getRfqRecovery: () => Promise<RfqRecoveryView[]>
  openRecoveryResult: (runId: string) => Promise<RfqRecoveryResult>
  resolveRfqRecovery: (input: { runId: string; note?: string; verifiedInSap: true; engineStopped: true }) => Promise<RfqRecoveryResult>
  getLocalIntelligence: () => Promise<LocalIntelligenceSnapshot>
  onAutomationEta: (listener: (eta: EtaSnapshot) => void) => () => void
  downloadApqpTemplate: () => Promise<ApqpFileResult>
  selectApqpExcel: () => Promise<ApqpFileResult>
  previewApqp: (config: ApqpConfig) => Promise<ApqpPreviewResult>
  startApqp: (config: ApqpConfig) => Promise<ApqpResult>
  cancelApqp: () => Promise<{ success: boolean }>
  onApqpProgress: (listener: (progress: ApqpProgress) => void) => () => void
  openSapWebGui: (request?: OpenSapRequest) => Promise<AutomationResult>
  onAutomationProgress: (listener: (progress: AutomationProgress) => void) => () => void
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<SaveSettingsResult>
  getDiagnosticLogs: (query?: DiagnosticLogQuery) => Promise<DiagnosticLogResult>
  openLogFolder: () => Promise<OpenLogFolderResult>
  selectMe12ExcelFile: () => Promise<SelectExcelFileResult>
  downloadMe12Template: () => Promise<DownloadMe12TemplateResult>
  previewMe12Batch: (config: Me12BatchConfig) => Promise<Me12PreviewResult>
  startMe12Batch: (config: Me12BatchConfig) => Promise<Me12BatchResult>
  cancelMe12Batch: () => Promise<Me12CancelResult>
  onMe12Progress: (listener: (progress: Me12BatchProgress) => void) => () => void
  selectMe01ExcelFile: () => Promise<SelectMe01ExcelResult>
  downloadMe01Template: () => Promise<DownloadMe01TemplateResult>
  previewMe01Batch: (config: Me01BatchConfig) => Promise<Me01PreviewResult>
  startMe01Batch: (config: Me01BatchConfig) => Promise<Me01BatchResult>
  cancelMe01Batch: () => Promise<Me01CancelResult>
  onMe01Progress: (listener: (progress: Me01BatchProgress) => void) => () => void
  openAutomationArtifact: (path: string) => Promise<{ success: boolean; message?: string }>
  getExecutionHistory: (query?: ExecutionHistoryQuery) => Promise<ExecutionHistoryResult>
  deleteExecutionHistory: () => Promise<DeleteHistoryResult>
  selectRfqExcelFile: () => Promise<SelectRfqExcelResult>
  downloadRfqTemplate: () => Promise<DownloadRfqTemplateResult>
  previewRfqBatch: (config: RfqBatchConfig) => Promise<RfqPreviewResult>
  startRfqBatch: (config: RfqBatchConfig) => Promise<RfqBatchResult>
  cancelRfqBatch: () => Promise<RfqCancelResult>
  getAutomationInteraction: () => Promise<AutomationInteraction | null>
  onAutomationInteraction: (listener: (interaction: AutomationInteraction | null) => void) => () => void
  respondAutomationInteraction: (input: InteractionResponse) => Promise<{ success: boolean; message?: string }>
  openRfqArtifact: (path: string) => Promise<{ success: boolean; message?: string }>
  onRfqProgress: (listener: (progress: RfqBatchProgress) => void) => () => void
}
