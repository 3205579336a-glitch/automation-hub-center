import { useEffect, useRef, useState } from 'react'
import type { AutomationInteraction, InteractionAction } from '../../../../shared/automation-interaction'
import type { Notify } from '../../types/notifications'
import { ActionRequiredModal } from './ActionRequiredModal'

export function AutomationInteractionManager({ notify, onStateChange }: { notify: Notify; onStateChange: (state: AutomationInteraction['state'] | null) => void }): React.JSX.Element {
  const [request, setRequest] = useState<AutomationInteraction | null>(null)
  const notified = useRef('')
  useEffect(() => {
    let active = true
    let receivedEvent = false
    const update = (next: AutomationInteraction | null): void => {
      if (!active) return
      setRequest(next)
      onStateChange(next?.state ?? null)
      if (next?.state === 'WAITING_FOR_USER' && notified.current !== next.requestId) {
        notified.current = next.requestId
        try { notify({ kind: 'warning', title: 'Action Required / 需要处理', message: 'Automation is paused. Review the dialog. / 自动化已暂停，请查看弹窗。' }) } catch { /* Sound/toast failure must not dismiss the modal. */ }
      }
    }
    const unsubscribe = window.sapAutomation.onAutomationInteraction((next) => { receivedEvent = true; update(next) })
    void window.sapAutomation.getAutomationInteraction().then((next) => { if (!receivedEvent) update(next) }).catch(() => undefined)
    return () => { active = false; unsubscribe() }
  }, [notify, onStateChange])
  const respond = async (action: InteractionAction, values?: Record<string, string | boolean>): Promise<{ success: boolean; message?: string }> => {
    if (!request) return { success: false }
    return window.sapAutomation.respondAutomationInteraction({ runId: request.runId, requestId: request.requestId, action, ...(values ? { values } : {}) })
  }
  return <ActionRequiredModal request={request} onRespond={respond} />
}
