export interface RfqRecoveryRecord {
  version: 1; runId: string; startedAt: string; updatedAt: string; environment: 'PROD' | 'QA' | 'UNKNOWN'
  ownerPid?: number; enginePid?: number; engineClosed: boolean; phase: 'active' | 'review' | 'complete' | 'resolved'
  projects: string[]; groupKey?: string; project?: string; plant?: string; supplier?: string; materials?: string[]
  totalGroups: number | null; completedGroupKeys: string[]; lastConfirmedCheckpoint?: string; checkpointGroup?: string
  uncertainGroupKeys?: string[]
  rfqNumbers: string[]; resultPath?: string; terminal?: string; resolvedAt?: string; resolutionNote?: string
  storageIssue?: boolean
}
export interface RfqRecoveryView extends RfqRecoveryRecord {
  processStatus: 'alive' | 'dead' | 'unknown'; resultAvailable: boolean; completedGroups: number
}
export interface RfqRecoveryResult { success: boolean; message?: string }
export interface RfqRecoveryRecorder {
  begin(runId: string, environment: 'QA' | 'PROD', resultPath: string): void
  launched(runId: string, pid: number): void
  observe(runId: string, event: Record<string, unknown>): void
  close(runId: string, code: number | null): void
}
export const RFQ_RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
