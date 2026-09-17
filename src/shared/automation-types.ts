export type AutomationErrorCode =
  | 'INVALID_SAP_URL'
  | 'SAP_URL_EMPTY'
  | 'BROWSER_UNAVAILABLE'
  | 'BROWSER_LAUNCH_FAILED'
  | 'NAVIGATION_FAILED'
  | 'NAVIGATION_TIMEOUT'
  | 'OPERATION_IN_PROGRESS'
  | 'IPC_FORBIDDEN'
  | 'UNKNOWN_ERROR'

export type AutomationResult =
  | {
      success: true
      message: string
      requiresUserAction?: boolean
    }
  | {
      success: false
      errorCode: AutomationErrorCode
      message: string
    }

export type AutomationProgressStage =
  | 'starting-browser'
  | 'opening-sap'
  | 'waiting-for-login'
  | 'complete'
  | 'failed'

export interface AutomationProgress {
  stage: AutomationProgressStage
  message: string
}

export interface OpenSapRequest {
  tcode?: string
  newBrowser?: boolean
}

export function isOpenSapRequest(value: unknown): value is OpenSapRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  const validTcode =
    candidate.tcode === undefined ||
    (typeof candidate.tcode === 'string' &&
      candidate.tcode.length <= 32 &&
      /^[a-zA-Z0-9_./-]*$/.test(candidate.tcode))
  const validNewBrowser =
    candidate.newBrowser === undefined || typeof candidate.newBrowser === 'boolean'
  return validTcode && validNewBrowser
}
