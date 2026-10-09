import { ArrowLeft, Download, Upload, Play, Square, FolderOpen, AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { RfqBatchProgress, RfqBatchResult, RfqExcelPreview } from '../../../shared/rfq-batch-types'
import { useLocalization } from '../i18n/use-localization'
import { operationCopy } from '../i18n/operation-copy'
import { completedUnits } from '../../../shared/local-intelligence'
import { useAdaptiveEta } from '../hooks/use-adaptive-eta'
import { AdaptiveEta } from '../components/automation/AdaptiveEta'
import type { Notify } from '../types/notifications'
import styles from './CreateRfqPage.module.css'

interface CreateRfqPageProps { notify: Notify; onBack: () => void; onRunningChange: (running: boolean) => void }

export function CreateRfqPage({ notify, onBack, onRunningChange }: CreateRfqPageProps): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const text = operationCopy('create-rfq', language)
  const t = (cn: string, en: string): string => zh ? cn : en
  const [excelPath, setExcelPath] = useState('')
  const [downloadedPath, setDownloadedPath] = useState('')
  const [preview, setPreview] = useState<RfqExcelPreview | null>(null)
  const [events, setEvents] = useState<RfqBatchProgress[]>([])
  const [result, setResult] = useState<RfqBatchResult | null>(null)
  const [running, setRunning] = useState(false)
  useEffect(() => { onRunningChange(running) }, [running, onRunningChange])
  const { eta, unavailable: etaUnavailable } = useAdaptiveEta('create-rfq', running)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [attention, setAttention] = useState<RfqBatchProgress | null>(null)
  const [numbers, setNumbers] = useState<string[]>([])
  const [slowWait, setSlowWait] = useState<RfqBatchProgress | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const attentionNotified = useRef(false)
  const latest = events[events.length - 1]
  const group = [...events].reverse().find((event) => event.groupKey)
  const totals = [...events].reverse().find((event) => event.succeeded !== undefined)
  const completedGroups = result?.processed ?? Math.max(0, ...events.map(event => completedUnits('create-rfq', event) ?? 0))
  const percent = preview?.groupCount ? Math.min(100, Math.round(completedGroups / preview.groupCount * 100)) : 0
  const canRun = Boolean(preview && preview.validRows > 0 && preview.invalidRows === 0 && !running && !loading && !result)

  useEffect(() => window.sapAutomation.onRfqProgress((event) => {
    // Detailed timing stays in engine diagnostics, not the buyer's live status.
    if (event.type === 'WRITE_PROFILE' || event.type === 'RUNTIME_PROFILE') return
    if (event.type === 'SAP_SLOW') setSlowWait(event)
    else if (event.type === 'SAP_RECOVERED' || event.state === 'WAITING_FOR_USER' || ['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED'].includes(event.type ?? '')) setSlowWait(null)
    setEvents((previous) => [...previous.slice(-199), event])
    if (event.rfqNumber) setNumbers((previous) => [...new Set([...previous, event.rfqNumber!])])
    if (event.type === 'ACTION_REQUIRED' && event.state !== 'WAITING_FOR_USER') {
      setAttention(event)
      if (!attentionNotified.current) {
        attentionNotified.current = true
        notify({ kind: 'warning', title: 'RFQ — Action required / 需要处理', message: event.message })
      }
    }
  }), [notify])

  useEffect(() => {
    if (confirming) dialog.current?.showModal()
    else dialog.current?.close()
  }, [confirming])

  const reportError = (error: unknown): void => notify({ kind: 'error', title: t('RFQ 操作失败', 'RFQ action failed'), message: String(error instanceof Error ? error.message : error) })

  const download = async (): Promise<void> => {
    setLoading(true)
    try {
      const response = await window.sapAutomation.downloadRfqTemplate()
      if (response.success) {
        setDownloadedPath(response.path)
        notify({ kind: 'success', title: t('模板下载完成', 'Template downloaded'), message: response.path })
      } else if (!response.cancelled) reportError(response.message)
    } catch (error) { reportError(error) } finally { setLoading(false) }
  }

  const upload = async (): Promise<void> => {
    setLoading(true)
    try {
      const selected = await window.sapAutomation.selectRfqExcelFile()
      if (!selected.success) {
        if (!selected.cancelled) reportError(selected.message)
        return
      }
      setExcelPath(selected.path); setPreview(null); setResult(null); setEvents([]); setNumbers([]); setAttention(null)
      const response = await window.sapAutomation.previewRfqBatch({ excelPath: selected.path, environment: 'PROD', productionConfirmed: false })
      if (response.success) setPreview(response.preview)
      else reportError(response.message)
    } catch (error) { reportError(error) } finally { setLoading(false) }
  }

  const start = async (): Promise<void> => {
    if (!canRun || !preview || !confirming) return
    setConfirming(false); setRunning(true); setStopping(false); setEvents([]); setResult(null); setAttention(null); setNumbers([])
    attentionNotified.current = false; setSlowWait(null)
    try {
      const response = await window.sapAutomation.startRfqBatch({ excelPath, environment: 'PROD', productionConfirmed: true, fingerprint: preview.fingerprint })
      setResult(response)
      setNumbers((previous) => [...new Set([...previous, ...(response.rfqNumbers ?? [])])])
      const warning = response.success && (response.failed > 0 || response.skipped > 0 || (response.withSkips ?? 0) > 0)
      notify({ kind: response.success ? warning ? 'warning' : 'success' : response.errorCode === 'CANCELLED' ? 'warning' : 'error',
        title: response.success ? t('RFQ 执行结束', 'RFQ run finished') : t('RFQ 已停止', 'RFQ stopped'), message: response.message })
    } catch (error) { reportError(error) } finally { setRunning(false) }
  }

  const stop = async (): Promise<void> => {
    try {
      const response = await window.sapAutomation.cancelRfqBatch()
      if (response.success) setStopping(true)
      notify({ kind: 'warning', title: t('停止请求', 'Stop request'), message: response.message })
    } catch (error) { reportError(error) }
  }

  const open = async (path: string): Promise<void> => {
    try {
      const response = await window.sapAutomation.openRfqArtifact(path)
      if (!response.success) reportError(response.message)
    } catch (error) { reportError(error) }
  }

  const stepLabels: Record<string, string> = {
    RUN_STARTED: t('连接 SAP，请完成登录', 'Connecting to SAP; complete sign-in'),
    GROUP_STARTED: t('查找 NPL 物料', 'Finding NPL materials'),
    BUYER_RECEIPT_STARTED: t('创建 Buyer Receipt', 'Creating Buyer Receipt'),
    GROUP_PROGRESS: t('保存并检查 Buyer Receipt 绿色状态', 'Saving and checking green Buyer Receipt'),
    BUYER_RECEIPT_SAVED: t('Buyer Receipt 已保存', 'Buyer Receipt saved'),
    RFQ_STARTED: t('创建 RFQ', 'Creating RFQ'),
    RFQ_CREATED: t('RFQ 已创建，结果已保存', 'RFQ created; result saved'),
    MATERIAL_SKIPPED: t('跳过已处理物料', 'Material skipped'),
    ACTION_REQUIRED: t('部分物料需要处理，请查看提示', 'Some materials need attention'),
    RECOVERABLE_ERROR: t('记录物料问题并继续处理', 'Recording a material issue'),
    GROUP_COMPLETED: t('分组处理完成', 'Group finished'),
    GROUP_FAILED: t('分组处理失败', 'Group failed'),
    RUN_COMPLETED: t('执行结束', 'Run finished'),
    RUN_FAILED: t('执行停止，请查看详情', 'Run stopped; review details'),
    RUN_CANCELLED: t('已停止并保存结果', 'Stopped with results saved'),
    RECOVERING: t('正在重新验证 SAP 状态', 'Checking SAP state again'),
    INTERACTION_RESOLVED: t('验证通过，从当前步骤继续', 'Verified; resuming the current step'),
    COMMODITY_CHECK_STARTED: t('检查 Commodity', 'Checking Commodity'),
    NPL_READ_FAILED: t('NPL 数据读取失败', 'NPL data read failed'),
    COMMODITY_RECHECK_STARTED: t('重新查询 NPL 并检查 Commodity', 'Re-querying NPL and checking Commodity'),
    COMMODITY_RECHECK_SUCCESS: t('Commodity 验证通过', 'Commodity verified'),
    SAP_SLOW: t('SAP 响应较慢，仍在等待', 'SAP is responding slowly; still waiting'),
    SAP_RECOVERED: t('SAP 已响应，继续当前步骤', 'SAP responded; continuing the current step')
  }

  return <div className="page">
    <button className={styles.backButton} onClick={onBack} disabled={running}><ArrowLeft size={16} />{t('返回操作中心', 'Back to Operations')}</button>
    <div className="page-heading"><div><h2>{text.title}</h2><p>{text.description}</p></div>
      <span className={styles.environmentBadge}>VCE · {t('正式系统', 'Production')} [949] · Client 100</span></div>
    <div className={styles.steps}>{[t('下载模板', 'Download template'), t('填写并上传', 'Complete and upload'), t('预览并开始', 'Review and start')].map((label, index) => <div key={label}><span>{index + 1}</span><strong>{label}</strong></div>)}</div>
    <div className={styles.layout}><div className={styles.mainColumn}>
      <section className={`card ${styles.section}`}>
        <h3>{t('RFQ 模板', 'RFQ template')}</h3>
        <p>{t('Plant 默认 C100；日期建议填写 YYYY-MM-DD，例如 2026-12-31。G 列 PPAP Date、H 列 Technology 为必填。', 'Plant defaults to C100. Use YYYY-MM-DD for dates, e.g. 2026-12-31. PPAP Date (G) and Technology (H) are required.')}</p>
        <p className={styles.hint}>{t('I 列 12 MR Qty、K 列 RFQ Qty Serial 为必填。I/J/K 无默认值；J 列选填，留空不写入 SAP 数量。Cost Breakdown：No／留空强制取消已有勾选；Yes 不操作，保留 SAP 原状态（不会自动勾选）。', '12 MR Qty (I) and RFQ Qty Serial (K) are required. I/J/K have no defaults; optional J is not written to SAP when blank. Cost Breakdown: No/blank clears the checkbox; Yes leaves SAP unchanged and does not check an unchecked box.')}</p>
        <div className={styles.fileActions}>
          <button className="button" disabled={loading || running} onClick={() => void download()}><Download size={16} />{t('下载模板', 'Download template')}</button>
          <button className="button primary" disabled={loading || running} onClick={() => void upload()}><Upload size={16} />{loading ? t('处理中…', 'Processing…') : t('上传已填写模板', 'Upload completed template')}</button>
        </div>
        {downloadedPath && <p className={styles.savedPath}>{t('模板已保存：', 'Template saved: ')}{downloadedPath}</p>}
        {excelPath && <p className={styles.path}>{excelPath}</p>}
        <p className={styles.hint}>{t('使用已保存的 Excel 内容。原文件保持安全；结果保存到本机独立文件，可在完成后打开。', 'Uses the saved Excel content. Your original is kept safe; results are saved to a separate local workbook.')}</p>
      </section>
      {preview && <section className={`card ${styles.section}`}>
        <h3>{preview.invalidRows ? t('请修正数据后重新上传', 'Correct the data and upload again') : t('RFQ 文件已就绪', 'RFQ file ready')}</h3>
        <div className={styles.metrics}>
          <Metric label={t('物料', 'Materials')} value={preview.validRows} />
          <Metric label={t('RFQ 分组', 'RFQ groups')} value={preview.groupCount} />
          <Metric label={t('无效行', 'Invalid rows')} value={preview.invalidRows} />
        </div>
        <p>{t('输入行', 'Input rows')}: {preview.totalRows} · {t('唯一待执行行', 'Unique ready rows')}: {preview.validRows} · {t('重复行自动忽略', 'Duplicates automatically ignored')}: {preview.duplicateRows ?? 0}</p>
        <p>Plant: {preview.plants.join(', ')} · {t('已处理行', 'Previously processed rows')}: {preview.skippedRows - (preview.duplicateRows ?? 0)}</p>
        <p className={styles.hint}>{t('同 Plant + Project + Supplier Parma 合并，每组最多 50 个物料。', 'Same Plant + Project + Supplier Parma form one RFQ; up to 50 materials per group.')}</p>
        {preview.warnings.map((warning) => <p className={styles.warning} key={warning}>{warning}</p>)}
        <details open={preview.invalidRows > 0}><summary>{t('查看明细', 'View details')} · {preview.sheetName}</summary>
          <div className={styles.scrollTable}><table><thead><tr><th>{t('行', 'Row')}</th><th>Material</th><th>Project</th><th>Supplier Parma</th><th>12 MR Qty</th><th>RFQ Qty Prototype</th><th>RFQ Qty Serial</th><th>Cost Breakdown</th><th>{t('校验', 'Validation')}</th></tr></thead><tbody>
            {preview.sample.map((row) => <tr key={row.excelRow}><td>{row.excelRow}</td><td>{row.material}</td><td>{row.project}</td><td>{row.supplier}</td><td>{row.qty12mr || '—'}</td><td>{row.rfqQtyPrototype || '—'}</td><td>{row.rfqQtySerial || '—'}</td><td>{row.costBreakdown == null ? '—' : row.costBreakdown ? 'Yes' : 'No'}</td><td className={!row.valid ? styles.error : ''}>{row.message || t('有效', 'Valid')}</td></tr>)}
          </tbody></table></div>
        </details>
        <div className={styles.groupList}>{preview.groups.map((entry) => <div key={entry.key}><strong>Parma {entry.supplier}</strong><span>{entry.plant} · Project {entry.project} · {entry.materials.length} {t('个物料', 'materials')}</span><small>{entry.materials.join(', ')}</small></div>)}</div>
      </section>}
    </div><aside className={styles.sideColumn}>
      <section className={`card ${styles.section}`} aria-live="polite">
        <h3>{t('执行状态', 'Run status')}</h3>
        {running ? <button className="button" disabled={stopping} onClick={() => void stop()}><Square size={14} />{stopping ? t('当前组保存后停止…', 'Stopping after current group…') : t('停止', 'Stop')}</button>
          : <button className="button primary" disabled={!canRun} onClick={() => setConfirming(true)}><Play size={16} />{t('开始自动化', 'Start Automation')}</button>}
        <p className={styles.hint}>{t('运行后请完成 SAP 登录。正在处理的分组会在保存后停止。', 'Complete SAP sign-in when prompted. Stop finishes and saves the current group first.')}</p>
        {(running || latest) && <><div className={styles.progressTrack} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${percent}%` }} /></div>
          <p>{completedGroups} / {preview?.groupCount ?? 0} · {percent}%</p>
          <strong>{latest?.state === 'WAITING_FOR_USER' ? t('已暂停，等待用户处理', 'Paused; waiting for user') : stepLabels[latest?.type ?? ''] || t('准备运行', 'Preparing run')}</strong></>}
        {running && <AdaptiveEta eta={eta} unavailable={etaUnavailable} automationId="create-rfq" total={preview?.groupCount ?? 0}
          waiting={latest?.state === 'WAITING_FOR_USER'} recovering={latest?.state === 'RECOVERING'} />}
        {running && slowWait && <div className={styles.hint} role="status"><strong>{t('SAP 响应较慢', 'SAP is responding slowly')}</strong><p>{t('自动化仍在等待 SAP，暂不需要操作。', 'The automation is still waiting for SAP. No action is required yet.')}</p><p>{t('当前步骤', 'Current step')}: {slowWait.step} · {t('已等待', 'Elapsed wait')}: {Math.round(slowWait.waitSeconds ?? 0)} {t('秒', 'sec')}</p></div>}
        {group && <p>Parma {group.supplier}<br />{group.plant} · Project {group.project}<br />{Array.isArray(group.materials) ? group.materials.join(', ') : ''}</p>}
        {totals && <div className={styles.metrics}><Metric label={t('成功 RFQ', 'Successful RFQs')} value={totals.succeeded ?? 0} /><Metric label={t('跳过', 'Skipped')} value={totals.skipped ?? 0} /><Metric label={t('失败', 'Failed')} value={totals.failed ?? 0} /></div>}
        {attention && <div className={styles.warning}><AlertTriangle size={18} /><strong>{t('需要处理', 'Action required')}</strong>
          <p>Material: {Array.isArray(attention.materials) ? attention.materials.join(', ') : '—'} · {t('阶段', 'Stage')}: {attention.step || attention.type}</p>
          <p>{attention.message}</p><p>{t('其他可处理物料会继续执行。请在结果中修正该物料，再重新上传。', 'Other eligible materials continue. Correct this material in the result workbook, then upload again.')}</p></div>}
        {result && <div className={styles.resultPaths}>
          <strong>{result.success ? t('执行结束', 'Automation finished') : t('执行已停止', 'Automation stopped')}</strong>
          <p>{result.message}</p>
          {result.success && <p>{t('成功但含跳过物料的组', 'Successful groups with skipped materials')}: {result.withSkips ?? 0}</p>}
          {result.resultPath && <button className="button" onClick={() => void open(result.resultPath!)}><FolderOpen size={16} />{t('打开结果文件', 'Open Result File')}</button>}
          {result.diagnosticsPath && <button className="button" onClick={() => void open(result.diagnosticsPath!)}>{t('打开本地诊断资料', 'Open local diagnostics')}</button>}
          <button className="button" onClick={() => { setResult(null); setPreview(null); setExcelPath(''); setEvents([]); setAttention(null); setNumbers([]) }}>{t('运行另一任务', 'Run Another Task')}</button>
        </div>}
        {numbers.length > 0 && <p><strong>{t('已创建 RFQ 编号', 'Created RFQ numbers')}</strong><br />{numbers.join(', ')}</p>}
        {events.length > 0 && <details><summary>{t('查看执行详情', 'View execution details')}</summary><div className={styles.progressLog}>{events.map((entry, index) => <p key={index}>{entry.message}</p>)}</div></details>}
      </section>
    </aside></div>
    <dialog ref={dialog} className={styles.confirmDialog} onCancel={() => setConfirming(false)} aria-labelledby="rfq-confirm-title">
      <h2 id="rfq-confirm-title">{t('确认开始', 'Ready to Start')}</h2>
      <p>VCE / {t('正式系统', 'Production')} [949] / Client 100</p>
      <p>{t('RFQ 分组', 'RFQ Groups')}: {preview?.groupCount} · {t('物料', 'Materials')}: {preview?.validRows}</p>
      <p>{t('本次操作将在 SAP 中创建真实 Buyer Receipt 和 RFQ。', 'This operation will create Buyer Receipts and RFQs in SAP Production.')}</p>
      <div className={styles.fileActions}><button className="button" autoFocus onClick={() => setConfirming(false)}>{t('取消', 'Cancel')}</button><button className="button primary" onClick={() => void start()}>{t('确认并开始', 'Confirm and Start')}</button></div>
    </dialog>
  </div>
}
function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return <div><span>{label}</span><strong>{value}</strong></div>
}
