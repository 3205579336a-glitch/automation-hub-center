import type { AutomationState } from '../../../../shared/guided-automation'

export function stateLabel(state: AutomationState, zh: boolean): string {
  const labels: Record<AutomationState, [string, string]> = {
    READY: ['Ready', '等待上传'], VALIDATING: ['Validating file…', '正在校验文件…'], READY_TO_START: ['Ready to start', '可以开始'],
    RUNNING: ['Running', '运行中'], WAITING_FOR_USER: ['Paused — waiting for you', '已暂停，等待处理'], RECOVERING: ['Checking SAP…', '正在验证 SAP…'],
    COMPLETED: ['Completed', '已完成'], COMPLETED_WITH_WARNINGS: ['Completed with warnings', '已完成，部分记录需检查'], FAILED: ['Could not complete', '未能完成'], CANCELLED: ['Stopped', '已停止']
  }
  return labels[state][zh ? 1 : 0]
}
