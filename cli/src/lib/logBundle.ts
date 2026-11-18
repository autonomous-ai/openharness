import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { REMOVALS_FILE } from './signOut.js'
import { writeZip, type ZipEntry } from './zipWriter.js'

/**
 * The file a person sends when the dial got stuck: the last week of every log this product writes, in
 * one zip, secrets, email addresses and the home folder blanked.
 *
 *   app-YYYYMMDD.log, cli-YYYYMMDD.log   the desktop app's own log and its CLI transcript
 *   dial-YYYYMMDD.log                    the dial's console + the daemon's cable events (dialLog.ts),
 *                                        and usb-<serial>/dial-YYYYMMDD.log, one folder per device
 *   harness-device/app-YYYYMMDD.log      the Harness menu-bar app's own log
 *   harness.log (tail)                   the daemon's console — the last few MB, which is where today is
 *   sign-in-removals.log                 the last 20 sign-in removals, kept apart from harness.log (signOut.ts)
 *   status.txt                           what the status commands printed, as the caller ran them
 *   README.txt                           when, which versions, what was included
 *
 * Shared by `harness logs export`, the desktop app's Settings ▸ Debug button and the menu-bar app's Export logs,
 * so the three produce the same bundle; both apps run this through the CLI rather than carrying a second copy.
 */
export interface LogBundleOptions {
  /** `~/.harness/logs` — the dated files. */
  logsDir: string
  /** `~/.harness/cli/data` — where `harness.log` is. */
  dataDir: string
  /** Days of dated logs to include, counting today. Default 7. */
  days?: number
  /** How much of the end of `harness.log` to take. Default 5 MB. */
  harnessLogTailBytes?: number
  /** Most bytes of devices' dial logs, newest day first across every device. Default 20 MB. */
  deviceLogCapBytes?: number
  now?: Date
  version: string
  /** Free text for the README — `harness status` output, the app's version, anything else known. */
  notes?: string[]
  /** Runs over every text file but the README before it is written, then `blankPersonal`. */
  redact: (text: string) => string
  /** The person's home folder (`os.homedir()`): written `~` in every text file of the bundle, the README too. */
  home: string
  /** The menu-bar app's log folder. Only its `app-YYYYMMDD.log` files in the window are read. */
  deviceAppLogsDir?: string
  /** The text of `status.txt`. No file without it. */
  status?: string
}

const DATED = /^(app|cli|dial)-(\d{8})\.log$/
const DEVICE_DIR = /^usb-[A-Za-z0-9_-]+$/
const DEVICE_APP_LOG = /^app-(\d{8})\.log$/
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/
const DOMAIN = /[A-Za-z0-9.-]+\.[A-Za-z]{2,}/y

/**
 * Blanks what the menu-bar app's own rule for an email address matches (`log.rs`), its local part held to the 64
 * characters an address allows: `/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g`, with the same output.
 * That regex in JavaScript tries every start of a run against it: unbounded, 100 KB of base64 or hex took 20 s; held to
 * 64, a 20 MB run (a device's day) took 4.4 s, and 9.3 s with an `@` before a 20 MB domain. So each `@` is found once,
 * its local part read back at most 64 characters and its domain matched once: 20 MB in under 0.2 s.
 */
function blankEmails(text: string): string {
  let out = '', from = 0
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    let start = at
    while (start > Math.max(from, at - 64) && LOCAL_CHAR.test(text[start - 1])) start--
    if (start === at) continue
    DOMAIN.lastIndex = at + 1
    if (!DOMAIN.test(text)) continue
    out += text.slice(from, start) + '<email>'
    from = DOMAIN.lastIndex
  }
  return out + text.slice(from)
}

/** Steps 2 and 3 of the bundle's blanking, after `redact`: email addresses, then the home folder. */
export function blankPersonal(text: string, home: string): string {
  const emailsBlanked = blankEmails(text)
  const folder = home.replace(/[\\/]+$/, '')
  // A root holds every path: it names no one, and blanking it would hide where each file is.
  if (!folder || /^[A-Za-z]:$/.test(folder)) return emailsBlanked
  // A log written as JSON doubles each `\` of a Windows home.
  const spellings = [...new Set([folder.replaceAll('\\', '\\\\'), folder])]
  const literal = spellings.map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  // The home as a whole folder, as `home_rule` in the menu-bar app's `log.rs`: `/Users/al` leaves `/Users/alice` alone.
  // It ends where a character no folder name holds follows, or the text ends, after any dots that end a sentence.
  return emailsBlanked.replace(new RegExp(`(?:${literal})(?=\\.*(?:[^A-Za-z0-9_.-]|$))`, 'g'), '~')
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** `harness-logs-YYYYMMDD-HHMM.zip` — sortable, and says what it is in Finder. */
export function bundleFileName(now: Date): string {
  return `harness-logs-${ymd(now)}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}.zip`
}

function readTail(path: string, bytes: number): Buffer {
  const size = statSync(path).size
  const from = Math.max(0, size - bytes)
  const fd = openSync(path, 'r')
  try {
    const out = Buffer.alloc(size - from)
    readSync(fd, out, 0, out.length, from)
    return out
  } finally {
    closeSync(fd)
  }
}

/** The bundle as bytes, plus what went into it — for the README and for the caller's own message. */
export function buildLogBundle(opts: LogBundleOptions): { zip: Buffer; included: string[] } {
  const now = opts.now ?? new Date()
  const days = opts.days ?? 7
  const cutoff = ymd(new Date(now.getTime() - (days - 1) * 86_400_000))
  const entries: ZipEntry[] = []
  const included: string[] = []
  const blank = (text: string) => blankPersonal(opts.redact(text), opts.home)

  if (opts.status !== undefined) {
    entries.push({ name: 'status.txt', data: Buffer.from(blank(opts.status)), mtime: now })
    included.push('status.txt')
  }

  let names: string[] = []
  try { names = readdirSync(opts.logsDir).sort() } catch { /* no logs directory yet */ }
  // Each device's dial logs are in a folder of their own, `usb-<serial>/` (cableFleet.ts). Reading only the top
  // level left a user's Harness Pro console out of the bundle sent about it stuck silent (20-26 Oct).
  names = names.flatMap((name) => {
    if (!DEVICE_DIR.test(name)) return [name]
    try { return readdirSync(join(opts.logsDir, name)).sort().filter((f) => f.startsWith('dial-')).map((f) => `${name}/${f}`) } catch { return [] }
  })
  // A device's day may be 20 MB (dialLog.ts) and a desk may hold several, so their logs share one cap. Every device keeps
  // its newest day, as its tail when that does not fit: counting whole files once left out every device's logs when one
  // day was 20 MB and the line that says so. Older days follow, newest first, while there is room.
  const cap = opts.deviceLogCapBytes ?? 20 * 1024 * 1024
  const dayOf = (name: string) => DATED.exec(basename(name))?.[2] ?? ''
  const sizeOf = (name: string) => { try { return statSync(join(opts.logsDir, name)).size } catch { return 0 } }
  const deviceDays = names.filter((n) => n.includes('/') && dayOf(n) >= cutoff).sort((x, y) => dayOf(y).localeCompare(dayOf(x)))
  // deviceDays is newest first; reversed, each folder's newest day is the last one written into the map.
  const newestPerDevice = [...new Map([...deviceDays].reverse().map((n) => [n.split('/')[0], n])).values()]
  /** Bytes to take from the end of each device log; 0 leaves it out. */
  const take = new Map<string, number>()
  let room = cap
  newestPerDevice.sort((x, y) => sizeOf(x) - sizeOf(y)).forEach((name, i, all) => {
    const share = Math.min(sizeOf(name), Math.floor(room / (all.length - i)))
    take.set(name, share)
    room -= share
  })
  for (const name of deviceDays) {
    if (take.has(name)) continue
    const size = sizeOf(name)
    take.set(name, size <= room ? size : 0)
    if (size <= room) room -= size
  }
  for (const name of names) {
    const m = DATED.exec(basename(name))
    if (!m || m[2] < cutoff) continue
    const bytes = take.get(name)
    if (bytes === 0) { included.push(`${name} (left out to keep the bundle small)`); continue }
    const path = join(opts.logsDir, name)
    try {
      const whole = bytes === undefined || bytes >= statSync(path).size
      const text = whole ? readFileSync(path, 'utf8') : readTail(path, bytes).toString('utf8')
      entries.push({ name: `logs/${name}`, data: Buffer.from(blank(text)), mtime: statSync(path).mtime })
      included.push(whole ? name : `${name} (last ${Math.round(bytes / 1024)} KB)`)
    } catch { /* unreadable: skipped, said in the README below */ }
  }

  // Only the app's dated logs, and only files: its folder also holds what the app keeps, and a link could point anywhere.
  const appDir = opts.deviceAppLogsDir
  if (appDir) {
    let files: string[] = []
    try { files = readdirSync(appDir, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name).sort() } catch { /* the menu-bar app never ran here */ }
    for (const file of files) {
      const m = DEVICE_APP_LOG.exec(file)
      if (!m || m[1] < cutoff) continue
      const path = join(appDir, file)
      try {
        entries.push({ name: `logs/harness-device/${file}`, data: Buffer.from(blank(readFileSync(path, 'utf8'))), mtime: statSync(path).mtime })
        included.push(`harness-device/${file}`)
      } catch { /* unreadable: skipped, said in the README below */ }
    }
  }

  const harnessLog = join(opts.dataDir, 'harness.log')
  try {
    const tail = readTail(harnessLog, opts.harnessLogTailBytes ?? 5 * 1024 * 1024)
    const text = tail.toString('utf8')
    entries.push({ name: 'harness.log', data: Buffer.from(blank(text)), mtime: statSync(harnessLog).mtime })
    included.push(`harness.log (last ${Math.round(tail.length / 1024)} KB)`)
  } catch { /* no daemon log */ }

  // Kept apart because harness.log's trim can take its line (anh Dee's Mac, 2026-11-12): small and whole.
  const removals = join(opts.dataDir, REMOVALS_FILE)
  try {
    entries.push({ name: REMOVALS_FILE, data: Buffer.from(blank(readFileSync(removals, 'utf8'))), mtime: statSync(removals).mtime })
    included.push(REMOVALS_FILE)
  } catch { /* no removal yet */ }

  const readme = [
    `Harness log bundle`,
    `exported: ${now.toISOString()}`,
    `cli: v${opts.version}`,
    `window: last ${days} day${days === 1 ? '' : 's'} (from ${cutoff})`,
    ...(opts.notes ?? []),
    ``,
    `included:`,
    ...(included.length ? included.map((n) => `  ${n}`) : ['  (nothing — no logs were found)']),
    ``,
    `Blanked before writing: secrets (tokens, keys, passwords, signed URLs), email addresses (<email>) and the home folder (~).`,
    `Never included: conversations and transcripts, prompts, voice, tokens, keys, passwords and sign-in files, any process's environment, project files.`,
    'status.txt: what `harness status` and `harness device claude|codex|vscode status --json` printed.',
    `logs/harness-device/: the Harness menu-bar app's own log.`,
    'The dial\'s firmware version is in harness.log: the `fw` on the `cable: dial … on fw …` line of each dial greeting.',
    `dial-*.log: the dial's own console (I/W/E lines, ticks since boot) interleaved with the daemon's`,
    `[daemon] cable events. 'alive up=' once a minute is the UI task's heartbeat; a gap in it while`,
    `[daemon] lines continue is a wedged UI task. 'boot: reset reason' after a session-up says why the`,
    `dial last rebooted; 'last:' lines are its log from just before a crash.`,
  ].join('\n')
  entries.unshift({ name: 'README.txt', data: Buffer.from(blankPersonal(readme, opts.home) + '\n'), mtime: now })

  return { zip: writeZip(entries), included }
}
