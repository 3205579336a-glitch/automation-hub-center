import type { AppLanguage } from '../../../shared/settings-types'

interface OperationCopy {
  title: string
  shortTitle: string
  description: string
  steps: string[]
  permissionNotice?: string
}

// Keep task names, benefits and instructions together for cards and task pages.
const copy = {
  en: {
    'create-rfq': {
      title: 'Automatically Create Buyer Receipts and RFQs in Batch from NPL',
      shortTitle: 'Batch Create Buyer Receipts / RFQs',
      description: 'Upload one Excel template. The Hub looks up NPL materials, groups them by Plant, Project and Supplier Parma, then creates Buyer Receipts and RFQs and writes the results back to Excel.',
      steps: ['Download the template and fill materials, project and supplier details', 'Upload and review the groups; each RFQ contains up to 50 materials', 'Confirm the SAP environment, start the batch and check RFQ numbers in the result file']
    },
    'me12-lead-time': {
      title: 'Batch Update Purchasing Info Records (IR)',
      shortTitle: 'Batch Update Info Records',
      permissionNotice: 'Permission required: SAP ME12 purchasing Info Record change authorization. If unavailable, contact your key user or IT.',
      description: 'Update SLT, PDT and confirmation control independently by Info Record. Standard and consignment are selected by default. Excel reports both outcomes separately.',
      steps: ['Fill the Info Record number and at least one change per row', 'Review the upload and confirm Plant, purchasing organization and types', 'Choose your certificate if prompted, then review the results in Excel']
    },
    'apqp-plan-closure': {
      title: 'APQP Date Management',
      shortTitle: 'APQP Date Management',
      description: 'Find APQPs by project and owner, then update four planned dates in Production 949. The separate Excel workflow looks up plan closure dates without changing SAP.',
      steps: ['Choose Find APQPs & Edit Dates or Query Plan Closure Date', 'Check the project and owner User ID, or upload the Excel query template', 'Save only the planned dates you intend to change, or review the read-only query results in Excel']
    },
    'me01-source-list': {
      title: 'Automatically Maintain Source Lists in Batch',
      shortTitle: 'Batch Source List Maintenance',
      description: 'Upload materials, Supplier Parma and Dual Sourcing (Yes/No). Existing target suppliers are skipped without changes. Missing suppliers are added with Fix and MRP 1; Yes keeps other Fix/MRP, No clears them. No records are deleted.',
      steps: ['Fill material, Parma and required Dual Sourcing Yes/No in the template', 'Existing target Parma is skipped; for a new supplier, Yes retains other Fix/MRP and No clears them', 'Confirm and run with Excel open or closed; review results in Excel. Errors are shown directly in a popup']
    },
    'mm02-sub-commodity': {
      title: 'Automatically Update Material Sub-commodity in Batch',
      shortTitle: 'Batch Update Sub-commodity',
      description: 'Upload Material and the new six-digit Sub-commodity. The Hub updates only that classification value in SAP and gives you a separate Excel result.',
      permissionNotice: 'Requires SAP GUI Scripting and permission to change material classification (MM02).',
      steps: ['Download the template and fill Material and the six-digit Sub-commodity', 'Save and upload the file, then review the materials and codes', 'Leave an idle window open at SAP Easy Access in Production 949, confirm the update, then open the result']
    }
  },
  'zh-CN': {
    'create-rfq': {
      title: '在 NPL 中自动批量创建 Buyer Receipt 和 RFQ',
      shortTitle: '批量创建 Buyer Receipt / RFQ',
      description: '上传一份 Excel 模板，系统自动查询 NPL 物料，按工厂、项目和供应商分组，批量创建 Buyer Receipt 和 RFQ，并将结果回写 Excel。',
      steps: ['下载模板，填写物料、项目及供应商等信息', '上传并核对自动分组，每份 RFQ 最多包含 50 个物料', '确认 SAP 系统后开始批量创建，在结果文件中查看 RFQ 编号']
    },
    'me12-lead-time': {
      title: '批量维护采购信息记录（IR）',
      shortTitle: '批量维护采购信息记录',
      permissionNotice: '需要权限：请确认已开通 SAP ME12 采购信息记录修改权限；如无权限，请联系 Key User 或 IT。',
      description: '按采购信息记录分别更新 SLT、PDT 和确认控制码。默认处理标准和寄售两种类型，分别将结果写回 Excel。',
      steps: ['填写信息记录号，每行至少填写一项修改', '上传并核对预览、工厂、采购组织和采购类型', '如有提示，选择证书；执行后在 Excel 中查看两种采购类型的结果']
    },
    'apqp-plan-closure': {
      title: 'APQP 日期管理',
      shortTitle: 'APQP 日期管理',
      description: '按项目和负责人查找 APQP，在正式 949 更新四个计划日期。也可用 Excel 批量查询计划关闭日期，此查询不修改 SAP。',
      steps: ['选择查找 APQP 并编辑日期，或批量查询计划关闭日期', '核对项目和负责人 User ID，或上传 Excel 查询模板', '仅保存需要修改的计划日期，或在 Excel 查看只读查询结果']
    },
    'me01-source-list': {
      title: '自动批量 Source List 维护',
      shortTitle: '自动批量 Source List 维护',
      description: '上传物料、Supplier Parma 和是否双供（Yes/No）。目标供应商已存在则跳过且不修改；不存在则新增并勾选 Fix、MRP 填 1。Yes 保留其他 Fix/MRP，No 清空其他标识，不删除记录。',
      steps: ['填写模板中的物料、Parma 和必填的是否双供 Yes/No', '目标 Parma 已存在则跳过；新增供应商时，Yes 保留其他 Fix/MRP，No 清空其他标识', 'Excel 可以保持打开；确认执行后查看结果，遇到无法继续的错误会直接弹窗提示']
    },
    'mm02-sub-commodity': {
      title: '自动批量修改物料 Sub-commodity',
      shortTitle: '批量修改 Sub-commodity',
      description: '上传物料号和新的 6 位 Sub-commodity，Hub 只更新对应的 SAP 分类字段，并单独生成 Excel 结果。',
      permissionNotice: '需要 SAP GUI Scripting 和 MM02 物料分类修改权限。',
      steps: ['下载模板，填写物料号和 6 位 Sub-commodity', '保存并上传 Excel，核对物料和目标代码', '在正式 949 保留一个停在 SAP 首页的空闲窗口，确认执行后打开结果']
    }
  }
}

export type PurchasingOperation = keyof typeof copy.en

export function operationCopy(operation: PurchasingOperation, language: AppLanguage): OperationCopy {
  return copy[language][operation]
}
