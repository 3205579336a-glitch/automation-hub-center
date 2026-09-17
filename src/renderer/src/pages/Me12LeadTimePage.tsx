import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FileSearch,
  Play,
  Save,
  Square,
  Upload
} from 'lucide-react'
import type {
  Me12BatchConfig,
  Me12BatchProgress,
  Me12BatchResult,
  Me12ExcelPreview
} from '../../../shared/me12-types'
import type { SupportedBrowser } from '../../../shared/settings-types'
import { useLocalization } from '../i18n/use-localization'
import type { Notify } from '../types/notifications'
import styles from './Me12LeadTimePage.module.css'

const DEFAULT_CONFIG: Me12BatchConfig = {
  excelPath: '',
  sheetName: '',
  infoRecordColumn: 1,
  plantColumn: 2,
  dataStartRow: 2,
  targetPlant: 'C100',
  purchasingOrganization: 'C100',
  targetLeadTime: '1',
  infoCategory: 'standard',
  infoRecordWidth: 10,
  dryRun: false,
  maxItems: 0,
  maxRetries: 2,
  saveEvery: 5
}

interface Me12LeadTimePageProps {
  notify: Notify
  onBack: () => void
}

const text = {
  en: {
    title: 'Batch maintain Supplier Lead Time',
    copy: 'Download the template, fill it in, upload it, and run SAP ME12.',
    source: '1. Prepare and upload the template',
    sourceCopy: 'Keep the template headers unchanged. The workbook is previewed automatically after upload.',
    downloadTemplate: 'Download template',
    downloadingTemplate: 'Downloading…',
    uploadWorkbook: 'Upload completed template',
    templateSaved: 'Template downloaded',
    templateSavedCopy: 'Fill in the ME12 Upload sheet, save it, then upload it here.',
    savedTo: 'Saved to',
    preview: 'Preview again',
    selectedFile: 'Selected file',
    detected: 'Detected automatically',
    sapValues: '2. Confirm SAP target values',
    plant: 'Target Plant',
    org: 'Purchasing Organization',
    leadTime: 'Target Supplier Lead Time',
    infoCategory: 'Info Category',
    standard: 'Standard',
    consignment: 'Consignment',
    safety: 'Live SAP update enabled',
    safetyCopy: 'This run can save changes in ME12 for the selected Info Category. A timestamped Excel backup is created first.',
    confirm: 'I reviewed the preview and authorize live SAP updates for the selected records.',
    run: 'Run ME12 batch',
    cancel: 'Cancel safely',
    summary: 'Workbook preview',
    matched: 'Matching rows',
    unique: 'Unique Info Records',
    selected: 'Selected to run',
    duplicates: 'Duplicate rows',
    ignored: 'Other Plant rows',
    empty: 'Empty Info Records',
    sample: 'Sample selection',
    rows: 'Excel row(s)',
    status: 'Run status',
    idle: 'Upload the completed template to preview it.',
    browser: 'Automation browser',
    workers: 'maximum worker windows',
    login: 'ACTION REQUIRED: Confirm the Windows certificate in every browser window before ME12 processing begins.',
    result: 'Result workbook',
    backup: 'Backup workbook',
    previewFailed: 'Workbook preview failed',
    previewReady: 'Workbook preview ready',
    completed: 'ME12 batch finished',
    failed: 'ME12 batch stopped',
    back: 'Back to Operations'
  },
  'zh-CN': {
    title: '批量维护 Supplier Lead Time',
    copy: '下载模板、填写、上传，然后运行 SAP ME12。',
    source: '1. 下载并上传模板',
    sourceCopy: '请不要修改模板表头；上传后会自动预览并识别列。',
    downloadTemplate: '下载模板',
    downloadingTemplate: '正在下载…',
    uploadWorkbook: '上传已填写模板',
    templateSaved: '模板已下载',
    templateSavedCopy: '填写“ME12 Upload”工作表并保存，然后在这里上传。',
    savedTo: '保存位置',
    preview: '重新预览',
    selectedFile: '已选择文件',
    detected: '已自动识别',
    sapValues: '2. 确认 SAP 目标值',
    plant: '目标 Plant',
    org: '采购组织',
    leadTime: '目标 Supplier Lead Time',
    infoCategory: '信息类别 Info Category',
    standard: 'Standard（标准）',
    consignment: 'Consignment（寄售）',
    safety: '已启用 SAP 正式修改',
    safetyCopy: '本次执行会按所选 Info Category 在 ME12 中保存修改；开始前会先创建带时间戳的 Excel 备份。',
    confirm: '我已检查预览，并授权对所选记录执行 SAP 正式修改。',
    run: '运行 ME12 批处理',
    cancel: '安全取消',
    summary: '工作簿预览',
    matched: '匹配行数',
    unique: '唯一 Info Record',
    selected: '本次执行数',
    duplicates: '重复行数',
    ignored: '其他 Plant 行',
    empty: '空 Info Record',
    sample: '抽样明细',
    rows: 'Excel 行',
    status: '运行状态',
    idle: '请上传已填写的模板以生成预览。',
    browser: '自动化浏览器',
    workers: '最大并发窗口',
    login: '需要操作：请在每个浏览器窗口中确认 Windows 证书，完成后才会开始处理 ME12。',
    result: '结果工作簿',
    backup: '备份工作簿',
    previewFailed: '工作簿预览失败',
    previewReady: '工作簿预览完成',
    completed: 'ME12 批处理完成',
    failed: 'ME12 批处理已停止',
    back: '返回 Operations'
  }
} as const

export function Me12LeadTimePage({
  notify,
  onBack
}: Me12LeadTimePageProps): React.JSX.Element {
  const { language } = useLocalization()
  const copy = text[language]
  const [config, setConfig] = useState<Me12BatchConfig>(DEFAULT_CONFIG)
  const [preview, setPreview] = useState<Me12ExcelPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadedTemplatePath, setDownloadedTemplatePath] = useState('')
  const [running, setRunning] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [progress, setProgress] = useState<Me12BatchProgress[]>([])
  const [result, setResult] = useState<Me12BatchResult | null>(null)
  const [browser, setBrowser] = useState<SupportedBrowser>('chrome')
  const [maxConcurrentBrowsers, setMaxConcurrentBrowsers] = useState(1)

  useEffect(() => {
    void window.sapAutomation.getSettings().then((settings) => {
      setBrowser(settings.browser)
      setMaxConcurrentBrowsers(settings.maxConcurrentBrowsers)
    })
    return window.sapAutomation.onMe12Progress((event) => {
      setProgress((current) => [...current.slice(-99), event])
    })
  }, [])

  const latestProgress = progress[progress.length - 1]
  const canRun = Boolean(
    preview &&
      preview.selectedInfoRecords > 0 &&
      !running &&
      confirmed
  )
  const browserName = browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'
  const progressPercent = useMemo(() => {
    if (!latestProgress?.total || !latestProgress.current) {
      return 0
    }
    return Math.min(100, Math.round((latestProgress.current / latestProgress.total) * 100))
  }, [latestProgress])

  const updateConfig = <Key extends keyof Me12BatchConfig>(
    key: Key,
    value: Me12BatchConfig[Key]
  ): void => {
    setConfig((current) => ({ ...current, [key]: value }))
    setPreview(null)
    setConfirmed(false)
    setResult(null)
  }

  const downloadTemplate = async (): Promise<void> => {
    setDownloading(true)
    try {
      const response = await window.sapAutomation.downloadMe12Template()
      if (response.success) {
        setDownloadedTemplatePath(response.path)
        notify({
          kind: 'success',
          title: copy.templateSaved,
          message: `${copy.templateSavedCopy} ${response.path}`
        })
      } else if (!response.cancelled) {
        notify({
          kind: 'error',
          title: copy.previewFailed,
          message: response.message ?? 'The ME12 template could not be downloaded.'
        })
      }
    } catch (error) {
      notify({
        kind: 'error',
        title: copy.previewFailed,
        message:
          error instanceof Error
            ? error.message
            : 'The ME12 template could not be downloaded.'
      })
    } finally {
      setDownloading(false)
    }
  }

  const previewWorkbook = async (nextConfig: Me12BatchConfig = config): Promise<void> => {
    if (!nextConfig.excelPath) {
      return
    }
    setPreviewing(true)
    setPreview(null)
    setConfirmed(false)
    const response = await window.sapAutomation.previewMe12Batch(nextConfig)
    setPreviewing(false)
    if (response.success) {
      setPreview(response.preview)
      setConfig((current) => ({
        ...current,
        excelPath: nextConfig.excelPath,
        sheetName: response.preview.sheetName,
        infoRecordColumn: response.preview.infoRecordColumn,
        plantColumn: response.preview.plantColumn,
        dataStartRow: response.preview.dataStartRow
      }))
      notify({
        kind: 'success',
        title: copy.previewReady,
        message: `${response.preview.selectedInfoRecords} Info Record(s) selected.`
      })
    } else {
      notify({ kind: 'error', title: copy.previewFailed, message: response.message })
    }
  }

  const selectWorkbook = async (): Promise<void> => {
    const selection = await window.sapAutomation.selectMe12ExcelFile()
    if (selection.success) {
      const nextConfig = {
        ...config,
        excelPath: selection.path,
        sheetName: ''
      }
      setConfig(nextConfig)
      setResult(null)
      await previewWorkbook(nextConfig)
    } else if (!selection.cancelled && selection.message) {
      notify({ kind: 'error', title: copy.previewFailed, message: selection.message })
    }
  }

  const startBatch = async (): Promise<void> => {
    if (!canRun) {
      return
    }
    setRunning(true)
    setProgress([])
    setResult(null)
    const response = await window.sapAutomation.startMe12Batch(config)
    setResult(response)
    setRunning(false)
    notify({
      kind: response.success
        ? response.failed > 0 ? 'warning' : 'success'
        : response.errorCode === 'CANCELLED' ? 'warning' : 'error',
      title: response.success ? copy.completed : copy.failed,
      message: response.message
    })
  }

  const cancelBatch = async (): Promise<void> => {
    const response = await window.sapAutomation.cancelMe12Batch()
    notify({
      kind: response.success ? 'warning' : 'info',
      title: copy.cancel,
      message: response.message
    })
  }

  return (
    <div className="page">
      <button className={styles.backButton} onClick={onBack}>
        <ArrowLeft size={13} /> {copy.back}
      </button>
      <div className="page-heading">
        <div><h2>{copy.title}</h2><p>{copy.copy}</p></div>
        <div className={styles.headingActions}>
          <button
            className="button"
            onClick={() => void previewWorkbook()}
            disabled={previewing || running || !config.excelPath}
          >
            <FileSearch size={14} /> {previewing ? `${copy.preview}…` : copy.preview}
          </button>
          {running ? (
            <button className={`button ${styles.cancelButton}`} onClick={() => void cancelBatch()}>
              <Square size={12} /> {copy.cancel}
            </button>
          ) : (
            <button className="button primary" onClick={() => void startBatch()} disabled={!canRun}>
              <Play size={13} /> {copy.run}
            </button>
          )}
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.formColumn}>
          <section className={`card ${styles.section}`}>
            <div className={styles.sectionHeading}>
              <div><h3>{copy.source}</h3><p>{copy.sourceCopy}</p></div>
              <span className={styles.browserBadge}>
                {copy.browser}: {browserName} · {maxConcurrentBrowsers} {copy.workers}
              </span>
            </div>
            <div className={styles.templateActions}>
              <button
                className="button"
                onClick={() => void downloadTemplate()}
                disabled={running || downloading}
              >
                <Download size={14} /> {downloading ? copy.downloadingTemplate : copy.downloadTemplate}
              </button>
              <button className="button primary" onClick={() => void selectWorkbook()} disabled={running}>
                <Upload size={14} /> {copy.uploadWorkbook}
              </button>
            </div>
            {downloadedTemplatePath && (
              <p className={styles.downloadedPath}>
                <strong>{copy.savedTo}:</strong> {downloadedTemplatePath}
              </p>
            )}
            {config.excelPath && (
              <p className={styles.selectedPath}>
                <strong>{copy.selectedFile}:</strong> {config.excelPath}
              </p>
            )}
          </section>

          <section className={`card ${styles.section}`}>
            <h3>{copy.sapValues}</h3>
            <div className={styles.threeColumns}>
              <TextField label={copy.plant} value={config.targetPlant} onChange={(value) => updateConfig('targetPlant', value.toUpperCase())} disabled={running} />
              <TextField label={copy.org} value={config.purchasingOrganization} onChange={(value) => updateConfig('purchasingOrganization', value.toUpperCase())} disabled={running} />
              <TextField label={copy.leadTime} value={config.targetLeadTime} onChange={(value) => updateConfig('targetLeadTime', value)} disabled={running} />
              <label className={styles.field}>
                <span>{copy.infoCategory}</span>
                <select
                  className="input"
                  value={config.infoCategory}
                  onChange={(event) => {
                    setConfig((current) => ({ ...current, infoCategory: event.target.value as Me12BatchConfig['infoCategory'] }))
                    setConfirmed(false)
                    setResult(null)
                  }}
                  disabled={running}
                >
                  <option value="standard">{copy.standard}</option>
                  <option value="consignment">{copy.consignment}</option>
                </select>
              </label>
            </div>
          </section>

          <section className={styles.liveWarning}>
            <AlertTriangle size={19} />
            <div><strong>{copy.safety}</strong><p>{copy.safetyCopy}</p>
              <label>
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={running || !preview} />
                <span>{copy.confirm}</span>
              </label>
            </div>
          </section>
        </div>

        <aside className={styles.sideColumn}>
          <section className={`card ${styles.section}`}>
            <h3>{copy.summary}</h3>
            {preview ? (
              <>
                <span className={styles.detectedBadge}>
                  {copy.detected}: A={preview.infoRecordColumn}, Plant={preview.plantColumn}, Row={preview.dataStartRow}
                </span>
                <div className={styles.metrics}>
                  <Metric label={copy.matched} value={preview.matchedRows} />
                  <Metric label={copy.unique} value={preview.uniqueInfoRecords} />
                  <Metric label={copy.selected} value={preview.selectedInfoRecords} accent />
                  <Metric label={copy.duplicates} value={preview.duplicateRows} />
                  <Metric label={copy.ignored} value={preview.skippedOtherPlant} />
                  <Metric label={copy.empty} value={preview.skippedEmptyInfoRecord} />
                </div>
                <div className={styles.sample}>
                  <strong>{copy.sample} · {preview.sheetName}</strong>
                  {preview.sample.map((row) => (
                    <div key={row.infoRecord}>
                      <code>{row.infoRecord}</code>
                      <span>{copy.rows}: {row.excelRows.join(', ')}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className={styles.empty}>{copy.idle}</p>}
          </section>

          <section className={`card ${styles.section}`}>
            <h3>{copy.status}</h3>
            <p className={styles.loginNote}>{copy.login}</p>
            {latestProgress && (
              <>
                <div className={styles.progressTrack}><i style={{ width: `${progressPercent}%` }} /></div>
                <p className={styles.latest}>{latestProgress.message}</p>
              </>
            )}
            <div className={styles.progressLog}>
              {progress.slice(-8).map((event, index) => (
                <div key={`${event.stage}-${event.current ?? 0}-${index}`}>
                  <span className={styles[event.status ?? 'running']} />
                  <p>{event.message}</p>
                </div>
              ))}
            </div>
            {result?.success && (
              <div className={styles.resultPaths}>
                <div><Save size={13} /><span><strong>{copy.browser}</strong>{result.browserCount} worker window(s)</span></div>
                <div><Save size={13} /><span><strong>{copy.result}</strong>{result.resultPath}</span></div>
                <div><Save size={13} /><span><strong>{copy.backup}</strong>{result.backupPath}</span></div>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

interface TextFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  disabled: boolean
}

function TextField({ label, value, onChange, disabled }: TextFieldProps): React.JSX.Element {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input className="input" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} />
    </label>
  )
}

function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }): React.JSX.Element {
  return <div className={accent ? styles.metricAccent : ''}><span>{label}</span><strong>{value}</strong></div>
}
