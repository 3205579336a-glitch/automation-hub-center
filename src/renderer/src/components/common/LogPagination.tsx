import { useLocalization } from '../../i18n/use-localization'
import styles from './LogPagination.module.css'

export function LogPagination({ page, totalPages, hasMore, loading, onPage }: {
  page: number; totalPages?: number; hasMore: boolean; loading: boolean; onPage: (page: number) => void
}): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  return <nav className={styles.pager} aria-label={zh ? '日志分页' : 'Log pagination'}>
    <button className="button" disabled={loading || page <= 1} onClick={() => onPage(page - 1)}>{zh ? '上一页' : 'Previous page'}</button>
    <span aria-live="polite">{zh ? `第 ${page} 页` : `Page ${page}`}{totalPages !== undefined ? ` / ${Math.max(1, totalPages)}` : ''}</span>
    <button className="button" disabled={loading || !hasMore} onClick={() => onPage(page + 1)}>{zh ? '下一页' : 'Next page'}</button>
  </nav>
}
