export class BrowserSlotManager {
  private readonly occupiedSlots = new Set<number>()

  acquire(maximumSlots: number): number | null {
    if (this.occupiedSlots.size >= maximumSlots) {
      return null
    }
    for (let slot = 1; slot <= maximumSlots; slot += 1) {
      if (!this.occupiedSlots.has(slot)) {
        this.occupiedSlots.add(slot)
        return slot
      }
    }
    return null
  }

  release(slot: number): void {
    this.occupiedSlots.delete(slot)
  }
}
