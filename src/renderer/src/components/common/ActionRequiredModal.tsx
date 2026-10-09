import { useEffect, useRef, useState } from 'react'
import type { AutomationInteraction, InteractionAction } from '../../../../shared/automation-interaction'
import { useLocalization } from '../../i18n/use-localization'
import styles from './ActionRequiredModal.module.css'
import { UserInputModal } from './UserInputModal'

interface Props {
  request: AutomationInteraction | null
  onRespond: (action: InteractionAction, values?: Record<string, string | boolean>) => Promise<{ success: boolean; message?: string }>
}

export function ActionRequiredModal({ request, onRespond }: Props): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [sending, setSending] = useState<InteractionAction | null>(null)
  const [error, setError] = useState('')
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const { language } = useLocalization()
  const t = (cn: string, en: string): string => language === 'zh-CN' ? cn : en
  useEffect(() => {
    setSending(null)
    setError('')
    setValues({})
  }, [request?.requestId])
  useEffect(() => {
    if (request && !dialog.current?.open) dialog.current?.showModal()
    else if (!request) dialog.current?.close()
  }, [request])
  const respond = async (action: InteractionAction): Promise<void> => {
    if (action === 'continue' && request?.fields?.some(field => field.required &&
      (values[field.id] === undefined || values[field.id] === '' || field.type === 'checkbox' && values[field.id] !== true))) {
      setError(t('请填写必填信息。', 'Complete the required information.'))
      return
    }
    setSending(action)
    setError('')
    try {
      const result = await onRespond(action, request?.fields?.length ? values : undefined)
      if (!result.success) {
        setSending(null)
        setError(t('未能发送操作，自动化仍暂停。请重试。', result.message || 'Could not send the response. Automation remains paused; try again.'))
      }
      if (action === 'open-fix-session') setSending(null)
    } catch {
      setSending(null)
      setError(t('连接暂时不可用，自动化仍暂停。请重试。', 'Connection unavailable. Automation remains paused; try again.'))
    }
  }
  const canContinue = request?.allowedActions.includes('continue')
  const checking = request?.state === 'RECOVERING' || sending === 'continue'
  const failedCheck = request?.message.startsWith('The issue is still present.')
  const commodity = request?.recoveryPoint === 'COMMODITY_MISSING'
  const readFailure = request?.recoveryPoint === 'NPL_READ_FAILED'
  const slow = request?.recoveryPoint === 'SAP_SLOW_HARD_TIMEOUT'
  const material = Array.isArray(request?.materials) ? request.materials.join(', ') : ''
  const step = request?.recoveryPoint === 'PROD_RFQ_STAGING' ? t('RFQ 列表校验', 'RFQ list verification')
    : request?.recoveryPoint === 'BUYER_RECEIPT_SAVED_GREEN' ? t('Buyer Receipt 保存确认', 'Buyer Receipt save verification')
    : commodity ? t('Commodity 创建前检查', 'Commodity pre-check')
    : readFailure ? t('NPL 字段读取校验', 'NPL field verification')
    : request?.recoveryPoint === 'SIGN_IN' ? t('登录及工作窗口检查', 'Sign-in and window verification') : t('SAP 状态检查', 'SAP state verification')
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="action-required-title" onCancel={(event) => event.preventDefault()}>
    {request && <>
      <h2 id="action-required-title">{commodity ? t('需要维护 Commodity', 'Commodity Information Required') : readFailure ? t('NPL 数据读取失败', 'NPL Data Could Not Be Read') : slow ? t('SAP 需要处理', 'SAP Needs Attention') : canContinue ? t('需要处理', 'Action Required') : t('自动化已暂停', 'Automation Paused')}</h2>
      <p className={styles.state} role="status">{checking ? t('正在验证 SAP，自动化仍暂停…', 'Checking SAP; automation remains paused…') : t('自动化已暂停，等待用户处理。', 'Automation is paused and waiting for you.')}</p>
      <dl><dt>{t('物料', 'Material')}</dt><dd>{material || '—'}</dd><dt>{t('当前步骤', 'Current Step')}</dt><dd>{step}</dd></dl>
      <p><strong>{t('问题', 'Issue')}: </strong>{t(request.issueSummaryZh || '当前 SAP 页面或数据未通过验证。', request.issueSummary || 'The current SAP screen or data could not be verified.')}</p>
      {failedCheck && <p className={styles.warning}>{t('问题仍未解决。系统尚未确认 SAP 状态有效，请处理后再次检查。', 'The issue is still present. SAP could not be verified; correct it and check again.')}</p>}
      <p>{commodity || readFailure || slow || request.automation !== 'RFQ' && canContinue ? t(request.instructionsZh || '请在 SAP 中处理提示的问题，返回后点击重新检查。未知页面不能直接继续。', request.instructions || 'Resolve the issue in SAP, then recheck. An unknown screen cannot blindly continue.') : canContinue ? request.recoveryPoint === 'BUYER_RECEIPT_SAVED_GREEN'
        ? t('请在 SAP 中修正并手动保存当前 Buyer Receipt，确认相关物料为绿色状态，再点击继续。', 'Correct and manually save the current Buyer Receipt in SAP. Confirm the materials show green saved status, then click Continue.')
        : t('请检查 SAP 当前 RFQ 列表中的重复物料、供应商或可编辑状态。处理后返回这里点击继续，系统会重新验证。', 'Check the current SAP RFQ list for duplicate materials, supplier details or editability. After correcting it, click Continue to verify again.')
        : t('检测到未确认的 SAP 状态，无法安全继续。请查看详情并停止自动化，保留已创建的结果。', 'An unexpected SAP state was detected. Automatic execution cannot safely continue. View details and stop automation; existing results are preserved.')}</p>
      {!!request.fields?.length && <UserInputModal fields={request.fields} values={values} disabled={checking || sending === 'stop'}
        onChange={(id, value) => setValues(current => ({ ...current, [id]: value }))} />}
      <details className={styles.details}><summary>{t('查看详情', 'View Details')}</summary>
        <p>{request.message}</p><dl><dt>Run ID</dt><dd>{request.runId}</dd><dt>{t('分组', 'RFQ Group')}</dt><dd>{request.groupKey || '—'}</dd><dt>{t('Excel 行', 'Excel Row')}</dt><dd>{request.rows?.join(', ') || '—'}</dd><dt>{t('恢复点', 'Recovery Point')}</dt><dd>{request.recoveryPoint || request.step || '—'}</dd></dl>
      </details>
      {error && <p role="alert" className={styles.warning}>{error}</p>}
      {request.message.startsWith('Open Fix Session unavailable:') && <p className={styles.warning}>{t('未能打开额外会话，请使用另一个已有 SAP 会话人工修正，完成后重新检查。', 'An additional session is unavailable. Use another existing SAP session to correct master data, then Recheck.')}</p>}
      {request.message.startsWith('Manual correction session ready:') && <p className={styles.state}>{t('修正会话已打开；请手动维护 Commodity，完成后重新检查。原自动化会话仍暂停。', request.message)}</p>}
      <div className={styles.actions}>
        <button className="button" disabled={sending === 'stop'} onClick={() => void respond('stop')}>{sending === 'stop' ? t('正在停止…', 'Stopping…') : t('停止自动化', 'Stop Automation')}</button>
        {commodity && request.allowedActions.includes('open-fix-session') && <button className="button" disabled={checking || sending !== null} onClick={() => void respond('open-fix-session')}>{t('打开修正会话', 'Open Fix Session')}</button>}
        {canContinue && <button className="button primary" disabled={checking || sending !== null} onClick={() => void respond('continue')}>{checking ? t('正在验证…', 'Checking…') : commodity ? t('已修复，重新检查', "I've Fixed It – Recheck") : readFailure ? t('重新读取并检查', 'Recheck NPL Data') : slow || failedCheck ? t('再次检查', 'Check Again') : t('继续', 'Continue')}</button>}
      </div>
    </>}
  </dialog>
}
