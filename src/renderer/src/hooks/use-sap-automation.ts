import { useCallback, useEffect, useRef, useState } from 'react'
import type { AutomationProgressStage, OpenSapRequest } from '../../../shared/automation-types'
import type { Notify } from '../types/notifications'

type AutomationState = 'ready' | AutomationProgressStage

export function useSapAutomation(notify: Notify): {
  status: AutomationState
  statusLabel: string
  busy: boolean
  openSapWebGui: (request?: OpenSapRequest) => Promise<void>
} {
  const [status, setStatus] = useState<AutomationState>('ready')
  const manualFollowUpActive = useRef(false)

  useEffect(
    () =>
      window.sapAutomation.onAutomationProgress((progress) => {
        setStatus(progress.stage)
        if (progress.stage === 'starting-browser' || progress.stage === 'opening-sap') {
          notify({ kind: 'info', title: 'Opening SAP WebGUI', message: progress.message })
        }
        if (progress.stage === 'waiting-for-login') {
          notify({ kind: 'warning', title: 'Certificate selection required', message: progress.message })
        }
        if (progress.stage === 'failed') {
          if (manualFollowUpActive.current) {
            manualFollowUpActive.current = false
            notify({ kind: 'error', title: 'SAP browser operation failed', message: progress.message })
          }
        }
        if (progress.stage === 'complete') {
          if (manualFollowUpActive.current) {
            manualFollowUpActive.current = false
            notify({ kind: 'success', title: 'SAP WebGUI ready', message: progress.message })
          }
        }
      }),
    [notify]
  )

  const openSapWebGui = useCallback(async (request: OpenSapRequest = {}) => {
    setStatus('starting-browser')
    manualFollowUpActive.current = false
    try {
      const result = await window.sapAutomation.openSapWebGui(request)
      if (result.success) {
        if (result.requiresUserAction) {
          manualFollowUpActive.current = true
          setStatus('waiting-for-login')
          notify({ kind: 'warning', title: 'Complete SAP sign-in', message: result.message })
        } else {
          setStatus('complete')
          notify({ kind: 'success', title: 'SAP WebGUI ready', message: result.message })
        }
      } else {
        setStatus('failed')
        notify({ kind: 'error', title: 'Failed to open SAP WebGUI', message: result.message })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The main process did not respond.'
      setStatus('failed')
      notify({ kind: 'error', title: 'Failed to open SAP WebGUI', message })
    }
  }, [notify])

  const labels: Record<AutomationState, string> = {
    ready: 'Ready',
    'starting-browser': 'Starting Browser',
    'opening-sap': 'Opening SAP',
    'waiting-for-login': 'Waiting for Login',
    complete: 'Ready',
    failed: 'Attention'
  }

  return {
    status,
    statusLabel: labels[status],
    busy: status === 'starting-browser' || status === 'opening-sap',
    openSapWebGui
  }
}
