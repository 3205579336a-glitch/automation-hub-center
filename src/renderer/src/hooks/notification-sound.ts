import type { NotificationKind } from '../types/notifications'

let audio: AudioContext | undefined
let enabled = true
export function setNotificationSoundsEnabled(value: boolean): void { enabled = value }
/** Unlock audio in the Run/Preview click, before a long async SAP read completes. */
export function prepareNotificationAudio(): void {
  if (!enabled) return
  try { audio ??= new AudioContext(); void audio.resume().catch(() => undefined) } catch { /* Optional audio. */ }
}
export function playNotificationSound(kind: NotificationKind): void {
  if (!enabled || kind === 'info') return
  try {
    audio ??= new AudioContext()
    const context = audio
    void context.resume().then(() => {
      const tones = kind === 'success' ? [523, 659, 784] : kind === 'warning' ? [660, 440] : [330, 220]
      tones.forEach((frequency, index) => {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        const start = context.currentTime + index * 0.16
        oscillator.frequency.value = frequency
        gain.gain.setValueAtTime(0.035, start)
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start(start)
        oscillator.stop(start + 0.15)
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
      })
    }).catch(() => undefined)
  } catch { /* Audio is optional and must never affect automation. */ }
}
