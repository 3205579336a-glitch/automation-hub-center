import { Bug, FolderOpen, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type {
  DiagnosticLevel,
  DiagnosticLogEntry,
  DiagnosticLogResult
} from '../../../../shared/diagnostic-types'
import type { Notify } from '../../types/notifications'
import styles from './DiagnosticsPanel.module.css'

interface DiagnosticsPanelProps {
  notify: Notify
}

const emptyResult: DiagnosticLogResult = {
  entries: [],
  logDirectory: '',
  dataDirectory: ''
}

export function DiagnosticsPanel({ notify }: DiagnosticsPanelProps): React.JSX.Element {
  const [result, setResult] = useState(emptyResult)
  const [search, setSearch] = useState('')
  const [level, setLevel] = useState<DiagnosticLevel | 'all'>('all')
  const [loading, setLoading] = useState(true)

  const loadLogs = useCallback(async () => {
    setLoading(true)
    try {
      const logs = await window.sapAutomation.getDiagnosticLogs({
        search,
        levels: level === 'all' ? undefined : [level],
        limit: 20
      })
      setResult(logs)
    } catch (error) {
      notify({
        kind: 'error',
        title: 'Diagnostics unavailable',
        message: error instanceof Error ? error.message : 'Local logs could not be read.'
      })
    } finally {
      setLoading(false)
    }
  }, [level, notify, search])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const openFolder = async (): Promise<void> => {
    const openResult = await window.sapAutomation.openLogFolder()
    if (!openResult.success) {
      notify({ kind: 'error', title: 'Log folder unavailable', message: openResult.message })
    }
  }

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.heading}>
        <div className={styles.headingTitle}>
          <span className={styles.icon}><Bug size={18} /></span>
          <div>
            <h3 className="section-title">Diagnostics / 诊断日志</h3>
            <p className="section-copy">Structured local logs for Key User troubleshooting / Key User 本地排错记录</p>
          </div>
        </div>
        <div className={styles.actions}>
          <button className="button" onClick={() => void loadLogs()} disabled={loading}>
            <RefreshCw size={13} /> Refresh / 刷新
          </button>
          <button className="button" onClick={() => void openFolder()}>
            <FolderOpen size={13} /> Open Log Folder / 打开日志目录
          </button>
        </div>
      </div>

      <div className={styles.paths}>
        <div><span>Hidden data / 隐藏数据</span><code>{result.dataDirectory || 'Loading…'}</code></div>
        <div><span>Log folder / 日志目录</span><code>{result.logDirectory || 'Loading…'}</code></div>
      </div>

      <div className={styles.filters}>
        <div className={styles.search}>
          <Search size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                void loadLogs()
              }
            }}
            placeholder="Search event, error code, T-code…"
            aria-label="Search diagnostic logs"
          />
        </div>
        <select
          className="select"
          value={level}
          onChange={(event) => setLevel(normalizeLevel(event.target.value))}
          aria-label="Diagnostic log level"
        >
          <option value="all">All levels / 全部</option>
          <option value="error">Errors / 错误</option>
          <option value="warning">Warnings / 警告</option>
          <option value="info">Information / 信息</option>
        </select>
        <button className="button primary" onClick={() => void loadLogs()}>
          Search / 查询
        </button>
      </div>

      <div className={styles.logList}>
        {loading ? (
          <div className={styles.empty}>Loading local logs…</div>
        ) : result.entries.length === 0 ? (
          <div className={styles.empty}>No matching diagnostic entries / 没有匹配的诊断记录</div>
        ) : (
          result.entries.map((entry) => <LogEntryRow entry={entry} key={entry.id} />)
        )}
      </div>
      <p className={styles.privacy}>
        Logs show the full Info Record for Key User troubleshooting, but exclude SAP passwords,
        certificate contents, and RFQ form values. 日志为排错显示完整 Info Record，但不记录
        SAP 密码、证书内容或 RFQ 表单值。
      </p>
    </section>
  )
}

function LogEntryRow({ entry }: { entry: DiagnosticLogEntry }): React.JSX.Element {
  return (
    <article className={styles.logEntry}>
      <span className={`${styles.level} ${styles[entry.level]}`}>{entry.level}</span>
      <div className={styles.logBody}>
        <div>
          <strong>{entry.event}</strong>
          <time>{new Date(entry.timestamp).toLocaleString()}</time>
        </div>
        <p>{entry.message}</p>
        {(entry.errorCode || entry.tcode) && (
          <small>
            {entry.errorCode ? `Error: ${entry.errorCode}` : ''}
            {entry.errorCode && entry.tcode ? ' · ' : ''}
            {entry.tcode ? `T-code: ${entry.tcode}` : ''}
          </small>
        )}
      </div>
    </article>
  )
}

function normalizeLevel(value: string): DiagnosticLevel | 'all' {
  if (value === 'error' || value === 'warning' || value === 'info') {
    return value
  }
  return 'all'
}
