import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import type { PurchasingOperation } from '../../i18n/operation-copy'

export const TASK_FINISHED_EVENT = 'automation-task-finished'

interface TaskRunGate {
  activeTask: PurchasingOperation | null
  tryStart: (task: PurchasingOperation) => (() => void) | null
  openRunningTask: () => void
}
export const TaskRunContext = createContext<TaskRunGate | null>(null)

export function useTaskRun(): TaskRunGate {
  const gate = useContext(TaskRunContext)
  if (!gate) throw new Error('Automation task controls require the application run gate.')
  return gate
}

// Local result dialogs must not make the visible page inert from a hidden workflow.
export const WorkflowVisibility = createContext(true)

export function useWorkflowDialog(open: boolean): React.RefObject<HTMLDialogElement> {
  const visible = useContext(WorkflowVisibility)
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    if (open && visible) {
      if (!dialog.current?.open) dialog.current?.showModal()
    } else dialog.current?.close()
  }, [open, visible])
  return dialog
}
