import { useEffect, useState } from 'react'
import type { AppSettings } from '../../shared/settings-types'
import { SAP_TRANSACTIONS } from '../../shared/sap-transactions'
import { NotificationCenter } from './components/common/NotificationCenter'
import { AppShell } from './components/layout/AppShell'
import { useNotifications } from './hooks/use-notifications'
import { useSapAutomation } from './hooks/use-sap-automation'
import { LocalizationProvider } from './i18n/LocalizationProvider'
import { CreateRfqPage } from './pages/CreateRfqPage'
import { DashboardPage } from './pages/DashboardPage'
import { HistoryPage } from './pages/HistoryPage'
import { OperationsPage } from './pages/OperationsPage'
import { Me12LeadTimePage } from './pages/Me12LeadTimePage'
import { Me01SourceListPage } from './pages/Me01SourceListPage'
import { Me52nProjectRefPage } from './pages/Me52nProjectRefPage'
import { ApqpPlanClosurePage } from './pages/ApqpPlanClosurePage'
import { SettingsPage } from './pages/SettingsPage'
import type { PageId } from './types/navigation'

const pageIds: PageId[] = [
  'dashboard',
  'create-rfq',
  'me12-lead-time',
  'me01-source-list',
  'me52n-project-ref',
  'apqp-plan-closure',
  'operations',
  'history',
  'settings'
]

function pageFromHash(): PageId {
  const hash = window.location.hash.replace('#/', '')
  return pageIds.includes(hash as PageId) ? (hash as PageId) : 'dashboard'
}

export default function App(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>(pageFromHash)
  const [preferences, setPreferences] = useState<
    Pick<AppSettings, 'language' | 'fontSize' | 'theme'>
  >({ language: 'en', fontSize: 'medium', theme: 'light' })
  const { notifications, notify, dismiss } = useNotifications()
  const automation = useSapAutomation(notify)

  useEffect(() => {
    const onHashChange = (): void => setActivePage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    void window.sapAutomation.getSettings().then((settings) => {
      setPreferences({
        language: settings.language,
        fontSize: settings.fontSize,
        theme: settings.theme
      })
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.fontSize = preferences.fontSize
    document.documentElement.dataset.theme = preferences.theme
    document.documentElement.lang = preferences.language
  }, [preferences])

  const navigate = (page: PageId): void => {
    window.location.hash = `/${page}`
  }

  const renderPage = (): React.JSX.Element => {
    switch (activePage) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigate} />
      case 'create-rfq':
        return (
          <CreateRfqPage
            notify={notify}
            onBack={() => navigate('operations')}
          />
        )
      case 'me12-lead-time':
        return (
          <Me12LeadTimePage
            notify={notify}
            onBack={() => navigate('operations')}
          />
        )
      case 'me01-source-list':
        return (
          <Me01SourceListPage
            notify={notify}
            onBack={() => navigate('operations')}
          />
        )
      case 'me52n-project-ref':
        return <Me52nProjectRefPage notify={notify} onBack={() => navigate('operations')} />
      case 'operations':
        return <OperationsPage onNavigate={navigate} onOpenSap={() => void automation.openSapWebGui({ tcode: SAP_TRANSACTIONS.sapMenu })} automationBusy={automation.busy} />
      case 'apqp-plan-closure':
        return <ApqpPlanClosurePage notify={notify} onBack={() => navigate('operations')} />
      case 'history':
        return <HistoryPage />
      case 'settings':
        return <SettingsPage notify={notify} onPreferencesSaved={setPreferences} />
    }
  }

  return (
    <LocalizationProvider language={preferences.language}>
      <AppShell activePage={activePage} onNavigate={navigate} statusLabel={automation.statusLabel} isBusy={automation.busy}>
          {renderPage()}
        </AppShell>
        <NotificationCenter notifications={notifications} onDismiss={dismiss} />
    </LocalizationProvider>
  )
}
