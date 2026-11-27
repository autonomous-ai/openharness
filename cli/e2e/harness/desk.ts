/**
 * The dials on a desk, for the end-to-end suite: fake dials on pseudo-terminals (fakeDial.ts) that a daemon
 * finds where `HARNESSD_TEST_DIAL_PORT` points, a file it reads at every scan (cable/cableFleet.ts), so a
 * test can plug several in and unplug them. And the devices' processes a daemon's master started.
 */
import { writeFileSync } from 'node:fs'
import type { LocalClient } from './client.js'
import { until, type IsolatedDaemon } from './daemon.js'
import { FakeDial } from './fakeDial.js'

/** What a dial says its settings are when it greets. */
export const SETTINGS = { brightness: 60, character: 0, face: 466, muted: false, quiet: false, straightTitle: false, focusFace: false, scrollReversed: false, round: true, voiceLang: 'en' }

/** This daemon's devices processes: started by its own master, by the pid it logged, and still its child. */
export function devicesPids(d: IsolatedDaemon): number[] {
  return d.servicePids('devices')
}
/** Until the daemon reads that dial as unplugged: an answer with a status and no attached row of it. The fleet shows
 *  `attached: false` only from the port's close to its next 2 s scan, which drops a dial no longer in `dials.json`, so
 *  absent is unplugged too (`cable.isConnected` is false either way). */
export async function untilUnplugged(window: LocalClient, serial: string): Promise<void> {
  await until('the dial to read as unplugged', async () => {
    const answer = await window.request('harness_devices_list', {})
    const devices = answer.status?.devices as Array<{ id: string; attached: boolean }> | undefined
    return (devices && !devices.some((device) => device.id === serial && device.attached)) || null
  }, 30_000, 500)
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
  /** Takes the dial off the file and leaves it open, so a test can choose whether the daemon's scan or the dial's
   *  close comes first. */
  forget(serial: string): FakeDial | undefined {
    const dial = this.plugged.get(serial)
    this.plugged.delete(serial)
    this.write()
    return dial
  }
  async unplug(serial: string): Promise<void> {
    await this.forget(serial)?.close()
  }
  async close(): Promise<void> {
    for (const serial of [...this.plugged.keys()]) await this.unplug(serial)
  }
  private write(): void {
    writeFileSync(this.file, JSON.stringify([...this.plugged].map(([serial, dial]) => ({ serial, path: dial.path }))))
  }
}

