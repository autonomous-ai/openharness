/**
 * How `harness` shows the account's devices: the order, the "last active" wording, and the lines of
 * `devices list|show` and the `status` row. Pure — the clock is passed in — so the same rules the
 * desktop and mobile apps follow (their `relative_time.dart`) are pinned by one spec here.
 */
import type { DevLogConflict, DevLogDeparted, DevLogFile } from './deviceLogStore.js'
import type { DeviceLogListing } from './deviceLogSyncer.js'
import type { DevLogHistoryRow } from './deviceHistory.js'

/** The fields of a listing row this module reads. `seq` (log position) and `firstSeen` (when this
 *  machine first applied the add) are the two a device cannot choose for itself; both optional so a
 *  daemon that predates them still lists, just without `new`. */
export type DeviceRow = Pick<DeviceLogListing['members'][number], 'pub' | 'label' | 'machineId' | 'addedAt' | 'fingerprint' | 'self'> & {
  kind: string
  seq?: number
  firstSeen?: number
  /** Not yet marked as seen on this machine / not trusted after a fork — only a daemon that has the
   *  joined-point marks sends them; absent, `new` falls back to the 7-day `firstSeen` rule. */
  pending?: boolean
  suspended?: boolean
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** A device seen this recently reads as "active now" rather than "5 minutes ago". */
const ACTIVE_NOW_MS = 5 * MIN
/** A device this machine first learned of this recently, that is not this machine, is flagged `new`. */
const NEW_DEVICE_MS = 7 * DAY

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** What to do to check a device's key code. Shown under `devices show`. */
export const COMPARE_HINT =
  'To check it is really that device: open Your devices on it — the code under "This device" must match. On a computer, `harness status` shows it too.'

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`

/** "2 days ago". Coarse on purpose: the person is deciding "do I recognise this", not auditing a log. */
export function relativeAgo(at: number, now: number): string {
  const d = Math.max(0, now - at)
  if (d < MIN) return 'just now'
  if (d < HOUR) return plural(Math.floor(d / MIN), 'minute')
  if (d < DAY) return plural(Math.floor(d / HOUR), 'hour')
  if (d < 2 * DAY) return 'yesterday'
  const days = Math.floor(d / DAY)
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  return 'over a year ago'
}

/** `1 Oct 2026, 14:05` in local time — spelled out so it reads the same in every locale. */
export function fullDateTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `active now` / `last active 2 days ago` / `added 3 weeks ago` (no session ever recorded for it). */
export function activityPhrase(lastSeen: number | undefined, addedAt: number, now: number): string {
  if (lastSeen === undefined) return `added ${relativeAgo(addedAt, now)}`
  return now - lastSeen < ACTIVE_NOW_MS ? 'active now' : `last active ${relativeAgo(lastSeen, now)}`
}

/** `new` rests on when THIS machine applied the add, never the entry's `at`: the adding device picks
 *  that itself, and a backdated one would hide exactly the device the flag is for. */
export function isNewDevice(row: Pick<DeviceRow, 'self' | 'firstSeen' | 'pending'>, now: number): boolean {
  if (row.pending !== undefined) return !row.self && row.pending
  return !row.self && row.firstSeen !== undefined && now - row.firstSeen < NEW_DEVICE_MS
}

/** Log order — the order devices were added, which only shifts when one is removed. The `#` of
 *  `list`, `show` and `remove` is the position here, so a number read from the list still names that
 *  device when activity reorders the display or a device is added before the person types it. */
export function logOrder<T extends DeviceRow>(members: T[]): T[] {
  return members.map((m, i) => ({ m, i })).sort((a, b) => (a.m.seq ?? a.i) - (b.m.seq ?? b.i) || a.i - b.i).map((x) => x.m)
}

/** This machine first, then the new ones (newest log entry first), then the rest by last activity.
 *  Ties keep log order. Display only — numbering is `logOrder`. */
export function orderDevices<T extends DeviceRow>(members: T[], lastSeen: Record<string, number> | undefined, now: number): T[] {
  const indexed = logOrder(members).map((m, i) => ({ m, i }))
  const rank = (m: T): number => (m.self ? 0 : isNewDevice(m, now) ? 1 : 2)
  // The log position is the unforgeable "when" for the new group; activity (else the add date) for the rest.
  const when = (x: { m: T; i: number }): number => (rank(x.m) === 2 ? lastSeen?.[x.m.pub] ?? x.m.addedAt : x.i)
  indexed.sort((a, b) => rank(a.m) - rank(b.m) || when(b) - when(a) || a.i - b.i)
  return indexed.map((x) => x.m)
}

/** Whether `devices remove` goes ahead, asks first, or refuses, given how the selector resolved:
 *  `byNumber` when it named a list number, else `key` is the key-code start it matched (normalised:
 *  upper case, no spaces or separators). A number is a guess about what the person last read, and a
 *  removal cannot be undone (the key is spent): it is echoed and confirmed at a terminal, and without
 *  one it needs `--yes`. A key-code start of 4 or more characters names the device and needs neither,
 *  digits or not ("1111" that is not a list number is the start of 1111·…); one under 4 ("1A") is as
 *  much a guess as a number and is treated like it.
 *  `interactive` means someone can both see the question and answer it (stdin AND stdout a TTY). */
export function removeConfirmation(
  sel: { byNumber: boolean; key: string },
  opts: { yes: boolean; interactive: boolean },
): 'go' | 'ask' | 'refuse' {
  if (opts.yes || (!sel.byNumber && sel.key.length >= 4)) return 'go'
  return opts.interactive ? 'ask' : 'refuse'
}

/** The answer to `remove`'s `[y/N]`: only an explicit yes removes. */
export const confirmsRemoval = (answer: string): boolean => /^y(es)?$/i.test(answer.trim())

export type DeviceRegistration = 'active' | 'removed' | 'unregistered' | 'taken'

/** Whether the account's device log holds this machine's key. No key on disk but a retired one means
 *  this machine was signed out of the account; neither means there is nothing to say. */
export function deviceRegistration(pub: string | null, file: DevLogFile, spent: boolean): DeviceRegistration | null {
  if (!pub) return spent ? 'removed' : null
  if (file.state?.active[pub]) return 'active'
  if (file.state?.removed.includes(pub)) return 'removed'
  if (file.conflict && file.state?.active[file.conflict.pub]) return 'taken'
  return 'unregistered'
}

/** The text after `device     ` in `harness status`, or null for no row. `holderFp` is the key code of
 *  the key holding this computer's place (`taken`), shortened to its first two groups. */
export function deviceStatusValue(fp: string | null, reg: DeviceRegistration | null, holderFp?: string): string | null {
  if (!reg) return null
  if (reg === 'taken') {
    const note = `not registered — another key holds this computer${holderFp ? `: ${shortFingerprint(holderFp, 2)}` : ''}`
    return fp ? `${fp}  (${note})` : `(${note})`
  }
  const note = reg === 'active' ? 'in your account' : reg === 'removed' ? 'removed — run harness login' : 'not registered yet'
  return fp ? `${fp}  (${note})` : `(${note})`
}

/** The first `groups` groups of a key code and an ellipsis: enough to tell two keys apart in a sentence. */
export function shortFingerprint(fp: string, groups = 1): string {
  return `${fp.split('·').slice(0, groups).join('·')}…`
}

const nameOf = (row: Pick<DeviceRow, 'label'>): string => row.label || '(no name)'
const kindOf = (row: Pick<DeviceRow, 'kind' | 'machineId'>): string => (row.kind === 'machine' ? `computer ${row.machineId.slice(0, 8)}` : 'app')

/** The lines of `harness devices list`: shown in `orderDevices` order, each row keeping its `logOrder`
 *  number. Above the rows, when the listing has them: the key holding this computer's place
 *  (`conflict`, worded by `afterJoin`), keys not trusted here after a fork (`suspended`), new keys
 *  that joined and left before anyone looked (`departed`), and how to mark `pending` ones seen.
 *  `selfFallback` is this machine's own key code for when the log has no row for it yet. */
export function formatDeviceList(
  listing: {
    members: DeviceRow[]; lastSeen?: Record<string, number>; pending?: string[]; suspended?: string[]
    conflict?: Pick<DevLogConflict, 'label' | 'fingerprint' | 'addedAt' | 'afterJoin'> | null
    departed?: Array<Pick<DevLogDeparted, 'label' | 'fingerprint' | 'removedBy' | 'removedByLabel' | 'selfRemoved'>>
    registerError?: string
  },
  now: number,
  selfFallback?: { label: string; fp: string },
): string[] {
  const numbers = new Map(logOrder(listing.members).map((m, i) => [m.pub, i + 1]))
  const rows = orderDevices(listing.members, listing.lastSeen, now)
  const lines: string[] = ['']
  const self = rows.find((r) => r.self)
  if (self) lines.push(`  This machine: ${nameOf(self)}  ${self.fingerprint}`, '')
  else if (selfFallback) {
    lines.push(`  This machine: ${selfFallback.label}  ${selfFallback.fp}  (not registered yet)`)
    // The backend refused this machine's key: say why, or the person waits for a join that never comes.
    const why = listing.registerError
    if (why) {
      lines.push(why === 'TOO_MANY'
        ? '  ⚠ This account has too many devices — remove unused ones: harness devices remove <fingerprint>'
        : `  ⚠ The account refused this computer's key (${why}) — see the daemon's log`)
    }
    lines.push('')
  }
  const c = listing.conflict
  if (c) {
    // No "added <when>": the holder's `addedAt` is whatever its signer wrote.
    const who = `${nameOf(c)} · ${c.fingerprint}`
    lines.push(c.afterJoin
      ? `  ⚠ Another key took this computer's place on your account after it joined: ${who}. If you did not set up Harness here again, remove that key from another device now.`
      : `  ⚠ This computer is held by another key on your account: ${who}. If that was an earlier install of this computer, remove it from another device (Your devices) — this computer joins on its own once it is gone.`, '')
  }
  const suspended = listing.members.filter((m) => m.suspended || listing.suspended?.includes(m.pub))
  if (suspended.length) {
    lines.push(`  ⚠ Not trusted here until you review the list: ${suspended.map(nameOf).join(', ')} — added after this computer's and another device's lists split apart. Review it: harness devices rebaseline   Yours? harness devices dismiss <key code>`, '')
  }
  // A new key that was removed again before anyone looked: gone, but nobody saw it come.
  // Removed by a key that is itself new here (unlooked at): said so.
  const unlooked = new Set([...(listing.pending ?? []), ...listing.members.filter((m) => m.pending).map((m) => m.pub)])
  for (const d of listing.departed ?? []) {
    const by = d.selfRemoved || !d.removedBy ? '' : ` (removed by ${unlooked.has(d.removedBy) ? 'a new device you have not looked at: ' : ''}${d.removedByLabel || 'another device'})`
    lines.push(`  ⚠ ${nameOf(d)} joined and left before you looked${by} — mark it seen: harness devices dismiss ${d.fingerprint}`)
  }
  if (listing.departed?.length) lines.push('')
  if (listing.members.some((m) => !m.self && (m.pending || listing.pending?.includes(m.pub)))) {
    lines.push('  New since you last looked — mark them seen: harness devices dismiss', '')
  }
  lines.push('  Devices on this account — each one trusts every other:', '')
  rows.forEach((m) => {
    const flag = m.self ? '  (this machine)' : m.suspended ? '  suspended' : isNewDevice(m, now) ? '  new' : ''
    lines.push(`   ${String(numbers.get(m.pub)).padStart(2)}. ${nameOf(m)}  ${kindOf(m)}  ${m.fingerprint}  ${activityPhrase(listing.lastSeen?.[m.pub], m.addedAt, now)}${flag}`)
  })
  // `remove` takes the key code here, not a number: a code names one device however the list moves.
  lines.push('', '  Details: harness devices show <#|fingerprint>   Not yours? harness devices remove <fingerprint>')
  lines.push('   History: harness devices history', '')
  return lines
}

const OP_WORDS: Record<DevLogHistoryRow['op'], string> = { added: 'added', renamed: 'renamed', removed: 'removed', signedOut: 'signed out' }

/** The lines of `harness devices history`: newest first, with what to say when the log could not be
 *  read in full. A still-unseen key is flagged `new`, or `left before you looked` once it is gone. */
export function formatDeviceHistory(h: { rows: DevLogHistoryRow[]; complete: boolean }): string[] {
  const lines = ['', '  Device history, newest first (as this machine verified it):', '']
  for (const r of h.rows) {
    const name = r.op === 'renamed' && r.previousLabel !== undefined ? `${r.previousLabel || '(no name)'} → ${nameOf(r)}` : nameOf(r)
    const by = r.by ? `  by ${r.by.label || `another device (${shortFingerprint(r.by.fingerprint, 2)})`}` : ''
    lines.push(`  ${r.seq}  ${fullDateTime(r.at)}  ${OP_WORDS[r.op]}  ${name}  ${kindOf(r)}  ${r.fingerprint}${by}`
      + `${r.pending ? (r.active ? '  new' : '  left before you looked') : ''}${r.thisDevice ? '  (this machine)' : ''}${r.whileFrozen ? '  (applied while the list was frozen)' : ''}`)
  }
  if (!h.complete) lines.push('', '  Older history needs a connection.')
  else if (!h.rows.length) lines.push('  No history yet.')
  lines.push('')
  return lines
}

/** The lines of `harness devices show`: everything known about one device, and how to check it. */
export function formatDeviceDetail(row: DeviceRow, lastSeen: number | undefined, now: number): string[] {
  const lines = ['', `  ${nameOf(row)}${row.self ? '  (this machine)' : ''}`, '']
  lines.push(`    kind         ${row.kind === 'machine' ? 'Computer' : 'App'}`)
  lines.push(`    added        ${fullDateTime(row.addedAt)} (${relativeAgo(row.addedAt, now)})`)
  lines.push(`    last active  ${lastSeen === undefined ? 'unknown' : `${relativeAgo(lastSeen, now)} (${fullDateTime(lastSeen)})`}`)
  if (row.kind === 'machine') lines.push(`    machine      ${row.machineId.slice(0, 8)}`)
  lines.push(`    key code     ${row.fingerprint}`, '')
  lines.push(`  ${COMPARE_HINT}`, '')
  lines.push(row.self ? '  This is this machine.' : `  Not yours? harness devices remove ${row.fingerprint}`, '')
  return lines
}
