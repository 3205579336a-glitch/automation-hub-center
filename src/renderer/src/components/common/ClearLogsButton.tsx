import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocalization } from '../../i18n/use-localization'
import styles from '../automation/GuidedAutomation.module.css'

/** One bulk action shared by history and diagnostics. No per-record deletion UI. */
export function ClearLogsButton({ onCleared }: { onCleared: () => Promise<void> }): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (confirming) dialog.current?.showModal(); else dialog.current?.close() }, [confirming])
  const clear = async (): Promise<void> => {
    if (busy) return
    setBusy(true); setMessage('')
    try {
      const result = await window.sapAutomation.deleteExecutionHistory()
      if (!result.success) {
        setMessage(zh ? `无法清理：请先结束自动化，并检查文件权限。${result.message || ''}` : result.message || 'Could not clear logs; finish active automation and check file permissions.')
        return
      }
      setConfirming(false)
      setMessage(result.warnings?.length
        ? zh ? '清理完成，部分运行中或无法安全删除的日志已保留。Excel 和备份未删除。' : 'Cleanup complete. Unfinished or unsafe diagnostics were kept. Excel files and backups were preserved.'
        : zh ? '全部日志和执行历史已清理；Excel、备份和 SAP 数据未修改。' : 'All logs and execution history cleared; Excel files, backups and SAP data were preserved.')
      await onCleared()
    } catch { setMessage(zh ? '未能清理，请检查文件权限后重试。' : 'Could not clear logs. Check file permissions and retry.') }
    finally { setBusy(false) }
  }
  return <>
    <button className="button" disabled={busy} onClick={() => { setMessage(''); setConfirming(true) }}><Trash2 size={14} />{zh ? '一键清空日志' : 'Clear All Logs'}</button>
    {!confirming && message && <p role="status">{message}</p>}
    <dialog ref={dialog} className={styles.dialog} aria-label={zh ? '清空全部日志和执行历史？' : 'Clear all logs and execution history?'} onCancel={event => { if (busy) event.preventDefault(); else setConfirming(false) }}>
      <h2>{zh ? '清空全部日志和执行历史？' : 'Clear all logs and execution history?'}</h2>
      <p>{zh ? '将永久删除本机全部已结束的执行历史及可识别的诊断日志、临时数据，不仅是当前页或筛选结果。保留原始上传文件、结果 Excel 和备份，不修改 SAP 数据。' : 'Permanently deletes all completed local execution history and identified diagnostic logs/temporary data, not just this page or filter. Original uploads, result workbooks and backups are kept. SAP data is unaffected.'}</p>
      <p>{zh ? '清理不可恢复，这些记录也将不再用于任务排序和预计耗时学习。运行中无法清理。' : 'This cannot be undone. These records will no longer contribute to ranking or ETA learning. Cleanup is blocked during automation.'}</p>
      {message && <p role="alert">{message}</p>}
      <div className={styles.actions}>
        <button className="button" disabled={busy} onClick={() => setConfirming(false)}>{zh ? '取消' : 'Cancel'}</button>
        <button className="button" disabled={busy} onClick={() => void clear()}>{busy ? zh ? '正在清理…' : 'Clearing…' : zh ? '确认清空全部' : 'Confirm Clear All'}</button>
      </div>
    </dialog>
  </>
}
