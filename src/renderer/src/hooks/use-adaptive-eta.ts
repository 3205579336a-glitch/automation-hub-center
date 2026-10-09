import { useEffect, useState } from 'react'
import type { AutomationId, EtaSnapshot } from '../../../shared/local-intelligence'

function validEta(eta: EtaSnapshot | null, id: AutomationId): eta is EtaSnapshot {
  return !!eta && eta.automationId === id && typeof eta.runId === 'string'
    && ['running', 'waiting', 'recovering', 'saving'].includes(eta.state)
    && ['learning', 'estimated', 'high'].includes(eta.confidence)
    && typeof eta.active === 'boolean' && Number.isInteger(eta.total) && eta.total >= 0 && eta.total <= 100_000
    && Number.isInteger(eta.completed) && eta.completed >= 0 && eta.completed <= eta.total
    && Number.isInteger(eta.historicalRuns) && eta.historicalRuns >= 0 && eta.historicalRuns <= 100
    && (eta.remainingMs === null || Number.isFinite(eta.remainingMs) && eta.remainingMs >= 0)
}
export function useAdaptiveEta(id: AutomationId, active: boolean): { eta: EtaSnapshot | null; unavailable: boolean } {
  const [eta, setEta] = useState<EtaSnapshot | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    setEta(null); setUnavailable(false)
    if (!active) return
    let mounted = true
    let received = false
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = window.sapAutomation.onAutomationEta(value => {
        if (!mounted || value.automationId !== id) return
        received = true
        if (validEta(value, id)) { setEta(value); setUnavailable(false) }
        else setUnavailable(true)
      })
      void window.sapAutomation.getLocalIntelligence().then(value => {
        if (mounted && !received && validEta(value.eta, id)) setEta(value.eta)
      }).catch(() => { if (mounted && !received) setUnavailable(true) })
    } catch { setUnavailable(true) }
    return () => { mounted = false; unsubscribe?.() }
  }, [id, active])
  return { eta, unavailable }
}
