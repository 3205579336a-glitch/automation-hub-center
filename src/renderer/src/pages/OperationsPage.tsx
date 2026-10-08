import { ArrowRight, CalendarSearch, ClockArrowUp, FilePlus2, Info, ListChecks } from 'lucide-react'
import { useState } from 'react'
import { OperationGuideModal, type OperationGuide } from '../components/operations/OperationGuideModal'
import { useLocalization } from '../i18n/use-localization'
import type { PageId } from '../types/navigation'
import styles from './OperationsPage.module.css'

export function OperationsPage({ onNavigate }: { onNavigate: (page: PageId) => void }): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const [selectedGuide, setSelectedGuide] = useState<OperationGuide | null>(null)
  const cards: { page: PageId; title: string; description: string; icon: typeof FilePlus2; tone: string; steps: string[] }[] = [
    { page: 'create-rfq', title: zh ? '创建 Buyer Receipt / RFQ' : 'Create Buyer Receipt / RFQ', icon: FilePlus2, tone: 'purple',
      description: zh ? '从标准模板创建 Buyer Receipt 和 RFQ，按供应商自动分组。' : 'Create Buyer Receipts and RFQs from the standard template, grouped by supplier.',
      steps: zh ? ['下载并填写模板', '上传并核对分组预览', '确认正式系统后运行，查看结果'] : ['Download and complete the template', 'Upload and review grouped preview', 'Confirm Production, run and review results'] },
    { page: 'me12-lead-time', title: zh ? '更新采购信息记录' : 'Update Info Record', icon: ClockArrowUp, tone: 'green',
      description: zh ? '批量更新供应商交货时间，支持标准和寄售采购。' : 'Update supplier lead times in batch for standard or consignment purchasing.',
      steps: zh ? ['填写模板中的信息记录和工厂', '上传，填写目标交货天数并核对预览', '确认更新，运行并打开结果'] : ['Complete the Info Record and Plant columns', 'Upload, enter target lead time and review', 'Confirm the update, run and open results'] },
    { page: 'apqp-plan-closure', title: 'APQP', icon: CalendarSearch, tone: 'blue',
      description: zh ? '查询 APQP 计划关闭日期并写入 Excel，不修改 SAP 数据。' : 'Download APQP plan close dates to Excel without changing SAP data.',
      steps: zh ? ['下载模板并填写物料及供应商', '上传并核对预览', '开始查询并打开结果'] : ['Fill material and supplier in the template', 'Upload and review', 'Start the query and open results'] },
    { page: 'me01-source-list', title: zh ? '更新货源清单' : 'Update Source List', icon: ListChecks, tone: 'orange',
      description: zh ? '按物料和供应商固定货源，保留其他供应商记录及已有勾选。' : 'Fix the intended supplier for each material while preserving other supplier records and existing selections.',
      steps: zh ? ['填写物料和供应商代码', '上传并核对预览，工厂固定为 C100', '确认更新，运行并打开结果'] : ['Fill material and supplier codes', 'Upload and review; Plant is C100', 'Confirm the update, run and open results'] }
  ]
  return <div className="page">
    <div className="page-heading"><div><h2>{zh ? '采购自动化中心' : 'Purchasing Automation Hub'}</h2>
      <p>{zh ? '选择任务，填写模板，上传后交给系统处理。' : 'Choose a task, provide the purchasing data, and let the Hub handle the rest.'}</p></div></div>
    <div className={styles.grid}>{cards.map(card => {
      const Icon = card.icon
      return <article className={`card ${styles.card} ${styles.activeCard}`} key={card.page}>
        <div className={`${styles.icon} ${styles[card.tone]}`}><Icon size={23} /></div>
        <div className={styles.cardTop}><span>{zh ? '采购任务' : 'Purchasing task'}</span></div>
        <h3>{card.title}</h3><p>{card.description}</p>
        <div className={styles.actions}>
          <button className="button" onClick={() => setSelectedGuide({ title: card.title, description: card.description, steps: card.steps, availability: 'active' })}><Info size={14} />{zh ? '说明' : 'Info'}</button>
          <button className="button primary" onClick={() => onNavigate(card.page)}>{zh ? '打开' : 'Open'}<ArrowRight size={14} /></button>
        </div>
      </article>
    })}</div>
    {selectedGuide && <OperationGuideModal guide={selectedGuide} closeLabel={zh ? '关闭' : 'Close'} onClose={() => setSelectedGuide(null)} />}
  </div>
}
