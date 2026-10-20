import { join } from 'node:path'
import { env } from '../config/env.js'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import { DIAL_PRODUCT_ID, DIAL_VENDOR_ID, findDialPorts, type DialPort } from '../cable/serial.js'

export interface FlashRecoveryDeps {
  findPorts: () => Promise<DialPort[]>
  stopDiscovery: () => void
  verdictFile: string
}

/** Reconsider only the board just written, even when USB kept the same attachment across the flash. */
export async function completeFlash(port: string, overrides?: FlashRecoveryDeps): Promise<void> {
  const deps = overrides ?? {
    findPorts: findDialPorts,
    stopDiscovery: (await import('../cable/windowsSerial.js')).windowsDialWatch().stop,
    verdictFile: join(env.ADAPTER_DATA_DIR, 'dial-ports.json'),
  }
  // The daemon's watch deliberately unrefs its child, pipes and first-read deadline. This short-lived
  // CLI must stay alive until that asynchronous snapshot arrives and the persisted verdict is saved.
  const lifetime = setInterval(() => {}, 60_000)
  try {
    if (!/^COM[1-9]\d{0,2}$/i.test(port)) throw new Error('flash completion needs a COM port')
    // Discovery reads the native watch; it never opens, probes or resets a serial port.
    const ports = await deps.findPorts()
    const selected = ports.filter(candidate => candidate.path.toUpperCase() === port.toUpperCase())
    const key = (candidate: DialPort) => (candidate.serialNumber ?? candidate.path).toUpperCase()
    if (selected.length !== 1 || !selected[0].serialNumber?.trim()
      || selected[0].vendorId !== DIAL_VENDOR_ID || selected[0].productId !== DIAL_PRODUCT_ID
      || ports.filter(candidate => key(candidate) === key(selected[0])).length !== 1) {
      throw new Error('could not uniquely identify the flashed board')
    }
    new DialVerdicts(deps.verdictFile).clear(selected[0])
    // DialVerdicts also serves the long-running daemon and tolerates a failed save there. This hook
    // must not report recovery when the next daemon would still load the persisted foreign verdict.
    if (new DialVerdicts(deps.verdictFile).isForeign(selected[0])) throw new Error('could not save flashed board recovery')
  } finally {
    try { deps.stopDiscovery() } finally { clearInterval(lifetime) }
  }
}
