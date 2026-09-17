import type { SapAutomationApi } from '../../preload/types'

declare global {
  interface Window {
    sapAutomation: SapAutomationApi
  }
}

export {}
