import type { RfqBatchConfig, RfqExcelPreview } from '../../shared/rfq-batch-types'
import type { RfqNativeRunner } from '../automation/rfq-native-runner'

// One validation source of truth: the supplied Python RFQ engine.
export class RfqExcelService {
  constructor(private readonly runner: RfqNativeRunner) {}
  preview(config: RfqBatchConfig): Promise<RfqExcelPreview> {
    return this.runner.preview(config)
  }
}
