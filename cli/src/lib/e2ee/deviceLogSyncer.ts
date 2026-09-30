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
 *  - announce:   a key this machine had never trusted before is a "New device: X" — the one way a device
 *    added by whoever got hold of the account (or by the backend itself) is seen.
 */
import {
  applyDevLogEntries, compareDevLogHead, DevLogError, devLogMessage, emptyDevLogState, nextDevLogEntry,
  parseDevLogEntry, signDevLogEntry, type DevLogEntry, type DevLogHead, type DevLogMember, type DevLogState,
} from './deviceLog.js'
import { DEVLOG_RECENT, type DevLogFile, type DevLogFreeze, type DeviceLogStore } from './deviceLogStore.js'
import { b64d, fingerprint, verify } from './core.js'

export interface DeviceLogFetched { acct: string; head: DevLogHead; entries: unknown[] }
export type DeviceLogAppendAnswer = { head: DevLogHead } | { error: string; head?: DevLogHead }

export interface DeviceLogSyncerDeps {
  store: DeviceLogStore
  /** This machine's identity: base64 public key and the private key that signs for it. */
  identity: () => { pub: string; priv: Uint8Array }
  /** How this machine describes itself in the log; no machineId = not signed in, nothing to register. */
  self: () => { machineId: string | null; label: string }
  /** The log from `since`; null when the backend has none to give (an older backend, or unreachable). */
  fetch: (since: number) => Promise<DeviceLogFetched | null>
  /** Append one signed entry; null when the backend could not be reached. */
  append: (entry: DevLogEntry) => Promise<DeviceLogAppendAnswer | null>
  /** Trust these keys here (and tell the trust group, so devices that predate the log learn of them). */
  adopt: (members: DevLogMember[]) => void
  /** Stop trusting a key here (and tombstone it in the trust group). */
  drop: (pub: string) => void
  /** Whether this machine already trusted `pub` before the log named it — then it is not news. */
  knownBefore: (pub: string) => boolean
  /** Whether the trust group holds a removal for `pub` that predates the log. */
  tombstoned: (pub: string) => boolean
  /** Whether this machine's user unpaired `pub` here — a local override the log never beats. */
  blocked: (pub: string) => boolean
  /** A key this machine had never trusted joined the log: "New device: X". */
  announce: (member: DevLogMember) => void
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
  members: Array<DevLogMember & { fingerprint: string; self: boolean }>
  /** Machines whose own copy of the log is frozen, as their last `group_sync` said. */
  frozenPeers: string[]
}

export type DeviceLogRemoveResult = { ok: true } | { ok: false; error: 'NOT_ACTIVE' | 'NOT_IN_LOG' | 'UNAVAILABLE' | 'REFUSED'; detail?: string }

export interface DeviceLogRebaseline {
  head: DevLogHead
  added: DevLogMember[]
  removed: DevLogMember[]
}

const APPEND_ATTEMPTS = 5
const PAGES = 20

export class DeviceLogSyncer {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private refreshing: Promise<void> | null = null
  private readonly frozenPeers = new Map<string, boolean>()
  private readonly removing = new Set<string>()
  private readonly inFlightRemovals = new Map<string, Promise<DeviceLogRemoveResult>>()

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
        const file = this.deps.store.read()
        const state = file.state
        if (!state || file.frozen) return
        if (state.removed.includes(pub)) { this.deps.signedOut(); return }
        const mine = state.active[pub]
        if (mine) {
          if (mine.label === self.label || mine.machineId !== self.machineId) return
        } else {
          const taken = Object.values(state.active).find((m) => m.kind === 'machine' && m.machineId === self.machineId)
          if (taken) {
            this.deps.log?.(`[devlog] this machine's id is held by another key (${fingerprint(b64d(taken.pub))}); remove it from another device to register this one`)
            return
          }
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

  private async doRefresh(): Promise<void> {
    // The first read of a log (a new install, or an existing sign-in from before the log existed) only
    // learns what is there: nothing in it is news, every page of it.
    let bootstrap = !this.deps.store.read().state?.head.seq
    for (let page = 0; page < PAGES; page++) {
      const file = this.deps.store.read()
      const since = file.state?.head.seq ?? 0
      const got = await this.deps.fetch(since)
      if (!got) return
      if (!file.state || file.state.acct !== got.acct) {
        // First read, or signed in to another account: that account's log starts from nothing here.
        const fresh: DevLogFile = { state: emptyDevLogState(got.acct), recent: [], frozen: null, notifiedUpTo: 0 }
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

  /** Apply entries that continue this machine's log; freeze on anything that does not. */
  private accept(entries: readonly unknown[], bootstrap: boolean): boolean {
    const file = this.deps.store.read()
    let applied
    try {
      applied = applyDevLogEntries(file.state!, entries)
    } catch (err) {
      if (!(err instanceof DevLogError)) throw err
      this.freeze(err.code === 'BROKEN_CHAIN' || err.code === 'OUT_OF_ORDER' ? 'fork' : 'invalid')
      return false
    }
    const selfPub = this.deps.identity().pub
    // Decided before anything is adopted: afterwards every one of them is "known".
    const news = bootstrap ? [] : applied.added.filter((m) =>
      m.seq > file.notifiedUpTo && m.pub !== selfPub && !this.deps.knownBefore(m.pub) && !this.deps.blocked(m.pub))
    const parsed = entries.map((e) => parseDevLogEntry(e)).filter((e): e is DevLogEntry => e !== null)
    this.deps.store.write({
      state: applied.state,
      recent: [...file.recent, ...parsed].slice(-DEVLOG_RECENT),
      frozen: null,
      notifiedUpTo: applied.state.head.seq,
    })
    this.trustState(applied.state, bootstrap ? Object.values(applied.state.active) : [...applied.added, ...applied.relabeled])
    for (const m of applied.removed) this.deps.drop(m.pub)
    for (const m of news) this.deps.announce(m)
    if (applied.state.removed.includes(selfPub)) this.deps.signedOut()
    void this.carryOverTombstones(applied.state)
    this.deps.changed?.()
    return true
  }

  private trustState(state: DevLogState, members: DevLogMember[]): void {
    const selfPub = this.deps.identity().pub
    const adopt = members.filter((m) => m.pub !== selfPub && state.active[m.pub] && !this.deps.blocked(m.pub) && !this.deps.tombstoned(m.pub))
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

  /** While frozen, a removal still counts — if a key this machine trusts signed it. */
  private looseRemovals(entries: readonly unknown[]): void {
    const file = this.deps.store.read()
    const state = file.state
    if (!state) return
    let changed = false
    for (const raw of entries) {
      const e = parseDevLogEntry(raw)
      if (!e || e.op !== 'remove' || !state.active[e.signer] || !state.active[e.pub]) continue
      if (!verify(b64d(e.signer), devLogMessage(e), b64d(e.sig))) continue
      delete state.active[e.pub]
      state.removed.push(e.pub)
      this.deps.drop(e.pub)
      changed = true
    }
    if (changed) { this.deps.store.write({ ...file, state }); this.deps.changed?.() }
  }

  private freeze(reason: DevLogFreeze['reason']): void {
    const file = this.deps.store.read()
    if (file.frozen || !file.state) return
    this.deps.store.write({ ...file, frozen: { reason, at: this.now(), lastGoodHead: file.state.head } })
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

  /** What trusting the backend's log again would change; with `confirm`, do it. */
  async rebaseline(confirm: boolean): Promise<DeviceLogRebaseline | null> {
    const entries: unknown[] = []
    let acct = ''
    let head: DevLogHead = emptyDevLogState('').head
    for (let page = 0; page < PAGES; page++) {
      const got = await this.deps.fetch(entries.length)
      if (!got) return null
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
    const file = this.deps.store.read()
    const before = file.state?.active ?? {}
    const added = Object.values(next.active).filter((m) => !before[m.pub])
    const removed = Object.values(before).filter((m) => !next.active[m.pub])
    if (confirm) {
      const parsed = entries.map((e) => parseDevLogEntry(e)).filter((e): e is DevLogEntry => e !== null)
      this.deps.store.write({ state: next, recent: parsed.slice(-DEVLOG_RECENT), frozen: null, notifiedUpTo: next.head.seq })
      this.trustState(next, Object.values(next.active))
      for (const m of removed) this.deps.drop(m.pub)
      this.deps.changed?.()
    }
    return { head: next.head, added, removed }
  }

  /** What rides this machine's side of a `group_sync`. */
  gossip(): Record<string, unknown> | undefined {
    const file = this.deps.store.read()
    if (!file.state) return undefined
    return { head: file.state.head, frozen: file.frozen !== null }
  }

  /**
   * A peer's side of a `group_sync`. Returns what to answer (a responder hands back its own head, and
   * the entries the peer is missing if it is behind).
   */
  heard(peerPub: string, raw: unknown): Record<string, unknown> | undefined {
    const file = this.deps.store.read()
    const state = file.state
    const mine = this.gossip()
    if (!state || !raw || typeof raw !== 'object') return mine
    const p = raw as { head?: unknown; frozen?: unknown; tail?: unknown }
    this.frozenPeers.set(peerPub, p.frozen === true)
    const head = p.head as { seq?: unknown; hash?: unknown } | undefined
    if (!head || typeof head.seq !== 'number' || !Number.isSafeInteger(head.seq) || head.seq < 0 || typeof head.hash !== 'string') return mine
    const theirs: DevLogHead = { seq: head.seq, hash: head.hash }
    const relation = compareDevLogHead(state, theirs)
    if (relation === 'fork') { this.freeze('fork'); return this.gossip() }
    if (relation === 'behind') {
      const tail = Array.isArray(p.tail) ? p.tail.filter((e) => (parseDevLogEntry(e)?.seq ?? 0) > state.head.seq) : []
      if (tail.length && !file.frozen) this.accept(tail, false)
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

  /** The account's devices as this machine's log has them, for the Devices list. */
  list(): DeviceLogListing {
    const file = this.deps.store.read()
    const selfPub = this.deps.identity().pub
    const members = Object.values(file.state?.active ?? {})
      .sort((a, b) => a.seq - b.seq)
      .map((m) => ({ ...m, fingerprint: fingerprint(b64d(m.pub)), self: m.pub === selfPub }))
    const labels = new Map(members.map((m) => [m.pub, m.label]))
    const frozenPeers = [...this.frozenPeers].filter(([, frozen]) => frozen).map(([pub]) => labels.get(pub) ?? fingerprint(b64d(pub)))
    return { head: file.state?.head ?? null, frozen: file.frozen, self: selfPub, members, frozenPeers }
  }
}
