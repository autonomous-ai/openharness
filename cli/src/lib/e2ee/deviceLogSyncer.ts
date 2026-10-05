/**
 * Keeps this machine in step with its account's device key log (deviceLog.ts) and turns what the log
 * says into trust: every key the log leaves active is trusted here, through the same path a trust-group
 * member is (GroupSyncer), and every key a `remove` takes out is forgotten.
 *
 *  - register(): this machine's own key goes into the log, once per sign-in — so an existing sign-in,
 *    from before the log existed, joins it with no action from anyone.
 *  - refresh():  read the log from the head this machine already verified; verify every new entry.
 *    A backend that rewrote the log (a different entry at a position already verified) or rolled it
 *    back (a head older than one verified) FREEZES it here: no key is added from the log until someone
 *    looks at what changed and trusts it again (rebaseline). Removals still take effect.
 *  - gossip:     the head rides every `group_sync`, so two devices shown different logs find out, and a
 *    device that is behind is handed the entries it is missing (a removal the backend held back).
 *  - announce:   an `add` past the point this machine joined the log is a "New device: X" and stays
 *    `pending` until someone marks it seen — the one way a device added by whoever got hold of the
 *    account (or by the backend itself) is seen. Decided from the log alone, never from what the trust
 *    group already holds: a roster that outran the log must not hide it.
 *  - history:    what the log says about every add and remove, as this machine verified it.
 */
import {
  applyDevLogEntries, compareDevLogHead, DevLogError, devLogHash, devLogMessage, emptyDevLogState, nextDevLogEntry,
  parseDevLogEntry, signDevLogEntry, type DevLogEntry, type DevLogHead, type DevLogMember, type DevLogState,
} from './deviceLog.js'
import {
  DEVLOG_DEPARTED, DEVLOG_RECENT, type DevLogConflict, type DevLogDeparted, type DevLogFile, type DevLogFreeze, type DeviceLogStore,
} from './deviceLogStore.js'
import { devLogHistory, type DevLogHistoryRow } from './deviceHistory.js'
import { b64d, fingerprint, verify } from './core.js'

export interface DeviceLogFetched { acct: string; head: DevLogHead; entries: unknown[] }
export type DeviceLogAppendAnswer = { head: DevLogHead } | { error: string; head?: DevLogHead }

/** A sign-in by hand, as this machine's session records it (authSession `signInOf`) — never anything
 *  the backend sends. */
export interface DevLogSignIn {
  /** Which sign-in it is. */
  epoch: string
  /** Given to a session from before sign-ins were recorded: nobody saw it being made here, so it never
   *  starts the log over (it may take a file over). */
  adopted: boolean
  /** When it was made (ms); null when not known — then it never starts the log over either. */
  at: number | null
}

/** How long after a sign-in by hand a read of another account may start the log over: past it, with
 *  no read of that account yet, the backend has had the time to pick when it says so. */
export const DEVLOG_RESET_WINDOW_MS = 10 * 60_000

export interface DeviceLogSyncerDeps {
  store: DeviceLogStore
  /** This machine's identity: base64 public key and the private key that signs for it. */
  identity: () => { pub: string; priv: Uint8Array }
  /** How this machine describes itself in the log; no machineId = not signed in, nothing to register. */
  self: () => { machineId: string | null; label: string }
  /** Which sign-in by hand this machine is under; null when not known. The log of another account is
   *  started (or a kept one restored) only when this changed AND the backend's account differs AND it
   *  was made less than DEVLOG_RESET_WINDOW_MS ago — never for an adopted one. Otherwise a different
   *  account id from the backend freezes the log. While the file is not this sign-in's yet (no read of
   *  it so far), what peers gossip is not taken either. */
  signIn: () => DevLogSignIn | null
  /** The log from `since`; null when the backend has none to give (an older backend, or unreachable). */
  fetch: (since: number) => Promise<DeviceLogFetched | null>
  /** Append one signed entry; null when the backend could not be reached. */
  append: (entry: DevLogEntry) => Promise<DeviceLogAppendAnswer | null>
  /** Trust these keys here (and tell the trust group, so devices that predate the log learn of them). */
  adopt: (members: DevLogMember[]) => void
  /** Stop trusting a key here (and tombstone it in the trust group). */
  drop: (pub: string) => void
  /** The keys this machine trusts right now: snapshotted once, when it joins the log (or migrates to
   *  this version), so what it already knew then is never news. */
  trustedNow: () => string[]
  /** Whether the trust group holds a removal for `pub` that predates the log. */
  tombstoned: (pub: string) => boolean
  /** Whether this machine's user unpaired `pub` here — a local override the log never beats. */
  blocked: (pub: string) => boolean
  /** A key joined the log after this machine did: "New device: X". */
  announce: (member: DevLogMember) => void
  /** A device was taken out of the log after this machine joined (not by this machine). */
  removed?: (notice: DeviceRemovalNotice) => void
  /** Another key holds this machine's id in the log (first time that holder is seen). */
  conflict?: (conflict: DevLogConflict) => void
  /** A fork split the lists: stop trusting these keys here until `rebaseline`. */
  suspend?: (pubs: string[]) => void
  /** `rebaseline` cleared the suspension: trust the roster again. */
  resume?: () => void
  /** This machine's own key was removed from the log: it is signed out. */
  signedOut: () => void
  /** Something a window shows changed (the list, the frozen line). */
  changed?: () => void
  log?: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface DeviceLogListing {
  head: DevLogHead | null
  frozen: DevLogFreeze | null
  self: string
  members: Array<DevLogMember & { fingerprint: string; self: boolean; firstSeen?: number; pending: boolean; suspended: boolean }>
  /** Machines whose own copy of the log is frozen, as their last `group_sync` said. */
  frozenPeers: string[]
  /** Keys that joined after this machine did and nobody has marked as seen. */
  pending: string[]
  /** Keys not trusted here after a fork, until `rebaseline`. */
  suspended: string[]
  joinedSeq: number
  /** The keys that were on the account before this machine joined (the "Already on your account" list):
   *  active, not this machine, at or before `joinedSeq` — plus any key this machine already trusted at
   *  joining whose entry came after it (a log cut short at the first read must not hide it). */
  baseline: string[]
  /** false until the "already on your account" list was acknowledged. */
  baselineSeen: boolean
  /** Another key holds this machine's id (and still does). */
  conflict: DevLogConflict | null
  /** New keys removed before anyone marked them as seen: flagged until dismissed (oldest first). */
  departed: DevLogDeparted[]
}

/** A device taken out of the account's log after this machine joined it. */
export interface DeviceRemovalNotice {
  pub: string
  label: string
  kind: DevLogMember['kind']
  fingerprint: string
  signer: string
  signerLabel: string
  signerFingerprint: string
  /** The signer is itself a new device nobody has looked at. */
  signerPending: boolean
  /** The device removed itself (signed out). */
  selfRemoved: boolean
  at: number
}

export interface DeviceLogHistory {
  rows: DevLogHistoryRow[]
  /** false when only part of the log could be read (offline). */
  complete: boolean
  frozen: DevLogFreeze | null
}

export type DeviceLogRemoveResult = { ok: true } | { ok: false; error: 'NOT_ACTIVE' | 'NOT_IN_LOG' | 'UNAVAILABLE' | 'REFUSED'; detail?: string }

/** `rebaseline(confirm, head)` refused: the backend's list is no longer the one that was previewed
 *  (`LOG_CHANGED`), or it is another account's while the log this machine keeps is the one of the
 *  sign-in it is under (`OTHER_ACCOUNT`: only a sign-in switches accounts). */
export interface DeviceLogRebaselineChanged { error: 'LOG_CHANGED' | 'OTHER_ACCOUNT' }

export interface DeviceLogRebaseline {
  head: DevLogHead
  added: DevLogMember[]
  removed: DevLogMember[]
}

const APPEND_ATTEMPTS = 5
const PAGES = 20
/** The newest hashes a `group_sync` carries, so a fork can be located. */
const GOSSIP_HASHES = 64

interface Known { label: string; kind: DevLogMember['kind'] }

const fp = (pub: string): string => fingerprint(b64d(pub))
const uniq = (xs: readonly string[]): string[] => [...new Set(xs)]

/**
 * Where a peer's log first differs from `state`: the first seq, in the window of hashes the peer sent
 * (`theirs.hashes`, with `theirs.head` the last of them), whose hash is not ours — only when the entry
 * before it matches (or it is the first), so the split is proven rather than guessed. null when the peer
 * sent no usable hashes, nothing in the shared window differs, or the split lies before the window.
 */
export function devLogDivergence(state: DevLogState, theirs: unknown): number | null {
  if (!theirs || typeof theirs !== 'object') return null
  const { head, hashes } = theirs as { head?: { seq?: unknown; hash?: unknown }; hashes?: unknown }
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 4 * GOSSIP_HASHES) return null
  const window = new Map<number, string>()
  let prev = 0
  for (const h of hashes) {
    if (!h || typeof h !== 'object') return null
    const { seq, hash } = h as { seq?: unknown; hash?: unknown }
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || typeof hash !== 'string' || hash.length > 128) return null
    if (prev !== 0 && seq !== prev + 1) return null
    prev = seq
    window.set(seq, hash)
  }
  // The window must end where the peer's head is, or it describes some other log.
  if (!head || head.seq !== prev || head.hash !== window.get(prev)) return null
  const first = Math.min(...window.keys())
  for (const [seq, hash] of window) {
    if (seq > state.head.seq || state.hashes[seq - 1] === hash) continue
    if (seq === 1) return 1
    if (seq === first) return null
    return state.hashes[seq - 2] === window.get(seq - 1) ? seq : null
  }
  return null
}

export class DeviceLogSyncer {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private refreshing: Promise<void> | null = null
  private readonly frozenPeers = new Map<string, boolean>()
  private readonly removing = new Set<string>()
  private readonly inFlightRemovals = new Map<string, Promise<DeviceLogRemoveResult>>()
  /** The history walk in progress, which a second `history()` joins. */
  private historying: Promise<DeviceLogHistory> | null = null
  /** Every entry fetched for the history so far (seq 1..n), this run only: never written to disk. */
  private histCache: { acct: string; entries: DevLogEntry[] } | null = null

  constructor(private readonly deps: DeviceLogSyncerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** Read the log and put this machine's own key into it. Never throws. */
  async register(): Promise<void> {
    try {
      const self = this.deps.self()
      if (!self.machineId) return
      await this.refresh()
      const { pub, priv } = this.deps.identity()
      for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
        const file = this.marks()
        const state = file.state
        if (!state || file.frozen) return
        if (state.removed.includes(pub)) { this.deps.signedOut(); return }
        const mine = state.active[pub]
        if (mine) {
          this.clearConflict()
          if (mine.label === self.label || mine.machineId !== self.machineId) return
        } else {
          const taken = Object.values(state.active).find((m) => m.kind === 'machine' && m.machineId === self.machineId)
          if (taken) { this.noteConflict(file, taken); return }
        }
        const entry = signDevLogEntry(nextDevLogEntry(state, {
          op: 'add', pub, kind: 'machine', machineId: self.machineId, label: self.label, signer: pub,
        }, this.now()), priv)
        const answer = await this.deps.append(entry)
        if (!answer) return
        if ('head' in answer && !('error' in answer)) { await this.refresh(); return }
        if (answer.error !== 'STALE_HEAD') { this.deps.log?.(`[devlog] register refused: ${answer.error}`); return }
        await this.refresh()
        await this.sleep(200 + Math.floor(Math.random() * 800) * (attempt + 1))
      }
    } catch (err) {
      this.deps.log?.(`[devlog] register failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Read and verify whatever the log gained. Concurrent calls share one read. Never throws. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh()
      .catch((err) => { this.deps.log?.(`[devlog] refresh failed: ${err instanceof Error ? err.message : String(err)}`) })
      .finally(() => { this.refreshing = null })
    return this.refreshing
  }

  /** The file, with the joined point filled in for one written before it existed (or by a client that
   *  dropped it): everything up to what was already announced is then known, as it was. */
  private marks(): DevLogFile {
    const file = this.deps.store.read()
    if (!file.state || file.joinedSeq !== undefined) return file
    const next: DevLogFile = {
      ...file, joinedSeq: file.notifiedUpTo, preLog: this.deps.trustedNow(), pending: [], announced: [], baselineSeen: true,
    }
    this.deps.store.write(next)
    return next
  }

  /** Whether `local` — a sign-in by hand the file is not yet the log of — may start it over for another
   *  account: never an adopted one, and only shortly after it was made. A backend that holds back the
   *  log after a sign-in must not keep that door open, to name another account days later. */
  private mayStartOver(local: DevLogSignIn): boolean {
    return !local.adopted && local.at !== null && Math.abs(this.now() - local.at) <= DEVLOG_RESET_WINDOW_MS
  }

  /** Whether the file is the log of the sign-in this machine is under (or that cannot be told). Until a
   *  read of it under a new sign-in, it may be another account's: what a peer says is not judged
   *  against it — a peer of the new account would read as a fork of the old one. */
  private ownsFile(file: DevLogFile): boolean {
    const local = this.deps.signIn()
    return local === null || file.owner === local.epoch
  }

  /** `file`, with every key a fork suspended in another account's kept log, and active in this one,
   *  suspended (and new) here as well: it is not trusted either way, so the list says so — and "It's
   *  mine" lifts it, everywhere (a review of this list does not: it never showed that suspension). */
  private carrySuspensions(file: DevLogFile): DevLogFile {
    const state = file.state
    if (!state) return file
    const selfPub = this.deps.identity().pub
    const current = file.suspended ?? []
    const carried = this.deps.store.archivedSuspended().filter((k) => !!state.active[k] && k !== selfPub && !current.includes(k))
    if (!carried.length) return file
    return { ...file, suspended: [...current, ...carried], pending: uniq([...(file.pending ?? []), ...carried]) }
  }

  /** `gone`, just taken out by `e`, kept flagged: it was new here and nobody had looked at it yet. */
  private departedOf(gone: DevLogMember, e: DevLogEntry, signerLabel: string): DevLogDeparted {
    return {
      pub: gone.pub, label: gone.label, kind: gone.kind, machineId: gone.machineId, fingerprint: fp(gone.pub), addedAt: gone.addedAt,
      removedAt: e.at, removedBy: e.signer, removedByLabel: signerLabel, selfRemoved: e.signer === gone.pub,
    }
  }

  /** `prev` plus `more` (a key once, at its newest), the oldest dropped past DEVLOG_DEPARTED. */
  private withDeparted(prev: DevLogDeparted[] | undefined, more: readonly DevLogDeparted[]): { departed?: DevLogDeparted[] } {
    if (!more.length) return prev ? { departed: prev } : {}
    const pubs = new Set(more.map((d) => d.pub))
    return { departed: [...(prev ?? []).filter((d) => !pubs.has(d.pub)), ...more].slice(-DEVLOG_DEPARTED) }
  }

  /** What a review (`rebaseline --yes`) takes out that was new here and never looked at: a key pending
   *  in `base` that the reviewed list does not keep — and a key the list added and removed again at
   *  entries this machine never verified (while it was frozen) — stays flagged as departed. */
  private reviewDeparted(
    base: DevLogFile, next: DevLogState, parsed: readonly DevLogEntry[], removed: readonly DevLogMember[], selfPub: string, preLog: ReadonlySet<string>,
  ): DevLogDeparted[] {
    const verified = base.state
    if (!verified) return []
    const pending = base.pending ?? []
    const known = new Map<string, Known>()
    const adds = new Map<string, DevLogEntry>()
    const out = new Map<string, DevLogDeparted>()
    for (const e of [...parsed].sort((a, b) => a.seq - b.seq)) {
      if (e.op === 'add') {
        if (!known.has(e.pub)) adds.set(e.pub, e) // added (not renamed)
        known.set(e.pub, { label: e.label, kind: e.kind })
        continue
      }
      const was = removed.find((m) => m.pub === e.pub)
      const add = adds.get(e.pub)
      const label = known.get(e.pub)?.label
      known.delete(e.pub)
      if (e.pub === selfPub || next.active[e.pub]) continue
      // Added at an entry this machine never verified, and gone again before it could see it.
      const unseen = !was && !!add && verified.hashes[add.seq - 1] !== devLogHash(add) && !preLog.has(e.pub) && !this.deps.blocked(e.pub)
      if ((was && pending.includes(e.pub)) || unseen) {
        const member: DevLogMember = was ?? { pub: e.pub, kind: add!.kind, machineId: add!.machineId, label: label ?? add!.label, addedAt: add!.at, seq: add!.seq }
        out.set(e.pub, this.departedOf(member, e, known.get(e.signer)?.label ?? ''))
      }
    }
    // Pending here, and not on the reviewed list at all (a branch the backend no longer serves).
    for (const m of removed) {
      if (out.has(m.pub) || m.pub === selfPub || !pending.includes(m.pub)) continue
      out.set(m.pub, {
        pub: m.pub, label: m.label, kind: m.kind, machineId: m.machineId, fingerprint: fp(m.pub), addedAt: m.addedAt,
        removedAt: this.now(), removedBy: '', removedByLabel: '', selfRemoved: false,
      })
    }
    return [...out.values()]
  }

  /** The first read of the log has reached its head (or stopped): what is verified from here on is news. */
  private endJoin(): void {
    const file = this.deps.store.read()
    if (!file.joining) return
    const { joining: _j, ...rest } = file
    this.deps.store.write(rest)
  }

  /** Another key holds this machine's id: remember it, and say so the first time that holder is seen. */
  private noteConflict(file: DevLogFile, holder: DevLogMember): void {
    if (file.conflict?.pub === holder.pub) return
    const conflict: DevLogConflict = {
      pub: holder.pub, label: holder.label, machineId: holder.machineId, addedAt: holder.addedAt, seq: holder.seq,
      fingerprint: fp(holder.pub), afterJoin: holder.seq > (file.joinedSeq ?? 0),
    }
    this.deps.store.write({ ...file, conflict })
    const who = `${conflict.label || '(no name)'} (${conflict.fingerprint})`
    this.deps.log?.(conflict.afterJoin
      ? `[devlog] ⚠ another key took this computer's place on your account after it joined: ${who} — if you did not set up Harness here again, remove that key from another device now`
      : `[devlog] this computer is held by another key on your account: ${who} — if that was an earlier install of this computer, remove it from another device; this computer joins on its own once it is gone`)
    this.deps.conflict?.(conflict)
    this.deps.changed?.()
  }

  private clearConflict(): void {
    const file = this.deps.store.read()
    if (!file.conflict) return
    const { conflict: _gone, ...rest } = file
    this.deps.store.write(rest)
    this.deps.changed?.()
  }

  private async doRefresh(): Promise<void> {
    try {
      await this.readPages()
    } finally {
      // However the read ended — at the head, on a freeze, or cut short (no answer, the page cap) — the
      // first read of a log is over: what is verified from here on is news. Held open, a backend that
      // stalls the second page would have every key it adds later taken for one there at joining.
      this.endJoin()
    }
  }

  private async readPages(): Promise<void> {
    this.marks()
    // The first read of a log (a new install, or an existing sign-in from before the log existed) only
    // learns what is there: every key it adopts, and none of it is news (it is before `joinedSeq`).
    let bootstrap = !this.deps.store.read().state?.head.seq
    for (let page = 0; page < PAGES; page++) {
      const file = this.deps.store.read()
      const since = file.state?.head.seq ?? 0
      const got = await this.deps.fetch(since)
      if (!got) return
      // A head that is not a position is the backend lying (or broken): nothing to verify it against.
      if (!Number.isSafeInteger(got.head.seq) || got.head.seq < 0) return
      const latest = this.deps.store.read()
      const now = latest.state
      if (file.state && now && now.acct === got.acct
        && (file.state.acct !== now.acct || file.state.head.seq !== now.head.seq || file.state.head.hash !== now.head.hash)) {
        // The log moved here while this page was on its way (a peer handed over its tail): judged
        // against the newer head the page would read as a rollback, or as entries out of order. Ask
        // again from where the log is now.
        continue
      }
      const local = this.deps.signIn()
      let reset = !now
      if (now) {
        const signedInAgain = local !== null && latest.owner !== local.epoch
        if (now.acct !== got.acct) {
          // Another account only right after a sign-in by hand here. Otherwise it is the backend saying
          // so — and starting over would clear every mark a fork put on the list, the real log then
          // adopted whole.
          if (!signedInAgain || !this.mayStartOver(local)) {
            this.freeze('invalid')
            return
          }
          reset = true
        } else if (signedInAgain) {
          // Signed in again to the same account: the same list, now this sign-in's.
          this.deps.store.write({ ...latest, owner: local.epoch })
        }
      }
      if (reset) {
        if (now) this.deps.store.archive(latest)
        // Back to an account this machine was signed in to before: its log as verified then, and every
        // mark on it (frozen, suspended, pending), go on from where they were.
        const kept = this.deps.store.restore(got.acct, (k) => this.carrySuspensions({ ...k, ...(local ? { owner: local.epoch } : {}) }))
        if (kept) {
          bootstrap = !kept.state?.head.seq
          continue
        }
        // First read, or signed in to another account here: that account's log starts from nothing.
        // `joinedSeq` starts at 0 and follows the head of each page this machine VERIFIES (accept):
        // never the head the backend merely claims, or it could park it far ahead and have every key
        // it forges below that adopted without a word. `preLog` is what was trusted already.
        const fresh: DevLogFile = {
          state: emptyDevLogState(got.acct), recent: [], frozen: null, notifiedUpTo: 0,
          joinedSeq: 0, preLog: this.deps.trustedNow(), pending: [], announced: [], suspended: [], baselineSeen: false,
          joining: true, ...(local ? { owner: local.epoch } : {}),
        }
        this.deps.store.write(fresh)
        bootstrap = true
        if (got.head.seq === 0) return
        if (since !== 0) continue
      }
      const current = this.deps.store.read()
      const state = current.state!
      if (current.frozen) { this.looseRemovals(got.entries); return }
      if (got.head.seq < state.head.seq) { this.freeze('rollback'); return }
      if (got.head.seq === state.head.seq) {
        if (got.head.hash !== state.head.hash) this.freeze('fork')
        return
      }
      if (!got.entries.length) { this.freeze('invalid'); return }
      if (!this.accept(got.entries, bootstrap)) return
      if (this.deps.store.read().state!.head.seq >= got.head.seq) return
    }
  }

  /** `firstSeen` plus now for each newly applied key, minus keys no longer active (keeps the file small). */
  private stamp(prev: Record<string, number> | undefined, added: readonly DevLogMember[], state: DevLogState): Record<string, number> {
    const at = this.now()
    const out: Record<string, number> = {}
    for (const pub of Object.keys(state.active)) {
      const t = prev?.[pub] ?? (added.some((m) => m.pub === pub) ? at : undefined)
      if (t !== undefined) out[pub] = t
    }
    return out
  }

  /** `keys` cut to the ones still active — the marks never outlive the key. */
  private prune(keys: readonly string[] | undefined, state: DevLogState): string[] {
    return uniq(keys ?? []).filter((k) => state.active[k] !== undefined)
  }

  /** The notice for a `remove` that took `gone` out, or null when there is nothing to say: this
   *  machine's own removal, this machine's own key, or a removal from before it joined. `known` says
   *  what each key was called, and what kind it was, BEFORE this removal — the remove entry's own label
   *  and kind are the signer's to pick, so they are never what the person is told. */
  private removalNotice(e: DevLogEntry, joinedSeq: number, selfPub: string, pending: readonly string[], known: ReadonlyMap<string, Known>): DeviceRemovalNotice | null {
    if (e.op !== 'remove' || e.seq <= joinedSeq || e.pub === selfPub || e.signer === selfPub) return null
    const was = known.get(e.pub)
    return {
      pub: e.pub, label: was?.label ?? e.label, kind: was?.kind ?? e.kind, fingerprint: fp(e.pub),
      signer: e.signer, signerLabel: known.get(e.signer)?.label ?? '', signerFingerprint: fp(e.signer),
      signerPending: pending.includes(e.signer), selfRemoved: e.signer === e.pub, at: this.now(),
    }
  }

  /** What each active key in `state` is called now, to be walked forward through entries. */
  private knownOf(state: DevLogState): Map<string, Known> {
    return new Map(Object.values(state.active).map((m) => [m.pub, { label: m.label, kind: m.kind }] as const))
  }

  /** Apply entries that continue this machine's log; freeze on anything that does not. */
  private accept(entries: readonly unknown[], bootstrap: boolean): boolean {
    const file = this.marks()
    // While the first read of this log is open (a peer's tail can arrive between its pages too):
    // whatever is verified before it reaches the head is what was there at joining.
    const joining = file.joining === true
    let applied
    try {
      applied = applyDevLogEntries(file.state!, entries)
    } catch (err) {
      if (!(err instanceof DevLogError)) throw err
      this.freeze(err.code === 'BROKEN_CHAIN' || err.code === 'OUT_OF_ORDER' ? 'fork' : 'invalid')
      return false
    }
    const selfPub = this.deps.identity().pub
    // While joining, everything this page verified is what was there before: the joined point moves up
    // to the verified head (never past it), and none of it is news.
    const joinedSeq = joining ? applied.state.head.seq : file.joinedSeq ?? 0
    const preLog = new Set(file.preLog ?? [])
    const parsed = entries.map((e) => parseDevLogEntry(e)).filter((e): e is DevLogEntry => e !== null)
    // News is decided from the log alone: an `add` past the point this machine joined, for a key it
    // did not already trust then. What the roster or the pins hold now says nothing — a key can reach
    // them (over `group_sync`) before this machine reads the entry that adds it.
    const news = applied.added.filter((m) =>
      m.seq > joinedSeq && m.pub !== selfPub && !preLog.has(m.pub) && !this.deps.blocked(m.pub))
    const pendingBefore = file.pending ?? []
    const announced = file.announced ?? []
    const newHere = [...pendingBefore, ...news.map((m) => m.pub)]
    const pending = this.prune(newHere, applied.state)
    const toAnnounce = news.filter((m) => !announced.includes(m.pub))
    // Walk the entries in order: a removal is described by what the key was called when it was removed.
    const known = this.knownOf(file.state!)
    const notices: DeviceRemovalNotice[] = []
    const gone = new Map(applied.removed.map((m) => [m.pub, m] as const))
    const departed: DevLogDeparted[] = []
    for (const e of [...parsed].sort((a, b) => a.seq - b.seq)) {
      if (e.op === 'add') known.set(e.pub, { label: e.label, kind: e.kind })
      else {
        const n = this.removalNotice(e, joinedSeq, selfPub, newHere, known)
        if (n) notices.push(n)
        // A new key nobody looked at, gone again (even within this page): it stays flagged.
        const member = gone.get(e.pub)
        if (member && newHere.includes(e.pub) && e.pub !== selfPub) departed.push(this.departedOf(member, e, known.get(e.signer)?.label ?? ''))
        known.delete(e.pub)
      }
    }
    // The holder of this machine's id left, or this machine got its own key in: the conflict is over.
    const conflictOver = !!file.conflict && (!!applied.state.active[selfPub] || !applied.state.active[file.conflict.pub])
    // A key taken into the "already on your account" list after that list was acknowledged: show it.
    const unseen = joining && file.baselineSeen !== false && applied.added.some((m) => m.pub !== selfPub)
    const { conflict: _c, ...rest } = file
    this.deps.store.write(this.carrySuspensions({
      ...rest,
      ...(unseen ? { baselineSeen: false } : {}),
      ...(file.conflict && !conflictOver ? { conflict: file.conflict } : {}),
      state: applied.state,
      joinedSeq,
      recent: [...file.recent, ...parsed].slice(-DEVLOG_RECENT),
      frozen: null,
      notifiedUpTo: applied.state.head.seq,
      firstSeen: this.stamp(file.firstSeen, applied.added.filter((m) => m.seq > joinedSeq), applied.state),
      pending,
      announced: this.prune([...announced, ...toAnnounce.map((m) => m.pub)], applied.state),
      suspended: this.prune(file.suspended, applied.state),
      ...this.withDeparted(file.departed, departed),
    }))
    this.trustState(applied.state, bootstrap ? Object.values(applied.state.active) : [...applied.added, ...applied.relabeled])
    for (const m of applied.removed) this.deps.drop(m.pub)
    for (const m of toAnnounce) this.deps.announce(m)
    for (const n of notices) this.deps.removed?.(n)
    if (applied.state.removed.includes(selfPub)) this.deps.signedOut()
    void this.carryOverTombstones(applied.state)
    this.deps.changed?.()
    // Its holder gone, this machine takes its own place in the account.
    if (conflictOver && !applied.state.active[selfPub]) void this.register()
    return true
  }

  private trustState(state: DevLogState, members: DevLogMember[]): void {
    const selfPub = this.deps.identity().pub
    const suspended = this.suspendedKeys()
    const adopt = members.filter((m) => m.pub !== selfPub && state.active[m.pub] && !suspended.includes(m.pub)
      && !this.deps.blocked(m.pub) && !this.deps.tombstoned(m.pub))
    if (adopt.length) this.deps.adopt(adopt)
  }

  /** A removal made in the trust group before the log existed must not be undone by the log: this
   *  machine, holding that removal, writes it into the log. */
  private async carryOverTombstones(state: DevLogState): Promise<void> {
    const selfPub = this.deps.identity().pub
    if (!state.active[selfPub]) return
    for (const m of Object.values(state.active)) {
      if (m.pub !== selfPub && this.deps.tombstoned(m.pub) && !this.removing.has(m.pub)) await this.remove(m.pub)
    }
  }

  /** While frozen, a removal still counts — if a key this machine trusts signed it. A key a fork
   *  suspended is not trusted here, so what it signs does not count either. */
  private looseRemovals(entries: readonly unknown[]): void {
    const file = this.marks()
    const state = file.state
    if (!state) return
    const selfPub = this.deps.identity().pub
    const joinedSeq = file.joinedSeq ?? 0
    const suspended = new Set(file.suspended ?? [])
    const loose: DevLogEntry[] = []
    const notices: DeviceRemovalNotice[] = []
    const departed: DevLogDeparted[] = []
    const known = this.knownOf(state)
    for (const raw of entries) {
      const e = parseDevLogEntry(raw)
      if (!e || e.op !== 'remove' || !state.active[e.signer] || suspended.has(e.signer) || !state.active[e.pub]) continue
      if (!verify(b64d(e.signer), devLogMessage(e), b64d(e.sig))) continue
      const notice = this.removalNotice(e, joinedSeq, selfPub, file.pending ?? [], known)
      if ((file.pending ?? []).includes(e.pub) && e.pub !== selfPub) departed.push(this.departedOf(state.active[e.pub], e, known.get(e.signer)?.label ?? ''))
      delete state.active[e.pub]
      state.removed.push(e.pub)
      this.deps.drop(e.pub)
      loose.push(e)
      if (notice) notices.push(notice)
    }
    if (!loose.length) return
    this.deps.store.write({
      ...file, state,
      looseRemoved: [...(file.looseRemoved ?? []), ...loose],
      pending: this.prune(file.pending, state), announced: this.prune(file.announced, state), suspended: this.prune(file.suspended, state),
      ...this.withDeparted(file.departed, departed),
    })
    for (const n of notices) this.deps.removed?.(n)
    this.deps.changed?.()
  }

  private freeze(reason: DevLogFreeze['reason']): void {
    const file = this.deps.store.read()
    if (file.frozen || !file.state) return
    const { joining: _j, ...rest } = file
    this.deps.store.write({ ...rest, frozen: { reason, at: this.now(), lastGoodHead: file.state.head } })
    this.deps.log?.(`[devlog] FROZEN (${reason}): the device list the backend serves does not match what this machine verified — no device is added from it until someone reviews it (harness devices rebaseline)`)
    this.deps.changed?.()
  }

  /** Remove a device from the log (and so from every device). Signed by this machine. */
  remove(pub: string): Promise<DeviceLogRemoveResult> {
    // One removal per key at a time: taking it out here tombstones it in the trust group, which hands
    // it straight back through `onDropped` — that second ask joins this one.
    const running = this.inFlightRemovals.get(pub)
    if (running) return running
    this.removing.add(pub)
    const task = this.removeOnce(pub).finally(() => { this.removing.delete(pub); this.inFlightRemovals.delete(pub) })
    this.inFlightRemovals.set(pub, task)
    return task
  }

  private async removeOnce(pub: string): Promise<DeviceLogRemoveResult> {
    const { pub: selfPub, priv } = this.deps.identity()
    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
      const file = this.deps.store.read()
      const state = file.state
      if (!state) return { ok: false, error: 'UNAVAILABLE' }
      const target = state.active[pub]
      if (!target) return { ok: false, error: 'NOT_IN_LOG' }
      if (!state.active[selfPub]) return { ok: false, error: 'NOT_ACTIVE' }
      // Take effect here at once, whatever the backend does with it.
      this.deps.drop(pub)
      const entry = signDevLogEntry(nextDevLogEntry(state, {
        op: 'remove', pub, kind: target.kind, machineId: target.machineId, label: target.label, signer: selfPub,
      }, this.now()), priv)
      const answer = await this.deps.append(entry)
      if (!answer) return { ok: false, error: 'UNAVAILABLE' }
      if (!('error' in answer)) { await this.refresh(); return { ok: true } }
      if (answer.error !== 'STALE_HEAD') return { ok: false, error: 'REFUSED', detail: answer.error }
      await this.refresh()
      await this.sleep(200 + Math.floor(Math.random() * 800) * (attempt + 1))
    }
    return { ok: false, error: 'UNAVAILABLE' }
  }

  /**
   * What trusting the backend's log again would change; with `confirm`, do it. `expected` is the head
   * the person was shown in the preview: if the backend's log is not that one any more, nothing is
   * done (`LOG_CHANGED`) — what gets trusted is what was reviewed.
   */
  async rebaseline(confirm: boolean, expected?: DevLogHead): Promise<DeviceLogRebaseline | DeviceLogRebaselineChanged | null> {
    const entries: unknown[] = []
    let acct = ''
    let head: DevLogHead = emptyDevLogState('').head
    for (let page = 0; page < PAGES; page++) {
      const got = await this.deps.fetch(entries.length)
      if (!got) return null
      if (!Number.isSafeInteger(got.head.seq) || got.head.seq < 0) return null
      acct = got.acct
      head = got.head
      entries.push(...got.entries)
      if (!got.entries.length || entries.length >= got.head.seq) break
    }
    let next: DevLogState
    try {
      next = applyDevLogEntries(emptyDevLogState(acct), entries).state
    } catch { return null }
    if (next.head.seq !== head.seq || next.head.hash !== head.hash) return null
    const file = this.marks()
    const same = !!file.state && file.state.acct === next.acct
    // Another account's list while the live log is the one of the sign-in this machine is under: the
    // backend switched accounts on its own. A review must not move this machine there (the account it
    // is signed in to, and every mark on it, would go out of sight): only a sign-in switches accounts.
    // Only a sign-in by hand the file is not stamped with is that switch: none recorded, an adopted one
    // (a session this machine took over — whatever stamp the file has, or lacks, from an older version),
    // or the sign-in the file is stamped with is not.
    const local = this.deps.signIn()
    if (file.state && !same && (local === null || local.adopted || file.owner === local.epoch)) return { error: 'OTHER_ACCOUNT' }
    if (confirm && expected && (expected.seq !== next.head.seq || expected.hash !== next.head.hash)) return { error: 'LOG_CHANGED' }
    // The list under review is judged against this account's own log as this machine verified it:
    // the live file, or — for another account — the one kept when this machine left it (its marks go
    // on), or else nothing (every key on it is new here). Never against the account being left.
    const kept = same ? null : this.deps.store.archivedFile(next.acct)
    const base: DevLogFile = same ? file : kept ?? {
      state: null, recent: [], frozen: null, notifiedUpTo: 0, joinedSeq: 0, preLog: file.preLog ?? [],
      pending: [], announced: [], suspended: [], baselineSeen: true,
    }
    const before = base.state?.active ?? {}
    const added = Object.values(next.active).filter((m) => !before[m.pub])
    const removed = Object.values(before).filter((m) => !next.active[m.pub])
    if (confirm) {
      const parsed = entries.map((e) => parseDevLogEntry(e)).filter((e): e is DevLogEntry => e !== null)
      const selfPub = this.deps.identity().pub
      const signIn = this.deps.signIn()
      const preLog = new Set(base.preLog ?? [])
      const announced = base.announced ?? []
      // Every key the review let in is new here — however the preview and this read differ — unless
      // this machine knew it already or its user unpaired it.
      const news = added.filter((m) => m.pub !== selfPub && !preLog.has(m.pub) && !this.deps.blocked(m.pub))
      const toAnnounce = news.filter((m) => !announced.includes(m.pub))
      // The joined point never moves up past the reviewed head: a shorter list (rolled back, or
      // another account's) must leave every key added to it from here on news.
      const joinedSeq = Math.min(base.joinedSeq ?? base.notifiedUpTo, next.head.seq)
      // The reviewed list is another account's: the one this machine leaves is kept, as on a sign-in
      // (and what a fork suspended in it stays suspended here) — and a kept one of the reviewed account
      // goes on from where it was.
      if (file.state && !same) this.deps.store.archive(file)
      const { joining: _j, ...rest } = base
      const reviewed: DevLogFile = this.carrySuspensions({
        ...rest,
        state: next, recent: parsed.slice(-DEVLOG_RECENT), frozen: null, notifiedUpTo: next.head.seq, joinedSeq,
        firstSeen: this.stamp(base.firstSeen, added, next),
        pending: this.prune([...(base.pending ?? []), ...news.map((m) => m.pub)], next),
        announced: this.prune([...announced, ...toAnnounce.map((m) => m.pub)], next),
        // A review lifts what a fork suspended in this list; a kept list's suspensions were never in
        // the preview, so they stay.
        suspended: same ? [] : this.prune(base.suspended, next),
        looseRemoved: [], reviewedSeq: next.head.seq,
        ...this.withDeparted(base.departed, this.reviewDeparted(base, next, parsed, removed, selfPub, preLog)),
        ...(signIn ? { owner: signIn.epoch } : {}),
      })
      if (!kept || !this.deps.store.restore(next.acct, () => reviewed)) this.deps.store.write(reviewed)
      this.trustState(next, Object.values(next.active))
      for (const m of removed) this.deps.drop(m.pub)
      // The review is done: what a fork suspended is trusted again, along with the rest of the log —
      // after the drops, so a key the reviewed log removed is not pinned again on the way out.
      this.deps.resume?.()
      for (const m of toAnnounce) this.deps.announce(m)
      this.deps.changed?.()
    }
    return { head: next.head, added, removed }
  }

  /** What rides this machine's side of a `group_sync`. */
  gossip(): Record<string, unknown> | undefined {
    const file = this.deps.store.read()
    // Not this sign-in's log yet (it may be the account this machine just left): nothing to say.
    if (!file.state || !this.ownsFile(file)) return undefined
    // The newest hashes let a peer that finds the logs forked say where they split.
    const hashes = file.state.hashes.slice(-GOSSIP_HASHES).map((hash, i, all) => ({ seq: file.state!.head.seq - (all.length - 1 - i), hash }))
    return { head: file.state.head, frozen: file.frozen !== null, hashes }
  }

  /**
   * A peer's side of a `group_sync`. Returns what to answer (a responder hands back its own head, and
   * the entries the peer is missing if it is behind).
   */
  heard(peerPub: string, raw: unknown): Record<string, unknown> | undefined {
    const file = this.marks()
    const state = file.state
    // A sign-in waiting for its first read: the file may be the account left behind, and a peer of the
    // new one would freeze it as a fork. Nothing is judged until the log is this sign-in's.
    if (!this.ownsFile(file)) return undefined
    const mine = this.gossip()
    if (!state || !raw || typeof raw !== 'object') return mine
    const p = raw as { head?: unknown; frozen?: unknown; tail?: unknown }
    this.frozenPeers.set(peerPub, p.frozen === true)
    const head = p.head as { seq?: unknown; hash?: unknown } | undefined
    if (!head || typeof head.seq !== 'number' || !Number.isSafeInteger(head.seq) || head.seq < 0 || typeof head.hash !== 'string') return mine
    const theirs: DevLogHead = { seq: head.seq, hash: head.hash }
    const relation = compareDevLogHead(state, theirs)
    if (relation === 'fork') { this.freeze('fork'); this.suspendAfterFork(state, raw); return this.gossip() }
    if (relation === 'behind') {
      const tail = Array.isArray(p.tail) ? p.tail.filter((e) => (parseDevLogEntry(e)?.seq ?? 0) > state.head.seq) : []
      // A tail that does not continue this log is a fork; and a log already frozen on one can still
      // learn from this peer's hashes where it split.
      if (file.frozen || (tail.length && !this.accept(tail, false))) this.suspendAfterFork(state, raw)
      // Either way ask the backend too: if it will not serve what a peer already verified, that is a
      // rollback, and the next refresh freezes on it.
      void this.refresh()
      return this.gossip()
    }
    if (relation === 'ahead') {
      const tail = file.recent.filter((e) => e.seq > theirs.seq)
      if (tail.length && tail[0].seq === theirs.seq + 1) return { ...mine, tail }
    }
    return mine
  }

  /**
   * A fork a peer proved with its hashes: the keys added at or after the split — and new here — are
   * not trusted until the list is reviewed (rebaseline). Only locally: nothing is tombstoned or
   * written to the log. Without usable hashes (an older peer, a split outside the window, a rollback)
   * the freeze alone stands.
   */
  private suspendAfterFork(state: DevLogState, theirs: unknown): void {
    const file = this.deps.store.read()
    if (file.frozen?.reason !== 'fork') return
    const split = devLogDivergence(state, theirs)
    if (split === null) return
    const selfPub = this.deps.identity().pub
    const pending = file.pending ?? []
    // Only keys nobody here has marked as seen — and not one a review (`rebaseline --yes`) already let
    // in: another device's old branch must not cost this one the devices its user just looked at.
    const reviewed = file.reviewedSeq ?? -1
    const keys = Object.values(state.active)
      .filter((m) => m.seq >= split && m.pub !== selfPub && pending.includes(m.pub) && m.seq > reviewed)
      .map((m) => m.pub)
    const fresh = keys.filter((k) => !(file.suspended ?? []).includes(k))
    if (!fresh.length) return
    this.deps.store.write({ ...file, suspended: uniq([...(file.suspended ?? []), ...fresh]) })
    this.deps.suspend?.(fresh)
    this.deps.log?.(`[devlog] this computer's and another device's lists split at entry ${split}: not trusting ${fresh.length} key(s) added after it until you review the list (harness devices rebaseline)`)
    this.deps.changed?.()
  }

  /** Keys not trusted here after a fork, until `rebaseline` — and every key a fork suspended in the
   *  kept log of another account, which no other account's log can bring back in. */
  suspendedKeys(): string[] {
    return [...new Set([...(this.deps.store.read().suspended ?? []), ...this.deps.store.archivedSuspended()])]
  }

  /**
   * Mark new devices as seen: the ones in `pubs` (what a window displayed), one (`pub`), every one
   * (nothing named — only the explicit `harness devices dismiss`), and/or the "already on your account"
   * list (`baseline`). Persisted, so it holds across restarts. A key a fork suspended stays flagged
   * when it is only part of a list that was looked at; `pub` — "It's mine" on that very device — is the
   * person vouching for it, and lifts its suspension here (and in every kept account's log). A key that
   * joined and left before anyone looked (`departed`) is cleared the same way: named, or every one.
   */
  dismiss(opts: { pub?: string; pubs?: string[]; baseline?: boolean } = {}): void {
    const file = this.marks()
    if (!file.state) return
    const suspended = file.suspended ?? []
    const named = opts.pub !== undefined || opts.pubs !== undefined
    const gone = new Set([...(opts.pubs ?? []), ...(opts.pub !== undefined ? [opts.pub] : [])])
    const keep = (k: string): boolean => (named ? !gone.has(k) : !!opts.baseline) || (suspended.includes(k) && k !== opts.pub)
    const pending = (file.pending ?? []).filter(keep)
    const departed = (file.departed ?? []).filter((d) => (named ? !gone.has(d.pub) : !!opts.baseline))
    const lift = opts.pub !== undefined && suspended.includes(opts.pub)
    // The "already on your account" list was looked at: the first read is over, whatever comes after is
    // news — or a backend that stalls that read could add a key to a list nobody will look at again.
    const { joining: _j, ...rest } = file
    this.deps.store.write({
      ...(opts.baseline ? { ...rest, baselineSeen: true } : file), pending,
      ...(file.departed ? { departed } : {}),
      ...(lift ? { suspended: suspended.filter((k) => k !== opts.pub) } : {}),
    })
    if (lift) {
      this.deps.store.unsuspendArchived([opts.pub!])
      const member = file.state.active[opts.pub!]
      if (member) this.trustState(file.state, [member])
      this.deps.resume?.()
    }
    this.deps.changed?.()
  }

  /**
   * Every add and remove in the log, newest first, as this machine verified it: the entries come from
   * the backend but each must hash to what this machine already verified, or the log freezes. Offline,
   * what is kept locally (`complete: false`).
   */
  history(): Promise<DeviceLogHistory> {
    // One walk at a time: two interleaved on the same cache would each read the other's entries as a
    // gap in the log and freeze it.
    this.historying ??= this.historyOnce().finally(() => { this.historying = null })
    return this.historying
  }

  private async historyOnce(): Promise<DeviceLogHistory> {
    await this.refresh()
    const file = this.marks()
    const state = file.state
    if (!state) return { rows: [], complete: false, frozen: file.frozen }
    const cache = this.histCache && this.histCache.acct === state.acct ? this.histCache : { acct: state.acct, entries: [] as DevLogEntry[] }
    const last = cache.entries.at(-1)
    if (last && (last.seq > state.head.seq || devLogHash(last) !== state.hashes[last.seq - 1])) cache.entries = []
    this.histCache = cache
    for (let page = 0; page < PAGES && cache.entries.length < state.head.seq; page++) {
      const since = cache.entries.length
      const got = await this.deps.fetch(since)
      if (!got || got.acct !== state.acct) break
      let progressed = false
      for (const raw of got.entries) {
        const e = parseDevLogEntry(raw)
        const rawSeq = (raw as { seq?: unknown } | null)?.seq
        const seq = e?.seq ?? (typeof rawSeq === 'number' ? rawSeq : 0)
        if (seq <= cache.entries.length || seq > state.head.seq) continue
        // At a position this machine verified, anything unreadable or off-hash means the backend is
        // lying about the past: freeze, and show only what was already checked.
        if (!e || e.seq !== cache.entries.length + 1 || devLogHash(e) !== state.hashes[e.seq - 1]) {
          // Only against the log this walk started from: if the file was rebaselined (or moved to
          // another account) while the pages were on their way, the mismatch is with a log that is
          // gone, and says nothing about the backend.
          const now = this.deps.store.read().state
          if (!now || now.acct !== state.acct || now.head.seq !== state.head.seq || now.head.hash !== state.head.hash) {
            this.histCache = null
            return this.historyOf([], false)
          }
          this.freeze('fork')
          return this.historyOf(cache.entries, false)
        }
        cache.entries.push(e)
        progressed = true
      }
      if (!progressed) break
    }
    return this.historyOf(cache.entries, cache.entries.length >= state.head.seq)
  }

  private historyOf(fetched: readonly DevLogEntry[], complete: boolean): DeviceLogHistory {
    const file = this.deps.store.read()
    const state = file.state
    if (!state) return { rows: [], complete: false, frozen: file.frozen }
    // Offline, the newest entries kept locally fill in what could not be fetched.
    const entries = complete ? fetched : [...fetched, ...file.recent.filter((e) => e.seq > (fetched.at(-1)?.seq ?? 0))]
    const rows = devLogHistory(entries, {
      // A key that joined and left before anyone looked is still new, in its rows too.
      selfPub: this.deps.identity().pub, joinedSeq: file.joinedSeq, active: state.active, loose: file.looseRemoved,
      pending: [...(file.pending ?? []), ...(file.departed ?? []).map((d) => d.pub)],
    })
    return { rows, complete, frozen: file.frozen }
  }

  /** The account's devices as this machine's log has them, for the Devices list. */
  list(): DeviceLogListing {
    const file = this.marks()
    const selfPub = this.deps.identity().pub
    const pending = file.pending ?? []
    const suspended = file.suspended ?? []
    const members = Object.values(file.state?.active ?? {})
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ ...m, fingerprint: fp(m.pub), self: m.pub === selfPub, pending: pending.includes(m.pub), suspended: suspended.includes(m.pub) }))
    const labels = new Map(members.map((m) => [m.pub, m.label]))
    const frozenPeers = [...this.frozenPeers].filter(([, frozen]) => frozen).map(([pub]) => labels.get(pub) ?? fp(pub))
    // Each row carries when this machine first applied it (never the entry's self-chosen `at`).
    const withSeen = members.map((m) => (file.firstSeen?.[m.pub] === undefined ? m : { ...m, firstSeen: file.firstSeen[m.pub] }))
    const joinedSeq = file.joinedSeq ?? 0
    const preLog = new Set(file.preLog ?? [])
    const baseline = withSeen.filter((m) => !m.self && (m.seq <= joinedSeq || preLog.has(m.pub))).map((m) => m.pub)
    const holder = file.conflict
    const conflict = holder && file.state?.active[holder.pub] && !file.state.active[selfPub] ? holder : null
    return {
      head: file.state?.head ?? null, frozen: file.frozen, self: selfPub, members: withSeen, frozenPeers,
      pending, suspended, joinedSeq, baseline, baselineSeen: file.baselineSeen ?? true, conflict, departed: file.departed ?? [],
    }
  }
}
