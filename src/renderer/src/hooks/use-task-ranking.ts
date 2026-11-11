import { useEffect, useState } from 'react'
import { DEFAULT_TASK_ORDER, rankTasks, type AutomationId, type TaskRanking } from '../../../shared/local-intelligence'
import type { PurchasingOperation } from '../i18n/operation-copy'

export const TASK_PAGES: Record<AutomationId, PurchasingOperation> = {
  'create-rfq': 'create-rfq', 'me12-batch': 'me12-lead-time',
  'apqp-plan-closure': 'apqp-plan-closure', 'me01-source-list': 'me01-source-list', 'mm02-sub-commodity': 'mm02-sub-commodity'
}
export const TASK_RANKING_WAIT_MS = 550
let warmed: { started: number; ranking: Promise<TaskRanking | undefined> } | undefined

/** Overlap the intent-to-open asset load and history read. Consume once; never store to disk. */
export function warmTaskRanking(): void {
  if (warmed && performance.now() - warmed.started < TASK_RANKING_WAIT_MS) return
  warmed = {
    started: performance.now(),
    ranking: Promise.resolve().then(() => window.sapAutomation.getLocalIntelligence()).then(result => result.ranking).catch(() => undefined)
  }
}

function takeTaskRanking(): NonNullable<typeof warmed> {
  warmTaskRanking()
  const result = warmed!
  warmed = undefined
  return result
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
      const valid = value && Array.isArray(value.order) && value.order.length === DEFAULT_TASK_ORDER.length
        && new Set(value.order).size === DEFAULT_TASK_ORDER.length && value.order.every(id => DEFAULT_TASK_ORDER.includes(id))
      setRanking(valid ? { ...value, frequentlyUsed: Array.isArray(value.frequentlyUsed) ? value.frequentlyUsed : [] } : rankTasks([]))
      setLoading(false)
    }
    const request = takeTaskRanking()
    const timer = window.setTimeout(() => settle(), Math.max(0, TASK_RANKING_WAIT_MS - (performance.now() - request.started)))
    void request.ranking.then(settle)
    return () => { settled = true; window.clearTimeout(timer) }
  }, [])
  return { ranking, loading }
}
