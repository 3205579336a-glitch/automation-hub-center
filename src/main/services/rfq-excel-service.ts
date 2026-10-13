import type { RfqBatchConfig, RfqExcelPreview } from '../../shared/rfq-batch-types'
import type { RfqNativeRunner } from '../automation/rfq-native-runner'
import { checkRfqTemplateHeaders } from './excel-template-header'

// A cheap header gate precedes the Python engine, which remains the full business-validation source of truth.
export class RfqExcelService {
  constructor(private readonly runner: RfqNativeRunner) {}
  async preview(config: RfqBatchConfig): Promise<RfqExcelPreview> {
    await checkRfqTemplateHeaders(config.excelPath)
    return this.runner.preview(config)
  }
}
