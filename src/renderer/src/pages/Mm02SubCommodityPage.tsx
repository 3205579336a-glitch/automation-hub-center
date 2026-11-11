import { useEffect, useRef, useState } from 'react'
import { FileCheck2, FileSpreadsheet } from 'lucide-react'
import { outcomeOf, type AutomationOutcome, type AutomationState } from '../../../shared/guided-automation'
import { MM02_OPERATION, type Mm02Preview, type Mm02Progress } from '../../../shared/mm02-types'
import { AdaptiveEta } from '../components/automation/AdaptiveEta'
import { AutomationPageLayout, AutomationProgress, AutomationResult, FileUploader, NoticeConfirmationModal, PreviewSummary,
  RunConfirmationModal, TemplateDownloadButton, ValidationSummary } from '../components/automation/AutomationPageLayout'
import { AutomationTaskToolbar } from '../components/automation/AutomationTaskToolbar'
import { useTaskRun } from '../components/automation/task-run-context'
import styles from '../components/automation/GuidedAutomation.module.css'
import { stateLabel } from '../components/automation/state-label'
import { useAdaptiveEta } from '../hooks/use-adaptive-eta'
import { operationCopy } from '../i18n/operation-copy'
import { useLocalization } from '../i18n/use-localization'
import type { Notify } from '../types/notifications'

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const filename = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function Mm02SubCommodityPage({ notify, onBack }: { notify: Notify; onBack: () => void }): React.JSX.Element {
  const { language } = useLocalization()
  const { tryStart } = useTaskRun()
  const zh = language === 'zh-CN'
  const t = (en: string, cn: string): string => zh ? cn : en
  const copy = operationCopy(MM02_OPERATION, language)
  const api = window.sapAutomation
  const [file, setFile] = useState('')
  const [downloaded, setDownloaded] = useState('')
  const [preview, setPreview] = useState<Mm02Preview | null>(null)
  const [state, setState] = useState<AutomationState>('READY')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [progress, setProgress] = useState<Mm02Progress | null>(null)
  const [outcome, setOutcome] = useState<AutomationOutcome | null>(null)
  const active = useRef(false)
  const { eta, unavailable } = useAdaptiveEta(MM02_OPERATION, running)

  useEffect(() => {
    const unsubscribe = api.onMm02Progress(event => { if (active.current) setProgress(previous => ({ ...event, current: event.current ?? previous?.current })) })
    const interaction = api.onAutomationInteraction(request => {
      if (!active.current) return
      if (request?.automation === 'Sub-commodity') setState(request.state)
      else if (!request) setState(current => current === 'WAITING_FOR_USER' || current === 'RECOVERING' ? 'RUNNING' : current)
    })
    return () => { unsubscribe(); interaction() }
  }, [api])

  const total = preview?.uniqueMaterials ?? outcome?.total ?? 0
  const canRun = Boolean(preview && state === 'READY_TO_START' && !busy && !running)
  const metrics = [{ label: t('Materials to update', '待处理物料'), value: total }, { label: t('SAP environment', 'SAP 环境'), value: t('Production · 949', '正式 · 949') }]
  if (preview?.duplicateRows) metrics.push({ label: t('Duplicate rows merged', '合并的重复行'), value: preview.duplicateRows })

  const showError = (title: string, message: string): void => { setNotice({ title, message }) }
  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api.downloadMm02Template()
      if (result.success) {
        setDownloaded(result.path)
        notify({ kind: 'success', title: t('Template downloaded', '模板已下载'), message: result.path })
      } else if (!result.cancelled) throw new Error(result.message)
    } catch (reason) { showError(t('Could not download the template', '未能下载模板'), errorText(reason)) }
    finally { setBusy(false) }
  }
  const upload = async (): Promise<void> => {
    setBusy(true)
    try {
      const choice = await api.selectMm02Excel()
      if (!choice.success) { if (!choice.cancelled) throw new Error(choice.message); return }
      setFile(choice.path); setPreview(null); setOutcome(null); setProgress(null); setError(''); setState('VALIDATING')
      const checked = await api.previewMm02Batch(choice.path)
      if (!checked.success) throw new Error(checked.message)
      setPreview(checked.preview); setState('READY_TO_START')
    } catch (reason) {
      setPreview(null); setState('READY'); setError(errorText(reason))
      showError(t('Check the Excel file', '请检查 Excel 文件'), errorText(reason))
    } finally { setBusy(false) }
  }
  const reset = (): void => {
    if (active.current || busy) return
    setFile(''); setDownloaded(''); setPreview(null); setError(''); setOutcome(null); setProgress(null); setState('READY')
  }
  const start = async (): Promise<void> => {
    if (!preview || !canRun || active.current) return
    const release = tryStart('mm02-sub-commodity')
    if (!release) { setConfirming(false); return }
    active.current = true
    setConfirming(false); setRunning(true); setState('RUNNING'); setProgress(null); setOutcome(null)
    try {
      const result = await api.startMm02Batch({ excelPath: file, previewToken: preview.token, confirmed: true })
      const next = outcomeOf(result, preview.uniqueMaterials)
      setOutcome(next); setState(next.state)
      if (next.state === 'FAILED' || next.failed && next.state !== 'CANCELLED') showError(t('Review MM02 results', '请核对 MM02 运行结果'), result.message)
      notify({ kind: next.state === 'FAILED' ? 'error' : next.state === 'COMPLETED' ? 'success' : 'warning',
        title: stateLabel(next.state, zh), message: t('Review the result below.', '请查看下方的运行结果。') })
    } catch (reason) {
      setState('FAILED'); setOutcome(outcomeOf({ success: false, message: errorText(reason) }, preview.uniqueMaterials))
      showError(t('Could not complete MM02', 'MM02 未能完成'), errorText(reason))
    } finally {
      active.current = false; setRunning(false); setStopping(false)
      release()
    }
  }
  const stop = async (): Promise<void> => {
    if (stopping || !active.current) return
    setStopping(true)
    if (!(await api.cancelMm02Batch().catch(() => ({ success: false }))).success) {
      setStopping(false)
      if (active.current) notify({ kind: 'warning', title: t('Stop not yet available', '暂时未能停止'), message: t('Try again in a moment.', '请稍后重试。') })
    }
  }
  const openResult = async (): Promise<void> => {
    if (!outcome?.resultPath) return
    const result = await api.openAutomationArtifact(outcome.resultPath).catch(() => null)
    if (!result?.success) showError(t('Could not open the result', '未能打开结果'), result?.message || outcome.resultPath)
  }
  return <AutomationPageLayout title={copy.title} description={copy.description} onBack={onBack} toolbar={
    <AutomationTaskToolbar status={stateLabel(state, zh)} hint={t('Review your file before updating SAP.', '核对上传的文件后，再开始修改 SAP。')}
      startLabel={t('Start Update', '开始修改')} canRun={canRun} running={running} stopping={stopping} locked={busy}
      canClear={Boolean(file || downloaded || outcome)} onStart={() => setConfirming(true)} onStop={() => void stop()} onClear={reset} />
  }>
    <p className={styles.warning} role="note">{copy.permissionNotice}</p>
    <div className={styles.body}>
      <section className={`card ${styles.section}`}>
        <div className={styles.sectionTitle}><span className={styles.sectionIcon}><FileSpreadsheet size={20} /></span><div><h3>{t('Prepare your Excel', '准备 Excel')}</h3>
          <p>{t('Fill Material and the six-digit Sub-commodity. Keep leading zeros.', '只填物料号和 6 位 Sub-commodity，保留前导零。')}</p></div></div>
        <p>{t('Save your workbook before uploading. It can stay open; the Hub does not modify the source workbook.', '上传前先保存 Excel。运行时可以保持打开，Hub 不会修改原文件。')}</p>
        <div className={styles.actions}><TemplateDownloadButton busy={busy || running} onDownload={() => void download()} />
          <FileUploader busy={busy || running} onUpload={() => void upload()} /></div>
        {downloaded && <p className={styles.filename}>{t('Downloaded', '已下载')}: {filename(downloaded)}</p>}
        {file && <p className={styles.filename}>{t('Uploaded file', '已上传文件')}: {filename(file)}</p>}
      </section>
      <section className={`card ${styles.section}`}>
        <div className={styles.sectionTitle}><span className={styles.sectionIcon}><FileCheck2 size={20} /></span><div><h3>{t('Review your batch', '核对本次任务')}</h3>
          <p>{t('Check the materials and target values.', '请核对物料和目标代码。')}</p></div></div>
        <ValidationSummary state={state} error={error} />
        {preview && <><PreviewSummary metrics={metrics} />
          <table className={styles.table}><caption>{t('Sample', '数据抽样')}</caption><thead><tr><th>Material</th><th>Sub-commodity</th></tr></thead>
            <tbody>{preview.sample.map(row => <tr key={row.material}><td>{row.material}</td><td>{row.subCommodity}</td></tr>)}</tbody></table></>}
        {running && <><AutomationProgress state={state} current={progress?.current ?? 0} total={total} />
          {progress && <p role="status">{progress.message}</p>}
          <AdaptiveEta eta={eta} unavailable={unavailable} automationId={MM02_OPERATION} total={total}
            waiting={state === 'WAITING_FOR_USER'} recovering={state === 'RECOVERING'} /></>}
      </section>
    </div>
    {outcome && <AutomationResult outcome={outcome} onOpen={() => void openResult()} onAnother={reset} expandedDetails />}
    <NoticeConfirmationModal notice={notice} onClose={() => setNotice(null)} />
    <RunConfirmationModal open={confirming} title={t('Update SAP Sub-commodity?', '确认修改 SAP Sub-commodity？')}
      description={t('This writes material master data in Production 949. Leave an idle SAP Easy Access window open. Already-matching records are skipped; stopping does not undo saved changes.',
        '本次会写入正式 949 的物料主数据。请保留一个停在 SAP 首页的空闲窗口。已是目标代码的物料会跳过，停止不会撤销已保存的修改。')}
      metrics={metrics} onCancel={() => setConfirming(false)} onStart={() => void start()} />
  </AutomationPageLayout>
}
