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
import { StatusBadge } from '../components/common/StatusBadge'
import { useLocalization } from '../i18n/use-localization'
import type { PageId } from '../types/navigation'
import styles from './DashboardPage.module.css'

interface DashboardPageProps {
  onNavigate: (page: PageId) => void
}

export function DashboardPage({
  onNavigate
}: DashboardPageProps): React.JSX.Element {
  const { language, t } = useLocalization()
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const zh = language === 'zh-CN'

  useEffect(() => {
    let mounted = true
    void window.sapAutomation.getExecutionHistory({ limit: 200 }).then((result) => {
      if (mounted) {
        setHistory(result.entries)
        setLoading(false)
      }
    }).catch(() => {
      if (mounted) {
        setHistory([])
        setLoading(false)
      }
    })
    return () => { mounted = false }
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
                  <strong>{item.label}</strong>
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
    { label: 'availableOperations' as const, value: '6', note: zh ? `${running} 个正在运行` : `${running} currently running`, icon: Workflow, tone: 'blue' as const },
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
