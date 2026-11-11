import { Play, RotateCcw, Square } from 'lucide-react'
import { useId, useState } from 'react'
import { useLocalization } from '../../i18n/use-localization'
import styles from './AutomationTaskToolbar.module.css'
import dialogStyles from './GuidedAutomation.module.css'
import { useTaskRun, useWorkflowDialog } from './task-run-context'

/** Presentation-only task controls. Reset never calls SAP or deletes a file. */
export function AutomationTaskToolbar({ status, hint, startLabel, canRun, running, stopping = false, locked,
  canClear, clearWarning, onStart, onStop, onClear }: {
  status: string; hint: string; startLabel: string; canRun: boolean; running: boolean; stopping?: boolean;
  locked: boolean; canClear: boolean; clearWarning?: string; onStart: () => void; onStop: () => void; onClear: () => void
}): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const { activeTask, openRunningTask } = useTaskRun()
  const blocked = activeTask !== null && !running
  const [confirming, setConfirming] = useState(false)
  const dialog = useWorkflowDialog(confirming)
  const titleId = useId()
  return <>
    <section className={`card ${styles.toolbar}`} aria-label={zh ? '任务操作' : 'Task controls'}>
      <div className={styles.copy}>
        <span className={`${styles.indicator} ${running ? styles.active : canRun ? styles.ready : ''}`} />
        <div><strong>{status}</strong><p>{hint}</p></div>
      </div>
      <div className={styles.actions}>
        <button className="button" disabled={locked || running || !canClear} onClick={() => setConfirming(true)}><RotateCcw size={15} />{zh ? '清空本页' : 'Clear this page'}</button>
        {running
          ? <button className="button" disabled={stopping} onClick={onStop}><Square size={15} />{stopping ? zh ? '正在安全停止…' : 'Stopping safely…' : zh ? '安全停止' : 'Stop safely'}</button>
          : <button className="button primary" disabled={blocked || !canRun || locked || confirming} onClick={onStart}><Play size={15} />{startLabel}</button>}
      </div>
      {blocked && <div className={styles.runLock}>
        <p role="status">{zh ? '另一个任务正在运行。你可以准备本页，等当前任务完成或安全停止后再开始。' : 'Another task is running. You can prepare this page, then start after the current task finishes or stops safely.'}</p>
        <button type="button" className="button" onClick={openRunningTask}>{zh ? '查看正在运行的任务' : 'Go to running task'}</button>
      </div>}
    </section>
    <dialog ref={dialog} className={dialogStyles.dialog} aria-labelledby={titleId} onCancel={() => setConfirming(false)}>
      <h2 id={titleId}>{zh ? '清空当前页面？' : 'Clear this task page?'}</h2>
      <p>{zh ? '重置本页文件选择、业务参数、预览、执行提示和结果展示，回到默认状态。其他任务页面不受影响。' : 'Reset this page’s file selection, business options, preview, messages and displayed results to their defaults. Other task pages are unchanged.'}</p>
      <p>{zh ? '不会删除 Excel、下载模板、执行历史或日志，也不会撤销 SAP 中已保存的修改。结果仍可从执行历史查找。' : 'Excel files, downloaded templates, execution history and logs are kept. Saved SAP changes are not undone. Result locations remain in Execution History.'}</p>
      {clearWarning && <p role="alert">{clearWarning}</p>}
      <div className={dialogStyles.actions}>
        <button className="button" onClick={() => setConfirming(false)}>{zh ? '取消' : 'Cancel'}</button>
        <button className="button primary" disabled={locked || running} onClick={() => { if (!locked && !running) { onClear(); setConfirming(false) } }}>{zh ? '确认清空' : 'Confirm Clear'}</button>
      </div>
    </dialog>
  </>
}
