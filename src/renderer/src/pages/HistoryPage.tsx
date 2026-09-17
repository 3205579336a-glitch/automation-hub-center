import { ChevronDown, ChevronUp, Eye, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type {
  ExecutionHistoryEntry,
  ExecutionHistoryStatus
} from '../../../shared/execution-history-types'
import { StatusBadge } from '../components/common/StatusBadge'
import { useLocalization } from '../i18n/use-localization'
import styles from './HistoryPage.module.css'

export function HistoryPage(): React.JSX.Element {
  const { language, t } = useLocalization()
  const [entries, setEntries] = useState<ExecutionHistoryEntry[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ExecutionHistoryStatus | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.sapAutomation.getExecutionHistory({
        search,
        statuses: status === 'all' ? undefined : [status],
        limit: 200
      })
      setEntries(result.entries)
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [search, status])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const zh = language === 'zh-CN'
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h2>{t('executionHistory')}</h2>
          <p>{zh ? '来自本机隐藏数据目录的真实自动化执行记录。' : 'Real automation runs stored in the hidden local data directory.'}</p>
        </div>
        <button className="button" onClick={() => void loadHistory()} disabled={loading}>
          <RefreshCw size={14} /> {zh ? '刷新' : 'Refresh'}
        </button>
      </div>
      <section className={`card ${styles.container}`}>
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={zh ? '搜索操作、结果、T-code…' : 'Search operation, result, T-code…'}
              aria-label="Search operations"
            />
          </div>
          <select
            className={`select ${styles.statusFilter}`}
            value={status}
            onChange={(event) => setStatus(normalizeStatus(event.target.value))}
            aria-label="History status"
          >
            <option value="all">{zh ? '全部状态' : 'All statuses'}</option>
            <option value="Running">{zh ? '运行中' : 'Running'}</option>
            <option value="Success">{zh ? '成功' : 'Success'}</option>
            <option value="Partial">{zh ? '部分成功' : 'Partial'}</option>
            <option value="Failed">{zh ? '失败' : 'Failed'}</option>
            <option value="Cancelled">{zh ? '已取消' : 'Cancelled'}</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{zh ? '操作' : 'Operation'}</th>
                <th>{zh ? '开始时间' : 'Started At'}</th>
                <th>{zh ? '耗时' : 'Duration'}</th>
                <th>{zh ? '状态' : 'Status'}</th>
                <th>{zh ? '结果' : 'Result'}</th>
                <th>{zh ? '详情' : 'Details'}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className={styles.empty}>{zh ? '正在读取本地历史…' : 'Loading local history…'}</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={6} className={styles.empty}>{zh ? '暂无匹配的真实执行记录。' : 'No matching real execution records yet.'}</td></tr>
              ) : entries.map((entry) => (
                <HistoryRows
                  entry={entry}
                  expanded={expanded === entry.id}
                  onToggle={() => setExpanded((current) => current === entry.id ? null : entry.id)}
                  zh={zh}
                  key={entry.id}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.footer}>
          <span>{zh ? `显示 ${entries.length} 条本地记录` : `Showing ${entries.length} local record(s)`}</span>
          <span>{zh ? '数据来源：.local-data/data/execution-history.json' : 'Source: .local-data/data/execution-history.json'}</span>
        </div>
      </section>
    </div>
  )
}

function HistoryRows({
  entry,
  expanded,
  onToggle,
  zh
}: {
  entry: ExecutionHistoryEntry
  expanded: boolean
  onToggle: () => void
  zh: boolean
}): React.JSX.Element {
  return (
    <>
      <tr>
        <td>
          <strong className={styles.operation}>{entry.label}</strong>
          {entry.tcode && <small className={styles.tcode}>T-code: {entry.tcode}</small>}
        </td>
        <td>{new Date(entry.startedAt).toLocaleString()}</td>
        <td>{formatDuration(entry.durationMs)}</td>
        <td><StatusBadge status={entry.status} /></td>
        <td className={styles.result}>{entry.summary}</td>
        <td>
          <button className={styles.viewButton} aria-label={`View ${entry.label}`} onClick={onToggle}>
            <Eye size={14} /> {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className={styles.detailRow}>
          <td colSpan={6}>
            <div className={styles.details}>
              <Detail label={zh ? '完成时间' : 'Completed'} value={entry.completedAt ? new Date(entry.completedAt).toLocaleString() : '—'} />
              <Detail label={entry.sessionCount !== undefined ? (zh ? 'SAP 会话数' : 'SAP sessions') : (zh ? '浏览器数' : 'Browsers')} value={entry.sessionCount ?? entry.browserCount ?? '—'} />
              <Detail label={zh ? '处理数' : 'Processed'} value={entry.processed ?? '—'} />
              <Detail label={zh ? '成功' : 'Succeeded'} value={entry.succeeded ?? '—'} />
              <Detail label={zh ? '跳过' : 'Skipped'} value={entry.skipped ?? '—'} />
              <Detail label={zh ? '失败' : 'Failed'} value={entry.failed ?? '—'} />
              <Detail label="Dry Run" value={entry.dryRun === undefined ? '—' : entry.dryRun ? 'Yes' : 'No'} />
            </div>
            {entry.resultPath && <PathLine label={zh ? '结果文件' : 'Result file'} value={entry.resultPath} />}
            {entry.backupPath && <PathLine label={zh ? '备份文件' : 'Backup file'} value={entry.backupPath} />}
            {entry.logPath && <PathLine label={zh ? '详细日志' : 'Detailed log'} value={entry.logPath} />}
          </td>
        </tr>
      )}
    </>
  )
}

function Detail({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function PathLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <p className={styles.path}><strong>{label}</strong><code>{value}</code></p>
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) {
    return '—'
  }
  if (value < 1_000) {
    return '<1 sec'
  }
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) {
    return `${seconds} sec`
  }
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function normalizeStatus(value: string): ExecutionHistoryStatus | 'all' {
  if (
    value === 'Running' ||
    value === 'Success' ||
    value === 'Partial' ||
    value === 'Failed' ||
    value === 'Cancelled'
  ) {
    return value
  }
  return 'all'
}
