/**
 * The dials on a desk, for the end-to-end suite: fake dials on pseudo-terminals (fakeDial.ts) that a daemon
 * finds where `HARNESSD_TEST_DIAL_PORT` points, a file it reads at every scan (cable/cableFleet.ts), so a
 * test can plug several in and unplug them. And the devices' processes a daemon's master started.
 */
import { writeFileSync } from 'node:fs'
import type { IsolatedDaemon } from './daemon.js'
import { FakeDial } from './fakeDial.js'

/** What a dial says its settings are when it greets. */
export const SETTINGS = { brightness: 60, character: 0, face: 466, muted: false, quiet: false, straightTitle: false, focusFace: false, scrollReversed: false, round: true, voiceLang: 'en' }

/** This daemon's devices processes: started by its own master, by the pid it logged, and still its child. */
export function devicesPids(d: IsolatedDaemon): number[] {
  return d.servicePids('devices')
}
/** The dials this daemon finds, written where its discovery reads them at every scan. */
export class Desk {
  constructor(readonly file: string, private readonly plugged = new Map<string, FakeDial>()) {}
  /** [capabilities]: what its greeting names, as a firmware that speaks them does (`appFilter: 'v1'`, …). */
  async plug(serial: string, mac: string, capabilities?: Record<string, string>): Promise<FakeDial> {
    const dial = await FakeDial.open({ mac, settings: SETTINGS, capabilities })
    this.plugged.set(serial, dial)
    this.write()
    dial.keepGreeting()
    return dial
  }
  async unplug(serial: string): Promise<void> {
    const dial = this.plugged.get(serial)
    this.plugged.delete(serial)
    this.write()
    await dial?.close()
  }
  async close(): Promise<void> {
    for (const serial of [...this.plugged.keys()]) await this.unplug(serial)
  }
  private write(): void {
    writeFileSync(this.file, JSON.stringify([...this.plugged].map(([serial, dial]) => ({ serial, path: dial.path }))))
  }
}

