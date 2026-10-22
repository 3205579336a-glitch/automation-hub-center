import type { ExecutionHistoryEntry } from '../../../shared/execution-history-types'
import { operationCopy } from '../i18n/operation-copy'

export function operationName(entry: ExecutionHistoryEntry, zh: boolean): string {
  switch (entry.operation) {
    case 'me12-batch': return operationCopy('me12-lead-time', zh ? 'zh-CN' : 'en').shortTitle
    case 'me01-source-list': return operationCopy('me01-source-list', zh ? 'zh-CN' : 'en').shortTitle
    case 'apqp-plan-closure': return operationCopy('apqp-plan-closure', zh ? 'zh-CN' : 'en').shortTitle
    case 'apqp-date-management': return entry.apqpDateAction === 'update'
      ? entry.apqpStaged !== undefined ? zh ? 'APQP 测试填入（未保存）' : 'APQP Test Input (NOT SAVED)' : zh ? 'APQP 日期修改' : 'APQP Date Update' : entry.apqpDateAction === 'preview'
      ? zh ? 'APQP 日期差异预览（不修改 SAP）' : 'APQP Date Comparison (read-only)'
      : zh ? 'APQP 日期读取（不修改 SAP）' : 'APQP Date Discovery (read-only)'
    default: return entry.label
  }
}
