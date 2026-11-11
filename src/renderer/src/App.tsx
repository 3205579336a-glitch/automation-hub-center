import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '../../shared/settings-types'
import type { AutomationInteraction } from '../../shared/automation-interaction'
import { NotificationCenter } from './components/common/NotificationCenter'
import { AutomationInteractionManager } from './components/common/AutomationInteractionManager'
import { AppShell, type ApplicationStatus } from './components/layout/AppShell'
import { useNotifications } from './hooks/use-notifications'
import { useSapAutomation } from './hooks/use-sap-automation'
import { LocalizationProvider } from './i18n/LocalizationProvider'
import { DashboardPage } from './pages/DashboardPage'
import { setNotificationSoundsEnabled } from './hooks/notification-sound'
import { SafeRecoveryPanel } from './components/automation/SafeRecoveryPanel'
import { TASK_FINISHED_EVENT, TaskRunContext, WorkflowVisibility } from './components/automation/task-run-context'
import type { PurchasingOperation } from './i18n/operation-copy'
import type { PageId } from './types/navigation'
import { pageLoaders, preloadPage } from './pages/page-loaders'

const OperationsPage = lazy(pageLoaders.operations)
const HistoryPage = lazy(pageLoaders.history)
const SettingsPage = lazy(pageLoaders.settings)
// Keep visited workflows mounted for drafts and progress, but do not re-render them on shell updates.
const CreateRfqPage = memo(lazy(pageLoaders['create-rfq']))
const Me12LeadTimePage = memo(lazy(pageLoaders['me12-lead-time']))
const Me01SourceListPage = memo(lazy(pageLoaders['me01-source-list']))
const Mm02SubCommodityPage = memo(lazy(pageLoaders['mm02-sub-commodity']))
const ApqpPlanClosurePage = memo(lazy(pageLoaders['apqp-plan-closure']))

const pageIds: PageId[] = [
  'dashboard',
  'create-rfq',
  'me12-lead-time',
  'me01-source-list',
  'mm02-sub-commodity',
  'apqp-plan-closure',
  'operations',
  'history',
  'settings'
]

function pageFromHash(): PageId {
  const hash = window.location.hash.replace('#/', '')
  return pageIds.includes(hash as PageId) ? (hash as PageId) : 'dashboard'
}

function WorkflowPanel({ visible, children }: { visible: boolean; children: React.ReactNode }): React.JSX.Element {
  return <div hidden={!visible}><WorkflowVisibility.Provider value={visible}>{children}</WorkflowVisibility.Provider></div>
}

export default function App(): React.JSX.Element {
  const [activePage, setActivePage] = useState<PageId>(pageFromHash)
  const [visitedPages, setVisitedPages] = useState<Set<PageId>>(() => new Set([pageFromHash()]))
  const [activeTask, setActiveTask] = useState<PurchasingOperation | null>(null)
  const taskOwner = useRef<PurchasingOperation | null>(null)
  const tryStart = useCallback((task: PurchasingOperation): (() => void) | null => {
    // Claim synchronously, before a pending render or another click can start a second run.
    if (taskOwner.current) return null
    taskOwner.current = task
    setActiveTask(task)
    let released = false
    return () => {
      if (released) return
      released = true
      taskOwner.current = null
      setActiveTask(null)
      window.dispatchEvent(new Event(TASK_FINISHED_EVENT))
      if (task === 'create-rfq') window.dispatchEvent(new Event('rfq-run-finished'))
    }
  }, [])
  const [interactionState, setInteractionState] = useState<AutomationInteraction['state'] | null>(null)
  const [preferences, setPreferences] = useState<
    Pick<AppSettings, 'language' | 'fontSize' | 'theme'>
  >({ language: 'en', fontSize: 'medium', theme: 'light' })
  const { notifications, notify, dismiss } = useNotifications()
  const automation = useSapAutomation(notify)
  const activatePage = useCallback((page: PageId): void => {
    setActivePage(page)
    setVisitedPages(current => current.has(page) ? current : new Set([...current, page]))
  }, [])

  useEffect(() => {
    const onHashChange = (): void => activatePage(pageFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => { window.removeEventListener('hashchange', onHashChange) }
  }, [activatePage])

  useEffect(() => {
    void window.sapAutomation.getSettings().then((settings) => {
      setNotificationSoundsEnabled(settings.notificationSounds !== false)
      setPreferences({
        language: settings.language,
        fontSize: settings.fontSize,
        theme: settings.theme
      })
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.fontSize = preferences.fontSize
    document.documentElement.dataset.theme = preferences.theme
    document.documentElement.lang = preferences.language
  }, [preferences])

  const navigate = useCallback((page: PageId): void => {
    if (pageFromHash() === page) return
    preloadPage(page)
    window.location.hash = `/${page}`
    activatePage(page)
  }, [activatePage])
  const pageIntent = useCallback((page: PageId): void => {
    if (pageFromHash() !== page) preloadPage(page)
  }, [])
  const backToOperations = useCallback(() => navigate('operations'), [navigate])
  const openRunningTask = useCallback(() => { if (taskOwner.current) navigate(taskOwner.current) }, [navigate])
  const runGate = useMemo(() => ({ activeTask, tryStart, openRunningTask }), [activeTask, tryStart, openRunningTask])
  const loadingPage = <p className="page page-loading" role="status">{preferences.language === 'zh-CN' ? '正在打开页面…' : 'Opening page…'}</p>
  const hasVisited = (page: PageId): boolean => activePage === page || visitedPages.has(page)
  const taskRunning = activeTask !== null
  const status: ApplicationStatus = interactionState === 'WAITING_FOR_USER' ? 'waiting'
    : interactionState === 'RECOVERING' ? 'checking'
    : taskRunning ? 'running'
    : automation.status === 'waiting-for-login' ? 'waiting'
    : automation.busy ? 'opening'
    : automation.status === 'failed' ? 'attention' : 'ready'

  const renderPage = (): React.JSX.Element => {
    switch (activePage) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigate} />
      case 'create-rfq':
        return <></>
      case 'me12-lead-time':
      case 'me01-source-list':
      case 'mm02-sub-commodity':
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
      <TaskRunContext.Provider value={runGate}>
      <AppShell activePage={activePage} onNavigate={navigate} onPageIntent={pageIntent} status={status}>
          <SafeRecoveryPanel notify={notify} busy={automation.busy || taskRunning || interactionState !== null} />
          <Suspense fallback={loadingPage}>{renderPage()}</Suspense>
          <WorkflowPanel visible={activePage === 'create-rfq'}>
            <Suspense fallback={loadingPage}>{hasVisited('create-rfq') && <CreateRfqPage notify={notify} onBack={backToOperations} />}</Suspense>
          </WorkflowPanel>
          <WorkflowPanel visible={activePage === 'me12-lead-time'}><Suspense fallback={loadingPage}>{hasVisited('me12-lead-time') && <Me12LeadTimePage notify={notify} onBack={backToOperations} />}</Suspense></WorkflowPanel>
          <WorkflowPanel visible={activePage === 'me01-source-list'}><Suspense fallback={loadingPage}>{hasVisited('me01-source-list') && <Me01SourceListPage notify={notify} onBack={backToOperations} />}</Suspense></WorkflowPanel>
          <WorkflowPanel visible={activePage === 'mm02-sub-commodity'}><Suspense fallback={loadingPage}>{hasVisited('mm02-sub-commodity') && <Mm02SubCommodityPage notify={notify} onBack={backToOperations} />}</Suspense></WorkflowPanel>
          <WorkflowPanel visible={activePage === 'apqp-plan-closure'}><Suspense fallback={loadingPage}>{hasVisited('apqp-plan-closure') && <ApqpPlanClosurePage notify={notify} onBack={backToOperations} />}</Suspense></WorkflowPanel>
        </AppShell>
        <NotificationCenter notifications={notifications} onDismiss={dismiss} />
        <AutomationInteractionManager notify={notify} onStateChange={setInteractionState} />
      </TaskRunContext.Provider>
    </LocalizationProvider>
  )
}
