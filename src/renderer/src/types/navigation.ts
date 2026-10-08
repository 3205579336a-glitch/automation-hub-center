export type PageId =
  | 'dashboard'
  | 'create-rfq'
  | 'me12-lead-time'
  | 'me01-source-list'
  | 'apqp-plan-closure'
  | 'operations'
  | 'history'
  | 'settings'

export const PAGE_TITLES: Record<PageId, string> = {
  dashboard: 'Dashboard',
  'create-rfq': 'Create RFQ',
  'me12-lead-time': 'Update Info Record',
  'me01-source-list': 'Update Source List',
  'apqp-plan-closure': 'APQP',
  operations: 'Operations',
  history: 'Execution History',
  settings: 'Settings'
}
