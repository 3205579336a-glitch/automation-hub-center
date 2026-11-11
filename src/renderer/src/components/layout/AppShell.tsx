import {
  Activity,
  Boxes,
  CircleGauge,
  FileClock,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PageId } from '../../types/navigation'
import { useLocalization } from '../../i18n/use-localization'
import type { TranslationKey } from '../../i18n/translations'
import styles from './AppShell.module.css'

interface AppShellProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
  onPageIntent: (page: PageId) => void
  status: ApplicationStatus
  children: React.ReactNode
}

export type ApplicationStatus = 'ready' | 'running' | 'waiting' | 'checking' | 'opening' | 'attention'
const statusKeys: Record<ApplicationStatus, TranslationKey> = {
  ready: 'ready', running: 'statusRunning', waiting: 'statusWaiting', checking: 'statusChecking',
  opening: 'statusOpening', attention: 'statusAttention'
}

const navigationItems: Array<{ id: PageId; label: TranslationKey; icon: typeof CircleGauge }> = [
  { id: 'dashboard', label: 'dashboard', icon: CircleGauge },
  { id: 'operations', label: 'operations', icon: Boxes },
  { id: 'history', label: 'history', icon: FileClock },
  { id: 'settings', label: 'settings', icon: Settings }
]
const SIDEBAR_KEY = 'purchasing-hub.sidebar'
const COMPACT_WINDOW = '(max-width: 1050px)'
const appVersion = import.meta.env.VITE_APP_VERSION as string

function readSidebarPreference(): boolean | null {
  try {
    const saved = window.localStorage.getItem(SIDEBAR_KEY)
    return saved === 'collapsed' ? true : saved === 'expanded' ? false : null
  } catch { return null }
}

const pageTitleKeys: Record<PageId, TranslationKey> = {
  dashboard: 'dashboard',
  'create-rfq': 'createRfq',
  'me12-lead-time': 'me12LeadTime',
  'me01-source-list': 'me01SourceList',
  'mm02-sub-commodity': 'mm02SubCommodity',
  'apqp-plan-closure': 'apqpPlanClosure',
  operations: 'operations',
  history: 'history',
  settings: 'settings'
}

export function AppShell({
  activePage,
  onNavigate,
  onPageIntent,
  status,
  children
}: AppShellProps): React.JSX.Element {
  const { language, t } = useLocalization()
  const zh = language === 'zh-CN'
  const [preference, setPreference] = useState(readSidebarPreference)
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_WINDOW).matches)
  useEffect(() => {
    const query = window.matchMedia(COMPACT_WINDOW)
    const update = (): void => setCompact(query.matches)
    query.addEventListener('change', update)
    update()
    return () => query.removeEventListener('change', update)
  }, [])
  const collapsed = preference ?? compact
  const toggleLabel = collapsed ? zh ? '展开侧边栏' : 'Expand sidebar' : zh ? '折叠侧边栏' : 'Collapse sidebar'
  const toggleSidebar = (): void => {
    setPreference(!collapsed)
    try { window.localStorage.setItem(SIDEBAR_KEY, collapsed ? 'expanded' : 'collapsed') } catch { /* Layout still works without storage. */ }
  }
  const currentSection = navigationItems.some(item => item.id === activePage) ? activePage : 'operations'
  return (
    <div className={styles.shell} data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <aside id="workspace-sidebar" className={styles.sidebar}>
        <div className={styles.brand}>
          <div className={styles.brandMark}><Sparkles size={19} aria-hidden="true" /></div>
          <div className={styles.brandText}>
            <strong>SAP Automation</strong>
            <span>Toolbox</span>
          </div>
        </div>

        <nav className={styles.navigation} aria-label={zh ? '主导航' : 'Main navigation'}>
          <span className={styles.navLabel}>{t('workspace')}</span>
          {navigationItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`${styles.navItem} ${currentSection === item.id ? styles.active : ''}`}
                aria-label={t(item.label)}
                aria-current={currentSection === item.id ? 'page' : undefined}
                title={t(item.label)}
                onPointerEnter={() => onPageIntent(item.id)}
                onFocus={() => onPageIntent(item.id)}
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{t(item.label)}</span>
              </button>
            )
          })}
        </nav>

        <footer className={styles.sidebarFooter}>
          <button type="button" className={styles.sidebarToggle} aria-controls="workspace-sidebar"
            aria-expanded={!collapsed} aria-label={toggleLabel} title={toggleLabel} onClick={toggleSidebar}>
            {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
            <span>{toggleLabel}</span>
          </button>
          <div className={styles.security}>
            <ShieldCheck size={16} />
            <span>{t('localSecure')}</span>
          </div>
          <span className={styles.version} title={appVersion}><span className={styles.versionLabel}>Version </span>{appVersion}</span>
        </footer>
      </aside>

      <div className={styles.content}>
        <header className={styles.topbar}>
          <div className={styles.pageTitle}>
            <span className={styles.eyebrow}>Purchasing Automation Hub</span>
            <h1>{t(pageTitleKeys[activePage])}</h1>
          </div>
          <div className={styles.appStatus} data-state={status} role="status" aria-label={t('appStatus')}>
            <Activity size={15} aria-hidden="true" />
            <i aria-hidden="true" />
            <strong>{t(statusKeys[status])}</strong>
          </div>
        </header>
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  )
}
