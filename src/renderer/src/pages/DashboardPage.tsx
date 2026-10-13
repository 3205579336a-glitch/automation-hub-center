import {
  ArrowRight,
  Bot,
  Boxes,
  CheckCircle2,
  CircleX,
  Clock3,
  Workflow
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ExecutionHistoryEntry } from '../../../shared/execution-history-types'
import type { TimeSavingsSummary } from '../../../shared/time-savings'
import { StatusBadge } from '../components/common/StatusBadge'
import { useLocalization } from '../i18n/use-localization'
import type { PageId } from '../types/navigation'
import styles from './DashboardPage.module.css'
import { operationName } from './operation-name'
import { TASK_PAGES, useTaskRanking } from '../hooks/use-task-ranking'
import { operationCopy } from '../i18n/operation-copy'

interface DashboardPageProps {
  onNavigate: (page: PageId) => void
}

export function DashboardPage({
  onNavigate
}: DashboardPageProps): React.JSX.Element {
  const { language, t } = useLocalization()
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [savings, setSavings] = useState<TimeSavingsSummary | null>(null)
  const [savingsLoading, setSavingsLoading] = useState(true)
  const zh = language === 'zh-CN'
  const { ranking, loading: rankingLoading } = useTaskRanking()

  useEffect(() => {
    let active = true
    let request = 0
    const load = (): void => {
      const current = ++request
      void Promise.allSettled([window.sapAutomation.getTimeSavings(), window.sapAutomation.getExecutionHistory({ limit: 200 })]).then(([estimate, result]) => {
        if (!active || current !== request) return
        setSavings(estimate.status === 'fulfilled' ? estimate.value : null)
        setHistory(result.status === 'fulfilled' ? result.value.entries.filter(entry => entry.operation !== 'me52n-project-ref' && entry.operation !== 'open-sap') : [])
        setSavingsLoading(false); setLoading(false)
      })
    }
    load()
    const guided = (event: Event): void => { if (!(event as CustomEvent).detail) load() }
    window.addEventListener('rfq-run-finished', load); window.addEventListener('guided-running', guided); window.addEventListener('focus', load)
    return () => { active = false; window.removeEventListener('rfq-run-finished', load); window.removeEventListener('guided-running', guided); window.removeEventListener('focus', load) }
  }, [])

  const metrics = useMemo(() => buildMetrics(history, zh, loading), [history, zh, loading])
  const recentActivity = history.slice(0, 3)
  return (
    <div className="page">
      <section className={styles.welcome}>
        <div>
          <span className={styles.welcomeEyebrow}>{t('automationWorkspace')}</span>
          <h2>{t('welcome')}</h2>
          <p>{t('welcomeCopy')}</p>
        </div>
        <div className={styles.localBadge}>
          <Bot size={17} />
          <div><strong>{t('desktopReady')}</strong><span>{t('desktopReadyCopy')}</span></div>
        </div>
      </section>

      <section className={styles.metrics} aria-label="Automation summary">
        {metrics.map((metric) => {
          const Icon = metric.icon
          return (
            <article className={`card ${styles.metric}`} key={metric.label}>
              <div className={`${styles.metricIcon} ${styles[metric.tone]}`}><Icon size={18} /></div>
              <div className={styles.metricBody}>
                <span>{t(metric.label)}</span>
                <strong>{metric.value}</strong>
                <small>{metric.note}</small>
              </div>
            </article>
          )
        })}
      </section>

      <section className={`card ${styles.savings}`} aria-label={zh ? '预计节省时间' : 'Estimated time saved'}>
        <div><h3>{zh ? '预计节省时间' : 'Estimated time saved'}</h3><p>{zh ? '根据本机保留记录和当前人工耗时基准估算。' : 'Estimated from retained local history and current manual-time assumptions.'}</p></div>
        {savings && <span style={{marginTop:'-10px'}}>{zh ? '人工基准：Key User 已校准' : 'Manual baseline: key-user calibrated' }</span>}
        <div className={styles.savingsMetrics}>
          <div><span>{zh ? '今日' : 'Today'}</span><strong>{savingsLoading ? '…' : savings ? savedTime(savings.today.savedMs, zh) : '—'}</strong><small>{savings ? `${savings.today.runs} ${zh ? '次已确认运行' : 'confirmed runs'}` : zh ? '统计暂不可用' : 'Statistics unavailable'}</small></div>
          <div><span>{zh ? '最近 30 天' : 'Last 30 days'}</span><strong>{savingsLoading ? '…' : savings ? savedTime(savings.last30Days.savedMs, zh) : '—'}</strong><small>{savings ? `${savings.last30Days.successfulUnits} ${zh ? '个成功分组／记录' : 'successful groups / records'}` : '—'}</small></div>
        </div>
        {savings && <details><summary>{zh ? '计算依据与基准' : 'Calculation and baselines'}</summary>
          <p>{zh ? '人工预计耗时 = 已确认成功数量 × 人工单次耗时；预计节省 = 人工预计耗时 − 整批实际耗时（包含 SAP 等待和人工暂停，下限为 0）。并发不会重复扣除实际耗时。' : 'Manual estimate = confirmed successful units × manual seconds per unit. Savings = manual estimate − full batch elapsed time, including SAP and human waits, floored at zero. Worker counts never multiply elapsed time.'}</p>
          <p>{zh ? '失败、取消、演练、跳过、未核查和缺少数量／耗时的记录不计入成功量。删除历史或 60 天清理后，统计仅反映仍保留的记录。' : 'Failed, cancelled, dry-run, skipped, unresolved or incomplete records are not counted as successful work. Statistics reflect only retained history after history deletion or retention cleanup.'}</p>
          <p>{savings.calibrated ? zh ? '基准：Key User 已标记校准。' : 'Baseline: marked calibrated by a key user.' : zh ? '基准：系统内置参考值，尚未校准；无需用户配置。' : 'Baseline: built-in reference assumptions, not calibrated. No user configuration is required.'}</p>
          <ul>{Object.entries(savings.baselines).map(([id, seconds]) => <li key={id}>{id === 'create-rfq' ? 'RFQ' : id === 'me12-batch' ? 'SLT' : id === 'me01-source-list' ? 'Source List' : 'APQP'}: {seconds} {zh ? '秒' : 'sec'} / {id === 'create-rfq' ? zh ? '分组' : 'group' : zh ? '记录' : 'record'}</li>)}</ul>
        </details>}
      </section>
      <div className={styles.dashboardGrid}>
        <section className={`card ${styles.quickActions}`}>
          <div className={styles.sectionHeader}>
            <div><h3 className="section-title">{t('quickActions')}</h3><p className="section-copy">{t('quickActionsCopy')}</p></div>
            <button className={styles.linkButton} onClick={() => onNavigate('operations')}>
              {t('openOperations')} <ArrowRight size={13} />
            </button>
          </div>
          <div className={styles.catalogCta}>
            <div className={`${styles.operationIcon} ${styles.sapIcon}`}><Boxes size={22} /></div>
            <div>
              <h4>{t('automationCatalog')}</h4>
              <p>{t('automationCatalogCopy')}</p>
            </div>
            <button className="button primary" onClick={() => onNavigate('operations')}>
              {t('openOperations')} <ArrowRight size={13} />
            </button>
          </div>
          <p className="section-copy">{rankingLoading ? zh ? '正在加载任务…' : 'Loading tasks…'
            : ranking.personalized ? zh ? '常用任务优先 · 仅根据本机运行记录' : 'Common tasks first · Local history only'
            : zh ? '选择一个任务开始自动批量处理' : 'Choose a task to start automated batch processing'}</p>
          {!rankingLoading && <div className={styles.actionsGrid} aria-label={zh ? '任务快捷入口' : 'Task shortcuts'}>
            {ranking.order.map(id => <button key={id} className="button" onClick={() => onNavigate(TASK_PAGES[id])}>
              {operationCopy(TASK_PAGES[id], language).shortTitle}<ArrowRight size={13} />
            </button>)}
          </div>}
        </section>

        <section className={`card ${styles.activity}`}>
          <div className={styles.sectionHeader}>
            <div><h3 className="section-title">{t('recentActivity')}</h3><p className="section-copy">{t('recentActivityCopy')}</p></div>
            <Clock3 size={16} />
          </div>
          <div className={styles.activityList}>
            {recentActivity.map((item) => (
              <div className={styles.activityItem} key={item.id}>
                <span className={`${styles.activityDot} ${item.status === 'Success' ? styles.dotSuccess : styles.dotMuted}`} />
                <div className={styles.activityDetails}>
                  <strong>{operationName(item, zh)}</strong>
                  <span>{new Date(item.startedAt).toLocaleString()} · {formatDuration(item.durationMs, zh)}</span>
                </div>
                <StatusBadge status={item.status} />
              </div>
            ))}
            {!loading && recentActivity.length === 0 && (
              <p className={styles.emptyActivity}>{zh ? '暂无真实执行记录。' : 'No real execution records yet.'}</p>
            )}
          </div>
          <button className={styles.historyButton} onClick={() => onNavigate('history')}>
            {t('openHistory')} <ArrowRight size={13} />
          </button>
        </section>
      </div>
    </div>
  )
}
function savedTime(ms: number, zh: boolean): string {
  const minutes = Math.floor(ms / 60000), hours = Math.floor(minutes / 60)
  return hours ? zh ? `${hours} 小时 ${minutes % 60} 分` : `${hours}h ${minutes % 60}m` : zh ? `${minutes} 分钟` : `${minutes} min`
}

function buildMetrics(history: ExecutionHistoryEntry[], zh: boolean, loading: boolean) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1_000
  const today = history.filter((entry) => new Date(entry.startedAt).getTime() >= todayStart)
  const yesterday = history.filter((entry) => {
    const started = new Date(entry.startedAt).getTime()
    return started >= yesterdayStart && started < todayStart
  })
  const successful = today.filter((entry) => entry.status === 'Success').length
  const failed = today.filter((entry) => entry.status === 'Failed').length
  const running = history.filter((entry) => entry.status === 'Running').length
  const successRate = today.length === 0 ? 0 : Math.round((successful / today.length) * 100)
  const pending = loading ? '…' : undefined

  return [
    { label: 'availableOperations' as const, value: '4', note: zh ? `${running} 个正在运行` : `${running} currently running`, icon: Workflow, tone: 'blue' as const },
    { label: 'runsToday' as const, value: pending ?? String(today.length), note: zh ? `昨日 ${yesterday.length} 次` : `${yesterday.length} yesterday`, icon: Clock3, tone: 'violet' as const },
    { label: 'successfulRuns' as const, value: pending ?? String(successful), note: zh ? `今日成功率 ${successRate}%` : `${successRate}% success rate today`, icon: CheckCircle2, tone: 'green' as const },
    { label: 'failedRuns' as const, value: pending ?? String(failed), note: failed > 0 ? (zh ? '需要检查' : 'Requires review') : (zh ? '今日无失败' : 'No failures today'), icon: CircleX, tone: 'red' as const }
  ]
}

function formatDuration(value: number | undefined, zh: boolean): string {
  if (value === undefined) return '—'
  const seconds = Math.max(1, Math.round(value / 1_000))
  if (seconds < 60) return zh ? `${seconds} 秒` : `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return zh ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes}m ${seconds % 60}s`
}
