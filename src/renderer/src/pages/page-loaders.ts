import type { PageId } from '../types/navigation'
import { warmTaskRanking } from '../hooks/use-task-ranking'

export const pageLoaders = {
  operations: () => import('./OperationsPage').then(m => ({ default: m.OperationsPage })),
  history: () => import('./HistoryPage').then(m => ({ default: m.HistoryPage })),
  settings: () => import('./SettingsPage').then(m => ({ default: m.SettingsPage })),
  'create-rfq': () => import('./CreateRfqPage').then(m => ({ default: m.CreateRfqPage })),
  'me12-lead-time': () => import('./Me12LeadTimePage').then(m => ({ default: m.Me12LeadTimePage })),
  'me01-source-list': () => import('./Me01SourceListPage').then(m => ({ default: m.Me01SourceListPage })),
  'mm02-sub-commodity': () => import('./Mm02SubCommodityPage').then(m => ({ default: m.Mm02SubCommodityPage })),
  'apqp-plan-closure': () => import('./ApqpPlanClosurePage').then(m => ({ default: m.ApqpPlanClosurePage }))
}

export function preloadPage(page: PageId): void {
  if (page === 'dashboard') return
  if (page === 'operations') warmTaskRanking()
  void pageLoaders[page]().catch(() => undefined)
}
