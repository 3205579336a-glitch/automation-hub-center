import {
  ArrowRight, CalendarDays, CalendarSearch, CheckCircle2, ChevronRight, CircleX, Clock3,
  FilePlus2, ListChecks, Monitor, Sparkles, Tags, Timer, Workflow
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DashboardCounts, DashboardSnapshot } from '../../../shared/dashboard-types'
import { DEFAULT_TASK_ORDER, rankTasks, type AutomationId, type TaskRanking } from '../../../shared/local-intelligence'
import type { TimeSavingsSummary } from '../../../shared/time-savings'
import { StatusBadge } from '../components/common/StatusBadge'
import { TASK_FINISHED_EVENT } from '../components/automation/task-run-context'
import { TASK_PAGES, TASK_RANKING_WAIT_MS } from '../hooks/use-task-ranking'
import { operationCopy } from '../i18n/operation-copy'
import { useLocalization } from '../i18n/use-localization'
import { getWindowsUsername } from '../services/windows-account'
import type { PageId } from '../types/navigation'
import { operationName } from './operation-name'
import { preloadPage } from './page-loaders'
import styles from './DashboardPage.module.css'

const shortcuts = {
  'create-rfq': { icon: FilePlus2, tone: 'violet', en: 'Create from NPL', zh: '从 NPL 批量创建' },
  'me12-batch': { icon: Timer, tone: 'green', en: 'Lead times and confirmation control', zh: '交期与确认控制码' },
  'apqp-plan-closure': { icon: CalendarSearch, tone: 'blue', en: 'Find and maintain APQP dates', zh: '查询和维护 APQP 日期' },
  'me01-source-list': { icon: ListChecks, tone: 'amber', en: 'Maintain supplier assignments', zh: '维护物料货源' },
  'mm02-sub-commodity': { icon: Tags, tone: 'violet', en: 'Update material classification', zh: '更新物料分类' }
} satisfies Record<AutomationId, { icon: typeof Timer; tone: string; en: string; zh: string }>

export function DashboardPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const { language, t } = useLocalization()
  const zh = language === 'zh-CN'
  const [username, setUsername] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [ranking, setRanking] = useState<TaskRanking | null>(null)

  useEffect(() => {
    let active = true
    void getWindowsUsername().then(value => { if (active) setUsername(value) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    let inFlight = false
    let needsRefresh = false
    let lastRefresh = -Infinity
    const fallback = window.setTimeout(() => setRanking(current => current ?? rankTasks([])), TASK_RANKING_WAIT_MS)
    const load = async (): Promise<void> => {
      if (inFlight) { needsRefresh = true; return }
      inFlight = true
      lastRefresh = performance.now()
      try {
        const result = await window.sapAutomation.getDashboardSnapshot()
        if (!active) return
        setSnapshot(result)
        setRanking(current => current ?? result.ranking)
        window.clearTimeout(fallback)
      } catch {
        if (!active) return
        setRanking(current => current ?? rankTasks([]))
        window.clearTimeout(fallback)
      } finally {
        inFlight = false
        if (active) {
          setLoading(false)
          if (needsRefresh) { needsRefresh = false; void load() }
        }
      }
    }
    void load()
    const finished = (): void => { void load() }
    const focus = (): void => { if (!inFlight && performance.now() - lastRefresh >= 1200) void load() }
    window.addEventListener(TASK_FINISHED_EVENT, finished)
    window.addEventListener('focus', focus)
    return () => {
      active = false
      window.clearTimeout(fallback)
      window.removeEventListener(TASK_FINISHED_EVENT, finished)
      window.removeEventListener('focus', focus)
    }
  }, [])

  const metrics = buildMetrics(snapshot?.counts ?? null, zh, loading)
  const recent = snapshot?.recent ?? []
  const today = new Intl.DateTimeFormat(language, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())
  return (
    <div className={`page ${styles.dashboard}`}>
      <section className={styles.welcome} aria-labelledby="dashboard-welcome">
        <div className={styles.heroContent}>
          <div className={styles.date}><CalendarDays size={15} aria-hidden="true" /> {today}</div>
          <h2 id="dashboard-welcome">{t('welcome')}</h2>
          <p>{zh ? '在一个工作区运行采购自动化，并查看进度和结果。' : 'Run your purchasing workflows and review their results in one place.'}</p>
          <button type="button" className={styles.primaryButton} onPointerEnter={() => preloadPage('operations')} onFocus={() => preloadPage('operations')} onClick={() => onNavigate('operations')}>
            {t('openOperations')} <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.heroArt} aria-hidden="true"><div className={styles.artTile}><Sparkles size={40} strokeWidth={1.45} /></div></div>
        <div className={styles.account}>
          <div className={styles.accountIcon}><Monitor size={17} aria-hidden="true" /></div>
          <div className={styles.accountText}>
            <small>{username ? zh ? 'Windows 登录名' : 'Windows account' : t('localWorkspace')}</small>
            <strong dir="auto">{username ?? (zh ? '此设备' : 'This device')}</strong>
          </div>
        </div>
      </section>

      <section className={styles.metrics} aria-label={zh ? '自动化概览' : 'Automation summary'}>
        {metrics.map(({ label, note, value, icon: Icon, tone }) => (
          <article className={styles.metric} key={label}>
            <div className={`${styles.iconTile} ${styles[tone]}`}><Icon size={18} aria-hidden="true" /></div>
            <div className={styles.metricBody}>
              <div className={styles.metricLabel}>{t(label)}</div>
              <div className={styles.metricValue}>{value}</div>
              <small>{note}</small>
            </div>
          </article>
        ))}
      </section>

      <div className={styles.dashboardGrid}>
        <section className={styles.panel} aria-labelledby="dashboard-shortcuts">
          <div className={styles.sectionHeader}>
            <div><h3 id="dashboard-shortcuts">{t('quickActions')}</h3>
              <p>{!ranking ? zh ? '正在加载任务…' : 'Loading tasks…'
                : ranking.personalized ? zh ? '常用任务优先 · 根据本机运行记录排列' : 'Your most-used tasks first, based on local history'
                  : zh ? '选择一项任务，开始自动批量处理。' : 'Choose a task to start a batch.'}</p></div>
          </div>
          {ranking && <div className={styles.actionsGrid} aria-label={zh ? '任务快捷入口' : 'Task shortcuts'}>
            {ranking.order.map(id => {
              const item = shortcuts[id]
              const Icon = item.icon
              const title = operationCopy(TASK_PAGES[id], language).shortTitle
              return <button type="button" key={id} className={styles.shortcut} onPointerEnter={() => preloadPage(TASK_PAGES[id])} onFocus={() => preloadPage(TASK_PAGES[id])} onClick={() => onNavigate(TASK_PAGES[id])}>
                <span className={`${styles.iconTile} ${styles[item.tone]}`}><Icon size={20} aria-hidden="true" /></span>
                <span className={styles.shortcutText}><strong>{title}</strong><small>{zh ? item.zh : item.en}</small></span>
                <ChevronRight size={16} className={styles.shortcutArrow} aria-hidden="true" />
              </button>
            })}
          </div>}
        </section>

        <div className={styles.summaryStack}>
          <SavingsPanel savings={snapshot?.savings ?? null} loading={loading} zh={zh} />
          <section className={styles.panel} aria-labelledby="dashboard-activity">
            <div className={styles.sectionHeader}>
              <div><h3 id="dashboard-activity">{t('recentActivity')}</h3><p>{t('recentActivityCopy')}</p></div>
              <button type="button" className={styles.textButton} onClick={() => onNavigate('history')}>{zh ? '查看历史' : 'View history'} <ArrowRight size={15} aria-hidden="true" /></button>
            </div>
            {recent.length > 0 ? <ul className={styles.activityList}>
              {recent.map(item => <li className={styles.activityItem} key={item.id}>
                <div className={styles.activityDetails}>
                  <strong>{operationName(item, zh)}</strong>
                  <span>{new Date(item.startedAt).toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {formatDuration(item.durationMs, zh)}</span>
                </div>
                <StatusBadge status={item.status} />
              </li>)}
            </ul> : <p className={styles.emptyActivity}>{loading ? zh ? '正在读取运行记录…' : 'Loading run history…'
              : snapshot ? zh ? '暂无运行记录。' : 'No runs yet.' : zh ? '暂时无法读取运行记录。' : 'Run history is unavailable.'}</p>}
          </section>
        </div>
      </div>
    </div>
  )
}

function SavingsPanel({ savings, loading, zh }: { savings: TimeSavingsSummary | null; loading: boolean; zh: boolean }): React.JSX.Element {
  const none = loading ? '…' : '—'
  return (
    <section className={`${styles.panel} ${styles.savings}`} aria-labelledby="dashboard-savings">
      <div className={styles.sectionHeader}>
        <div><h3 id="dashboard-savings">{zh ? '预计节省时间' : 'Estimated time saved'}</h3>
          <p>{zh ? '根据本机记录与人工耗时基准估算。' : 'Based on local runs and manual-time estimates.'}</p></div>
        <div className={`${styles.iconTile} ${styles.blue}`}><Clock3 size={18} aria-hidden="true" /></div>
      </div>
      <div className={styles.savingsMetrics}>
        <div><div>{zh ? '今日' : 'Today'}</div><div className={styles.savingsValue}>{savings ? savedTime(savings.today.savedMs, zh) : none}</div>
          <small>{savings ? `${savings.today.runs} ${zh ? '次已确认运行' : 'confirmed runs'}` : '—'}</small></div>
        <div><div>{zh ? '全部时间' : 'All time'}</div><div className={styles.savingsValue}>{savings ? savedTime(savings.allTime.savedMs, zh) : none}</div>
          <small>{zh ? '本机保留的全部记录' : 'All retained local records'}</small></div>
      </div>
      {savings && <details className={styles.savingsDetails}>
        <summary>{zh ? '计算依据与基准' : 'Calculation and baselines'}</summary>
        <p>{zh ? '预计节省 = 已确认成功数量 × 人工单次耗时 − 整批实际耗时（含 SAP 等待和人工暂停，下限为 0）。' : 'Estimated savings = confirmed successful units × manual time per unit − full batch time, including SAP and human waits, floored at zero.'}</p>
        <p>{zh ? `APQP 日期：每个已保存并核实的字段按人工 1 分钟估算，本机保留记录中共完成 ${savings.allTime.successfulDateFields} 个字段。` : `APQP dates: 1 manual minute per saved and verified field. ${savings.allTime.successfulDateFields} date fields completed across retained records.`}</p>
        <p>{savings.calibrated ? zh ? '基准已由 Key User 标记校准。' : 'Baselines marked calibrated by a key user.' : zh ? '基准为未校准的参考值。统计仅使用本机保留的有效记录。' : 'Baselines are uncalibrated estimates. Only valid, retained local records count.'}</p>
        <ul>{Object.entries(savings.baselines).map(([id, seconds]) => <li key={id}>{id === 'create-rfq' ? 'RFQ' : id === 'me12-batch' ? 'SLT' : id === 'me01-source-list' ? 'Source List' : 'APQP'}: {seconds} {zh ? '秒' : 'sec'} / {id === 'create-rfq' ? zh ? '分组' : 'group' : zh ? '记录' : 'record'}</li>)}</ul>
      </details>}
    </section>
  )
}

function savedTime(ms: number, zh: boolean): string {
  const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60)
  return hours ? zh ? `${hours} 小时 ${minutes % 60} 分` : `${hours}h ${minutes % 60}m` : zh ? `${minutes} 分钟` : `${minutes} min`
}

function buildMetrics(counts: DashboardCounts | null, zh: boolean, loading: boolean) {
  const { today, yesterday, successful, failed, finalized } = counts ?? {
    today: 0, yesterday: 0, successful: 0, failed: 0, finalized: 0
  }
  const rate = finalized ? Math.round(successful / finalized * 100) : null
  const pending = loading ? '…' : counts === null ? '—' : null
  return [
    { label: 'availableOperations' as const, value: DEFAULT_TASK_ORDER.length, note: zh ? '采购自动化任务' : 'Purchasing workflows', icon: Workflow, tone: 'blue' },
    { label: 'runsToday' as const, value: pending ?? today, note: pending ? '—' : zh ? `昨日 ${yesterday} 次` : `${yesterday} yesterday`, icon: Clock3, tone: 'violet' },
    { label: 'successfulRuns' as const, value: pending ?? successful, note: pending ? '—' : rate === null ? zh ? '今日尚无完成记录' : 'None completed today' : zh ? `今日成功率 ${rate}%` : `${rate}% success rate today`, icon: CheckCircle2, tone: 'green' },
    { label: 'failedRuns' as const, value: pending ?? failed, note: pending ? '—' : failed ? zh ? '需要检查' : 'Requires review' : zh ? '今日无失败' : 'No failures today', icon: CircleX, tone: 'red' }
  ]
}

function formatDuration(value: number | undefined, zh: boolean): string {
  if (value === undefined) return '—'
  const seconds = Math.max(1, Math.round(value / 1_000))
  if (seconds < 60) return zh ? `${seconds} 秒` : `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return zh ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes}m ${seconds % 60}s`
}
