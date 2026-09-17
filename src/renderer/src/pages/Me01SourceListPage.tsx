import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Download, FileSearch, ListChecks, Play, Save, Square, Upload } from 'lucide-react'
import type { Me01BatchConfig, Me01BatchProgress, Me01BatchResult, Me01ExcelPreview } from '../../../shared/me01-types'
import { useLocalization } from '../i18n/use-localization'
import type { Notify } from '../types/notifications'
import styles from './Me12LeadTimePage.module.css'

interface Props { notify: Notify; onBack: () => void }

const copy = {
  en: {
    title: 'Batch maintain Source List', subtitle: 'Upload Material numbers and maintain SAP ME01 with fixed, controlled settings.', back: 'Back to Operations',
    prepare: '1. Download and upload the template', prepareCopy: 'Enter Material No. and the Parma supplier to fix. Result columns are filled automatically.', download: 'Download template', downloading: 'Downloading…', upload: 'Upload completed template', selected: 'Selected file', saved: 'Saved to', preview: 'Preview again',
    fixed: '2. Fixed SAP values', plant: 'Plant', usage: 'Source List Usage', fixedSource: 'Fixed Source', fixedYes: 'Selected', session: 'SAP connection', activeSession: 'First active SAP GUI session',
    safety: 'Live SAP update', safetyCopy: 'The workbook may stay open in Excel. If SAP is not running, SAP Logon opens automatically. The matching Parma row is fixed; existing Fix selections on other rows remain unchanged.', confirm: 'I reviewed the Material/Parma preview and authorize these ME01 updates in the SAP system I will select or have already opened.',
    run: 'Run ME01 batch', cancel: 'Cancel', summary: 'Workbook preview', rows: 'Material rows', unique: 'Unique materials', duplicates: 'Duplicate rows', blanks: 'Blank rows', sample: 'Sample materials', excelRows: 'Excel row(s)', status: 'Run status', idle: 'Upload the completed template to preview it.',
    downloaded: 'Template downloaded', downloadedCopy: 'Fill in Material No. and Parma on ME01_Input, save the workbook, then upload it here.', previewReady: 'Workbook preview ready', previewFailed: 'Workbook preview failed', completed: 'ME01 batch finished', failed: 'ME01 batch stopped', result: 'Result workbook', backup: 'Backup workbook', parmaMissing: 'Not detected', stalePreview: 'Parma was not returned by the background process. Restart Automation Hub, download the latest template, and upload it again.'
  },
  'zh-CN': {
    title: '批量维护 Source List', subtitle: '只需上传 Material 编号，使用受控固定参数执行 SAP ME01。', back: '返回操作中心',
    prepare: '1. 下载并上传模板', prepareCopy: '填写 Material No. 和需要 Fix 的供应商 Parma，结果列由系统自动回写。', download: '下载模板', downloading: '正在下载…', upload: '上传已填写模板', selected: '已选择文件', saved: '保存位置', preview: '重新预览',
    fixed: '2. 固定 SAP 参数', plant: 'Plant', usage: 'Source List Usage', fixedSource: 'Fixed Source', fixedYes: '已勾选', session: 'SAP 连接', activeSession: '第一个已登录的 SAP GUI 会话',
    safety: 'SAP 正式修改', safetyCopy: 'Excel 可以保持打开；没有 SAP 会话时会自动启动 SAP Logon。程序只勾选 Parma 匹配行，不会取消其他行已有的 Fix。', confirm: '我已检查 Material/Parma 预览，并授权在我将选择或已打开的 SAP 系统中执行这些 ME01 修改。',
    run: '运行 ME01 批处理', cancel: '取消', summary: '工作簿预览', rows: 'Material 行数', unique: '唯一 Material', duplicates: '重复行数', blanks: '空白行数', sample: 'Material 抽样', excelRows: 'Excel 行', status: '执行状态', idle: '请上传已填写的模板以生成预览。',
    downloaded: '模板已下载', downloadedCopy: '在 ME01_Input 中填写 Material No. 和 Parma，保存后上传到这里。', previewReady: '工作簿预览完成', previewFailed: '工作簿预览失败', completed: 'ME01 批处理完成', failed: 'ME01 批处理已停止', result: '结果工作簿', backup: '备份工作簿', parmaMissing: '未读取', stalePreview: '后台进程没有返回 Parma。请完全退出并重启 Automation Hub，然后下载最新版模板并重新上传。'
  }
} as const

export function Me01SourceListPage({ notify, onBack }: Props): React.JSX.Element {
  const { language } = useLocalization()
  const text = copy[language]
  const [config, setConfig] = useState<Me01BatchConfig>({ excelPath: '', confirmed: false })
  const [preview, setPreview] = useState<Me01ExcelPreview | null>(null)
  const [progress, setProgress] = useState<Me01BatchProgress[]>([])
  const [result, setResult] = useState<Me01BatchResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [running, setRunning] = useState(false)
  const [downloadedPath, setDownloadedPath] = useState('')

  useEffect(() => window.sapAutomation.onMe01Progress((event) => setProgress((current) => [...current.slice(-99), event])), [])
  const latest = progress[progress.length - 1]
  const percent = useMemo(() => latest?.total && latest.current ? Math.min(100, Math.round(latest.current / latest.total * 100)) : 0, [latest])
  const previewMissingParma = Boolean(preview?.sample.some((row) => !row.parma?.trim()))
  const canRun = Boolean(preview?.uniqueMaterials && !previewMissingParma && config.confirmed && !running)

  const previewWorkbook = async (nextConfig: Me01BatchConfig = config): Promise<void> => {
    if (!nextConfig.excelPath) return
    setPreviewing(true); setPreview(null); setResult(null)
    const response = await window.sapAutomation.previewMe01Batch(nextConfig)
    setPreviewing(false)
    if (response.success) {
      setPreview(response.preview)
      notify({ kind: 'success', title: text.previewReady, message: `${response.preview.uniqueMaterials} Material/Parma assignment(s) selected.` })
    } else notify({ kind: 'error', title: text.previewFailed, message: response.message })
  }

  const selectWorkbook = async (): Promise<void> => {
    const selection = await window.sapAutomation.selectMe01ExcelFile()
    if (selection.success) {
      const next = { excelPath: selection.path, confirmed: false }
      setConfig(next)
      await previewWorkbook(next)
    } else if (!selection.cancelled && selection.message) notify({ kind: 'error', title: text.previewFailed, message: selection.message })
  }

  const downloadTemplate = async (): Promise<void> => {
    setDownloading(true)
    const response = await window.sapAutomation.downloadMe01Template()
    setDownloading(false)
    if (response.success) {
      setDownloadedPath(response.path)
      notify({ kind: 'success', title: text.downloaded, message: `${text.downloadedCopy} ${response.path}` })
    } else if (!response.cancelled) notify({ kind: 'error', title: text.previewFailed, message: response.message ?? '' })
  }

  const start = async (): Promise<void> => {
    if (!canRun) return
    setRunning(true); setProgress([]); setResult(null)
    const response = await window.sapAutomation.startMe01Batch(config)
    setResult(response); setRunning(false)
    notify({ kind: response.success ? response.failed ? 'warning' : 'success' : response.errorCode === 'CANCELLED' ? 'warning' : 'error', title: response.success ? text.completed : text.failed, message: response.message })
  }

  return <div className="page">
    <button className={styles.backButton} onClick={onBack}><ArrowLeft size={13} /> {text.back}</button>
    <div className="page-heading"><div><h2>{text.title}</h2><p>{text.subtitle}</p></div><div className={styles.headingActions}>
      <button className="button" onClick={() => void previewWorkbook()} disabled={!config.excelPath || previewing || running}><FileSearch size={14} /> {text.preview}</button>
      {running ? <button className={`button ${styles.cancelButton}`} onClick={() => void window.sapAutomation.cancelMe01Batch()}><Square size={12} /> {text.cancel}</button> : <button className="button primary" onClick={() => void start()} disabled={!canRun}><Play size={13} /> {text.run}</button>}
    </div></div>
    <div className={styles.layout}><div className={styles.formColumn}>
      <section className={`card ${styles.section}`}><div className={styles.sectionHeading}><div><h3>{text.prepare}</h3><p>{text.prepareCopy}</p></div><span className={styles.browserBadge}><ListChecks size={13} /> ME01 · C100</span></div>
        <div className={styles.templateActions}><button className="button" onClick={() => void downloadTemplate()} disabled={downloading || running}><Download size={14} /> {downloading ? text.downloading : text.download}</button><button className="button primary" onClick={() => void selectWorkbook()} disabled={running}><Upload size={14} /> {text.upload}</button></div>
        {downloadedPath && <p className={styles.downloadedPath}><strong>{text.saved}:</strong> {downloadedPath}</p>}{config.excelPath && <p className={styles.selectedPath}><strong>{text.selected}:</strong> {config.excelPath}</p>}
      </section>
      <section className={`card ${styles.section}`}><h3>{text.fixed}</h3><div className={styles.metrics}><Metric label={text.plant} value="C100" /><Metric label={text.usage} value="1" /><Metric label={text.fixedSource} value={text.fixedYes} /><Metric label={text.session} value={text.activeSession} /></div></section>
      <section className={styles.liveWarning}><AlertTriangle size={19} /><div><strong>{text.safety}</strong><p>{text.safetyCopy}</p><label><input type="checkbox" checked={config.confirmed} onChange={(event) => setConfig((current) => ({ ...current, confirmed: event.target.checked }))} disabled={!preview || running} /><span>{text.confirm}</span></label></div></section>
    </div><aside className={styles.sideColumn}>
      <section className={`card ${styles.section}`}><h3>{text.summary}</h3>{preview ? <><div className={styles.metrics}><Metric label={text.rows} value={preview.totalDataRows} /><Metric label={text.unique} value={preview.uniqueMaterials} /><Metric label={text.duplicates} value={preview.duplicateRows} /><Metric label={text.blanks} value={preview.skippedBlankRows} /></div>{previewMissingParma && <p className={styles.previewWarning}>{text.stalePreview}</p>}<div className={styles.sample}><strong>{text.sample} · {preview.sheetName}</strong>{preview.sample.map((row) => <div className={styles.sampleRow} key={`${row.material}-${row.parma ?? ''}`}><div className={styles.sampleIdentity}><code>{row.material}</code><span>Parma <strong className={row.parma?.trim() ? styles.parmaCode : styles.missingValue}>{row.parma?.trim() || text.parmaMissing}</strong></span></div><span>{text.excelRows}: {row.excelRows.join(', ')}</span></div>)}</div></> : <p className={styles.empty}>{text.idle}</p>}</section>
      <section className={`card ${styles.section}`}><h3>{text.status}</h3>{latest && <><div className={styles.progressTrack}><i style={{ width: `${percent}%` }} /></div><p className={styles.latest}>{latest.message}</p></>}<div className={styles.progressLog}>{progress.slice(-8).map((event, index) => <div key={`${event.stage}-${index}`}><span className={styles[event.status ?? 'running']} /><p>{event.message}</p></div>)}</div>{result?.success && <div className={styles.resultPaths}><div><Save size={13} /><span><strong>{text.result}</strong>{result.resultPath}</span></div><div><Save size={13} /><span><strong>{text.backup}</strong>{result.backupPath}</span></div></div>}</section>
    </aside></div>
  </div>
}

function Metric({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}
