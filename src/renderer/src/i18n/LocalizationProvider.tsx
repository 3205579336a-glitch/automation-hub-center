import { useMemo } from 'react'
import type { AppLanguage } from '../../../shared/settings-types'
import { LocalizationContext } from './localization-context'
import { translate } from './translations'

interface LocalizationProviderProps {
  language: AppLanguage
  children: React.ReactNode
}

export function LocalizationProvider({
  language,
  children
}: LocalizationProviderProps): React.JSX.Element {
  const value = useMemo(
    () => ({ language, t: (key: Parameters<typeof translate>[1]) => translate(language, key) }),
    [language]
  )
  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>
}
