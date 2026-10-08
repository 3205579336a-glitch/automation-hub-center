import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AutomationInteraction, InteractionResponse } from '../../shared/automation-interaction'
import type { GuidedAutomationService } from '../services/guided-automation-service'

export interface GuidanceContext { service: GuidedAutomationService; runId: string }
export class NativeInteractionBridge {
  private responded = new Set<string>()
  constructor(private readonly guidance: GuidanceContext, private readonly child: ChildProcessWithoutNullStreams) {}
  async handle(event: { event?: string; interaction?: AutomationInteraction; requestId?: string }): Promise<void> {
    const { service, runId } = this.guidance
    if (event.event === 'interaction' && event.interaction) {
      const request = event.interaction
      if (request.runId !== runId || !/^[a-zA-Z0-9-]{1,100}$/.test(request.requestId)) throw new Error('Invalid engine interaction.')
      await service.publish(request, async (input: InteractionResponse) => {
        if (input.action === 'continue' && this.responded.has(input.requestId)) return false
        if (this.child.stdin.destroyed) return false
        this.responded.add(input.requestId)
        await new Promise<void>((resolve, reject) => this.child.stdin.write(JSON.stringify(input) + '\n', error => error ? reject(error) : resolve()))
        return true
      })
    } else if (event.event === 'recovering' && event.requestId) await service.change(event.requestId, 'RECOVERING')
    else if (event.event === 'interaction-resolved' && event.requestId) service.clear(event.requestId)
  }
}
