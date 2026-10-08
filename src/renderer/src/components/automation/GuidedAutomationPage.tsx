import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import type { Me12BatchConfig, Me12ExcelPreview } from '../../../../shared/me12-types'
import type { Me01ExcelPreview } from '../../../../shared/me01-types'
import type { ApqpConfig, ApqpPreview } from '../../../../shared/apqp-types'
import type { AutomationOutcome, AutomationState } from '../../../../shared/guided-automation'
import { outcomeOf } from '../../../../shared/guided-automation'
import { useLocalization } from '../../i18n/use-localization'
import type { Notify } from '../../types/notifications'
import { AutomationPageLayout, AutomationProgress, AutomationResult, FileUploader, PreviewSummary,
  RunConfirmationModal, TemplateDownloadButton, ValidationSummary, ViewDetailsPanel } from './AutomationPageLayout'
import { stateLabel } from './state-label'
import styles from './GuidedAutomation.module.css'

type Module = 'info-record' | 'source-list' | 'apqp'
type Preview = Me12ExcelPreview | Me01ExcelPreview | ApqpPreview
const me12Defaults: Me12BatchConfig = { excelPath: '', sheetName: '', infoRecordColumn: 1, plantColumn: 2, dataStartRow: 2,
  targetPlant: 'C100', purchasingOrganization: 'C100', targetLeadTime: '1', infoCategory: 'standard', infoRecordWidth: 10,
  dryRun: false, maxItems: 0, maxRetries: 2, saveEvery: 5 }
const apqpDefaults: ApqpConfig = { excelPath: '', sheetName: '', plant: 'C100', system: '', client: '', maxWorkers: 3,
  createSessions: false, maxItems: 0, overwriteExisting: false, confirmed: false }
const automationNames = { 'info-record': 'Info Record', 'source-list': 'Source List', apqp: 'APQP' }

export function GuidedAutomationPage({ module, notify, onBack }: { module: Module; notify: Notify; onBack: () => void }): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const t = (en: string, cn: string): string => zh ? cn : en
  const title = module === 'info-record' ? t('Update Info Record', '更新采购信息记录') : module === 'source-list' ? t('Update Source List', '更新货源清单') : t('APQP Plan Close Dates', 'APQP 计划关闭日期')
  const [file, setFile] = useState('')
  const [downloaded, setDownloaded] = useState('')
  const [business, setBusiness] = useState({ plant: 'C100', org: 'C100', leadTime: '1', category: 'standard', overwrite: false })
  const [preview, setPreview] = useState<Preview | null>(null)
  const [state, setState] = useState<AutomationState>('READY')
  const [error, setError] = useState('')
  const [technicalError, setTechnicalError] = useState('')
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [outcome, setOutcome] = useState<AutomationOutcome | null>(null)
  const [events, setEvents] = useState<{ message: string; current?: number; total?: number }[]>([])
  const runningRef = useRef(false)
  const runInFlight = useRef(false)
  const api = window.sapAutomation
  const config = useMemo(() => module === 'info-record'
    ? { ...me12Defaults, excelPath: file, targetPlant: business.plant, purchasingOrganization: business.org,
        targetLeadTime: business.leadTime, infoCategory: business.category as Me12BatchConfig['infoCategory'] }
    : { ...apqpDefaults, excelPath: file, plant: business.plant, overwriteExisting: business.overwrite }, [file, business, module])

  useEffect(() => {
    const report = (event: { message: string; current?: number; total?: number }): void => {
      if (runningRef.current) setEvents(current => [...current.slice(-49), event])
    }
    const unsubscribe = module === 'info-record' ? api.onMe12Progress(report) : module === 'source-list' ? api.onMe01Progress(report) : api.onApqpProgress(report)
    const interaction = api.onAutomationInteraction(request => {
      if (!runningRef.current) return
      if (request?.automation === automationNames[module]) setState(request.state)
      else if (!request) setState(current => ['WAITING_FOR_USER', 'RECOVERING'].includes(current) ? 'RUNNING' : current)
    })
    return () => { unsubscribe(); interaction() }
  }, [api, module])
  useEffect(() => {
    if (!file || running) return
    let active = true
    setState('VALIDATING'); setError(''); setTechnicalError(''); setPreview(null); setOutcome(null); setConfirming(false)
    const timer = window.setTimeout(() => {
      const invalidBusiness = module !== 'source-list' && !/^[A-Z0-9]{1,4}$/.test(business.plant)
        ? t('Enter a Plant code using 1–4 letters or numbers.', '请输入 1–4 位字母或数字组成的工厂代码。')
        : module === 'info-record' && (!/^[A-Z0-9]{1,4}$/.test(business.org) || !/^\d{1,3}$/.test(business.leadTime))
          ? t('Enter a valid purchasing organization and a whole-number lead time between 0 and 999 days.', '请输入有效采购组织，以及 0–999 的整数交货天数。') : ''
      if (invalidBusiness) { setState('READY'); setError(invalidBusiness); return }
      const request = module === 'info-record' ? api.previewMe12Batch(config as Me12BatchConfig)
        : module === 'source-list' ? api.previewMe01Batch({ excelPath: file, confirmed: false }) : api.previewApqp(config as ApqpConfig)
      void request.then(response => {
        if (!active) return
        if (!response.success) throw new Error(response.message)
        setPreview(response.preview)
        const count = 'selectedInfoRecords' in response.preview ? response.preview.selectedInfoRecords : 'uniqueMaterials' in response.preview ? response.preview.uniqueMaterials : response.preview.selected
        setState(count ? 'READY_TO_START' : 'READY')
        if (!count) setError(t('No pending records. Check your input and business choices, then upload again.', '没有待处理记录，请检查输入和业务选项后重新上传。'))
      }).catch((reason: unknown) => {
        if (!active) return
        setState('READY'); setTechnicalError(reason instanceof Error ? reason.message : String(reason))
        setError(t('We could not validate this file. Check the required template columns and try again.', '文件未通过校验。请检查模板必填字段，保存后重新上传。'))
        notify({ kind: 'error', title: t('Check your file', '请检查文件'), message: t('Review the validation details before continuing.', '请查看校验详情后重试。') })
      })
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
    // A language switch is presentation-only and must not reset an active task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, config, file, module])
  const records = preview ? 'selectedInfoRecords' in preview ? preview.selectedInfoRecords : 'uniqueMaterials' in preview ? preview.uniqueMaterials : preview.selected : 0
  const invalid = preview && 'invalid' in preview ? preview.invalid : 0
  const metrics: { label: string; value: string | number }[] = [{ label: t('Records to process', '待处理记录'), value: records }, { label: t('Plant', '工厂'), value: module === 'source-list' ? 'C100' : business.plant }]
  if (preview && 'uniqueMaterials' in preview) metrics.push({ label: t('Materials', '物料数'), value: preview.uniqueMaterials },
    { label: t('Suppliers', '供应商数'), value: preview.uniqueSuppliers ?? '—' })
  if (preview && 'selected' in preview) metrics.push({ label: t('Existing dates skipped', '跳过已有日期'), value: preview.skipped }, { label: t('Incomplete rows', '不完整行'), value: preview.invalid })
  if (preview && 'duplicateRows' in preview) metrics.push({ label: t('Duplicate rows ignored', '忽略重复行'), value: preview.duplicateRows })
  const canRun = records > 0 && !invalid && !running && !busy && state === 'READY_TO_START'
  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = module === 'info-record' ? await api.downloadMe12Template() : module === 'source-list' ? await api.downloadMe01Template() : await api.downloadApqpTemplate()
      if (response.success) { setDownloaded(response.path); notify({ kind: 'success', title: t('Template downloaded', '模板已下载'), message: t('Fill the required columns, save, then upload here.', '填写必填列并保存，然后在这里上传。') }) }
      else if (!response.cancelled) throw new Error(response.message)
    } catch (reason) { setTechnicalError(String(reason)); notify({ kind: 'error', title: t('Download unavailable', '未能下载'), message: t('Try again or view details.', '请重试或查看详情。') }) } finally { setBusy(false) }
  }
  const upload = async (): Promise<void> => {
    setBusy(true)
    try {
      const response = module === 'info-record' ? await api.selectMe12ExcelFile() : module === 'source-list' ? await api.selectMe01ExcelFile() : await api.selectApqpExcel()
      if (response.success) { setPreview(null); setOutcome(null); setFile(''); window.setTimeout(() => setFile(response.path), 0) }
      else if (!response.cancelled) throw new Error(response.message)
    } catch (reason) { setTechnicalError(String(reason)); notify({ kind: 'error', title: t('File unavailable', '未能读取文件'), message: t('Choose the saved Excel template and try again.', '请选择已保存的 Excel 模板后重试。') }) } finally { setBusy(false) }
  }
  const openResult = async (path: string): Promise<void> => {
    try {
      const response = await api.openAutomationArtifact(path)
      if (!response.success) throw new Error(response.message)
    } catch { notify({ kind: 'error', title: t('Could not open result', '未能打开结果'), message: t('The result could not be opened. View Details to find its saved location.', '未能打开结果，请在详情中查看保存位置。') }) }
  }
  const start = async (): Promise<void> => {
    if (!canRun || runInFlight.current) return
    runInFlight.current = true; runningRef.current = true
    setConfirming(false); setRunning(true); setState('RUNNING'); setEvents([]); setOutcome(null)
    window.dispatchEvent(new CustomEvent('guided-running', { detail: true }))
    try {
      const response = module === 'info-record' ? await api.startMe12Batch({ ...(config as Me12BatchConfig), confirmed: true })
        : module === 'source-list' ? await api.startMe01Batch({ excelPath: file, confirmed: true }) : await api.startApqp(config as ApqpConfig)
      const result = outcomeOf(response, records)
      setOutcome(result); setState(result.state)
      notify({ kind: result.state === 'FAILED' ? 'error' : result.state === 'COMPLETED' ? 'success' : 'warning', title: stateLabel(result.state, zh),
        message: t('Review your results below.', '请查看下方运行结果。') })
      // A preference read/open failure must not turn a completed SAP batch into a failed one.
      const settings = await api.getSettings().catch(() => null)
      if (settings?.openResultAfterCompletion && result.resultPath) await openResult(result.resultPath)
    } catch (reason) {
      setOutcome(outcomeOf({ success: false, message: String(reason) }, records)); setState('FAILED')
      notify({ kind: 'error', title: t('Could not complete', '未能完成'), message: t('Review details before retrying.', '请查看详情后再重试。') })
    } finally { runningRef.current = false; runInFlight.current = false; setRunning(false); window.dispatchEvent(new CustomEvent('guided-running', { detail: false })) }
  }
  const cancel = async (): Promise<void> => { if (module === 'info-record') await api.cancelMe12Batch(); else if (module === 'source-list') await api.cancelMe01Batch(); else await api.cancelApqp() }
  const update = (key: keyof typeof business, value: string | boolean): void => { setBusiness(current => ({ ...current, [key]: value })); setState(file ? 'VALIDATING' : 'READY'); setPreview(null) }
  const description = module === 'apqp' ? t('Download plan close dates to Excel. This task does not change SAP data.', '查询计划关闭日期并写入 Excel，不修改 SAP 数据。')
    : module === 'info-record' ? t('Update supplier lead times from a completed template.', '上传模板，批量更新供应商交货时间。') : t('Fix the intended supplier for each material in Plant C100.', '在工厂 C100，按物料和供应商代码固定货源。')
  return <AutomationPageLayout title={title} description={description} onBack={onBack}>
    <div className={styles.body}><section className={`card ${styles.section}`}>
      <h3>{t('1. Prepare your file', '1. 准备文件')}</h3><p>{t('Fill only the input columns. Result columns are completed automatically. Save Excel before upload; Excel may remain open.', '只需填写输入列，结果列自动回写。上传前请保存 Excel；运行时 Excel 可以保持打开。')}</p>
      <div className={styles.actions}><TemplateDownloadButton busy={busy || running} onDownload={() => void download()} /><FileUploader busy={busy || running} onUpload={() => void upload()} /></div>
      {downloaded && <p className={styles.filename}>{t('Downloaded', '已下载')}: {downloaded.split(/[\\/]/).pop()}</p>}
      {file && <p className={styles.filename}>{t('Uploaded file', '已上传文件')}: {file.split(/[\\/]/).pop()}</p>}
      {module === 'info-record' && <><h3>{t('2. What should be updated?', '2. 本次更新内容')}</h3><div className={styles.fields}>
        {[['plant', t('Plant', '工厂')], ['org', t('Purchasing Organization', '采购组织')], ['leadTime', t('Supplier Lead Time (days)', '供应商交货时间（天）')]].map(([key, label]) => <label className="field" key={key}><span>{label} *</span><input className="input" disabled={running} value={business[key as 'plant' | 'org' | 'leadTime']} onChange={event => update(key as 'plant' | 'org' | 'leadTime', event.target.value.toUpperCase())} /></label>)}
        <label className="field"><span>{t('Purchasing Type', '采购类型')}</span><select className="select" disabled={running} value={business.category} onChange={event => update('category', event.target.value)}><option value="standard">{t('Standard', '标准采购')}</option><option value="consignment">{t('Consignment', '寄售采购')}</option></select></label>
      </div></>}
      {module === 'apqp' && <div className={styles.fields}><label className="field"><span>{t('Plant', '工厂')}</span><input className="input" disabled={running} value={business.plant} onChange={event => update('plant', event.target.value.toUpperCase())} /></label>
        <label className="field"><span>{t('Refresh dates already in Excel', '刷新 Excel 中已有日期')}</span><select className="select" value={business.overwrite ? 'yes' : 'no'} disabled={running} onChange={event => update('overwrite', event.target.value === 'yes')}><option value="no">{t('No — keep existing dates', '否，保留已有日期')}</option><option value="yes">{t('Yes — query again', '是，重新查询')}</option></select></label></div>}
      {module === 'source-list' && <p className={styles.notice}>{t('Plant C100. Other suppliers and existing fixed-source selections are preserved.', '工厂固定 C100。保留其他供应商及已有的固定货源勾选。')}</p>}
      <ViewDetailsPanel><pre>{technicalError || t('Template columns and execution settings are detected automatically.', '系统自动识别模板列和执行参数。')}{'\n'}{file}{'\n'}{downloaded}</pre></ViewDetailsPanel>
    </section><section className={`card ${styles.section}`}><h3>{t('Review & start', '核对并开始')}</h3><ValidationSummary state={state} error={error} />
      {preview && <><PreviewSummary metrics={metrics} />
        {invalid > 0 && <p className={styles.warning}>{t('Some rows are incomplete. Fill both material and supplier, then upload again.', '有不完整行，请补全物料和供应商后重新上传。')}</p>}
        <p>{t('Sample of your business data', '业务数据抽样')}</p><table className={styles.table}><thead><tr><th>{t('Record / Material', '记录 / 物料')}</th><th>{t('Supplier', '供应商')}</th></tr></thead><tbody>{preview.sample.map((row, i) => <tr key={i}><td>{'infoRecord' in row ? row.infoRecord : row.material}</td><td>{'parma' in row ? row.parma : 'vendor' in row ? row.vendor : '—'}</td></tr>)}</tbody></table><ViewDetailsPanel><pre>{JSON.stringify(preview, null, 2)}</pre></ViewDetailsPanel>
      </>}
      {running && <AutomationProgress state={state} current={[...events].reverse().find(event => event.current !== undefined)?.current ?? 0} total={records} />}
      <div className={styles.actions}>{running ? <button className="button" onClick={() => void cancel()}><Square size={14} />{t('Stop safely', '安全停止')}</button>
        : <button className="button primary" disabled={!canRun} onClick={() => { if (module === 'apqp') void start(); else { setConfirming(true); notify({ kind: 'warning', title: t('Ready to update', '准备更新'), message: t('Review the batch confirmation.', '请核对本次批量修改。') }) } }}><Play size={14} />{module === 'apqp' ? t('Start query', '开始查询') : t('Start Automation', '开始自动化')}</button>}</div>
      {running && <ViewDetailsPanel><pre>{events.map(event => event.message).join('\n')}</pre></ViewDetailsPanel>}
    </section></div>
    {outcome && <AutomationResult outcome={outcome} onOpen={() => void openResult(outcome.resultPath || '')} onAnother={() => { setFile(''); setPreview(null); setOutcome(null); setEvents([]); setError(''); setState('READY') }} />}
    <RunConfirmationModal open={confirming} title={t('Ready to update', '准备更新')} description={t('This batch will update purchasing data in SAP. Completed changes will not be rolled back when stopped.', '本次将批量修改 SAP 采购数据。停止任务不会撤销已保存的修改。')} metrics={metrics} onCancel={() => setConfirming(false)} onStart={() => void start()} />
  </AutomationPageLayout>
}
