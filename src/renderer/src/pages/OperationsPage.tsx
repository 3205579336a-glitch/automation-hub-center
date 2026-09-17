import {
  ArrowRight,
  ClockArrowUp,
  DatabaseZap,
  ExternalLink,
  FilePenLine,
  CalendarSearch,
  FilePlus2,
  Info,
  ListChecks,
  Play,
  Share2
} from 'lucide-react'
import { useState } from 'react'
import { StatusBadge } from '../components/common/StatusBadge'
import { OperationGuideModal, type OperationGuide } from '../components/operations/OperationGuideModal'
import { useLocalization } from '../i18n/use-localization'
import type { PageId } from '../types/navigation'
import styles from './OperationsPage.module.css'

interface OperationsPageProps {
  onNavigate: (page: PageId) => void
  onOpenSap: () => void
  automationBusy: boolean
}

export function OperationsPage({ onNavigate, onOpenSap, automationBusy }: OperationsPageProps): React.JSX.Element {
  const { language } = useLocalization()
  const zh = language === 'zh-CN'
  const copy = operationCopy(zh)
  const guides = createGuides(zh)
  const [selectedGuide, setSelectedGuide] = useState<OperationGuide | null>(null)

  return (
    <div className="page">
      <div className="page-heading">
        <div><h2>{copy.title}</h2><p>{copy.subtitle}</p></div>
      </div>
      <div className={styles.grid}>
        <article className={`card ${styles.card} ${styles.activeCard}`}>
          <div className={`${styles.icon} ${styles.purple}`}><FilePlus2 size={23} /></div>
          <div className={styles.cardTop}><span>{copy.purchasing}</span><StatusBadge status="Active" /></div>
          <h3>{copy.createRfq}</h3>
          <p>{copy.createRfqCopy}</p>
          <div className={styles.actions}>
            <button className="button" onClick={() => setSelectedGuide(guides.createRfq)}><Info size={13} /> {copy.guide}</button>
            <button className="button primary" onClick={() => onNavigate('create-rfq')}>{copy.openWorkspace} <ArrowRight size={13} /></button>
          </div>
        </article>

        <article className={`card ${styles.card} ${styles.activeCard}`}>
          <div className={`${styles.icon} ${styles.blue}`}><ExternalLink size={23} /></div>
          <div className={styles.cardTop}><span>{copy.browser}</span><StatusBadge status="Active" /></div>
          <h3>{copy.openSap}</h3>
          <p>{copy.openSapCopy}</p>
          <div className={styles.actions}>
            <button className="button" onClick={() => setSelectedGuide(guides.openSap)}><Info size={13} /> {copy.guide}</button>
            <button className="button primary" onClick={onOpenSap} disabled={automationBusy}>
              <Play size={13} /> {automationBusy ? copy.starting : copy.openSap}
            </button>
          </div>
        </article>

        <article className={`card ${styles.card} ${styles.activeCard}`}>
          <div className={`${styles.icon} ${styles.green}`}><ClockArrowUp size={23} /></div>
          <div className={styles.cardTop}><span>{copy.purchasing}</span><StatusBadge status="Active" /></div>
          <h3>{copy.me12}</h3>
          <p>{copy.me12Copy}</p>
          <div className={styles.actions}>
            <button className="button" onClick={() => setSelectedGuide(guides.me12)}><Info size={13} /> {copy.guide}</button>
            <button className="button primary" onClick={() => onNavigate('me12-lead-time')}>
              {copy.configure} <ArrowRight size={13} />
            </button>
          </div>
        </article>

        <article className={`card ${styles.card} ${styles.activeCard}`}>
          <div className={`${styles.icon} ${styles.orange}`}><ListChecks size={23} /></div>
          <div className={styles.cardTop}><span>{copy.purchasing}</span><StatusBadge status="Active" /></div>
          <h3>{copy.me01}</h3>
          <p>{copy.me01Copy}</p>
          <div className={styles.actions}>
            <button className="button" onClick={() => setSelectedGuide(guides.me01)}><Info size={13} /> {copy.guide}</button>
            <button className="button primary" onClick={() => onNavigate('me01-source-list')}>
              {copy.configure} <ArrowRight size={13} />
            </button>
          </div>
        </article>

        <article className={`card ${styles.card} ${styles.activeCard}`}>
          <div className={`${styles.icon} ${styles.purple}`}><FilePenLine size={23} /></div>
          <div className={styles.cardTop}><span>{copy.purchasing}</span><StatusBadge status="Active" /></div>
          <h3>{copy.me52n}</h3>
          <p>{copy.me52nCopy}</p>
          <div className={styles.actions}>
            <button className="button" onClick={() => setSelectedGuide(guides.me52n)}><Info size={13} /> {copy.guide}</button>
            <button className="button primary" onClick={() => onNavigate('me52n-project-ref')}>{copy.configure} <ArrowRight size={13} /></button>
          </div>
        </article>

        <article className={`card ${styles.card} ${styles.activeCard}`}>
          <div className={`${styles.icon} ${styles.green}`}><CalendarSearch size={23} /></div>
          <div className={styles.cardTop}><span>SAP GUI · ZMFM050035</span><StatusBadge status="Active" /></div>
          <h3>APQP Plan Closure Date</h3>
          <p>{zh ? '下载模板，按 Material 和 Vendor 查询 APQP 日期并回写 Excel，支持多 SAP 会话并发。' : 'Download a template, query APQP dates by Material and Vendor, and write back to Excel using concurrent SAP sessions.'}</p>
          <div className={styles.actions}>
            <button className="button" onClick={() => setSelectedGuide(guides.apqp)}><Info size={13} /> {copy.guide}</button>
            <button className="button primary" onClick={() => onNavigate('apqp-plan-closure')}>{copy.configure} <ArrowRight size={13} /></button>
          </div>
        </article>
        <FutureCard icon={Share2} title={copy.future} description={copy.futureCopy} guide={guides.future} guideLabel={copy.guide} comingSoon={copy.comingSoon} onGuide={setSelectedGuide} />
        <FutureCard icon={DatabaseZap} title={copy.export} description={copy.exportCopy} guide={guides.export} guideLabel={copy.guide} comingSoon={copy.comingSoon} onGuide={setSelectedGuide} />
      </div>
      {selectedGuide && <OperationGuideModal guide={selectedGuide} closeLabel={copy.close} onClose={() => setSelectedGuide(null)} />}
    </div>
  )
}

function FutureCard({ icon: Icon, title, description, guide, guideLabel, comingSoon, onGuide }: {
  icon: typeof Share2
  title: string
  description: string
  guide: OperationGuide
  guideLabel: string
  comingSoon: string
  onGuide: (guide: OperationGuide) => void
}): React.JSX.Element {
  return (
    <article className={`card ${styles.card} ${styles.disabledCard}`}>
      <div className={`${styles.icon} ${styles.gray}`}><Icon size={23} /></div>
      <div className={styles.cardTop}><span>Extension point</span><StatusBadge status="Coming Soon" /></div>
      <h3>{title}</h3><p>{description}</p>
      <div className={styles.actions}>
        <button className="button" onClick={() => onGuide(guide)}><Info size={13} /> {guideLabel}</button>
        <button className="button" disabled>{comingSoon}</button>
      </div>
    </article>
  )
}

function operationCopy(zh: boolean) {
  return zh ? {
    title: '自动化操作中心', subtitle: '所有可用的 SAP 自动化操作都从这里进入。', purchasing: '采购流程',
    createRfq: '创建 RFQ', createRfqCopy: '下载模板并上传数据，通过 SAP GUI 自动创建 Buyer Receipt 和 RFQ，支持测试与正式系统。',
    browser: '浏览器自动化', openSap: '打开 SAP WebGUI', openSapCopy: '使用设置中的浏览器打开 SAP 菜单。', starting: '正在启动…',
    me12: 'ME12 Supplier Lead Time', me12Copy: '通过标准 Excel 模板批量维护 Standard 或 Consignment 的 Supplier Lead Time。', configure: '打开操作',
    me01: 'ME01 Source List', me01Copy: '填写 Material No. 和 Parma，固定 Plant C100，在匹配的供应商行勾选 Fixed Source 并设置 Usage=1。',
    me52n: 'ME52N Project Ref', me52nCopy: '从 Excel 读取 PR，仅对白名单 WBS 批量维护 Project Ref，可配置批次与 1–5 个独立浏览器。',
    future: '未来自动化', futureCopy: '为下一项 SAP 自动化流程预留。', export: '数据导出', exportCopy: '导出本地运行结果用于分析和审计。',
    guide: '查看说明', openWorkspace: '打开操作', comingSoon: '即将推出', close: '关闭'
  } : {
    title: 'Automation catalog', subtitle: 'Start every available SAP automation operation from one place.', purchasing: 'Purchasing workflow',
    createRfq: 'Create RFQ', createRfqCopy: 'Download and upload one template, then create Buyer Receipts and RFQs through SAP GUI in Test or Production.',
    browser: 'Browser automation', openSap: 'Open SAP WebGUI', openSapCopy: 'Open the SAP menu in the browser configured in Settings.', starting: 'Starting…',
    me12: 'ME12 Supplier Lead Time', me12Copy: 'Batch-maintain Standard or Consignment Supplier Lead Time with a controlled Excel template.', configure: 'Open operation',
    me01: 'ME01 Source List', me01Copy: 'Upload Material and Parma; Plant C100 is fixed and the matching supplier row receives Fixed Source and Usage=1.',
    me52n: 'ME52N Project Ref', me52nCopy: 'Read PRs from Excel and update Project Ref only for allow-listed WBS items, with configurable batches and 1–5 isolated browsers.',
    future: 'Future Automation', futureCopy: 'Reserved for the next SAP automation workflow.', export: 'Data Export', exportCopy: 'Export local run results for analysis and audit support.',
    guide: 'View guide', openWorkspace: 'Open operation', comingSoon: 'Coming Soon', close: 'Close'
  }
}

function createGuides(zh: boolean): Record<string, OperationGuide> {
  return {
    apqp: {
      title: 'APQP Plan Closure Date',
      description: zh ? 'SAP 只读查询。A 列 Material、D 列 Vendor，E 列回写日期；读取 SAP 第一条结果。需要 Microsoft Excel 和已登录的 SAP GUI。' : 'Read-only SAP query. A: Material, D: Vendor, E: returned date; uses the first SAP result. Requires Microsoft Excel and a signed-in SAP GUI session.',
      steps: zh ? ['下载模板并填写 A/D 列', '上传预览并设置并发会话数', '确认 SAP 环境，运行并查看回写结果'] : ['Download and fill columns A/D', 'Upload, preview, and set concurrent sessions', 'Confirm the SAP environment, run, and review results'],
      availability: 'active'
    },
    createRfq: {
      title: zh ? '创建 RFQ' : 'Create RFQ',
      description: zh ? '选择测试或正式系统，下载并填写模板，上传校验后运行。' : 'Choose Test or Production, complete the template, upload, validate, and run.',
      steps: zh ? ['选择 SAP 系统', '下载并填写模板', '上传校验并确认运行'] : ['Choose SAP system', 'Complete the template', 'Upload, validate, and confirm'],
      availability: 'active'
    },
    openSap: {
      title: zh ? '打开 SAP WebGUI' : 'Open SAP WebGUI',
      description: zh ? '启动独立浏览器并进入 SAP 菜单。' : 'Start the dedicated browser and open the SAP menu.',
      steps: zh ? ['启动浏览器', '确认 Windows 证书', '完成 SAP 登录'] : ['Start browser', 'Confirm Windows certificate', 'Complete SAP sign-in'],
      availability: 'active'
    },
    me12: {
      title: zh ? '批量维护 Supplier Lead Time' : 'Batch maintain Supplier Lead Time',
      description: zh ? '下载模板、填写并上传，选择 Standard 或 Consignment，然后运行 ME12。' : 'Download, complete, and upload the template, choose Standard or Consignment, then run ME12.',
      steps: zh ? ['填写模板', '上传预览并选择 Info Category', '确认并运行 ME12'] : ['Complete template', 'Upload, preview, and choose Info Category', 'Confirm and run ME12'],
      availability: 'active'
    },
    me01: {
      title: zh ? '批量维护 Source List' : 'Batch maintain Source List',
      description: zh ? '模板填写 Material No. 和 Parma；系统定位匹配供应商行执行 ME01，Plant 固定 C100。' : 'Enter Material No. and Parma; ME01 locates the matching supplier row with Plant fixed to C100.',
      steps: zh ? ['下载并填写模板', '打开并登录正确的 SAP GUI 系统', '上传预览、确认并运行'] : ['Complete the template', 'Open and sign in to the correct SAP GUI system', 'Upload, preview, confirm, and run'],
      availability: 'active'
    },
    me52n: {
      title: zh ? '批量维护 Project Ref' : 'Batch maintain Project Ref',
      description: zh ? '从 Excel 读取采购申请，在 ME52N 中遍历 Item，仅对白名单 WBS 写入目标 Project Ref。' : 'Read purchase requisitions from Excel, inspect every ME52N item, and write the target Project Ref only for allow-listed WBS.',
      steps: zh ? ['上传 Excel 并设置 PR 列/批次', '核对 WBS 白名单和目标 Project Ref', '设置并发数，逐个浏览器登录后运行'] : ['Upload Excel and set PR column/batch', 'Review WBS allow-list and target Project Ref', 'Set concurrency, sign in to each browser, and run'],
      availability: 'active'
    },
    future: { title: zh ? '未来自动化' : 'Future Automation', description: zh ? '为下一项经过批准的流程预留。' : 'Reserved for the next approved workflow.', steps: zh ? ['定义流程', '测试验证', '发布操作'] : ['Define workflow', 'Validate', 'Publish'], availability: 'coming-soon' },
    export: { title: zh ? '数据导出' : 'Data Export', description: zh ? '用于导出本地执行结果。' : 'Planned export for local execution results.', steps: zh ? ['选择记录', '选择格式', '保存文件'] : ['Select records', 'Choose format', 'Save file'], availability: 'coming-soon' }
  }
}
