import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FlaskConical,
  Play,
  Save,
  ShieldCheck,
  Square,
  Upload
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  RfqBatchConfig,
  RfqBatchProgress,
  RfqBatchResult,
  RfqEnvironment,
  RfqExcelPreview
} from '../../../shared/rfq-batch-types'
import { useLocalization } from '../i18n/use-localization'
import type { Notify } from '../types/notifications'
import styles from './CreateRfqPage.module.css'

interface CreateRfqPageProps {
  notify: Notify
  onBack: () => void
}

export function CreateRfqPage({ notify, onBack }: CreateRfqPageProps): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const copy = useMemo(() => createCopy(zh), [zh])
  const [environment, setEnvironment] = useState<RfqEnvironment>('QA')
  const [productionConfirmed, setProductionConfirmed] = useState(false)
  const [excelPath, setExcelPath] = useState('')
  const [downloadedPath, setDownloadedPath] = useState('')
  const [preview, setPreview] = useState<RfqExcelPreview | null>(null)
  const [progress, setProgress] = useState<RfqBatchProgress[]>([])
  const [result, setResult] = useState<RfqBatchResult | null>(null)
  const [running, setRunning] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => window.sapAutomation.onRfqProgress((event) => {
    setProgress((current) => [...current.slice(-39), event])
  }), [])

  const config: RfqBatchConfig = { excelPath, environment, productionConfirmed }
  const latest = progress[progress.length - 1]
  const progressPercent = latest?.total
    ? Math.min(100, Math.round(((latest.current ?? 0) / latest.total) * 100))
    : running ? 8 : result?.success ? 100 : 0
  const canRun = Boolean(
    preview && preview.validRows > 0 && !running &&
    (environment === 'QA' || productionConfirmed)
  )

  const downloadTemplate = async (): Promise<void> => {
    setDownloading(true)
    const response = await window.sapAutomation.downloadRfqTemplate()
    setDownloading(false)
    if (response.success) {
      setDownloadedPath(response.path)
      notify({ kind: 'success', title: copy.templateDownloaded, message: response.path })
    } else if (!response.cancelled) {
      notify({ kind: 'error', title: copy.downloadFailed, message: response.message })
    }
  }

  const previewWorkbook = async (nextConfig = config): Promise<void> => {
    if (!nextConfig.excelPath) return
    setPreviewing(true)
    const response = await window.sapAutomation.previewRfqBatch(nextConfig)
    setPreviewing(false)
    if (response.success) {
      setPreview(response.preview)
      setResult(null)
      notify({
        kind: response.preview.invalidRows > 0 ? 'warning' : 'success',
        title: copy.previewReady,
        message: `${response.preview.validRows} ${copy.validRows.toLowerCase()}`
      })
    } else {
      setPreview(null)
      notify({ kind: 'error', title: copy.previewFailed, message: response.message })
    }
  }

  const selectWorkbook = async (): Promise<void> => {
    const selection = await window.sapAutomation.selectRfqExcelFile()
    if (selection.success) {
      const nextConfig = { ...config, excelPath: selection.path }
      setExcelPath(selection.path)
      setProgress([])
      setResult(null)
      await previewWorkbook(nextConfig)
    } else if (!selection.cancelled && selection.message) {
      notify({ kind: 'error', title: copy.previewFailed, message: selection.message })
    }
  }

  const selectEnvironment = (value: RfqEnvironment): void => {
    setEnvironment(value)
    setProductionConfirmed(false)
    setProgress([])
    setResult(null)
  }

  const startRun = async (): Promise<void> => {
    if (!canRun) return
    setRunning(true)
    setProgress([])
    setResult(null)
    const response = await window.sapAutomation.startRfqBatch(config)
    setRunning(false)
    setResult(response)
    notify({
      kind: response.success ? response.failed > 0 ? 'warning' : 'success' : response.errorCode === 'CANCELLED' ? 'warning' : 'error',
      title: response.success ? copy.completed : copy.failed,
      message: response.message
    })
  }

  const cancelRun = async (): Promise<void> => {
    const response = await window.sapAutomation.cancelRfqBatch()
    notify({ kind: response.success ? 'warning' : 'info', title: copy.cancel, message: response.message })
  }

  return (
    <div className="page">
      <button className={styles.backButton} onClick={onBack}>
        <ArrowLeft size={15} /> {copy.back}
      </button>
      <div className="page-heading">
        <div><h2>{copy.title}</h2><p>{copy.subtitle}</p></div>
        <div className={styles.headingActions}>
          <button className="button" onClick={() => void previewWorkbook()} disabled={!excelPath || previewing || running}>
            <CheckCircle2 size={15} /> {previewing ? `${copy.validate}…` : copy.validate}
          </button>
          {running ? (
            <button className={`button ${styles.cancelButton}`} onClick={() => void cancelRun()}>
              <Square size={13} /> {copy.cancel}
            </button>
          ) : (
            <button className="button primary" onClick={() => void startRun()} disabled={!canRun}>
              <Play size={15} /> {copy.run}
            </button>
          )}
        </div>
      </div>

      <div className={styles.steps}>
        {[copy.step1, copy.step2, copy.step3].map((label, index) => (
          <div key={label}><span>{index + 1}</span><strong>{label}</strong></div>
        ))}
      </div>

      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <section className={`card ${styles.section}`}>
            <div className={styles.sectionHeading}>
              <div><h3>{copy.environment}</h3><p>{copy.environmentCopy}</p></div>
            </div>
            <div className={styles.environmentGrid}>
              <button
                className={`${styles.environmentCard} ${environment === 'QA' ? styles.qaSelected : ''}`}
                onClick={() => selectEnvironment('QA')}
                disabled={running}
              >
                <span className={styles.environmentIcon}><FlaskConical size={21} /></span>
                <span><strong>{copy.qa}</strong><small>CEQ · Client 100 · 321</small></span>
                <i>{copy.recommended}</i>
              </button>
              <button
                className={`${styles.environmentCard} ${styles.productionCard} ${environment === 'PROD' ? styles.prodSelected : ''}`}
                onClick={() => selectEnvironment('PROD')}
                disabled={running}
              >
                <span className={styles.environmentIcon}><ShieldCheck size={21} /></span>
                <span><strong>{copy.production}</strong><small>VCE · Client 100 · 949</small></span>
                <i>{copy.liveData}</i>
              </button>
            </div>
          </section>

          <section className={`card ${styles.section}`}>
            <div className={styles.sectionHeading}>
              <div><h3>{copy.workbook}</h3><p>{copy.workbookCopy}</p></div>
            </div>
            <div className={styles.fileActions}>
              <button className="button" onClick={() => void downloadTemplate()} disabled={downloading || running}>
                <Download size={15} /> {downloading ? `${copy.download}…` : copy.download}
              </button>
              <button className="button primary" onClick={() => void selectWorkbook()} disabled={running}>
                <Upload size={15} /> {copy.upload}
              </button>
            </div>
            {downloadedPath && <p className={styles.savedPath}><strong>{copy.savedTo}:</strong> {downloadedPath}</p>}
            {excelPath ? (
              <div className={styles.selectedFile}>
                <FileSpreadsheet size={23} />
                <div><strong>{copy.selectedFile}</strong><span>{excelPath}</span></div>
                {preview && <em>{preview.validRows} {copy.rowsReady}</em>}
              </div>
            ) : (
              <button className={styles.uploadZone} onClick={() => void selectWorkbook()}>
                <Upload size={25} /><strong>{copy.chooseWorkbook}</strong><span>{copy.chooseWorkbookCopy}</span>
              </button>
            )}
          </section>

          {environment === 'PROD' && (
            <section className={styles.productionWarning}>
              <AlertTriangle size={21} />
              <div>
                <strong>{copy.productionWarning}</strong>
                <p>{copy.productionWarningCopy}</p>
                <label>
                  <input type="checkbox" checked={productionConfirmed} onChange={(event) => setProductionConfirmed(event.target.checked)} disabled={running} />
                  <span>{copy.productionConfirm}</span>
                </label>
              </div>
            </section>
          )}
        </div>

        <aside className={styles.sideColumn}>
          <section className={`card ${styles.section}`}>
            <h3>{copy.preview}</h3>
            {preview ? (
              <>
                <div className={styles.metrics}>
                  <Metric label={copy.totalRows} value={preview.totalRows} />
                  <Metric label={copy.validRows} value={preview.validRows} accent="success" />
                  <Metric label={copy.invalidRows} value={preview.invalidRows} accent={preview.invalidRows > 0 ? 'danger' : undefined} />
                </div>
                <div className={styles.previewRows}>
                  <strong>{copy.sample} · {preview.sheetName}</strong>
                  {preview.sample.map((row) => (
                    <div key={row.excelRow} className={!row.valid ? styles.invalidRow : ''}>
                      <span>{row.excelRow}</span>
                      <p><strong>{row.material}</strong><small>{row.plant} · {row.project} · {row.supplier}</small>{!row.valid && <em>{row.message}</em>}</p>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className={styles.empty}>{copy.noPreview}</p>}
          </section>

          <section className={`card ${styles.section}`}>
            <h3>{copy.status}</h3>
            <p className={styles.loginNote}>{copy.loginNote}</p>
            {(running || latest || result) && (
              <>
                <div className={styles.progressTrack}><i style={{ width: `${progressPercent}%` }} /></div>
                {latest && <p className={styles.latest}>{latest.message}</p>}
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
                <div><Save size={14} /><span><strong>{copy.resultFile}</strong>{result.resultPath}</span></div>
                {result.logPath && <div><Save size={14} /><span><strong>{copy.runLog}</strong>{result.logPath}</span></div>}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: 'success' | 'danger' }): React.JSX.Element {
  return <div className={accent ? styles[accent] : ''}><span>{label}</span><strong>{value}</strong></div>
}

function createCopy(zh: boolean) {
  return zh ? {
    back: '返回操作中心', title: '创建 RFQ', subtitle: '下载模板、填写并上传，系统将通过 SAP GUI 自动完成 Buyer Receipt 和 RFQ。',
    validate: '校验数据', cancel: '取消运行', run: '开始创建 RFQ', step1: '选择系统', step2: '上传模板', step3: '确认并运行',
    environment: '选择 SAP 系统', environmentCopy: '建议先在测试系统验证；只有确认无误后再使用正式系统。', qa: '测试系统', production: '正式系统', recommended: '推荐先用', liveData: '真实业务数据',
    workbook: 'RFQ 模板', workbookCopy: '模板已经包含所需列。请不要修改表头，只需从第 2 行开始填写。', download: '下载模板', upload: '上传已填写模板', savedTo: '模板已保存', selectedFile: '已选择文件', rowsReady: '行可以执行', chooseWorkbook: '选择已填写的 Excel 模板', chooseWorkbookCopy: '支持 .xlsx / .xlsm，选择后会自动校验。',
    productionWarning: '你正在使用正式系统', productionWarningCopy: '程序会在 VCE 949 中创建真实 Buyer Receipt 和 RFQ，请确认模板、供应商和日期已经核对。', productionConfirm: '我已核对数据，并确认在正式系统执行。',
    preview: '数据预览', totalRows: '数据行', validRows: '有效行', invalidRows: '需修正', sample: '前几行', noPreview: '上传模板后，这里会显示可执行行和需要修正的内容。',
    status: '执行状态', loginNote: '运行后请完成 SAP Logon 登录；程序会自动识别所选测试或正式系统。', resultFile: 'Excel 结果文件', runLog: '运行日志',
    templateDownloaded: '模板下载完成', downloadFailed: '模板下载失败', previewReady: '数据校验完成', previewFailed: '无法读取模板', completed: 'RFQ 执行完成', failed: 'RFQ 执行失败'
  } : {
    back: 'Back to Operations', title: 'Create RFQ', subtitle: 'Download, complete, and upload one template. SAP GUI will create the Buyer Receipt and RFQ.',
    validate: 'Validate data', cancel: 'Cancel run', run: 'Start Create RFQ', step1: 'Choose system', step2: 'Upload template', step3: 'Confirm and run',
    environment: 'Choose SAP system', environmentCopy: 'Validate in the test system first, then use Production only after the result is confirmed.', qa: 'Test system', production: 'Production system', recommended: 'Recommended first', liveData: 'Live business data',
    workbook: 'RFQ template', workbookCopy: 'The template contains the required columns. Keep the headers and enter data from row 2.', download: 'Download template', upload: 'Upload completed template', savedTo: 'Template saved to', selectedFile: 'Selected workbook', rowsReady: 'row(s) ready', chooseWorkbook: 'Choose your completed Excel template', chooseWorkbookCopy: 'Supports .xlsx / .xlsm and validates automatically.',
    productionWarning: 'You selected Production', productionWarningCopy: 'The run will create real Buyer Receipts and RFQs in VCE 949. Check suppliers, dates, and workbook data first.', productionConfirm: 'I checked the data and confirm this Production run.',
    preview: 'Data preview', totalRows: 'Data rows', validRows: 'Valid rows', invalidRows: 'Needs fixing', sample: 'Sample', noPreview: 'Upload the template to see ready rows and anything that needs correction.',
    status: 'Run status', loginNote: 'After starting, complete SAP Logon sign-in. The app will verify the selected test or production system.', resultFile: 'Excel result file', runLog: 'Run log',
    templateDownloaded: 'Template downloaded', downloadFailed: 'Template download failed', previewReady: 'Validation complete', previewFailed: 'Could not read template', completed: 'RFQ run completed', failed: 'RFQ run failed'
  }
}
