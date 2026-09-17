import { useCallback, useRef, useState } from 'react'
import type { AppNotification, Notify } from '../types/notifications'

const NOTIFICATION_DURATION_MS = 5_000

export function useNotifications(): {
  notifications: AppNotification[]
  notify: Notify
  dismiss: (id: number) => void
} {
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id))
  }, [])

  const notify = useCallback<Notify>(
    (notification) => {
      const id = nextId.current++
      setNotifications((current) => [...current.slice(-3), { ...notification, id }])
      window.setTimeout(() => dismiss(id), NOTIFICATION_DURATION_MS)
    },
    [dismiss]
  )

  return { notifications, notify, dismiss }
}
