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
      title: 'Automatically Update Supplier Lead Times (SLT) in Batch',
      shortTitle: 'Batch Update Supplier Lead Times',
      permissionNotice: 'Permission required: SAP ME12 purchasing Info Record change authorization. If unavailable, contact your key user or IT.',
      description: 'Upload your Info Records, set the target lead time in days and update them in batch. Supports standard and consignment purchasing, with a result for each record.',
      steps: ['Download the template and fill Info Records and Plants', 'Upload, select standard or consignment, enter the target lead time and review', 'Confirm the update, start the batch and check each record in the result file']
    },
    'apqp-plan-closure': {
      title: 'APQP Date Management',
      shortTitle: 'APQP Date Management',
      description: 'Find APQPs by NPL and User ID, edit four dates and preview SAP differences. The existing batch plan-closure query remains available. Date writes require QA acceptance before release.',
      steps: ['Choose Find APQPs & Edit Dates or the existing Query Plan Closure Date workflow', 'Find by NPL and User ID, or upload the existing Excel template for the plan-closure query', 'Review date differences without SAP writes; actual date updates remain gated until QA acceptance']
    },
    'me01-source-list': {
      title: 'Automatically Maintain Source Lists in Batch',
      shortTitle: 'Batch Source List Maintenance',
      description: 'Upload materials, Supplier Parma and Dual Sourcing (Yes/No). Existing target suppliers are skipped without changes. Missing suppliers are added with Fix and MRP 1; Yes keeps other Fix/MRP, No clears them. No records are deleted.',
      steps: ['Fill material, Parma and required Dual Sourcing Yes/No in the template', 'Existing target Parma is skipped; for a new supplier, Yes retains other Fix/MRP and No clears them', 'Confirm and run with Excel open or closed; review results in Excel. Errors are shown directly in a popup']
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
      title: '自动批量更新供应商交货时间（SLT）',
      shortTitle: '批量更新供应商交货时间',
      permissionNotice: '需要权限：请确认已开通 SAP ME12 采购信息记录修改权限；如无权限，请联系 Key User 或 IT。',
      description: '上传采购信息记录，设置目标交货天数，系统自动逐条更新。支持标准和寄售采购，完成后可在 Excel 中查看每条记录的结果。',
      steps: ['下载模板，填写采购信息记录和工厂', '上传后选择标准或寄售采购，填写目标交货天数并核对预览', '确认更新后开始批量处理，在结果文件中查看每条记录的结果']
    },
    'apqp-plan-closure': {
      title: 'APQP 日期管理',
      shortTitle: 'APQP 日期管理',
      description: '按 NPL 和 User ID 查找 APQP、编辑四个日期并核对 SAP 差异；也可沿用 Excel 自动批量查询计划关闭日期。日期写入需通过 QA 验证后开放。',
      steps: ['选择查找 APQP 并编辑日期，或原有批量查询计划关闭日期', '按 NPL 和 User ID 查找，或上传原有查询模板', '核对日期差异或打开查询结果；新日期写入需先通过 QA 验证']
    },
    'me01-source-list': {
      title: '自动批量 Source List 维护',
      shortTitle: '自动批量 Source List 维护',
      description: '上传物料、Supplier Parma 和是否双供（Yes/No）。目标供应商已存在则跳过且不修改；不存在则新增并勾选 Fix、MRP 填 1。Yes 保留其他 Fix/MRP，No 清空其他标识，不删除记录。',
      steps: ['填写模板中的物料、Parma 和必填的是否双供 Yes/No', '目标 Parma 已存在则跳过；新增供应商时，Yes 保留其他 Fix/MRP，No 清空其他标识', 'Excel 可以保持打开；确认执行后查看结果，遇到无法继续的错误会直接弹窗提示']
    }
  }
}

export type PurchasingOperation = keyof typeof copy.en

export function operationCopy(operation: PurchasingOperation, language: AppLanguage): OperationCopy {
  return copy[language][operation]
}
