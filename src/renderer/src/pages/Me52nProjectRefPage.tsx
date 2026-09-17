import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, FileSearch, Play, Save, Square, Upload } from 'lucide-react'
import type { Me52nBatchConfig, Me52nBatchProgress, Me52nBatchResult, Me52nExcelPreview } from '../../../shared/me52n-types'
import { useLocalization } from '../i18n/use-localization'
import type { Notify } from '../types/notifications'
import styles from './Me52nProjectRefPage.module.css'

interface Props { notify: Notify; onBack: () => void }

const initialConfig: Me52nBatchConfig = {
  excelPath: '', sheetName: '', prColumn: 9, dataStartRow: 2, batchStartRow: 0, batchSize: 100,
  targetProjectRef: '775873', allowedWbs: ['JY415-03671-01-01-01', 'JY415-03671-01-01-05'],
  overwriteExisting: true, concurrency: 1, workerStartDelaySec: 2, taskErrorRetries: 1,
  loginTimeoutSec: 180, checkpointEnabled: true, writebackToSource: true, confirmed: false, parallelConfirmed: false
}

export function Me52nProjectRefPage({ notify, onBack }: Props): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const t = copy(zh)
  const [config, setConfig] = useState(initialConfig)
  const [wbsText, setWbsText] = useState(initialConfig.allowedWbs.join('\n'))
  const [preview, setPreview] = useState<Me52nExcelPreview | null>(null)
  const [progress, setProgress] = useState<Me52nBatchProgress[]>([])
  const [result, setResult] = useState<Me52nBatchResult | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => window.sapAutomation.onMe52nProgress((event) => setProgress((current) => [...current.slice(-99), event])), [])
  useEffect(() => { void window.sapAutomation.getSettings().then((settings) => setConfig((current) => ({ ...current, concurrency: Math.min(5, Math.max(1, settings.maxConcurrentBrowsers)) }))) }, [])

  const latest = progress[progress.length - 1]
  const percent = useMemo(() => latest?.total && latest.current !== undefined ? Math.min(100, Math.round(latest.current / latest.total * 100)) : 0, [latest])
  const canRun = Boolean(preview?.uniquePrs && config.confirmed && (config.concurrency === 1 || config.parallelConfirmed) && !running)

  const update = <K extends keyof Me52nBatchConfig>(key: K, value: Me52nBatchConfig[K], invalidate = true): void => {
    setConfig((current) => ({ ...current, [key]: value, confirmed: invalidate ? false : current.confirmed, parallelConfirmed: key === 'concurrency' ? false : current.parallelConfirmed }))
    if (invalidate) setPreview(null)
  }
  const previewWorkbook = async (candidate = config): Promise<void> => {
    if (!candidate.excelPath) return
    const normalized = { ...candidate, allowedWbs: splitWbs(wbsText), confirmed: false, parallelConfirmed: false }
    setConfig(normalized); setPreviewing(true); setPreview(null); setResult(null)
    const response = await window.sapAutomation.previewMe52nBatch(normalized)
    setPreviewing(false)
    if (response.success) { setPreview(response.preview); notify({ kind: 'success', title: t.previewReady, message: `${response.preview.uniquePrs} PR(s)` }) }
    else notify({ kind: 'error', title: t.previewFailed, message: response.message })
  }
  const selectWorkbook = async (): Promise<void> => {
    const selection = await window.sapAutomation.selectMe52nExcelFile()
    if (selection.success) await previewWorkbook({ ...config, excelPath: selection.path })
    else if (!selection.cancelled && selection.message) notify({ kind: 'error', title: t.previewFailed, message: selection.message })
  }
  const start = async (): Promise<void> => {
    if (!canRun) return
    setRunning(true); setProgress([]); setResult(null)
    const response = await window.sapAutomation.startMe52nBatch({ ...config, allowedWbs: splitWbs(wbsText) })
    setResult(response); setRunning(false)
    notify({ kind: response.success ? response.failed ? 'warning' : 'success' : response.errorCode === 'CANCELLED' ? 'warning' : 'error', title: response.success ? t.completed : t.failed, message: response.message })
  }

  return <div className="page">
    <button className={styles.backButton} onClick={onBack}><ArrowLeft size={13} /> {t.back}</button>
    <div className="page-heading"><div><h2>{t.title}</h2><p>{t.subtitle}</p></div><div className={styles.headingActions}>
      <button className="button" onClick={() => void previewWorkbook()} disabled={!config.excelPath || previewing || running}><FileSearch size={14} /> {previewing ? t.previewing : t.preview}</button>
      {running ? <button className={`button ${styles.cancelButton}`} onClick={() => void window.sapAutomation.cancelMe52nBatch()}><Square size={12} /> {t.cancel}</button> : <button className="button primary" onClick={() => void start()} disabled={!canRun}><Play size={13} /> {t.run}</button>}
    </div></div>
    <div className={styles.layout}><div className={styles.formColumn}>
      <section className={`card ${styles.section}`}><div className={styles.sectionHeading}><div><h3>{t.workbook}</h3><p>{t.workbookCopy}</p></div><span className={styles.browserBadge}>ME52N · Chrome WebGUI</span></div>
        <button className="button primary" onClick={() => void selectWorkbook()} disabled={running}><Upload size={14} /> {t.upload}</button>
        {config.excelPath && <p className={styles.selectedPath}><strong>{t.selected}:</strong> {config.excelPath}</p>}
        <div className={styles.fieldGrid}>
          <Field label={t.sheet}><input value={config.sheetName} placeholder={t.firstSheet} onChange={(e) => update('sheetName', e.target.value)} disabled={running} /></Field>
          <Field label={t.prColumn}><input type="number" min={1} max={16384} value={config.prColumn} onChange={(e) => update('prColumn', Number(e.target.value))} disabled={running} /></Field>
          <Field label={t.dataStart}><input type="number" min={1} value={config.dataStartRow} onChange={(e) => update('dataStartRow', Number(e.target.value))} disabled={running} /></Field>
          <Field label={t.batchStart}><input type="number" min={0} value={config.batchStartRow} onChange={(e) => update('batchStartRow', Number(e.target.value))} disabled={running} /></Field>
          <Field label={t.batchSize}><input type="number" min={0} value={config.batchSize} onChange={(e) => update('batchSize', Number(e.target.value))} disabled={running} /></Field>
        </div>
      </section>
      <section className={`card ${styles.section}`}><h3>{t.rules}</h3><div className={styles.rulesGrid}>
        <Field label={t.projectRef}><input value={config.targetProjectRef} onChange={(e) => update('targetProjectRef', e.target.value)} disabled={running} /></Field>
        <Field label={t.wbs}><textarea rows={3} value={wbsText} onChange={(e) => { setWbsText(e.target.value); setPreview(null); setConfig((c) => ({ ...c, confirmed: false })) }} disabled={running} /></Field>
      </div><label className={styles.check}><input type="checkbox" checked={config.overwriteExisting} onChange={(e) => update('overwriteExisting', e.target.checked)} disabled={running} /> {t.overwrite}</label></section>
      <section className={`card ${styles.section}`}><h3>{t.execution}</h3><div className={styles.fieldGrid}>
        <Field label={t.concurrency}><input type="number" min={1} max={5} value={config.concurrency} onChange={(e) => update('concurrency', Math.min(5, Math.max(1, Number(e.target.value))), false)} disabled={running} /></Field>
        <Field label={t.delay}><input type="number" min={0} max={15} value={config.workerStartDelaySec} onChange={(e) => update('workerStartDelaySec', Number(e.target.value), false)} disabled={running} /></Field>
        <Field label={t.retries}><input type="number" min={0} max={3} value={config.taskErrorRetries} onChange={(e) => update('taskErrorRetries', Number(e.target.value), false)} disabled={running} /></Field>
        <Field label={t.loginTimeout}><input type="number" min={30} max={600} value={config.loginTimeoutSec} onChange={(e) => update('loginTimeoutSec', Number(e.target.value), false)} disabled={running} /></Field>
      </div><p className={styles.loginNote}>{t.loginNote(config.concurrency)}</p>
        <div className={styles.optionRow}><label className={styles.check}><input type="checkbox" checked={config.checkpointEnabled} onChange={(e) => update('checkpointEnabled', e.target.checked, false)} /> {t.checkpoint}</label><label className={styles.check}><input type="checkbox" checked={config.writebackToSource} onChange={(e) => update('writebackToSource', e.target.checked, false)} /> {t.writeback}</label></div>
      </section>
      <section className={styles.liveWarning}><AlertTriangle size={19} /><div><strong>{t.live}</strong><p>{t.liveCopy}</p>
        <label><input type="checkbox" checked={config.confirmed} onChange={(e) => setConfig((c) => ({ ...c, confirmed: e.target.checked }))} disabled={!preview || running} /><span>{t.confirm}</span></label>
        {config.concurrency > 1 && <label><input type="checkbox" checked={config.parallelConfirmed} onChange={(e) => setConfig((c) => ({ ...c, parallelConfirmed: e.target.checked }))} disabled={!preview || running} /><span>{t.parallelConfirm(config.concurrency)}</span></label>}
      </div></section>
    </div><aside className={styles.sideColumn}>
      <section className={`card ${styles.section}`}><h3>{t.summary}</h3>{preview ? <><div className={styles.metrics}><Metric label={t.range} value={`${preview.startRow}–${preview.endRow}`} /><Metric label={t.unique} value={preview.uniquePrs} /><Metric label={t.duplicates} value={preview.duplicateRows} /><Metric label={t.invalid} value={preview.invalidRows} /></div><div className={styles.sample}><strong>{t.sample} · {preview.sheetName}</strong>{preview.sample.map((row) => <div key={row.pr}><code>{row.pr}</code><span>{t.rows}: {row.excelRows.join(', ')}</span></div>)}</div></> : <p className={styles.empty}>{t.idle}</p>}</section>
      <section className={`card ${styles.section}`}><h3>{t.status}</h3>{latest && <><div className={styles.progressTrack}><i style={{ width: `${percent}%` }} /></div><p className={styles.latest}>{latest.message}</p></>}<div className={styles.progressLog}>{progress.slice(-8).map((event, index) => <div key={`${event.stage}-${index}`}><span className={styles[event.status ?? 'running']} /><p>{event.message}</p></div>)}</div>{result?.success && <div className={styles.resultPaths}><Path label={t.log} value={result.resultPath} /><Path label={t.checkpointFile} value={result.checkpointPath} /><Path label={t.backup} value={result.backupPath} /></div>}</section>
    </aside></div>
  </div>
}

function splitWbs(value: string): string[] { return [...new Set(value.split(/[;,|\r\n]+/).map((item) => item.trim().toUpperCase()).filter(Boolean))] }
function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element { return <label className={styles.field}><span>{label}</span>{children}</label> }
function Metric({ label, value }: { label: string; value: string | number }): React.JSX.Element { return <div><span>{label}</span><strong>{value}</strong></div> }
function Path({ label, value }: { label: string; value: string }): React.JSX.Element | null { return value ? <div><Save size={13} /><span><strong>{label}</strong>{value}</span></div> : null }

function copy(zh: boolean) { return zh ? {
  title: '批量维护 Project Ref', subtitle: '从 Excel 读取 PR，在 ME52N 中只处理白名单 WBS，并支持独立 Chrome 并发会话。', back: '返回操作中心', preview: '预览', previewing: '预览中…', run: '运行 ME52N', cancel: '取消',
  workbook: '1. 选择 Excel 和批次', workbookCopy: 'PR 默认读取第 9 列；Excel 可以保持打开，运行时请勿修改输入列。0 表示按默认行或处理全部剩余数据。', upload: '上传 Excel', selected: '已选择文件', sheet: '工作表（可留空）', firstSheet: '默认第一个工作表', prColumn: 'PR 列号', dataStart: '数据起始行', batchStart: '本批起始行（0=自动）', batchSize: '本批行数（0=全部）',
  rules: '2. 业务规则', projectRef: '目标 Project Ref', wbs: '允许写入的 WBS（每行一个）', overwrite: '已有 Project Ref 时允许覆盖', execution: '3. 执行参数', concurrency: '同时并发浏览器数（1–5）', delay: '浏览器启动间隔（秒）', retries: '单个 PR 重试次数', loginTimeout: '登录等待（秒）', checkpoint: '启用 Checkpoint，成功项下次自动跳过', writeback: '把结果回写源 Excel（运行前自动备份）', loginNote: (n: number) => `将打开 ${n} 个独立 Chrome。每个窗口都需要用户完成证书确认和 SAP 登录。`,
  live: 'SAP 实时写入', liveCopy: '此操作会修改 ME52N。程序按 PR 去重，每个 PR 只由一个 Worker 处理；不会在界面测试中连接 SAP。', confirm: '我已检查 Excel 预览、WBS 白名单和目标 Project Ref，并授权执行实时修改。', parallelConfirm: (n: number) => `我确认使用 ${n} 个独立 SAP 会话并行写入，且输入 PR 之间不存在业务冲突。`,
  summary: '批次预览', range: 'Excel 行范围', unique: '唯一 PR', duplicates: '重复 PR 行', invalid: '非法 PR', sample: 'PR 抽样', rows: 'Excel 行', idle: '上传 Excel 并预览后，才可授权运行。', status: '执行状态', log: '详细日志', checkpointFile: 'Checkpoint', backup: '源 Excel 备份', previewReady: 'Excel 预览完成', previewFailed: 'Excel 预览失败', completed: 'ME52N 执行完成', failed: 'ME52N 执行停止'
} : {
  title: 'Batch maintain Project Ref', subtitle: 'Read PRs from Excel, update only allow-listed WBS items in ME52N, and use isolated concurrent Chrome sessions.', back: 'Back to Operations', preview: 'Preview', previewing: 'Previewing…', run: 'Run ME52N', cancel: 'Cancel',
  workbook: '1. Select workbook and batch', workbookCopy: 'PRs default to column 9. Excel may remain open; do not edit input columns during the run. Zero uses the automatic start or processes all remaining rows.', upload: 'Upload Excel', selected: 'Selected file', sheet: 'Worksheet (optional)', firstSheet: 'First worksheet', prColumn: 'PR column number', dataStart: 'Data start row', batchStart: 'Batch start row (0=auto)', batchSize: 'Batch rows (0=all)',
  rules: '2. Business rules', projectRef: 'Target Project Ref', wbs: 'Allowed WBS (one per line)', overwrite: 'Overwrite an existing Project Ref', execution: '3. Execution parameters', concurrency: 'Concurrent browsers (1–5)', delay: 'Browser start delay (seconds)', retries: 'Retries per PR', loginTimeout: 'Login wait (seconds)', checkpoint: 'Use checkpoint and skip completed PRs next time', writeback: 'Write results to source Excel (backup first)', loginNote: (n: number) => `${n} independent Chrome browser(s) will open. Complete certificate confirmation and SAP sign-in in every window.`,
  live: 'Live SAP update', liveCopy: 'This operation changes ME52N. PRs are deduplicated and one worker owns each PR. UI verification never connects to SAP.', confirm: 'I reviewed the workbook preview, WBS allow-list, and target Project Ref and authorize the live update.', parallelConfirm: (n: number) => `I approve ${n} independent SAP sessions writing in parallel and confirm the input PRs do not have business conflicts.`,
  summary: 'Batch preview', range: 'Excel row range', unique: 'Unique PRs', duplicates: 'Duplicate PR rows', invalid: 'Invalid PRs', sample: 'PR sample', rows: 'Excel row(s)', idle: 'Upload and preview a workbook before authorizing the run.', status: 'Run status', log: 'Detailed log', checkpointFile: 'Checkpoint', backup: 'Source Excel backup', previewReady: 'Workbook preview ready', previewFailed: 'Workbook preview failed', completed: 'ME52N completed', failed: 'ME52N stopped'
} }
