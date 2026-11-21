import { boundedJsonBytes } from '../boundedJsonBytes.js'

/** Encoded retained payload, not an estimate of JavaScript heap usage. */
const BYTES = 16 * 1024 * 1024
const ENTRIES = 100

/** Accounting only: the existing focus/notice promise chain remains its sole work owner. */
export class DeviceWorkBudget {
  private count = 0
  private bytes = 0

  reserve(payload: unknown): (() => void) | null {
    if (this.count >= ENTRIES) return null
    const bytes = boundedJsonBytes(payload, BYTES - this.bytes)
    if (bytes === null) return null
    this.count++; this.bytes += bytes
    let held = true
    return () => {
      if (!held) return
      held = false; this.count--; this.bytes -= bytes
    }
  }
}
