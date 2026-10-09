import { operationCopy } from '../i18n/operation-copy'

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
  'create-rfq': operationCopy('create-rfq', 'en').shortTitle,
  'me12-lead-time': operationCopy('me12-lead-time', 'en').shortTitle,
  'me01-source-list': operationCopy('me01-source-list', 'en').shortTitle,
  'apqp-plan-closure': operationCopy('apqp-plan-closure', 'en').shortTitle,
  operations: 'Operations',
  history: 'Execution History',
  settings: 'Settings'
}
