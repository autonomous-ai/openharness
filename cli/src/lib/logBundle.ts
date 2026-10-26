import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeZip, type ZipEntry } from './zipWriter.js'

/**
 * The file a person sends when the dial got stuck: the last week of every log this product writes, in
 * one zip, secrets blanked.
 *
 *   app-YYYYMMDD.log, cli-YYYYMMDD.log   the desktop app's own log and its CLI transcript
 *   dial-YYYYMMDD.log                    the dial's console + the daemon's cable events (dialLog.ts),
 *                                        and usb-<serial>/dial-YYYYMMDD.log, one folder per device
 *   harness.log (tail)                   the daemon's console — the last few MB, which is where today is
 *   README.txt                           when, which version, what was included
 *
 * Shared by `harness logs export` and the desktop app's Settings ▸ Debug button, so the two produce
 * the same bundle; the app runs this through the CLI rather than carrying a second copy.
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
  /** Runs over every text file before it is written. */
  redact: (text: string) => string
}

const DATED = /^(app|cli|dial)-(\d{8})\.log$/
const DEVICE_DIR = /^usb-[A-Za-z0-9_-]+$/

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

  let names: string[] = []
  try { names = readdirSync(opts.logsDir).sort() } catch { /* no logs directory yet */ }
  // Each device's dial logs are in a folder of their own, `usb-<serial>/` (cableFleet.ts). Reading only the top
  // level left a user's Harness Pro console out of the bundle sent about it stuck silent (20-26 Oct).
  names = names.flatMap((name) => {
    if (!DEVICE_DIR.test(name)) return [name]
    try { return readdirSync(join(opts.logsDir, name)).sort().filter((f) => f.startsWith('dial-')).map((f) => `${name}/${f}`) } catch { return [] }
  })
  // A device's day may be 20 MB (dialLog.ts) and a desk may hold several, so their logs share one cap, newest day first.
  const capped = new Set<string>()
  let deviceBytes = 0
  const byDay = (name: string) => DATED.exec(basename(name))?.[2] ?? ''
  for (const name of names.filter((n) => n.includes('/') && byDay(n) >= cutoff).sort((x, y) => byDay(y).localeCompare(byDay(x)))) {
    try { deviceBytes += statSync(join(opts.logsDir, name)).size } catch { continue }
    if (deviceBytes > (opts.deviceLogCapBytes ?? 20 * 1024 * 1024)) capped.add(name)
  }
  for (const name of names) {
    const m = DATED.exec(basename(name))
    if (!m || m[2] < cutoff) continue
    if (capped.has(name)) { included.push(`${name} (left out to keep the bundle small)`); continue }
    const path = join(opts.logsDir, name)
    try {
      const text = readFileSync(path, 'utf8')
      entries.push({ name: `logs/${name}`, data: Buffer.from(opts.redact(text)), mtime: statSync(path).mtime })
      included.push(name)
    } catch { /* unreadable: skipped, said in the README below */ }
  }

  const harnessLog = join(opts.dataDir, 'harness.log')
  try {
    const tail = readTail(harnessLog, opts.harnessLogTailBytes ?? 5 * 1024 * 1024)
    const text = tail.toString('utf8')
    entries.push({ name: 'harness.log', data: Buffer.from(opts.redact(text)), mtime: statSync(harnessLog).mtime })
    included.push(`harness.log (last ${Math.round(tail.length / 1024)} KB)`)
  } catch { /* no daemon log */ }

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
    `Secrets (tokens, keys, passwords, signed URLs) were blanked before writing.`,
    `dial-*.log: the dial's own console (I/W/E lines, ticks since boot) interleaved with the daemon's`,
    `[daemon] cable events. 'alive up=' once a minute is the UI task's heartbeat; a gap in it while`,
    `[daemon] lines continue is a wedged UI task. 'boot: reset reason' after a session-up says why the`,
    `dial last rebooted; 'last:' lines are its log from just before a crash.`,
  ].join('\n')
  entries.unshift({ name: 'README.txt', data: Buffer.from(readme + '\n'), mtime: now })

  return { zip: writeZip(entries), included }
}

/** The same denylist the desktop app's `redactSecretsInText` applies — keep the two in step. */
export function redactSecretsInText(input: string): string {
  return input
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/(["']?\b\w*(?:token|secret|password|passphrase|credential|api[_-]?key)\w*\b["']?\s*[:=]\s*["']?)([^\s"',}]{6,})/gi, '$1<redacted>')
    .replace(/([?&][^=\s&]*(?:token|key|secret|sig|signature)[^=\s&]*=)[^\s&]+/gi, '$1<redacted>')
}
