import { Play, RotateCcw, Square } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useLocalization } from '../../i18n/use-localization'
import styles from './AutomationTaskToolbar.module.css'
import dialogStyles from './GuidedAutomation.module.css'

/** Presentation-only task controls. Reset never calls SAP or deletes a file. */
export function AutomationTaskToolbar({ status, hint, startLabel, canRun, running, stopping = false, locked,
  canClear, onStart, onStop, onClear }: {
  status: string; hint: string; startLabel: string; canRun: boolean; running: boolean; stopping?: boolean;
  locked: boolean; canClear: boolean; onStart: () => void; onStop: () => void; onClear: () => void
}): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const [confirming, setConfirming] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (confirming && !dialog.current?.open) dialog.current?.showModal()
    else if (!confirming) dialog.current?.close()
  }, [confirming])
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
          : <button className="button primary" disabled={!canRun || locked || confirming} onClick={onStart}><Play size={15} />{startLabel}</button>}
      </div>
    </section>
    <dialog ref={dialog} className={dialogStyles.dialog} aria-labelledby={titleId} onCancel={() => setConfirming(false)}>
      <h2 id={titleId}>{zh ? '清空当前页面？' : 'Clear this task page?'}</h2>
      <p>{zh ? '重置本页文件选择、业务参数、预览、执行提示和结果展示，回到默认状态。其他任务页面不受影响。' : 'Reset this page’s file selection, business options, preview, messages and displayed results to their defaults. Other task pages are unchanged.'}</p>
      <p>{zh ? '不会删除 Excel、下载模板、执行历史或日志，也不会撤销 SAP 中已保存的修改。结果仍可从执行历史查找。' : 'Excel files, downloaded templates, execution history and logs are kept. Saved SAP changes are not undone. Result locations remain in Execution History.'}</p>
      <div className={dialogStyles.actions}>
        <button className="button" onClick={() => setConfirming(false)}>{zh ? '取消' : 'Cancel'}</button>
        <button className="button primary" disabled={locked || running} onClick={() => { if (!locked && !running) { onClear(); setConfirming(false) } }}>{zh ? '确认清空' : 'Confirm Clear'}</button>
      </div>
    </dialog>
  </>
}
