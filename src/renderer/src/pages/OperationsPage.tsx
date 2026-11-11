import { ArrowRight, CalendarSearch, ClockArrowUp, FilePlus2, Info, ListChecks, Tags } from 'lucide-react'
import { useState } from 'react'
import { OperationGuideModal, type OperationGuide } from '../components/operations/OperationGuideModal'
import { useLocalization } from '../i18n/use-localization'
import { operationCopy, type PurchasingOperation } from '../i18n/operation-copy'
import { TASK_PAGES, useTaskRanking } from '../hooks/use-task-ranking'
import type { PageId } from '../types/navigation'
import { preloadPage } from './page-loaders'
import styles from './OperationsPage.module.css'

export function OperationsPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const [selectedGuide, setSelectedGuide] = useState<OperationGuide | null>(null)
  const { ranking, loading } = useTaskRanking()
  const cards: { page: PurchasingOperation; icon: typeof FilePlus2; tone: string }[] = [
    { page: 'create-rfq', icon: FilePlus2, tone: 'purple' },
    { page: 'me12-lead-time', icon: ClockArrowUp, tone: 'green' },
    { page: 'apqp-plan-closure', icon: CalendarSearch, tone: 'blue' },
    { page: 'me01-source-list', icon: ListChecks, tone: 'orange' },
    { page: 'mm02-sub-commodity', icon: Tags, tone: 'purple' }
  ]
  return <div className="page">
    <div className="page-heading"><div><h2>{zh ? '采购自动化中心' : 'Purchasing Automation Hub'}</h2>
      <p>{zh ? '选任务 → 填模板 → 上传并核对 → 开始自动批量处理，在 Excel 中查看结果。' : 'Choose a task → Fill the template → Upload and review → Start the batch and review the results in Excel.'}</p></div></div>
    <p className={styles.rankingNote}>{loading ? zh ? '正在加载任务…' : 'Loading tasks…'
      : ranking.personalized ? zh ? '常用任务优先 · 根据本机近 60 天的运行记录排列' : 'Common tasks first · Based on the last 60 days on this device'
      : zh ? '所有自动化 · 运行后会逐渐按你的使用习惯排列' : 'All automations · Ordering adapts as you use this device'}</p>
    {!loading && <div className={styles.grid}>{ranking.order.map(id => {
      const card = cards.find(item => item.page === TASK_PAGES[id])!
      const Icon = card.icon
      const text = operationCopy(card.page, language)
      const frequent = ranking.frequentlyUsed.includes(id)
      return <article className={`card ${styles.card}`} key={card.page}>
        <div className={styles.cardTop}>
          <div className={`${styles.icon} ${styles[card.tone]}`}><Icon size={22} aria-hidden="true" /></div>
          <span className={frequent ? styles.frequent : ''}>{frequent ? zh ? '经常使用' : 'Frequently used' : zh ? '自动批量处理' : 'Automated batch task'}</span>
        </div>
        <h3>{text.title}</h3><p>{text.description}</p>
        {text.permissionNotice && <p className={styles.permissionNotice} role="note">{text.permissionNotice}</p>}
        <div className={styles.actions}>
          <button className="button" onClick={() => setSelectedGuide({ ...text, availability: 'active' })}><Info size={14} />{zh ? '说明' : 'Info'}</button>
          <button className="button primary" onPointerEnter={() => preloadPage(card.page)} onFocus={() => preloadPage(card.page)} onClick={() => onNavigate(card.page)}>{zh ? '打开' : 'Open'}<ArrowRight size={14} /></button>
        </div>
      </article>
    })}</div>}
    {selectedGuide && <OperationGuideModal guide={selectedGuide} closeLabel={zh ? '关闭' : 'Close'} onClose={() => setSelectedGuide(null)} />}
  </div>
}
