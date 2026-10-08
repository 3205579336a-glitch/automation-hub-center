import type { ExecutionHistoryEntry } from '../../../shared/execution-history-types'

export function operationName(entry: ExecutionHistoryEntry, zh: boolean): string {
  switch (entry.operation) {
    case 'me12-batch': return zh ? '更新采购信息记录' : 'Update Info Record'
    case 'me01-source-list': return zh ? '更新货源清单' : 'Update Source List'
    case 'apqp-plan-closure': return zh ? 'APQP 计划关闭日期' : 'APQP Plan Close Dates'
    default: return entry.label
  }
}
