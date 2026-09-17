export type NotificationKind = 'success' | 'error' | 'info' | 'warning'

export interface AppNotification {
  id: number
  kind: NotificationKind
  title: string
  message: string
}

export type Notify = (notification: Omit<AppNotification, 'id'>) => void
