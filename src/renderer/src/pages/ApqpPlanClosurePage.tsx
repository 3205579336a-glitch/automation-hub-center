import { ArrowLeft, CalendarClock, Search } from 'lucide-react'
import { lazy, Suspense, useContext, useState } from 'react'
import { useLocalization } from '../i18n/use-localization'
import { ApqpDateEditor } from '../components/automation/ApqpDateEditor'
import { WorkflowVisibility } from '../components/automation/task-run-context'
import styles from './ApqpDateManagement.module.css'
import type { Notify } from '../types/notifications'

const loadClosure = () => import('../components/automation/GuidedAutomationPage').then(m => ({ default: m.GuidedAutomationPage }))
const GuidedAutomationPage = lazy(loadClosure)
const preloadClosure = (): void => { void loadClosure().catch(() => undefined) }

export function ApqpPlanClosurePage({ notify, onBack }: { notify: Notify; onBack: () => void }): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const visible = useContext(WorkflowVisibility)
  const [mode, setMode] = useState<'dates' | 'closure'>('dates')
  const [openedClosure, setOpenedClosure] = useState(false)
  const [dateBusy, setDateBusy] = useState(false)
  const [closureBusy, setClosureBusy] = useState(false)
  return <div className="page">
    <button className={styles.back} onClick={onBack}><ArrowLeft size={15} />{zh ? '返回操作中心' : 'Back to Operations'}</button>
    <div className="page-heading"><div><h2>{zh ? 'APQP 日期管理' : 'APQP Date Management'}</h2>
      <p>{zh ? '按项目查找并修改 APQP 计划日期，或使用 Excel 批量查询关闭日期。' : 'Find and update APQP planned dates by project, or query closure dates using Excel.'}</p></div></div>
    <div className={styles.tabs} role="tablist" aria-label={zh ? 'APQP 操作' : 'APQP workflow'}>
      <button role="tab" id="apqp-dates-tab" aria-controls="apqp-dates-panel" aria-selected={mode === 'dates'} disabled={dateBusy || closureBusy} onClick={() => setMode('dates')}><CalendarClock size={18} /><span>{zh ? '查找 APQP 并编辑日期' : 'Find APQPs & Edit Dates'}</span></button>
      <button role="tab" id="apqp-closure-tab" aria-controls="apqp-closure-panel" aria-selected={mode === 'closure'} disabled={dateBusy || closureBusy}
        onPointerEnter={preloadClosure} onFocus={preloadClosure} onClick={() => { setOpenedClosure(true); setMode('closure') }}><Search size={18} /><span>{zh ? '批量查询计划关闭日期' : 'Query Plan Closure Date'}</span></button>
    </div>
    <div id="apqp-dates-panel" role="tabpanel" aria-labelledby="apqp-dates-tab" hidden={mode !== 'dates'}>
      <WorkflowVisibility.Provider value={visible && mode === 'dates'}><ApqpDateEditor notify={notify} onBusyChange={setDateBusy} /></WorkflowVisibility.Provider>
    </div>
    <div id="apqp-closure-panel" role="tabpanel" aria-labelledby="apqp-closure-tab" hidden={mode !== 'closure'}>
      <Suspense fallback={<p className="page-loading" role="status">{zh ? '正在打开批量查询…' : 'Opening batch query…'}</p>}>
        <WorkflowVisibility.Provider value={visible && mode === 'closure'}>
          {openedClosure && <GuidedAutomationPage module="apqp" notify={notify} onBack={onBack} embedded onBusyChange={setClosureBusy} />}
        </WorkflowVisibility.Provider>
      </Suspense>
    </div>
  </div>
}
