import { useEffect, useMemo, useRef, useState } from 'react'
import { FileCheck2, FileSpreadsheet } from 'lucide-react'
import type { Me12BatchConfig, Me12ExcelPreview } from '../../../../shared/me12-types'
import type { Me01BatchConfig, Me01ExcelPreview } from '../../../../shared/me01-types'
import { me01BusinessDefaults, resolveMe01Business } from '../../../../shared/me01-types'
import type { ApqpConfig, ApqpPreview } from '../../../../shared/apqp-types'
import { apqpPreviewForMode } from '../../../../shared/apqp-types'
import type { AutomationOutcome, AutomationState } from '../../../../shared/guided-automation'
import { outcomeOf } from '../../../../shared/guided-automation'
import { useLocalization } from '../../i18n/use-localization'
import { operationCopy } from '../../i18n/operation-copy'
import { completedUnits, type AutomationId, type TimingProgress } from '../../../../shared/local-intelligence'
import { useAdaptiveEta } from '../../hooks/use-adaptive-eta'
import { AdaptiveEta } from './AdaptiveEta'
import type { Notify } from '../../types/notifications'
import { AutomationPageLayout, AutomationProgress, AutomationResult, FileUploader, PreviewSummary,
  RunConfirmationModal, TemplateDownloadButton, ValidationSummary, ViewDetailsPanel, NoticeConfirmationModal } from './AutomationPageLayout'
import { stateLabel } from './state-label'
import { AutomationTaskToolbar } from './AutomationTaskToolbar'
import styles from './GuidedAutomation.module.css'

type Module = 'info-record' | 'source-list' | 'apqp'
type Preview = Me12ExcelPreview | Me01ExcelPreview | ApqpPreview
const me12Defaults: Me12BatchConfig = { excelPath: '', sheetName: '', infoRecordColumn: 1, plantColumn: 2, dataStartRow: 2,
  targetPlant: 'C100', purchasingOrganization: 'C100', targetLeadTime: '1', infoCategory: 'standard', infoRecordWidth: 10,
  dryRun: false, maxItems: 0, maxRetries: 2, saveEvery: 5 }
const apqpDefaults: ApqpConfig = { excelPath: '', sheetName: '', plant: 'C100', system: '', client: '', maxWorkers: 3,
  createSessions: false, maxItems: 0, overwriteExisting: false, confirmed: false }
const automationNames = { 'info-record': 'Info Record', 'source-list': 'Source List', apqp: 'APQP' }
const defaultBusiness = (): { plant: string; org: string; leadTime: string; category: string; overwrite: boolean; validFrom: string; validTo: string } => ({
  plant: 'C100', org: 'C100', leadTime: '1', category: 'standard', overwrite: false,
  validFrom: me01BusinessDefaults().validFrom, validTo: '2099-12-31' })

export function GuidedAutomationPage({ module, notify, onBack, embedded = false, onBusyChange }: { module: Module; notify: Notify; onBack: () => void; embedded?: boolean; onBusyChange?: (busy: boolean) => void }): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const t = (en: string, cn: string): string => zh ? cn : en
  const { title, description, permissionNotice } = operationCopy(module === 'info-record' ? 'me12-lead-time' : module === 'source-list' ? 'me01-source-list' : 'apqp-plan-closure', language)
  const [file, setFile] = useState('')
  const [downloaded, setDownloaded] = useState('')
  const [business, setBusiness] = useState(defaultBusiness)
  const [fileRevision, setFileRevision] = useState(0)
  const [parsedPreview, setPreview] = useState<Preview | null>(null)
  const preview = useMemo(() => module === 'apqp' && parsedPreview && 'selected' in parsedPreview
    ? apqpPreviewForMode(parsedPreview, business.overwrite) : parsedPreview, [module, parsedPreview, business.overwrite])
  const latestOverwrite = useRef(business.overwrite)
  latestOverwrite.current = business.overwrite
  const [state, setState] = useState<AutomationState>('READY')
  const [error, setError] = useState('')
  const [technicalError, setTechnicalError] = useState('')
  const [sourceNotice, setSourceNotice] = useState<{ title: string; message: string; details?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  useEffect(() => { onBusyChange?.(busy || running || state === 'VALIDATING') }, [busy, running, state, onBusyChange])
  const [stopping, setStopping] = useState(false)
  const automationId: AutomationId = module === 'info-record' ? 'me12-batch' : module === 'source-list' ? 'me01-source-list' : 'apqp-plan-closure'
  const { eta, unavailable: etaUnavailable } = useAdaptiveEta(automationId, running)
  const [completed, setCompleted] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [outcome, setOutcome] = useState<AutomationOutcome | null>(null)
  const [events, setEvents] = useState<{ message: string; current?: number; total?: number }[]>([])
  const runningRef = useRef(false)
  const runInFlight = useRef(false)
  const api = window.sapAutomation
  const config = useMemo(() => module === 'info-record'
    ? { ...me12Defaults, excelPath: file, targetPlant: business.plant, purchasingOrganization: business.org,
        targetLeadTime: business.leadTime, infoCategory: business.category as Me12BatchConfig['infoCategory'] }
    : module === 'source-list' ? { excelPath: file, confirmed: false, purchasingOrganization: business.org, validFrom: business.validFrom, validTo: business.validTo }
    : { ...apqpDefaults, excelPath: file, plant: business.plant, overwriteExisting: business.overwrite }, [file, business, module])
  // APQP refresh chooses rows from one upload snapshot. Plant/re-upload still
  // invalidate it; the start handler/engine independently recheck live Excel.
  const previewKey = module === 'apqp' ? JSON.stringify([file, business.plant]) : JSON.stringify(config)

  useEffect(() => {
    const report = (event: { message: string } & TimingProgress): void => {
      if (runningRef.current) {
        setEvents(current => [...current.slice(-49), event])
        const count = completedUnits(automationId, event)
        if (count !== undefined) setCompleted(current => Math.max(current, count))
      }
    }
    const unsubscribe = module === 'info-record' ? api.onMe12Progress(report) : module === 'source-list' ? api.onMe01Progress(report) : api.onApqpProgress(report)
    const interaction = api.onAutomationInteraction(request => {
      if (!runningRef.current) return
      if (request?.automation === automationNames[module]) setState(request.state)
      else if (!request) setState(current => ['WAITING_FOR_USER', 'RECOVERING'].includes(current) ? 'RUNNING' : current)
    })
    return () => { unsubscribe(); interaction() }
  }, [api, module, automationId])
  useEffect(() => {
    if (!file || running) return
    let active = true
    setState('VALIDATING'); setError(''); setTechnicalError(''); setPreview(null); setOutcome(null); setConfirming(false)
    setSourceNotice(null)
    const timer = window.setTimeout(() => {
      const invalidBusiness = module !== 'source-list' && !/^[A-Z0-9]{1,4}$/.test(business.plant)
        ? t('Enter a Plant code using 1–4 letters or numbers.', '请输入 1–4 位字母或数字组成的工厂代码。')
        : module === 'info-record' && (!/^[A-Z0-9]{1,4}$/.test(business.org) || !/^\d{1,3}$/.test(business.leadTime))
          ? t('Enter a valid purchasing organization and a whole-number lead time between 0 and 999 days.', '请输入有效采购组织，以及 0–999 的整数交货天数。') : ''
      if (invalidBusiness) { setState('READY'); setError(invalidBusiness); return }
      if (module === 'source-list') {
        try { resolveMe01Business(config as Me01BatchConfig) } catch (reason) { setState('READY'); setError(String(reason)); setSourceNotice({ title: t('Check Source List settings', '请检查货源清单设置'), message: String(reason) }); return }
      }
      const request = module === 'info-record' ? api.previewMe12Batch(config as Me12BatchConfig)
        : module === 'source-list' ? api.previewMe01Batch(config as Me01BatchConfig) : api.previewApqp(config as ApqpConfig)
      void request.then(response => {
        if (!active) return
        if (!response.success) {
          if ('errorCode' in response && response.errorCode === 'APQP_TEMPLATE_INVALID') {
            setState('READY'); setTechnicalError(response.message)
            setError(t('Excel headers do not match or the file cannot be read. Download the APQP template: A = Part No., B = Vendor, C = APQP plan closure date. Save before uploading. Previous five-column templates are still supported.',
              'Excel 表头不匹配或文件无法读取。请下载 APQP 模板：A 列物料、B 列供应商、C 列计划关闭日期。保留表头并保存后上传；旧五列模板仍兼容。'))
            return
          }
          throw new Error(response.message)
        }
        if (module === 'apqp' && 'selected' in response.preview && !response.preview.modes &&
          (config as ApqpConfig).overwriteExisting !== latestOverwrite.current) {
          // An older engine cannot answer a policy changed while it was reading.
          setFileRevision(current => current + 1)
          return
        }
        setPreview(response.preview)
        const count = 'selectedInfoRecords' in response.preview ? response.preview.selectedInfoRecords : 'uniqueMaterials' in response.preview ? response.preview.uniqueMaterials : apqpPreviewForMode(response.preview, latestOverwrite.current).selected
        setState(count ? 'READY_TO_START' : 'READY')
        if (!count) setError(t('No pending records. Check your input and business choices, then upload again.', '没有待处理记录，请检查输入和业务选项后重新上传。'))
      }).catch((reason: unknown) => {
        if (!active) return
        setState('READY'); setTechnicalError(reason instanceof Error ? reason.message : String(reason))
        setError(t('We could not validate this file. Check the required template columns and try again.', '文件未通过校验。请检查模板必填字段，保存后重新上传。'))
        if (module === 'source-list') setSourceNotice({ title: t('Source List file could not be validated', '货源清单文件校验未通过'), message: reason instanceof Error ? reason.message : String(reason) })
        notify({ kind: 'error', title: t('Check your file', '请检查文件'), message: t('Review the validation details before continuing.', '请查看校验详情后重试。') })
      })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
    // A language switch is presentation-only and must not reset an active task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, previewKey, fileRevision, module])
  const records = preview ? 'selectedInfoRecords' in preview ? preview.selectedInfoRecords : 'uniqueMaterials' in preview ? preview.uniqueMaterials : preview.selected : 0
  const invalid = preview && 'invalid' in preview ? preview.invalid : 0
  const metrics: { label: string; value: string | number }[] = [{ label: t('Records to process', '待处理记录'), value: records }, { label: t('Plant', '工厂'), value: module === 'source-list' ? 'C100' : business.plant }]
  if (preview && 'uniqueMaterials' in preview) metrics.push({ label: t('Materials', '物料数'), value: preview.uniqueMaterials },
    { label: t('Suppliers', '供应商数'), value: preview.uniqueSuppliers ?? '—' })
  if (preview && 'selected' in preview) metrics.push({ label: t('Existing dates skipped', '跳过已有日期'), value: preview.skipped }, { label: t('Incomplete rows', '不完整行'), value: preview.invalid })
  if (preview && 'duplicateRows' in preview) metrics.push({ label: t('Duplicate rows ignored', '忽略重复行'), value: preview.duplicateRows })
  if (preview && 'singleSourcingMaterials' in preview) metrics.push(
    { label: t('No — switch fixed source', 'No — 切换固定货源'), value: preview.singleSourcingMaterials },
    { label: t('Yes — retain other Fix', 'Yes — 保留其他 Fix'), value: preview.dualSourcingMaterials })
  if (module === 'source-list') metrics.push({label: t('Purchasing Organization', '采购组织'), value:business.org},
    {label:t('New row validity', '新增行有效期'), value:`${business.validFrom} → ${business.validTo}`})
  const canRun = records > 0 && !invalid && !running && !busy && state === 'READY_TO_START'
  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = module === 'info-record' ? await api.downloadMe12Template() : module === 'source-list' ? await api.downloadMe01Template() : await api.downloadApqpTemplate()
      if (response.success) { setDownloaded(response.path); notify({ kind: 'success', title: t('Template downloaded', '模板已下载'), message: t('Fill the required columns, save, then upload here.', '填写必填列并保存，然后在这里上传。') }) }
      else if (!response.cancelled) throw new Error(response.message)
    } catch (reason) { setTechnicalError(String(reason)); if (module === 'source-list') setSourceNotice({ title: t('Download unavailable', '未能下载模板'), message: String(reason) }); notify({ kind: 'error', title: t('Download unavailable', '未能下载'), message: t('Try again or view details.', '请重试或查看详情。') }) } finally { setBusy(false) }
  }
  const upload = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = module === 'info-record' ? await api.selectMe12ExcelFile() : module === 'source-list' ? await api.selectMe01ExcelFile() : await api.selectApqpExcel()
      if (response.success) { setPreview(null); setOutcome(null); setEvents([]); setCompleted(0); setFile(response.path); setFileRevision(current => current + 1) }
      else if (!response.cancelled) throw new Error(response.message)
    } catch (reason) { setTechnicalError(String(reason)); if (module === 'source-list') setSourceNotice({ title: t('File unavailable', '未能读取文件'), message: String(reason) }); notify({ kind: 'error', title: t('File unavailable', '未能读取文件'), message: t('Choose the saved Excel template and try again.', '请选择已保存的 Excel 模板后重试。') }) } finally { setBusy(false) }
  }
  const openResult = async (path: string): Promise<void> => {
    try {
      const response = await api.openAutomationArtifact(path)
      if (!response.success) throw new Error(response.message)
    } catch (reason) {
      if (module === 'source-list') setSourceNotice({ title: t('Could not open result', '未能打开结果'), message: String(reason), details: path })
      notify({ kind: 'error', title: t('Could not open result', '未能打开结果'), message: t('The result could not be opened. Its saved location is shown below.', '未能打开结果，保存位置已显示在下方。') })
    }
  }
  const start = async (): Promise<void> => {
    if (!canRun || runInFlight.current) return
    runInFlight.current = true; runningRef.current = true
    setConfirming(false); setSourceNotice(null); setRunning(true); setStopping(false); setState('RUNNING'); setEvents([]); setOutcome(null); setCompleted(0)
    window.dispatchEvent(new CustomEvent('guided-running', { detail: true }))
    try {
      const response = module === 'info-record' ? await api.startMe12Batch({ ...(config as Me12BatchConfig), confirmed: true })
        : module === 'source-list' ? await api.startMe01Batch({ ...(config as Me01BatchConfig), confirmed: true }) : await api.startApqp(config as ApqpConfig)
      const result = outcomeOf(response, records)
      setOutcome(result); setState(result.state)
      const writebackWarning = 'warning' in response && typeof response.warning === 'string' ? response.warning : ''
      if (module === 'source-list' && (result.state === 'FAILED' || result.failed > 0 && result.state !== 'CANCELLED' || writebackWarning)) {
        setSourceNotice({ title: writebackWarning ? t('Results saved in the log folder', '结果已保存在日志目录') : t('Source List could not finish', '货源清单未能完成'),
          message: writebackWarning || result.details, details: [result.resultPath, result.backupPath].filter(Boolean).join('\n') })
      }
      notify({ kind: result.state === 'FAILED' ? 'error' : result.state === 'COMPLETED' ? 'success' : 'warning', title: stateLabel(result.state, zh),
        message: t('Review your results below.', '请查看下方运行结果。') })
      // A preference read/open failure must not turn a completed SAP batch into a failed one.
      const settings = await api.getSettings().catch(() => null)
      if (settings?.openResultAfterCompletion && result.resultPath) await openResult(result.resultPath)
    } catch (reason) {
      setOutcome(outcomeOf({ success: false, message: String(reason) }, records)); setState('FAILED')
      if (module === 'source-list') setSourceNotice({ title: t('Source List could not finish', '货源清单未能完成'), message: String(reason) })
      notify({ kind: 'error', title: t('Could not complete', '未能完成'), message: t('Review details before retrying.', '请查看详情后再重试。') })
    } finally { runningRef.current = false; runInFlight.current = false; setRunning(false); setStopping(false); window.dispatchEvent(new CustomEvent('guided-running', { detail: false })) }
  }
  const cancel = async (): Promise<void> => {
    if (stopping || !runningRef.current) return
    setStopping(true)
    try {
      const result = module === 'info-record' ? await api.cancelMe12Batch() : module === 'source-list' ? await api.cancelMe01Batch() : await api.cancelApqp()
      if (!result.success) throw new Error('Stop request was not accepted.')
    } catch { setStopping(false); notify({ kind: 'error', title: t('Could not request stop', '未能请求停止'), message: t('The task is still running. Try Stop safely again.', '任务仍在运行，请再次点击安全停止。') }) }
  }
  const reset = (): void => {
    if (busy || runInFlight.current) return
    setFile(''); setDownloaded(''); setBusiness(defaultBusiness()); setFileRevision(current => current + 1)
    setPreview(null); setOutcome(null); setEvents([]); setCompleted(0); setError(''); setTechnicalError(''); setConfirming(false); setStopping(false); setState('READY')
    setSourceNotice(null)
  }
  const hasData = Boolean(file || downloaded || preview || outcome || error || technicalError || events.length || JSON.stringify(business) !== JSON.stringify(defaultBusiness()))
  const requestStart = (): void => {
    if (!canRun) return
    if (module === 'apqp') void start()
    else { setConfirming(true); notify({ kind: 'warning', title: t('Ready to update', '准备更新'), message: t('Review the batch confirmation.', '请核对本次批量修改。') }) }
  }
  const update = (key: keyof typeof business, value: string | boolean): void => {
    setBusiness(current => ({ ...current, [key]: value }))
    if (module === 'apqp' && key === 'overwrite' && parsedPreview && 'selected' in parsedPreview && parsedPreview.modes) {
      const selected = apqpPreviewForMode(parsedPreview, value === true).selected
      setOutcome(null); setConfirming(false); setTechnicalError('')
      setState(selected ? 'READY_TO_START' : 'READY')
      setError(selected ? '' : t('No pending records. Check your input and business choices, then upload again.', '没有待处理记录，请检查输入和业务选项后重新上传。'))
      return
    }
    // Changing the policy while parsing must not cancel or restart that read.
    if (module === 'apqp' && key === 'overwrite' && !parsedPreview) return
    // Backward compatibility with a pre-update engine that has no mode snapshot.
    if (module === 'apqp' && key === 'overwrite') setFileRevision(current => current + 1)
    setState(file ? 'VALIDATING' : 'READY'); setPreview(null)
  }
  return <AutomationPageLayout title={title} description={description} onBack={onBack} embedded={embedded} toolbar={
    <AutomationTaskToolbar status={canRun ? t(`${records} records ready to process`, `已就绪，待处理 ${records} 条记录`) : error ? t('Check your file', '请检查上传文件') : stateLabel(state, zh)}
      hint={running ? t('Keep SAP open. Stop safely preserves saved results.', '请保持 SAP 打开；安全停止会保留已保存的结果。') : outcome ? t('Open your result below, or clear this page for a new task.', '在下方打开结果，或清空本页准备新任务。') : file ? t('Review the preview below, then start from here.', '核对下方预览后，在这里开始执行。') : t('Download the template, fill it, then upload to get started.', '下载模板、填写并上传，即可开始。')}
      startLabel={module === 'apqp' ? t('Start query', '开始查询') : t('Start Automation', '开始自动化')}
      canRun={canRun} running={running} stopping={stopping} locked={busy} canClear={hasData} onStart={requestStart} onStop={() => void cancel()} onClear={reset} />
  }>
    {permissionNotice && <p className={styles.warning} role="note">{permissionNotice}</p>}
    {module === 'apqp' && <p className={styles.warning} role="note">{t('Before starting, save any work in SAP. You do not need to return to SAP home: existing 949 windows in other T-codes can switch directly to ZMFM050035. Parallel workers reuse the selected windows without creating sessions. Handle any SAP save/discard prompt yourself.', '开始前请先保存 SAP 当前页面的工作。不需要返回 SAP 首页：949 窗口停在其他 T-code 也能直接切换到 ZMFM050035。并发查询会复用选中的已有窗口，不新建会话；保存/放弃提示仍由你处理。')}</p>}
    <div className={styles.body}><section className={`card ${styles.section}`}>
      <div className={styles.sectionTitle}><span className={styles.sectionIcon}><FileSpreadsheet size={20} /></span><div><h3>{t('Prepare your Excel', '准备 Excel 文件')}</h3><p>{t('Fill the input columns only; results are written automatically.', '只填输入列，结果由系统自动回写。')}</p></div></div>
      <p>{t('Save Excel before upload. It may remain open during the run.', '上传前请保存 Excel；运行时可以保持打开。')}</p>
      {module === 'apqp' && (parsedPreview as ApqpPreview | null)?.source === 'saved-file' && <p>{t('Fast preview uses the saved file. Before querying SAP, the app rechecks the current Excel data, including unsaved edits.', '快速预览读取已保存文件；开始查询 SAP 前会重新校验 Excel 当前数据，包括未保存的修改。')}</p>}
      <div className={styles.actions}><TemplateDownloadButton busy={busy || running} onDownload={() => void download()} /><FileUploader busy={busy || running} onUpload={() => void upload()} /></div>
      {downloaded && <p className={styles.filename}>{t('Downloaded', '已下载')}: {downloaded.split(/[\\/]/).pop()}</p>}
      {file && <p className={styles.filename}>{t('Uploaded file', '已上传文件')}: {file.split(/[\\/]/).pop()}</p>}
      {module === 'info-record' && <><h3>{t('2. What should be updated?', '2. 本次更新内容')}</h3><div className={styles.fields}>
        {[['plant', t('Plant', '工厂')], ['org', t('Purchasing Organization', '采购组织')], ['leadTime', t('Supplier Lead Time (days)', '供应商交货时间（天）')]].map(([key, label]) => <label className="field" key={key}><span>{label} *</span><input className="input" disabled={running} value={business[key as 'plant' | 'org' | 'leadTime']} onChange={event => update(key as 'plant' | 'org' | 'leadTime', event.target.value.toUpperCase())} /></label>)}
        <label className="field"><span>{t('Purchasing Type', '采购类型')}</span><select className="select" disabled={running} value={business.category} onChange={event => update('category', event.target.value)}><option value="standard">{t('Standard', '标准采购')}</option><option value="consignment">{t('Consignment', '寄售采购')}</option></select></label>
      </div></>}
      {module === 'apqp' && <><p className={styles.notice}>{t('Read-only SAP query. Dates are written to Excel, not SAP.', '只查询 SAP，日期回写到 Excel，不修改 SAP 数据。')}</p><div className={styles.fields}><label className="field"><span>{t('Plant', '工厂')}</span><input className="input" disabled={running} value={business.plant} onChange={event => update('plant', event.target.value.toUpperCase())} /></label>
        <label className="field"><span>{t('Refresh dates already in Excel', '刷新 Excel 中已有日期')}</span><select className="select" aria-label={t('Refresh dates already in Excel', '刷新 Excel 中已有日期')} value={business.overwrite ? 'yes' : 'no'} disabled={running} onChange={event => update('overwrite', event.target.value === 'yes')}><option value="no">{t('No — keep existing dates', '否，保留已有日期')}</option><option value="yes">{t('Yes — query again', '是，重新查询')}</option></select></label></div></>}
      {module === 'source-list' && <><h3>{t('New source row', '新增货源行')}</h3><div className={styles.fields}>
        <label className="field"><span>{t('Purchasing Organization', '采购组织')} *</span><input className="input" disabled={running || busy} value={business.org} onChange={event => update('org',event.target.value.toUpperCase())} /></label>
        <label className="field"><span>{t('Valid from', '有效起始日期')} *</span><input className="input" type="date" disabled={running || busy} value={business.validFrom} onChange={event => update('validFrom',event.target.value)} /></label>
        <label className="field"><span>{t('Valid to', '有效截止日期')} *</span><input className="input" type="date" disabled={running || busy} value={business.validTo} onChange={event => update('validTo',event.target.value)} /></label>
      </div><p className={styles.notice}>{t('Plant C100. If this material already has the target Parma, skip it without changing any existing dates, Fix or MRP, and continue to the next material. Otherwise add the target row with Fix and MRP 1: Yes retains other Fix/MRP; No clears them without deleting any source records. Excel may remain open.', '工厂固定 C100。同一物料的目标 Parma 已存在时直接跳过，不修改日期、Fix 或 MRP，继续下一条。目标 Parma 不存在时新增，勾选 Fix、MRP 填 1：Yes 保留其他 Fix/MRP；No 清空其他 Fix/MRP，但不删除货源记录。Excel 可保持打开。')}</p></>}
      <ViewDetailsPanel><pre>{technicalError || t('Template columns and execution settings are detected automatically.', '系统自动识别模板列和执行参数。')}{'\n'}{file}{'\n'}{downloaded}</pre></ViewDetailsPanel>
    </section><section className={`card ${styles.section}`}><div className={styles.sectionTitle}><span className={styles.sectionIcon}><FileCheck2 size={20} /></span><div><h3>{t('Review your batch', '核对本次任务')}</h3><p>{t('Check the record count and sample before starting.', '开始前确认记录数和数据抽样。')}</p></div></div><ValidationSummary state={state} error={error} />
      {!preview && !running && !outcome && <div className={styles.emptyPreview}><FileCheck2 size={28} /><strong>{state === 'VALIDATING' ? t('Checking your Excel…', '正在校验 Excel…') : t('Your preview appears here', '上传后，这里会显示预览')}</strong><p>{t('Upload a completed template. The Hub checks it before enabling Start above.', '上传已填写模板，系统校验通过后会启用上方开始按钮。')}</p></div>}
      {preview && <><PreviewSummary metrics={metrics} />
        {invalid > 0 && <p className={styles.warning}>{t('Some rows are incomplete. Fill both material and supplier, then upload again.', '有不完整行，请补全物料和供应商后重新上传。')}</p>}
        <p>{t('Sample of your business data', '业务数据抽样')}</p><table className={styles.table}><thead><tr><th>{t('Record / Material', '记录 / 物料')}</th><th>{t('Supplier', '供应商')}</th>{module === 'source-list' && <th>{t('Dual Sourcing', '是否双供')}</th>}</tr></thead><tbody>{preview.sample.map((row, i) => <tr key={i}><td>{'infoRecord' in row ? row.infoRecord : row.material}</td><td>{'parma' in row ? row.parma : 'vendor' in row ? row.vendor : '—'}</td>{module === 'source-list' && <td>{'dualSourcing' in row ? row.dualSourcing ? t('Yes — retain other Fix', 'Yes — 保留其他 Fix') : t('No — switch source', 'No — 切换货源') : '—'}</td>}</tr>)}</tbody></table><ViewDetailsPanel><pre>{JSON.stringify(preview, null, 2)}</pre></ViewDetailsPanel>
      </>}
      {running && <><AutomationProgress state={state} current={completed} total={records} />
        <AdaptiveEta eta={eta} unavailable={etaUnavailable} automationId={automationId} total={records}
          waiting={state === 'WAITING_FOR_USER'} recovering={state === 'RECOVERING'} /></>}
      {running && <ViewDetailsPanel><pre>{events.map(event => event.message).join('\n')}</pre></ViewDetailsPanel>}
    </section></div>
    {outcome && <AutomationResult outcome={outcome} onOpen={() => void openResult(outcome.resultPath || '')} onAnother={reset} expandedDetails={module === 'source-list'} />}
    {module === 'source-list' && <NoticeConfirmationModal notice={sourceNotice} onClose={() => setSourceNotice(null)} expandedDetails />}
    <RunConfirmationModal open={confirming} title={t('Ready to update', '准备更新')} description={[t('This batch will update purchasing data in SAP. Completed changes will not be rolled back when stopped.', '本次将批量修改 SAP 采购数据。停止任务不会撤销已保存的修改。'), module === 'source-list' ? t('Existing target Parma: skip without changes. Missing target: add Fix and MRP 1; No clears other Fix/MRP, Yes retains them. No source record is deleted.', '目标 Parma 已存在：跳过且不修改；不存在：新增 Fix 和 MRP 1。No 清空其他 Fix/MRP，Yes 保留，不删除货源记录。') : '', permissionNotice].filter(Boolean).join(' ')} metrics={metrics} onCancel={() => setConfirming(false)} onStart={() => void start()} />
  </AutomationPageLayout>
}
