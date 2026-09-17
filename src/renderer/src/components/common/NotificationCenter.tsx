import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import type { AppNotification, NotificationKind } from '../../types/notifications'
import styles from './NotificationCenter.module.css'

interface NotificationCenterProps {
  notifications: AppNotification[]
  onDismiss: (id: number) => void
}

const icons: Record<NotificationKind, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  warning: TriangleAlert
}

export function NotificationCenter({
  notifications,
  onDismiss
}: NotificationCenterProps): React.JSX.Element {
  return (
    <div className={styles.stack} role="region" aria-label="Notifications">
      {notifications.map((notification) => {
        const Icon = icons[notification.kind]
        return (
          <div
            className={`${styles.notification} ${styles[notification.kind]}`}
            key={notification.id}
            role={notification.kind === 'error' ? 'alert' : 'status'}
          >
            <Icon className={styles.kindIcon} size={20} />
            <div className={styles.content}>
              <strong>{notification.title}</strong>
              <span>{notification.message}</span>
            </div>
            <button
              className={styles.dismiss}
              onClick={() => onDismiss(notification.id)}
              aria-label="Dismiss notification"
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
