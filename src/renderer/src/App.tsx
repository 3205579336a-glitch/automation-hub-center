import { useEffect, useState } from 'react'
import type { AppSettings } from '../../shared/settings-types'
import type { AutomationInteraction } from '../../shared/automation-interaction'
import { NotificationCenter } from './components/common/NotificationCenter'
import { AutomationInteractionManager } from './components/common/AutomationInteractionManager'
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
import { setNotificationSoundsEnabled } from './hooks/notification-sound'
import { ApqpPlanClosurePage } from './pages/ApqpPlanClosurePage'
import { SettingsPage } from './pages/SettingsPage'
import type { PageId } from './types/navigation'

const pageIds: PageId[] = [
  'dashboard',
  'create-rfq',
  'me12-lead-time',
  'me01-source-list',
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
  const [guidedBusy, setGuidedBusy] = useState(false)
  const [rfqBusy, setRfqBusy] = useState(false)
  const [interactionState, setInteractionState] = useState<AutomationInteraction['state'] | null>(null)
  const [preferences, setPreferences] = useState<
    Pick<AppSettings, 'language' | 'fontSize' | 'theme'>
  >({ language: 'en', fontSize: 'medium', theme: 'light' })
  const { notifications, notify, dismiss } = useNotifications()
  const automation = useSapAutomation(notify)

  useEffect(() => {
    const onHashChange = (): void => setActivePage(pageFromHash())
    const onGuidedRunning = (event: Event): void => setGuidedBusy(Boolean((event as CustomEvent).detail))
    window.addEventListener('guided-running', onGuidedRunning)
    window.addEventListener('hashchange', onHashChange)
    return () => { window.removeEventListener('hashchange', onHashChange); window.removeEventListener('guided-running', onGuidedRunning) }
  }, [])

  useEffect(() => {
    void window.sapAutomation.getSettings().then((settings) => {
      setNotificationSoundsEnabled(settings.notificationSounds !== false)
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
        return <></>
      case 'me12-lead-time':
      case 'me01-source-list':
      case 'apqp-plan-closure':
        return <></>
      case 'operations':
        return <OperationsPage onNavigate={navigate} />
      case 'history':
        return <HistoryPage />
      case 'settings':
        return <SettingsPage notify={notify} onPreferencesSaved={setPreferences} />
    }
  }

  return (
    <LocalizationProvider language={preferences.language}>
      <AppShell activePage={activePage} onNavigate={navigate} statusLabel={interactionState === 'WAITING_FOR_USER' ? preferences.language === 'zh-CN' ? '已暂停，等待用户处理' : 'Paused — waiting for user' : interactionState === 'RECOVERING' ? preferences.language === 'zh-CN' ? '正在验证 SAP' : 'Checking SAP' : guidedBusy || rfqBusy || automation.busy ? preferences.language === 'zh-CN' ? '正在运行' : 'Running' : automation.statusLabel} isBusy={automation.busy || guidedBusy || rfqBusy || interactionState !== null}>
          {renderPage()}
          <div hidden={activePage !== 'create-rfq'}>
            <CreateRfqPage notify={notify} onBack={() => navigate('operations')} onRunningChange={setRfqBusy} />
          </div>
          <div hidden={activePage !== 'me12-lead-time'}><Me12LeadTimePage notify={notify} onBack={() => navigate('operations')} /></div>
          <div hidden={activePage !== 'me01-source-list'}><Me01SourceListPage notify={notify} onBack={() => navigate('operations')} /></div>
          <div hidden={activePage !== 'apqp-plan-closure'}><ApqpPlanClosurePage notify={notify} onBack={() => navigate('operations')} /></div>
        </AppShell>
        <NotificationCenter notifications={notifications} onDismiss={dismiss} />
        <AutomationInteractionManager notify={notify} onStateChange={setInteractionState} />
    </LocalizationProvider>
  )
}
