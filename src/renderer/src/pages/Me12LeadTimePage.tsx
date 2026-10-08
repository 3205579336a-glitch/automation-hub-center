import { GuidedAutomationPage } from '../components/automation/GuidedAutomationPage'
import type { Notify } from '../types/notifications'

export function Me12LeadTimePage({ notify, onBack }: { notify: Notify; onBack: () => void }): React.JSX.Element {
  return <GuidedAutomationPage module="info-record" notify={notify} onBack={onBack} />
}
