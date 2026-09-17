import {
  Activity,
  Boxes,
  ChevronDown,
  CircleGauge,
  FileClock,
  Settings,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import type { PageId } from '../../types/navigation'
import { useLocalization } from '../../i18n/use-localization'
import type { TranslationKey } from '../../i18n/translations'
import styles from './AppShell.module.css'

interface AppShellProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
  statusLabel: string
  isBusy: boolean
  children: React.ReactNode
}

const navigationItems: Array<{ id: PageId; label: TranslationKey; icon: typeof CircleGauge }> = [
  { id: 'dashboard', label: 'dashboard', icon: CircleGauge },
  { id: 'operations', label: 'operations', icon: Boxes },
  { id: 'history', label: 'history', icon: FileClock },
  { id: 'settings', label: 'settings', icon: Settings }
]

const pageTitleKeys: Record<PageId, TranslationKey> = {
  dashboard: 'dashboard',
  'create-rfq': 'createRfq',
  'me12-lead-time': 'me12LeadTime',
  'me01-source-list': 'me01SourceList',
  'me52n-project-ref': 'me52nProjectRef',
  'apqp-plan-closure': 'apqpPlanClosure',
  operations: 'operations',
  history: 'history',
  settings: 'settings'
}

export function AppShell({
  activePage,
  onNavigate,
  statusLabel,
  isBusy,
  children
}: AppShellProps): React.JSX.Element {
  const { t } = useLocalization()
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandMark}><Sparkles size={19} /></div>
          <div>
            <strong>SAP Automation</strong>
            <span>Toolbox</span>
          </div>
        </div>

        <nav className={styles.navigation} aria-label="Main navigation">
          <span className={styles.navLabel}>{t('workspace')}</span>
          {navigationItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`${styles.navItem} ${activePage === item.id ? styles.active : ''}`}
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={18} />
                <span>{t(item.label)}</span>
              </button>
            )
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.security}>
            <ShieldCheck size={16} />
            <span>{t('localSecure')}</span>
          </div>
          <span className={styles.version}>Version 0.2.3</span>
        </div>
      </aside>

      <div className={styles.content}>
        <header className={styles.topbar}>
          <div>
            <span className={styles.eyebrow}>SAP Automation Toolbox</span>
            <h1>{t(pageTitleKeys[activePage])}</h1>
          </div>
          <div className={styles.topbarRight}>
            <div className={styles.appStatus}>
              <Activity size={15} />
              <div>
                <span>{t('appStatus')}</span>
                <strong>
                  <i className={isBusy ? styles.pulse : ''} />
                  {statusLabel === 'Ready' ? t('ready') : statusLabel}
                </strong>
              </div>
            </div>
            <button className={styles.profile} aria-label="User profile">
              <span className={styles.avatar}>AU</span>
              <div><strong>{t('automationUser')}</strong><span>{t('localWorkspace')}</span></div>
              <ChevronDown size={15} />
            </button>
          </div>
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  )
}
