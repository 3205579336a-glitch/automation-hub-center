import type { AutomationId, EtaSnapshot } from '../../../../shared/local-intelligence'
import { estimateRemaining, fallbackModel } from '../../../../shared/local-intelligence'
import { useLocalization } from '../../i18n/use-localization'
import styles from './GuidedAutomation.module.css'

export function AdaptiveEta({ eta, unavailable, automationId, total, waiting = false, recovering = false }: {
  eta: EtaSnapshot | null; unavailable: boolean; automationId: AutomationId; total: number; waiting?: boolean; recovering?: boolean
}): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const paused = waiting || eta?.state === 'waiting'
  const rechecking = recovering || eta?.state === 'recovering'
  const initial = estimateRemaining(fallbackModel(automationId), { total, completed: 0, concurrency: 1,
    startupDone: false, startupElapsed: 0, unitElapsed: 0, learned: 0 })
  const remaining = eta?.remainingMs ?? (eta?.total ? null : initial)
  const seconds = Math.max(1, Math.ceil((remaining ?? 0) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const rest = seconds % 60
  const duration = zh ? `${hours ? `${hours} 小时 ` : ''}${minutes ? `${minutes} 分 ` : ''}${rest} 秒`
    : `${hours ? `${hours} h ` : ''}${minutes ? `${minutes} min ` : ''}${rest} sec`
  return <div className={styles.eta} aria-label={zh ? '预计剩余时间' : 'Estimated time remaining'}>
    <span>{zh ? '预计剩余时间' : 'Estimated time remaining'}</span>
    <strong>{paused ? zh ? '等待你处理' : 'Waiting for your action'
      : rechecking ? zh ? '正在验证，验证后重新估算' : 'Checking; estimate resumes after verification'
      : eta && !eta.active ? zh ? '处理已结束' : 'Processing finished'
      : unavailable || remaining === null ? zh ? '暂时无法估算' : 'ETA unavailable' : `~${duration}`}</strong>
    {!paused && !rechecking && !unavailable && (!eta || eta.active) && remaining !== null && <small>
      {(!eta?.total || eta.confidence === 'learning') ? zh ? '正在学习本机耗时，仅供参考。' : 'Learning from this device; approximate estimate.'
        : zh ? `根据本机 ${eta?.historicalRuns} 次历史运行，并结合本次速度估算。` : `Based on ${eta?.historicalRuns} local runs and current speed.`}
    </small>}
  </div>
}
