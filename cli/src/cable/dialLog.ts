import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The dial's log, as a file somebody can send.
 *
 * The dial has one USB port and no flash log of its own: every `ESP_LOG` line it prints is framed over
 * the cable (type 0x04) and this is where it lands. The daemon's own `cable:` events go into the SAME
 * file, prefixed `[daemon]`, so a report reads end to end from one place — what the device said beside
 * what the desk did to it (opened the port, pushed a focus, saw silence).
 *
 * One file per day, `dial-YYYYMMDD.log`, in `~/.harness/logs` — the directory the desktop app already
 * keeps its own `app-*.log`/`cli-*.log` in and exports from. Days older than `retainDays` are deleted
 * on the first write after midnight; a day past `maxBytesPerDay` gets one `capped` line and then
 * nothing, so a firmware stuck in a log loop cannot fill the disk.
 *
 * Firmware lines keep their own `I (ticks) tag:` prefix beside the wall time, so a reboot shows as
 * ticks going back to zero. The firmware's 60s `alive` heartbeat is watched here too: cable lines
 * continuing while that one stops is what a wedged LVGL task looks like, and its ABSENCE is the
 * evidence, so this marks the gap in the file rather than leaving it to be inferred.
 */
export interface DialLogOptions {
  /** Days of `dial-*.log` to keep. Default 7. */
  retainDays?: number
  /** Bytes per day before the file is capped. Default 20 MB. */
  maxBytesPerDay?: number
  /** How long without an `alive` line from the dial before the gap is marked. Default 90s. */
  heartbeatGapMs?: number
  /** Wall clock, for tests. */
  now?: () => number
}

/** The firmware's liveness line — `ui/habitat/display_habitat.c` prints one a minute. */
const HEARTBEAT = /\balive up=/

export class DialLog {
  private readonly retainDays: number
  private readonly maxBytesPerDay: number
  private readonly heartbeatGapMs: number
  private readonly now: () => number

  private day: string | null = null
  private bytesToday = 0
  private capped = false
  /** Writes are chained so lines land in the order they were logged, and so tests can `flush()`. */
  private chain: Promise<void> = Promise.resolve()

  private lastHeartbeat: number | null = null
  private gapMarked = false

  constructor(readonly dir: string, opts: DialLogOptions = {}) {
    this.retainDays = opts.retainDays ?? 7
    this.maxBytesPerDay = opts.maxBytesPerDay ?? 20 * 1024 * 1024
    this.heartbeatGapMs = opts.heartbeatGapMs ?? 90_000
    this.now = opts.now ?? Date.now
  }

  /** `dial-YYYYMMDD.log` for a moment, in local time like the app's own files. */
  static fileName(at: number | Date): string {
    const d = new Date(at)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `dial-${y}${m}${day}.log`
  }

  /** The file the next line would land in. */
  get currentPath(): string {
    return join(this.dir, DialLog.fileName(this.now()))
  }

  /** A line the dial printed, verbatim. */
  device(line: string): void {
    if (HEARTBEAT.test(line)) this.heartbeat()
    this.write(line)
  }

  /** Something the daemon did to, or saw from, the dial. */
  daemon(line: string): void {
    this.write(`[daemon] ${line}`)
  }

  /**
   * Called on the session's tick while the port is open. Marks a missing heartbeat once, and again
   * when it comes back; a closed port resets the watch, since a dial that is not there owes no beat.
   */
  tick(connected: boolean): void {
    if (!connected) {
      this.lastHeartbeat = null
      this.gapMarked = false
      return
    }
    if (this.lastHeartbeat === null || this.gapMarked) return
    const gap = this.now() - this.lastHeartbeat
    if (gap >= this.heartbeatGapMs) {
      this.gapMarked = true
      this.daemon(`no dial heartbeat for ${Math.round(gap / 1000)}s — the cable is up, the UI task may be wedged`)
    }
  }

  /**
   * The dial greeted — a fresh boot, or a reconnect. Its first `alive` comes a minute after boot, so the
   * watch restarts from now rather than from the last beat of the previous boot; without this an OTA
   * reboot (port never closed, ticks back to zero) read as "no heartbeat for 90s" every time.
   */
  greeted(): void {
    this.lastHeartbeat = this.now()
    this.gapMarked = false
  }

  /** Every queued write has reached the file. */
  flush(): Promise<void> {
    return this.chain
  }

  private heartbeat(): void {
    const now = this.now()
    if (this.gapMarked && this.lastHeartbeat !== null) {
      this.daemon(`dial heartbeat back after ${Math.round((now - this.lastHeartbeat) / 1000)}s`)
    }
    this.gapMarked = false
    this.lastHeartbeat = now
  }

  private write(text: string): void {
    const at = this.now()
    const file = DialLog.fileName(at)
    const rolled = file !== this.day
    if (rolled) {
      this.day = file
      this.bytesToday = 0
      this.capped = false
    }
    if (this.capped) return
    const line = `${new Date(at).toISOString()} ${text}\n`
    this.bytesToday += Buffer.byteLength(line)
    let out = line
    if (this.bytesToday > this.maxBytesPerDay) {
      this.capped = true
      out = `${new Date(at).toISOString()} [daemon] dial log capped for today at ${this.maxBytesPerDay} B — dropping the rest\n`
    }
    const path = join(this.dir, file)
    this.chain = this.chain
      .then(async () => {
        await mkdir(this.dir, { recursive: true })
        if (rolled) await this.prune(at)
        await appendFile(path, out)
      })
      .catch(() => {})
  }

  /** Delete `dial-*.log` files older than `retainDays` before `at`. Best effort. */
  private async prune(at: number): Promise<void> {
    if (this.retainDays <= 0) return
    const cutoff = DialLog.fileName(at - this.retainDays * 86_400_000)
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!/^dial-\d{8}\.log$/.test(name) || name >= cutoff) continue
      await unlink(join(this.dir, name)).catch(() => {})
    }
  }
}
