import { useEffect, useState } from 'react'
import { ArrowLeft, Download, Upload, Play, Square, FileSearch, Info } from 'lucide-react'
import type { ApqpConfig, ApqpPreview, ApqpProgress, ApqpResult } from '../../../shared/apqp-types'
import { useLocalization } from '../i18n/use-localization'
import type { Notify } from '../types/notifications'
import styles from './Me12LeadTimePage.module.css'

const defaults: ApqpConfig = { excelPath: '', sheetName: '', plant: 'C100', system: '', client: '', maxWorkers: 3, createSessions: false, maxItems: 0, overwriteExisting: false, confirmed: false }

export function ApqpPlanClosurePage({ notify, onBack }: { notify: Notify; onBack: () => void }): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const t = (en: string, cn: string): string => zh ? cn : en
  const [config, setConfig] = useState<ApqpConfig>(defaults)
  const [preview, setPreview] = useState<ApqpPreview | null>(null)
  const [events, setEvents] = useState<ApqpProgress[]>([])
  const [result, setResult] = useState<ApqpResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [downloadPath, setDownloadPath] = useState('')
  useEffect(() => window.sapAutomation.onApqpProgress((event) => setEvents((current) => [...current.slice(-49), event])), [])

  const update = <K extends keyof ApqpConfig>(key: K, value: ApqpConfig[K]): void => {
    setConfig((current) => ({ ...current, [key]: value, confirmed: false }))
    setPreview(null); setResult(null)
  }
  const showError = (error: unknown): void => notify({ kind: 'error', title: 'APQP', message: error instanceof Error ? error.message : String(error) })
  const doPreview = async (next: ApqpConfig): Promise<void> => {
    setConfig({ ...next, confirmed: false }); setPreview(null); setResult(null)
    const response = await window.sapAutomation.previewApqp(next)
    if (!response.success) throw new Error(response.message)
    setPreview(response.preview)
  }
  const upload = async (): Promise<void> => {
    setBusy(true)
    try {
      const selection = await window.sapAutomation.selectApqpExcel()
      if (selection.success) await doPreview({ ...config, excelPath: selection.path })
      else if (!selection.cancelled) throw new Error(selection.message)
    } catch (error) { showError(error) } finally { setBusy(false) }
  }
  const refresh = async (): Promise<void> => {
    setBusy(true)
    try { await doPreview(config) } catch (error) { showError(error) } finally { setBusy(false) }
  }
  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = await window.sapAutomation.downloadApqpTemplate()
      if (!response.success) throw new Error(response.message)
      setDownloadPath(response.path)
      notify({ kind: 'success', title: t('Template downloaded', '模板已下载'), message: response.path })
    } catch (error) { showError(error) } finally { setBusy(false) }
  }
  const run = async (): Promise<void> => {
    if (!preview?.selected || !config.confirmed || busy || running) return
    setRunning(true); setEvents([]); setResult(null); setCancelling(false)
    try {
      const response = await window.sapAutomation.startApqp(config)
      setResult(response)
      notify({ kind: response.success ? response.failed || response.cancelled ? 'warning' : 'success' : 'error', title: 'APQP', message: response.message })
    } catch (error) { showError(error) } finally { setRunning(false); setConfig((c) => ({ ...c, confirmed: false })) }
  }
  const cancel = async (): Promise<void> => {
    try { const response = await window.sapAutomation.cancelApqp(); setCancelling(response.success) } catch (error) { showError(error) }
  }
  const disabled = busy || running
  const latest = events[events.length - 1]
  const progress = [...events].reverse().find((event) => event.current !== undefined && event.total)
  const workers = [...events].reverse().find((event) => event.workers !== undefined)?.workers
  const field = (label: string, input: React.ReactNode): React.JSX.Element => <label className={styles.field}><span>{label}</span>{input}</label>
  return <div className="page">
    <button className={styles.backButton} onClick={onBack} disabled={running}><ArrowLeft size={13} />{t('Back to Operations', '返回操作中心')}</button>
    <div className="page-heading"><div><h2>{t('Query APQP Plan Closure Date', '批量查询 APQP 计划关闭日期')}</h2><p>{t('SAP query only. Dates are written to your Excel workbook.', '仅查询 SAP，日期回写到 Excel，不修改 SAP 数据。')}</p></div><div className={styles.headingActions}>
      <button className="button" disabled={disabled || !config.excelPath} onClick={() => void refresh()}><FileSearch size={14} />{t('Preview again', '重新预览')}</button>
      {running ? <button className="button" disabled={cancelling} onClick={() => void cancel()}><Square size={13} />{cancelling ? t('Finishing current queries…', '等待当前查询完成…') : t('Stop after current queries', '安全停止')}</button> : <button className="button primary" disabled={disabled || !preview?.selected || !config.confirmed} onClick={() => void run()}><Play size={13} />{t('Run APQP query', '运行 APQP 查询')}</button>}
    </div></div>
    <div className={styles.layout}><div className={styles.formColumn}>
      <section className={`card ${styles.section}`}><div className={styles.sectionHeading}><h3>{t('1. Download and upload', '1. 下载并上传模板')}</h3><p>{t('Fill A: Part No. and D: Vendor. B: Ver and C: Description are optional. Leave E for results.', '必填 A 列 Part No. 和 D 列 Vendor。B 列版本、C 列描述可选；E 列由系统回写。')}</p></div>
        <div className={styles.templateActions}><button className="button" disabled={disabled} onClick={() => void download()}><Download size={14} />{t('Download template', '下载模板')}</button><button className="button primary" disabled={disabled} onClick={() => void upload()}><Upload size={14} />{t('Upload completed template', '上传已填写模板')}</button></div>
        {downloadPath && <p className={styles.downloadedPath}>{downloadPath}</p>}{config.excelPath && <p className={styles.selectedPath}>{config.excelPath}</p>}
      </section>
      <section className={`card ${styles.section}`}><h3>{t('2. SAP and concurrency', '2. SAP 与多开设置')}</h3><div className={styles.threeColumns}>
        {field('Plant', <input className="input" value={config.plant} maxLength={4} disabled={disabled} onChange={(e) => update('plant', e.target.value.toUpperCase())} />)}
        {field(t('Concurrent SAP sessions (1–5)', '同时并发 SAP 会话（1–5）'), <input className="input" type="number" min={1} max={5} value={config.maxWorkers} disabled={disabled} onChange={(e) => update('maxWorkers', Number(e.target.value))} />)}
        {field(t('Row limit (0 = all)', '最多查询行数（0=全部）'), <input className="input" type="number" min={0} max={100000} value={config.maxItems} disabled={disabled} onChange={(e) => update('maxItems', Number(e.target.value))} />)}
        {field(t('SAP System (optional)', 'SAP System（可留空）'), <input className="input" placeholder="VCE / CEQ" value={config.system} maxLength={3} disabled={disabled} onChange={(e) => update('system', e.target.value.toUpperCase())} />)}
        {field(t('Client (optional)', 'Client（可留空）'), <input className="input" placeholder="e.g. 100" value={config.client} maxLength={3} disabled={disabled} onChange={(e) => update('client', e.target.value)} />)}
        {field(t('Worksheet (blank = automatic)', '工作表（留空自动识别）'), <input className="input" placeholder="APQP_Input" value={config.sheetName} disabled={disabled} onChange={(e) => update('sheetName', e.target.value)} />)}
      </div></section>
      <section className={styles.liveWarning}><Info size={20} /><div><strong>{t('SAP GUI sessions, not browser windows', '使用 SAP GUI 会话，不是浏览器窗口')}</strong><p>{t('Sign in first and leave the selected sessions at SAP Easy Access. Multiple systems or clients require a filter. If fewer sessions are available, the actual worker count is reported. The query reads the first result row.', '请先登录 SAP，并将可用窗口停在 SAP Easy Access。检测到多个系统或 Client 时必须指定筛选条件。会话不足时会显示实际并发数；查询沿用脚本，读取第一条结果。')}</p>
        <label><input type="checkbox" checked={config.createSessions} disabled={disabled} onChange={(e) => update('createSessions', e.target.checked)} /><span>{t('Create missing SAP session windows (subject to SAP limits)', '会话不足时自动创建新 SAP 窗口（受系统上限限制）')}</span></label>
        <label><input type="checkbox" checked={config.overwriteExisting} disabled={disabled} onChange={(e) => update('overwriteExisting', e.target.checked)} /><span>{t('Refresh and overwrite existing Excel dates', '重新查询并覆盖 Excel 已有日期')}</span></label>
        <p>{t('Excel can stay open. A backup is created before writeback; avoid changing input rows during a run.', 'Excel 可以保持打开；回写前自动备份。运行期间请勿修改输入行。')}</p>
        <label><input type="checkbox" checked={config.confirmed} disabled={disabled || !preview?.selected} onChange={(e) => setConfig((c) => ({ ...c, confirmed: e.target.checked }))} /><span>{t('I reviewed the preview and authorize use of these SAP sessions and Excel writeback.', '我已核对预览，允许占用上述 SAP 会话进行查询并回写 Excel。')}</span></label>
      </div></section>
    </div><aside className={styles.sideColumn}>
      <section className={`card ${styles.section}`}><h3>{t('Workbook preview', '工作簿预览')}</h3>{preview ? <><div className={styles.metrics}><Metric label={t('To query', '待查询')} value={preview.selected} /><Metric label={t('Existing dates skipped', '跳过已有日期')} value={preview.skipped} /><Metric label={t('Incomplete rows', '不完整行')} value={preview.invalid} /></div><div className={styles.sample}><strong>{preview.sheetName} · Material / Vendor</strong>{preview.sample.map((row) => <div key={row.excelRow}><code>{row.material} / {row.vendor}</code><span>{t('Row', '行')} {row.excelRow}</span></div>)}</div></> : <p className={styles.empty}>{busy ? t('Reading Excel…', '正在读取 Excel…') : t('Upload the template to preview. No SAP query is run during preview.', '上传模板后生成预览，预览不会查询 SAP。')}</p>}</section>
      <section className={`card ${styles.section}`}><h3>{t('Run status', '运行状态')}</h3>{workers !== undefined && <p className={styles.browserBadge}>{t('Actual SAP sessions', '实际 SAP 会话数')}: {workers}</p>}{progress && <div className={styles.progressTrack}><i style={{ width: `${Math.round((progress.current ?? 0) / (progress.total ?? 1) * 100)}%` }} /></div>}{latest && <p className={styles.latest}>{latest.message}</p>}<div className={styles.progressLog}>{events.slice(-8).map((event, i) => <div key={i}><p>{event.message}</p></div>)}</div>
        {result?.success && <div className={styles.resultPaths}>{[[t('Result workbook', '结果工作簿'), result.resultPath], [t('Backup', '备份'), result.backupPath], [t('Detailed log', '详细日志'), result.logPath]].filter(([, path]) => path).map(([label, path]) => <div key={label}><span><strong>{label}</strong>{path}</span></div>)}</div>}
      </section>
    </aside></div>
  </div>
}
function Metric({ label, value }: { label: string; value: number }): React.JSX.Element { return <div><span>{label}</span><strong>{value}</strong></div> }
