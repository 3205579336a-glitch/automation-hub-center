export type AutomationState = 'READY' | 'VALIDATING' | 'READY_TO_START' | 'RUNNING'
  | 'WAITING_FOR_USER' | 'RECOVERING' | 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'FAILED' | 'CANCELLED'

export interface AutomationOutcome {
  state: AutomationState
  total: number
  processed: number
  succeeded: number
  skipped: number
  failed: number
  resultPath?: string
  backupPath?: string
  logPath?: string
  details: string
}

export function outcomeOf(result: { success: boolean; message: string; errorCode?: string; cancelled?: boolean;
  total?: number; processed?: number; succeeded?: number; skipped?: number; failed?: number;
  resultPath?: string; backupPath?: string; logPath?: string }, total: number): AutomationOutcome {
  const processed = result.processed ?? 0
  const failed = result.failed ?? 0
  const skipped = result.skipped ?? 0
  const cancelled = result.cancelled || result.errorCode === 'CANCELLED'
  const state: AutomationState = cancelled ? 'CANCELLED' : !result.success ? 'FAILED'
    : failed > 0 && !(result.succeeded ?? 0) && !skipped ? 'FAILED'
    : failed > 0 || skipped > 0 ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED'
  return { state, total: Math.max(result.total ?? total, (result.succeeded ?? 0) + skipped + failed), processed, failed, skipped,
    succeeded: result.succeeded ?? 0, resultPath: result.resultPath, backupPath: result.backupPath,
    logPath: result.logPath, details: result.message }
}
