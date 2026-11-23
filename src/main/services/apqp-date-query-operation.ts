import type { ApqpDateQuery, ApqpDateQueryResult } from '../../shared/apqp-date-types'
import type { ApqpProgress } from '../../shared/apqp-types'
import type { ApqpAgentRead, ApqpDateService } from './apqp-date-service'
import type { DiagnosticLogger } from './diagnostic-logger'
import type { ExecutionHistoryService } from './execution-history-service'
import type { GuidedAutomationService } from './guided-automation-service'
import type { LocalIntelligenceService } from './local-intelligence-service'

export class ApqpDateQueryOperation {
  constructor(private readonly service: ApqpDateService, private readonly guided: GuidedAutomationService,
    private readonly history: ExecutionHistoryService, private readonly logger: DiagnosticLogger,
    private readonly intelligence?: LocalIntelligenceService) {}

  async query(input: ApqpDateQuery, report: (event: ApqpProgress) => void): Promise<ApqpDateQueryResult> {
    try {
      const runId = this.guided.begin()
      try { return (await this.run(input, report, runId)).result }
      finally { this.guided.end(runId) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.logger.error({ category: 'automation', event: 'apqp.dates.query-failed', message, tcode: 'ZMFM050035' })
      return { success: false, message, errorCode: 'APQP_DATE_QUERY_FAILED' }
    }
  }

  /** Hold the same Hub lock across the queue claim and query. The caller owns release. */
  reserveAgentQuery(input: ApqpDateQuery, jobId: string, read: ApqpAgentRead): {
    run: () => ReturnType<ApqpDateQueryOperation['run']>
    release: () => void
  } | null {
    let runId: string
    try { runId = this.guided.begin() } catch { return null }
    let ready = true
    return {
      run: async () => {
        if (!ready) throw new Error('Inactive agent query reservation.')
        ready = false
        return this.run(input, () => undefined, runId, { ...read, jobId })
      },
      release: () => { ready = false; this.guided.end(runId) }
    }
  }

  private async run(input: ApqpDateQuery, report: (event: ApqpProgress) => void, runId: string,
    agent?: ApqpAgentRead & { jobId: string }): Promise<{
      result: ApqpDateQueryResult; runId: string; historyId?: string
    }> {
    let entryId: string | undefined
    try {
      const entry = await this.history.start({ operation: 'apqp-date-management', diagnosticRunId: runId,
        apqpDateAction: 'query', ...(agent ? { agentJobId: agent.jobId } : {}), label: 'APQP date discovery (read-only)',
        summary: `Finding APQPs for NPL ${input.project}.`, tcode: 'ZMFM050035' })
      entryId = entry.id
      this.intelligence?.begin(entry.id, 'apqp-date-management', runId)
      await this.logger.info({ category: 'automation', event: 'apqp.dates.query-started', message: 'APQP date discovery started (read-only).',
        tcode: 'ZMFM050035', details: { runId, project: input.project, environment: input.environment, ...(agent ? { jobId: agent.jobId } : {}) } })
      const result = await this.service.query(input, progress => {
        this.intelligence?.observe(entry.id, progress)
        report(progress)
      }, { service: this.guided, runId }, agent)
      const performance = this.intelligence?.finish(entry.id, result.success ? 'Success' : result.cancelled ? 'Cancelled' : 'Failed')
      await this.history.finish(entry.id, result.success ? { status: 'Success', summary: `Read ${result.snapshot.records.length} APQPs. No SAP dates changed.`,
        total: result.snapshot.records.length, processed: result.snapshot.records.length, succeeded: result.snapshot.records.length,
        failed: 0, sessionCount: 1, resultPath: result.snapshot.resultPath, performance }
        : { status: result.cancelled ? 'Cancelled' : 'Failed', summary: result.message, logPath: result.logPath, performance })
      if (result.success) this.guided.registerArtifacts(result.snapshot.resultPath)
      else if (result.logPath) this.guided.registerArtifacts(result.logPath)
      await this.logger.info({ category: 'automation', event: 'apqp.dates.query-finished',
        message: result.success ? 'APQP date discovery finished; no SAP dates changed.' : result.message, tcode: 'ZMFM050035', details: { runId } })
      return { result, runId, historyId: entry.id }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (entryId) await this.history.finish(entryId, { status: 'Failed', summary: message,
        performance: this.intelligence?.finish(entryId, 'Failed') }).catch(() => undefined)
      await this.logger.error({ category: 'automation', event: 'apqp.dates.query-failed', message, tcode: 'ZMFM050035' })
      return { result: { success: false, message, errorCode: 'APQP_DATE_QUERY_FAILED' }, runId, historyId: entryId }
    } finally { if (entryId) this.intelligence?.finish(entryId, 'Cancelled') }
  }
}
