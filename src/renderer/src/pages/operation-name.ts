import type { ExecutionHistoryEntry } from '../../../shared/execution-history-types'
import { operationCopy } from '../i18n/operation-copy'

export function operationName(entry: ExecutionHistoryEntry, zh: boolean): string {
  switch (entry.operation) {
    case 'me12-batch': return operationCopy('me12-lead-time', zh ? 'zh-CN' : 'en').shortTitle
    case 'me01-source-list': return operationCopy('me01-source-list', zh ? 'zh-CN' : 'en').shortTitle
    case 'apqp-plan-closure': return operationCopy('apqp-plan-closure', zh ? 'zh-CN' : 'en').shortTitle
    default: return entry.label
  }
}
