import { ChevronDown, ChevronUp, Eye, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ExecutionHistoryEntry,
  ExecutionHistoryStatus
} from '../../../shared/execution-history-types'
import { StatusBadge } from '../components/common/StatusBadge'
import { useLocalization } from '../i18n/use-localization'
import styles from './HistoryPage.module.css'
import { operationName } from './operation-name'
import { ClearLogsButton } from '../components/common/ClearLogsButton'
import { LogPagination } from '../components/common/LogPagination'

const PAGE_SIZE = 25

export function HistoryPage(): React.JSX.Element {
  const { language, t } = useLocalization()
  const [entries, setEntries] = useState<ExecutionHistoryEntry[]>([])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ExecutionHistoryStatus | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const request = useRef(0)

  const loadHistory = useCallback(async () => {
    const current = ++request.current
    setLoading(true)
    try {
      const result = await window.sapAutomation.getExecutionHistory({
        search,
        statuses: status === 'all' ? undefined : [status],
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        operations: ['create-rfq', 'me12-batch', 'me01-source-list', 'apqp-plan-closure']
      })
      if (current !== request.current) return
      setEntries(result.entries)
      setTotal(result.total ?? result.entries.length)
      const lastPage = Math.max(1, Math.ceil((result.total ?? result.entries.length) / PAGE_SIZE))
      if (page > lastPage) setPage(lastPage)
    } catch {
      if (current === request.current) { setEntries([]); setTotal(0) }
    } finally {
      if (current === request.current) setLoading(false)
    }
  }, [search, status, page])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const zh = language === 'zh-CN'
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h2>{t('executionHistory')}</h2>
          <p>{zh ? '本机真实执行记录，每页 25 条；60 天前的已结束历史及日志自动清理，结果文件保留。' : 'Real local runs, 25 per page. Completed history/logs older than 60 days are automatically cleaned; result files are kept.'}</p>
        </div>
        <button className="button" onClick={() => void loadHistory()} disabled={loading}>
          <RefreshCw size={14} /> {zh ? '刷新' : 'Refresh'}
        </button>
      </div>
      <ClearLogsButton onCleared={async () => { setPage(1); setExpanded(null); await loadHistory() }} />
      <section className={`card ${styles.container}`}>
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <Search size={14} />
            <input
              value={search}
              onChange={(event) => { setSearch(event.target.value); setPage(1); setExpanded(null) }}
              placeholder={zh ? '搜索操作、结果…' : 'Search operation, result…'}
              aria-label="Search operations"
            />
          </div>
          <select
            className={`select ${styles.statusFilter}`}
            value={status}
            onChange={(event) => { setStatus(normalizeStatus(event.target.value)); setPage(1); setExpanded(null) }}
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
          <span>{zh ? `共 ${total} 条，本页 ${entries.length} 条` : `${total} total, ${entries.length} on this page`}</span>
          <span>{zh ? '数据来源：.local-data/data/execution-history.json' : 'Source: .local-data/data/execution-history.json'}</span>
        </div>
        <LogPagination page={page} totalPages={Math.ceil(total / PAGE_SIZE)} hasMore={page * PAGE_SIZE < total} loading={loading}
          onPage={next => { setPage(next); setExpanded(null) }} />
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
          <strong className={styles.operation}>{operationName(entry, zh)}</strong>
        </td>
        <td>{new Date(entry.startedAt).toLocaleString()}</td>
        <td>{formatDuration(entry.durationMs)}</td>
        <td><StatusBadge status={entry.status} /></td>
        <td className={styles.result}>{entry.processed !== undefined ? `${entry.succeeded ?? 0} ${zh ? '成功' : 'successful'} · ${entry.failed ?? 0} ${zh ? '失败' : 'failed'}` : zh ? '查看详情' : 'View details'}</td>
        <td>
          <button className={styles.viewButton} aria-label={`View ${operationName(entry, zh)}`} onClick={onToggle}>
            <Eye size={14} /> {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className={styles.detailRow}>
          <td colSpan={6}>
            <div className={styles.details}>
              <p>{entry.summary}</p><Detail label="T-code" value={entry.tcode ?? '—'} />
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
