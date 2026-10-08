import { ArrowLeft, Download, Upload } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import type { AutomationOutcome, AutomationState } from '../../../../shared/guided-automation'
import { useLocalization } from '../../i18n/use-localization'
import { stateLabel } from './state-label'
import styles from './GuidedAutomation.module.css'

export function AutomationPageLayout({ title, description, onBack, children }: {
  title: string; description: string; onBack: () => void; children: React.ReactNode
}): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  return <div className="page"><button className={styles.back} onClick={onBack}><ArrowLeft size={15} />{zh ? '返回操作中心' : 'Back to Operations'}</button>
    <div className="page-heading"><div><h2>{title}</h2><p>{description}</p></div></div>
    <div className={styles.workflow}><div className={styles.steps} aria-label={zh ? '操作步骤' : 'Workflow steps'}>
      {(zh ? ['下载并填写模板', '上传并核对', '运行并查看结果'] : ['Download & fill', 'Upload & review', 'Run & view result']).map((label, i) => <span key={label}><b>{i + 1}</b>{label}</span>)}
    </div>{children}</div>
  </div>
}

export function TemplateDownloadButton({ busy, onDownload }: { busy: boolean; onDownload: () => void }): React.JSX.Element {
  const { language } = useLocalization()
  return <button className="button" disabled={busy} onClick={onDownload}><Download size={15} />{language === 'zh-CN' ? '下载模板' : 'Download template'}</button>
}
export function FileUploader({ busy, onUpload }: { busy: boolean; onUpload: () => void }): React.JSX.Element {
  const { language } = useLocalization()
  return <button className="button primary" disabled={busy} onClick={onUpload}><Upload size={15} />{language === 'zh-CN' ? '上传已填写模板' : 'Upload completed template'}</button>
}
export function PreviewSummary({ metrics }: { metrics: { label: string; value: string | number }[] }): React.JSX.Element {
  return <div className={styles.metrics}>{metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}</div>
}
export function ViewDetailsPanel({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { language } = useLocalization()
  return <details className={styles.details}><summary>{language === 'zh-CN' ? '查看详情' : 'View Details'}</summary>{children}</details>
}
export function ValidationSummary({ state, error }: { state: AutomationState; error: string }): React.JSX.Element {
  const { language } = useLocalization()
  return <p className={error ? styles.warning : styles.notice} role={error ? 'alert' : 'status'}>{error || stateLabel(state, language === 'zh-CN')}</p>
}
export function AutomationProgress({ state, current, total }: { state: AutomationState; current: number; total: number }): React.JSX.Element {
  const { language } = useLocalization()
  return <><span className={styles.badge}>{stateLabel(state, language === 'zh-CN')}</span>
    <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={current}><i style={{ width: `${Math.min(100, total ? current / total * 100 : 0)}%` }} /></div>
    <p>{current} / {total}</p></>
}
export function RunConfirmationModal({ open, title, description, metrics, onStart, onCancel }: {
  open: boolean; title: string; description: string; metrics: { label: string; value: string | number }[]; onStart: () => void; onCancel: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); else if (!open) dialog.current?.close() }, [open])
  return <dialog className={styles.dialog} ref={dialog} aria-labelledby={titleId} onCancel={onCancel}>
    <h2 id={titleId}>{title}</h2><p>{description}</p><PreviewSummary metrics={metrics} />
    <div className={styles.actions}><button className="button" onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button><button className="button primary" onClick={onStart}>{zh ? '开始自动化' : 'Start Automation'}</button></div>
  </dialog>
}
export function AutomationResult({ outcome, onOpen, onAnother }: {
  outcome: AutomationOutcome; onOpen: () => void; onAnother: () => void
}): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  return <section className={`card ${styles.section}`} aria-label={zh ? '自动化结果' : 'Automation result'}>
    <h3>{stateLabel(outcome.state, zh)}</h3><PreviewSummary metrics={[
      { label: zh ? '总数' : 'Total', value: outcome.total }, { label: zh ? '成功' : 'Successful', value: outcome.succeeded },
      { label: zh ? '跳过' : 'Skipped', value: outcome.skipped }, { label: zh ? '失败' : 'Failed', value: outcome.failed }
    ]} />
    {outcome.state === 'FAILED' && <p>{zh ? '本次任务未能安全完成。请查看详情，保留已有结果，不要直接重复运行。' : 'This task could not safely finish. Review details and existing results before retrying.'}</p>}
    <div className={styles.actions}>{outcome.resultPath && <button className="button primary" onClick={onOpen}>{zh ? '打开结果' : 'Open Result'}</button>}
      <button className="button" onClick={onAnother}>{zh ? '运行另一任务' : 'Run Another Task'}</button></div>
    <ViewDetailsPanel><pre>{outcome.details}{'\n'}{[outcome.resultPath, outcome.backupPath, outcome.logPath].filter(Boolean).join('\n')}</pre></ViewDetailsPanel>
  </section>
}
