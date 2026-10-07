/**
 * The dials on a desk, for the end-to-end suite: fake dials on pseudo-terminals (fakeDial.ts) that a daemon
 * finds where `HARNESSD_TEST_DIAL_PORT` points, a file it reads at every scan (cable/cableFleet.ts), so a
 * test can plug several in and unplug them. And the devices' processes a daemon's master started.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import type { IsolatedDaemon } from './daemon.js'
import { FakeDial } from './fakeDial.js'

/** What a dial says its settings are when it greets. */
export const SETTINGS = { brightness: 60, character: 0, face: 466, muted: false, quiet: false, straightTitle: false, focusFace: false, scrollReversed: false, round: true, voiceLang: 'en' }

/** This daemon's devices processes, by the pids its master logged: `harnessd-devices` alone would match every
 *  daemon's on the machine, another file's in a parallel run. */
export function devicesPids(d: IsolatedDaemon): number[] {
  const ours = new Set([...d.log().matchAll(/\[harnessd\] service devices started \(pid (\d+)\)/g)].map((match) => Number(match[1])))
  const table = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
  return table.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, pid, command]) => command.trim() === 'harnessd-devices' && ours.has(Number(pid))).map(([, pid]) => Number(pid))
}
/** The dials this daemon finds, written where its discovery reads them at every scan. */
export class Desk {
  constructor(readonly file: string, private readonly plugged = new Map<string, FakeDial>()) {}
  async plug(serial: string, mac: string): Promise<FakeDial> {
    const dial = await FakeDial.open({ mac, settings: SETTINGS })
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

