import styles from './StatusBadge.module.css'

interface StatusBadgeProps {
  status:
    | 'Success'
    | 'Partial'
    | 'Running'
    | 'Failed'
    | 'Cancelled'
    | 'Active'
    | 'Coming Soon'
}

export function StatusBadge({ status }: StatusBadgeProps): React.JSX.Element {
  const styleName = status.toLowerCase().replace(' ', '')
  return <span className={`${styles.badge} ${styles[styleName]}`}>{status}</span>
}
