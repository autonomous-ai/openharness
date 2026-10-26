// What this computer has learned about the USB boards that are not dials.
//
// Every ESP32-S3 shares one USB id, so the daemon cannot tell a dial from a developer's own board
// without opening the port and listening. It does that ONCE, writes down the answer, and leaves the
// board alone after that. The record outlives the daemon, which restarts often, so the answer does not
// cost another probe each time. It stops holding when the board is unplugged (a new attachment,
// DialPort.session), when someone worked on it and let go (the fleet clears it: a flash is exactly how a
// board becomes a dial, and a reset over USB-Serial/JTAG does NOT change the attachment, measured), or
// when it gets old. A board that once greeted as a dial is remembered as one and never judged foreign
// again: a dial rebooting while the daemon restarts is silent too, and a verdict then strands it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DialPort } from './serial.js'

/** A verdict about an attachment we can identify holds this long: the safety net for a board that
 *  changed without its USB attachment changing and without anyone being seen working on it. */
const KNOWN_FOR_MS = 6 * 60 * 60_000
/** A verdict about a port with no attachment identity is only a pause, since nothing says when it changes. */
const UNKNOWN_FOR_MS = 10 * 60_000

/** `board`: what a dial's greeting named it (`hello.board`), "pro" for a Harness Pro; absent for a round dial. */
interface Verdict { session?: string; at: number; dial?: true; board?: string }

const keyOf = (port: DialPort) => (port.serialNumber ?? port.path).toUpperCase()

export class DialVerdicts {
  private readonly foreign = new Map<string, Verdict>()

  constructor(private readonly file?: string, private readonly now: () => number = Date.now) {
    if (!file || !existsSync(file)) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      for (const [key, value] of Object.entries(raw)) {
        const v = value as Partial<Verdict> | null
        if (v && typeof v.at === 'number') this.foreign.set(key, { at: v.at, ...(typeof v.session === 'string' ? { session: v.session } : {}), ...(v.dial === true ? { dial: true as const } : {}), ...(typeof v.board === 'string' ? { board: v.board } : {}) })
      }
    } catch { /* unreadable: start with no opinions, and rewrite it on the next verdict */ }
  }

  /** Was this very attachment of this board already found not to be a dial? */
  isForeign(port: DialPort): boolean {
    const verdict = this.foreign.get(keyOf(port))
    if (!verdict || verdict.dial) return false
    const age = this.now() - verdict.at
    if (verdict.session === undefined || port.session === undefined) return age < UNKNOWN_FOR_MS
    return verdict.session === port.session && age < KNOWN_FOR_MS
  }

  /** Forget the verdict: somebody worked on this board since it was made. */
  clear(port: DialPort): void {
    if (this.foreign.get(keyOf(port))?.dial) return
    if (this.foreign.delete(keyOf(port))) this.save()
  }

  /** This board greeted as a dial: it is one, whatever a later silence looks like. `board` is its hello's. */
  markDial(port: DialPort, board?: string): void {
    const known = this.foreign.get(keyOf(port))
    if (known?.dial && (!board || known.board === board)) return
    const kept = board ?? known?.board
    this.foreign.set(keyOf(port), { at: this.now(), dial: true, ...(kept ? { board: kept } : {}) })
    this.save()
  }

  /** Did this board greet as a Harness Pro? The one board the fleet may reset over the cable (cableFleet.ts). */
  isPro(port: DialPort): boolean {
    const known = this.foreign.get(keyOf(port))
    return known?.dial === true && known.board === 'pro'
  }

  markForeign(port: DialPort): void {
    if (this.foreign.get(keyOf(port))?.dial) return
    this.foreign.set(keyOf(port), { at: this.now(), ...(port.session ? { session: port.session } : {}) })
    this.save()
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.foreign)))
      renameSync(tmp, this.file)
    } catch { /* a verdict that cannot be saved is still in memory for this run */ }
  }
}
