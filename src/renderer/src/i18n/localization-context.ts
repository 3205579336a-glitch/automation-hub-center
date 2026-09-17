import { createContext } from 'react'
import type { AppLanguage } from '../../../shared/settings-types'
import type { TranslationKey } from './translations'
import { translate } from './translations'

export interface LocalizationContextValue {
  language: AppLanguage
  t: (key: TranslationKey) => string
}

export const LocalizationContext = createContext<LocalizationContextValue>({
  language: 'en',
  t: (key) => translate('en', key)
})
