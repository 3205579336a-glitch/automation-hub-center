import { GuidedAutomationPage } from '../components/automation/GuidedAutomationPage'
import type { Notify } from '../types/notifications'

export function ApqpPlanClosurePage({ notify, onBack }: { notify: Notify; onBack: () => void }): React.JSX.Element {
  return <GuidedAutomationPage module="apqp" notify={notify} onBack={onBack} />
}
