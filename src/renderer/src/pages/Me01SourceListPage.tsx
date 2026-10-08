import { GuidedAutomationPage } from '../components/automation/GuidedAutomationPage'
import type { Notify } from '../types/notifications'

export function Me01SourceListPage({ notify, onBack }: { notify: Notify; onBack: () => void }): React.JSX.Element {
  return <GuidedAutomationPage module="source-list" notify={notify} onBack={onBack} />
}
