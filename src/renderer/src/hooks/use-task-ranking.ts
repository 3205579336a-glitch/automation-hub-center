import { useEffect, useState } from 'react'
import { DEFAULT_TASK_ORDER, rankTasks, type AutomationId, type TaskRanking } from '../../../shared/local-intelligence'
import type { PurchasingOperation } from '../i18n/operation-copy'

export const TASK_PAGES: Record<AutomationId, PurchasingOperation> = {
  'create-rfq': 'create-rfq', 'me12-batch': 'me12-lead-time',
  'apqp-plan-closure': 'apqp-plan-closure', 'me01-source-list': 'me01-source-list'
}
/** One snapshot per mounted page. Timeout freezes the default order, not a late shuffle. */
export function useTaskRanking(): { ranking: TaskRanking; loading: boolean } {
  const [ranking, setRanking] = useState<TaskRanking>(() => rankTasks([]))
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let settled = false
    const settle = (value?: TaskRanking): void => {
      if (settled) return
      settled = true
      const valid = value && Array.isArray(value.order) && value.order.length === 4
        && new Set(value.order).size === 4 && value.order.every(id => DEFAULT_TASK_ORDER.includes(id))
      setRanking(valid ? { ...value, frequentlyUsed: Array.isArray(value.frequentlyUsed) ? value.frequentlyUsed : [] } : rankTasks([]))
      setLoading(false)
    }
    const timer = window.setTimeout(() => settle(), 1500)
    try { void window.sapAutomation.getLocalIntelligence().then(result => settle(result.ranking)).catch(() => settle()) }
    catch { settle() }
    return () => { settled = true; window.clearTimeout(timer) }
  }, [])
  return { ranking, loading }
}
