import { ArrowRight, CalendarSearch, ClockArrowUp, FilePlus2, Info, ListChecks } from 'lucide-react'
import { useState } from 'react'
import { OperationGuideModal, type OperationGuide } from '../components/operations/OperationGuideModal'
import { useLocalization } from '../i18n/use-localization'
import { operationCopy, type PurchasingOperation } from '../i18n/operation-copy'
import { TASK_PAGES, useTaskRanking } from '../hooks/use-task-ranking'
import type { PageId } from '../types/navigation'
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
    { page: 'me01-source-list', icon: ListChecks, tone: 'orange' }
  ]
  return <div className="page">
    <div className="page-heading"><div><h2>{zh ? '采购自动化中心' : 'Purchasing Automation Hub'}</h2>
      <p>{zh ? '选任务 → 填模板 → 上传并核对 → 开始自动批量处理，结果回写 Excel。' : 'Choose a task → Fill the template → Upload and review → Start automated batch processing, with results written back to Excel.'}</p></div></div>
    <p className={styles.rankingNote}>{loading ? zh ? '正在加载任务…' : 'Loading tasks…'
      : ranking.personalized ? zh ? '常用任务优先 · 根据本机近 60 天的运行记录排列' : 'Common tasks first · Based on the last 60 days on this device'
      : zh ? '所有自动化 · 运行后会逐渐按你的使用习惯排列' : 'All automations · Ordering adapts as you use this device'}</p>
    {!loading && <div className={styles.grid}>{ranking.order.map(id => {
      const card = cards.find(item => item.page === TASK_PAGES[id])!
      const Icon = card.icon
      const text = operationCopy(card.page, language)
      return <article className={`card ${styles.card} ${styles.activeCard}`} key={card.page}>
        <div className={`${styles.icon} ${styles[card.tone]}`}><Icon size={23} /></div>
        <div className={styles.cardTop}><span>{ranking.frequentlyUsed.includes(id) ? zh ? '经常使用' : 'Frequently used' : zh ? '自动批量处理' : 'Automated batch task'}</span></div>
        <h3>{text.title}</h3><p>{text.description}</p>
        {text.permissionNotice && <p className={styles.permissionNotice} role="note">{text.permissionNotice}</p>}
        <div className={styles.actions}>
          <button className="button" onClick={() => setSelectedGuide({ ...text, availability: 'active' })}><Info size={14} />{zh ? '说明' : 'Info'}</button>
          <button className="button primary" onClick={() => onNavigate(card.page)}>{zh ? '打开' : 'Open'}<ArrowRight size={14} /></button>
        </div>
      </article>
    })}</div>}
    {selectedGuide && <OperationGuideModal guide={selectedGuide} closeLabel={zh ? '关闭' : 'Close'} onClose={() => setSelectedGuide(null)} />}
  </div>
}
