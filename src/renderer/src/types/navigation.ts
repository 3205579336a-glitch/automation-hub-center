export type PageId =
  | 'dashboard'
  | 'create-rfq'
  | 'me12-lead-time'
  | 'me01-source-list'
  | 'me52n-project-ref'
  | 'apqp-plan-closure'
  | 'operations'
  | 'history'
  | 'settings'

export const PAGE_TITLES: Record<PageId, string> = {
  dashboard: 'Dashboard',
  'create-rfq': 'Create RFQ',
  'me12-lead-time': 'ME12 Supplier Lead Time',
  'me01-source-list': 'ME01 Source List',
  'me52n-project-ref': 'ME52N Project Ref',
  'apqp-plan-closure': 'APQP Plan Closure Date',
  operations: 'Operations',
  history: 'Execution History',
  settings: 'Settings'
}
