import type { IpcMainInvokeEvent } from 'electron'

export function isTrustedRenderer(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url ?? ''
  return frameUrl.startsWith('file://') || frameUrl.startsWith('http://localhost:')
}
