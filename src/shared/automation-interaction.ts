export type InteractionAction = 'continue' | 'stop' | 'open-fix-session'

export interface InteractionField {
  id: string
  label: string
  labelZh?: string
  type: 'text' | 'date' | 'dropdown' | 'yes-no' | 'checkbox'
  required?: boolean
  options?: { value: string; label: string }[]
}

export interface AutomationInteraction {
  automation: string
  runId: string
  requestId: string
  state: 'WAITING_FOR_USER' | 'RECOVERING'
  allowedActions: InteractionAction[]
  message: string
  issueSummary?: string
  issueSummaryZh?: string
  step?: string
  recoveryPoint?: string
  groupKey?: string
  materials?: string[] | number
  rows?: number[]
  instructions?: string
  instructionsZh?: string
  fields?: InteractionField[]
}

export interface InteractionResponse {
  runId: string
  requestId: string
  action: InteractionAction
  values?: Record<string, string | boolean>
}

export function isInteractionResponse(value: unknown): value is InteractionResponse {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  return typeof input.runId === 'string' && input.runId.length <= 100
    && typeof input.requestId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(input.requestId)
    && (input.action === 'continue' || input.action === 'stop' || input.action === 'open-fix-session')
    && (input.values === undefined || (!!input.values && typeof input.values === 'object'
      && !Array.isArray(input.values) && Object.keys(input.values).length <= 20
      && Object.entries(input.values).every(([key, value]) => /^[a-zA-Z0-9_-]{1,50}$/.test(key)
        && (typeof value === 'boolean' || typeof value === 'string' && value.length <= 1000))))
}
/** Validate the values against the engine-owned request, not only the JSON envelope. */
export function validInteractionValues(request: AutomationInteraction, response: InteractionResponse): boolean {
  if (response.action === 'stop') return true
  const fields = request.fields ?? []
  const values = response.values ?? {}
  if (Object.keys(values).some(key => !fields.some(field => field.id === key))) return false
  return fields.every(field => {
    const value = values[field.id]
    if (value === undefined || value === '') return !field.required
    if (field.type === 'checkbox') return typeof value === 'boolean' && (!field.required || value)
    if (typeof value !== 'string') return false
    if (field.required && !value.trim()) return false
    if (field.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
    if (field.type === 'yes-no') return value === 'yes' || value === 'no'
    if (field.type === 'dropdown') return Boolean(field.options?.some(option => option.value === value))
    return true
  })
}
