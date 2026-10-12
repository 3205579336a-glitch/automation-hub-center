import { AlertTriangle, ClipboardCheck, FolderOpen, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RfqRecoveryView } from '../../../../shared/rfq-safe-recovery'
import { useLocalization } from '../../i18n/use-localization'
import type { Notify } from '../../types/notifications'
import styles from './SafeRecoveryPanel.module.css'

/** Manual forensic review only; no resume or SAP write API is used here. */
export function SafeRecoveryPanel({ notify, busy }: { notify: Notify; busy: boolean }): React.JSX.Element | null {
  const { language } = useLocalization(), zh = language === 'zh-CN'
  const [records, setRecords] = useState<RfqRecoveryView[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<{ record: RfqRecoveryView; mode: 'verify' | 'resolve' } | null>(null)
  const [saving, setSaving] = useState(false), [resolutionError, setResolutionError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId()
  const request = useRef(0)
  const invalidate = useCallback(() => { request.current++ }, [])
  const refresh = useCallback(async (): Promise<void> => {
    const current = ++request.current
    setLoading(true)
    try {
      const result = await window.sapAutomation.getRfqRecovery()
      if (current === request.current) { setRecords(result); setError(false) }
    }
    catch { if (current === request.current) setError(true) }
    finally { if (current === request.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 30000)
    const focus = (): void => { void refresh() }
    window.addEventListener('focus', focus)
    window.addEventListener('rfq-run-finished', focus)
    return () => { invalidate(); window.clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('rfq-run-finished', focus) }
  }, [refresh, invalidate])
  useEffect(() => {
    if (selection && !dialog.current?.open) dialog.current?.showModal()
    else if (!selection) dialog.current?.close()
  }, [selection])
  const choose = (record: RfqRecoveryView, mode: 'verify' | 'resolve'): void => {
    setResolutionError(''); setSelection({ record, mode })
  }
  const open = async (record: RfqRecoveryView): Promise<void> => {
    try {
      const response = await window.sapAutomation.openRecoveryResult(record.runId)
      if (!response.success) throw new Error(response.message)
    } catch (reason) { notify({ kind: 'error', title: zh ? '无法打开恢复结果' : 'Recovery result unavailable', message: String(reason instanceof Error ? reason.message : reason) }) }
  }
  const resolve = async (): Promise<void> => {
    if (!selection || busy || saving) return
    setSaving(true); setResolutionError('')
    try {
      const response = await window.sapAutomation.resolveRfqRecovery({ runId: selection.record.runId, verifiedInSap: true, engineStopped: true })
      if (!response.success) throw new Error(response.message)
      setSelection(null); await refresh()
      notify({ kind: 'success', title: zh ? '已标记人工核查完成' : 'Run marked resolved', message: zh ? '保留核查记录；没有恢复执行，也没有修改 SAP。' : 'Review evidence is kept. No execution was resumed and no SAP data was changed.' })
    } catch (reason) { setResolutionError(String(reason instanceof Error ? reason.message : reason)); await refresh() }
    finally { setSaving(false) }
  }
  if (!records.length && !error && !selection) return null
  const checkpoint = (record: RfqRecoveryView): string => ({ BUYER_RECEIPT_SAVED: zh ? 'Buyer Receipt 已保存' : 'Buyer Receipt saved',
    RFQ_CREATED: zh ? 'RFQ 已创建且结果已保存' : 'RFQ created; result saved', GROUP_COMPLETED: zh ? '分组已处理完成' : 'Group completed' }[record.lastConfirmedCheckpoint ?? ''] || (zh ? '未知／未记录' : 'Unknown / not recorded'))
  return <section className={`card ${styles.panel}`} aria-label="Safe Recovery">
    <div className={styles.header}><div><h3><AlertTriangle size={19} />Safe Recovery · {zh ? '安全核查' : 'Manual review'}</h3>
      <p>{zh ? '上次任务已中断：先核对 SAP，再点击“标记已处理”。不会自动重跑。' : 'A previous task stopped. Check SAP, then mark it resolved. Nothing reruns automatically.'}</p></div>
      <button className="button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} />{zh ? '刷新' : 'Refresh recovery'}</button></div>
    {error && <p role="alert">{zh ? '无法读取恢复记录，请联系 Key User 检查本地数据，不要直接重新执行 RFQ。' : 'Recovery records could not be read. Ask a key user to inspect local data before retrying RFQ.'}</p>}
    {records.map(record => <article className={styles.record} key={record.runId}>
      <strong>{zh ? '发现未完成或状态不确定的 RFQ 运行' : 'An unfinished RFQ run was found'}</strong>
      <dl><dt>Project</dt><dd>{record.projects.join(', ') || record.project || (zh ? '未知' : 'Unknown')}</dd>
        <dt>{zh ? '已确认处理分组' : 'Completed groups'}</dt><dd>{record.totalGroups === null ? zh ? '未知' : 'Unknown' : `${record.completedGroups} / ${record.totalGroups}`}</dd>
        <dt>{zh ? '最后确认检查点' : 'Last confirmed checkpoint'}</dt><dd>{checkpoint(record)}</dd></dl>
      <p className={styles.warning}>{zh ? '请确认已有 Buyer Receipt / RFQ，避免重复创建。' : 'Check existing Buyer Receipt / RFQ to avoid duplicate creation.'}</p>
      {record.processStatus !== 'dead' && <p role="note">{record.processStatus === 'alive' ? zh ? '旧 Hub 或 RFQ 引擎进程可能仍在运行。请先安全停止；暂不能标记已处理或打开工作文件。' : 'The old Hub or RFQ engine may still be running. Stop it safely first; resolution and opening its working file are blocked.'
        : zh ? '无法证明旧引擎已停止。请人工确认进程已结束，再核查 SAP。' : 'The old engine cannot be proven stopped. Manually confirm it has ended before reviewing SAP.'}</p>}
      {record.storageIssue && <p role="alert">{zh ? '恢复文件损坏或无法读取。原文件已保留，请联系 Key User；不能直接标记已处理。' : 'Recovery evidence is unreadable. It is preserved; ask a key user for help rather than dismissing it.'}</p>}
      <div className={styles.actions}><button className="button" disabled={busy} onClick={() => choose(record, 'verify')}><ClipboardCheck size={15} />{zh ? '在 SAP 核查' : 'Verify in SAP'}</button>
        <button className="button" disabled={!record.resultAvailable || record.processStatus !== 'dead' || busy} onClick={() => void open(record)}><FolderOpen size={15} />{zh ? '打开结果' : 'Open Result'}</button>
        <button className="button" disabled={busy || record.processStatus === 'alive' || record.storageIssue} onClick={() => choose(record, 'resolve')}>{zh ? '标记已处理' : 'Mark Resolved'}</button></div>
      <details><summary>{zh ? '运行详情' : 'Run details'}</summary><p>Run ID: {record.runId}<br />{record.environment} · {record.startedAt || '—'}<br />{record.groupKey}<br />Plant: {record.plant || '—'} · Parma: {record.supplier || '—'}<br />Material: {record.materials?.join(', ') || '—'}<br />RFQ: {record.rfqNumbers.join(', ') || '—'}<br />{zh ? '需核查分组' : 'Groups needing review'}: {record.uncertainGroupKeys?.join(', ') || '—'}</p></details>
    </article>)}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onCancel={event => { if (saving) event.preventDefault(); else setSelection(null) }}>
      <h2 id={titleId}>{selection?.mode === 'verify' ? zh ? '在 SAP 中人工核查' : 'Verify in SAP — manual checklist' : zh ? '确认标记已处理' : 'Mark Resolved — confirm review'}</h2>
      <div className={styles.context}>Project {selection?.record.projects.join(', ') || selection?.record.project || '—'} · {selection?.record.environment}<br />Plant {selection?.record.plant || '—'} · Parma {selection?.record.supplier || '—'}<br />{zh ? '物料' : 'Material'}: {selection?.record.materials?.join(', ') || '—'}</div>
      {selection?.mode === 'verify' ? <ol className={styles.steps}>
        <li>{zh ? '确认此任务已停止。' : 'Make sure this task has stopped.'}</li>
        <li>{zh ? '在 SAP 显示模式中检查已有 Buyer Receipt 和 RFQ；不要点击创建或保存。' : 'Check existing Buyer Receipt and RFQ in SAP display mode. Do not click Create or Save.'}</li>
        <li>{zh ? '核对结果编号；有疑问请找 Key User，确认后再标记已处理。' : 'Compare the result numbers. Ask a key user if unsure; mark resolved only after checking.'}</li>
      </ol> : <><p className={styles.warning}>{zh ? '点击确认表示：此任务已停止，且你已在 SAP 核查已有 Buyer Receipt / RFQ。' : 'Confirm only if this task has stopped and you checked existing Buyer Receipt / RFQ in SAP.'}</p>
        <p>{zh ? '无需填表。系统自动记录确认时间；不会重跑、撤销 SAP 修改或把任务改成成功。' : 'No form to fill. Confirmation time is recorded automatically; nothing reruns, rolls back, or becomes successful.'}</p></>}
      <details><summary>{zh ? '技术详情（Key User）' : 'Technical details (Key user)'}</summary><p>Run ID: {selection?.record.runId}<br />{zh ? '最后检查点' : 'Last checkpoint'}: {selection && checkpoint(selection.record)}<br />{selection?.record.checkpointGroup}</p></details>
      {resolutionError && <p role="alert">{resolutionError}</p>}
      <div className={styles.dialogActions}><button className="button" disabled={saving} onClick={() => setSelection(null)}>{zh ? '关闭' : 'Close'}</button>
        {selection?.mode === 'resolve' && <button className="button primary" disabled={saving || busy} onClick={() => void resolve()}>{saving ? zh ? '保存中…' : 'Saving…' : zh ? '已核查，完成处理' : 'Checked in SAP — Finish Review'}</button>}</div>
    </dialog>
  </section>
}
