import { useContext } from 'react'
import { LocalizationContext } from './localization-context'

export function useLocalization() {
  return useContext(LocalizationContext)
}
