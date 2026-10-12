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
      title: 'Automatically Query APQP Plan Close Dates in Batch',
      shortTitle: 'Batch Query APQP Close Dates',
      description: 'Upload materials and supplier codes to query their APQP plan close dates and write them back to Excel. This is a read-only SAP query; no SAP data is changed.',
      steps: ['Download the template and fill materials and supplier codes', 'Upload and review the records to query', 'Start the batch query and open the result file to see dates and row statuses']
    },
    'me01-source-list': {
      title: 'Automatically Maintain Source Lists in Batch',
      shortTitle: 'Batch Source List Maintenance',
      description: 'Upload materials, Supplier Parma and Dual Sourcing (Yes/No). The target source is added or reused with Fix and MRP 1. Yes keeps other Fix/MRP; No clears them. Existing records and dates are retained.',
      steps: ['Fill material, Parma and required Dual Sourcing Yes/No in the template', 'Review dates, purchasing organization and Yes/No; No clears other Fix/MRP on all rows', 'Confirm and run; open Excel to review results. Duplicate/overlapping target rows pause without replaying Save']
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
      title: '自动批量查询 APQP 计划关闭日期',
      shortTitle: '批量查询 APQP 关闭日期',
      description: '上传物料和供应商代码，系统自动批量查询 APQP 计划关闭日期并回写 Excel。仅查询，不修改 SAP 数据。',
      steps: ['下载模板，填写物料和供应商代码', '上传并核对待查询清单', '开始批量查询，打开结果文件查看日期及每行状态']
    },
    'me01-source-list': {
      title: '自动批量 Source List 维护',
      shortTitle: '自动批量 Source List 维护',
      description: '上传物料、Supplier Parma 和是否双供（Yes/No）。自动新增或复用目标货源，勾选 Fix、MRP 填 1。Yes 保留其他 Fix/MRP，No 清空其他标识；保留所有记录及日期。',
      steps: ['填写模板中的物料、Parma 和必填的是否双供 Yes/No', '核对有效期、采购组织及双供选择；No 清空所有其他行 Fix/MRP', '确认执行后查看 Excel 结果；目标重复或有效期重叠时暂停，不重复保存']
    }
  }
}

export type PurchasingOperation = keyof typeof copy.en

export function operationCopy(operation: PurchasingOperation, language: AppLanguage): OperationCopy {
  return copy[language][operation]
}
