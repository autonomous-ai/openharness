/**
 * Keeps this machine's trust group (trustGroup.ts) in step with every other member, and turns what the
 * roster says into the two trust stores that actually gate a connection:
 *   - machinePeers.json — the key this machine expects when it DIALS a machine member;
 *   - paired.json (through E2eeManager) — the keys allowed to open a session HERE.
 *
 * Both halves of the exchange are one sealed RPC, `group_sync`, over the ordinary relay session: the
 * dialer sends its roster and itself, the dialed machine merges, answers with its own, and the dialer
 * merges that. Whatever changed is then pushed on to the other members, so a link made anywhere
 * reaches everyone who is online, and the rest catch up on their next contact.
 */
import type { Frame, LocalClientSink } from '../../backendSocket.js'
import type { RelaySession } from '../remoteRelay.js'
import type { MachinePeerStore } from './machinePeers.js'
import type { LinkedPeer } from './manager.js'
import type { PairedClient } from './store.js'
import { parseMember, parseRoster, rosterDigest, type GroupMember, type MergeResult, type Roster, type TrustGroupStore } from './trustGroup.js'

/** The device key log's side of a `group_sync` (deviceLogSyncer.ts): its head rides every exchange, so
 *  two devices shown different logs find out, and one that is behind is handed what it is missing. */
export interface GroupSyncLogGossip {
  /** What this machine sends with its roster. */
  gossip: () => Record<string, unknown> | undefined
  /** What a peer sent; returns what to answer with (a responder's own head, and entries the peer lacks). */
  heard: (peerPub: string, raw: unknown) => Record<string, unknown> | undefined
}

export const GROUP_SYNC = 'group_sync'
/** The stamp a device's description of ITSELF carries: older than anything, so any removal beats it and
 *  a removed device cannot sync its way back in — only a new link (stamped now) can. */
export const SELF_STAMP = 1
const SYNC_TIMEOUT_MS = 20_000
const PERIODIC_MS = 10 * 60_000
/** A machine synced this recently is not synced again just because a session to it opened. */
const RECONTACT_MS = 5 * 60_000
/** After a round where a member could not be reached (or refused, having not heard of this machine yet),
 *  try again this soon — then less often. The periodic round takes over after the last. */
const RETRY_MS = [15_000, 60_000, 4 * 60_000]

export interface GroupSyncerDeps {
  store: TrustGroupStore
  peers: MachinePeerStore
  /** This machine, as the group should know it (stamped SELF_STAMP). */
  self: () => GroupMember
  /** Allow `peer` to open a session here (idempotent). */
  trust: (peer: LinkedPeer) => void
  /** Stop allowing `pub` here; drops its live sessions. */
  untrust: (pub: string) => void
  /** paired.json, for seeding the roster from links made before the group existed. */
  paired: () => PairedClient[]
  /** One sealed request/response with a machine over the relay; null when it could not be reached or
   *  did not answer (an older machine answers nothing for an unknown type). */
  request: (machineId: string, frame: Frame, timeoutMs: number) => Promise<Frame | null>
  /** Close every open relay session to a machine the group removed — a lingering one would otherwise
   *  keep working after its pin is gone, since a pooled session is reused without looking again. */
  dropSessions?: (machineId: string) => void
  /** Keys a fork put out of trust here until reviewed (deviceLogSyncer.ts): never pinned, trusted or dialed. */
  suspended?: () => ReadonlySet<string>
  /** Machines worth dialing now; null = unknown, try every member. */
  reachable?: () => Set<string> | null
  /** Whether the roster here is the account's this machine is signed in to (deviceLogSyncer `current`).
   *  While not, nothing is swapped: a daemon started after a switch of accounts read the new account's
   *  log only after its first rounds, and handed the roster of the account it left to the new one's
   *  machines. */
  ready?: () => boolean
  now?: () => number
  log?: (line: string) => void
}

export class GroupSyncer {
  private readonly now: () => number
  private readonly lastSynced = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private fanOutTimer: ReturnType<typeof setTimeout> | null = null
  private periodic: ReturnType<typeof setInterval> | null = null
  private retryRound = 0
  /** Bumped when the account changes: an exchange started before is not merged into the new roster. */
  private generation = 0
  /** Set once the device key log is wired up; the exchange works without it, as with an older peer. */
  devlog: GroupSyncLogGossip | null = null
  /** A member the GROUP removed (a tombstone that arrived by `group_sync` — from a device that
   *  predates the device key log, say): the log must hear of it too, or it would trust the key again. */
  onDropped: ((pub: string) => void) | null = null

  constructor(private readonly deps: GroupSyncerDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Seed the roster from links that predate it, re-apply it to the trust stores, and start the
   *  periodic catch-up. Safe to call once per daemon. */
  start(): void {
    this.seedFromExistingLinks()
    this.applyAll()
    this.scheduleFanOut(30_000)
    this.periodic = setInterval(() => this.scheduleFanOut(0), PERIODIC_MS)
    this.periodic.unref?.()
  }

  stop(): void {
    if (this.periodic) clearInterval(this.periodic)
    if (this.fanOutTimer) clearTimeout(this.fanOutTimer)
    this.periodic = null
    this.fanOutTimer = null
  }

  roster(): Roster { return this.deps.store.read() }

  /** The trust stores were swapped for another account's (accountTrust.ts): who was synced, and what is
   *  on its way, belong to the one left. */
  reset(): void {
    this.generation++
    this.lastSynced.clear()
    this.inFlight.clear()
  }

  /** A device just linked to or from this machine over the remote password: it joins the group, and the
   *  rest of the group hears of it. */
  linked(peer: LinkedPeer): void {
    if (!peer.kind) return // an older joiner that did not say what it is — it stays a plain pairing
    const member = parseMember({ ...peer, at: this.now() }, this.now())
    if (!member) return
    this.deps.store.unblock(member.pub) // linking again is the way back after an unpair
    this.apply(this.deps.store.add(member, this.selfPub()))
    this.scheduleFanOut(0)
  }

  /** Remove a member everywhere (`harness group remove`, `harness link unlink`). */
  remove(pub: string): boolean {
    const known = this.deps.store.read().members.some((m) => m.pub === pub)
    const result = this.deps.store.remove(pub, this.selfPub(), this.now())
    this.apply(result)
    // Not in the roster (a link that predates it): still stop trusting it here.
    if (!known) this.forget(pub)
    this.scheduleFanOut(0)
    return known || result.dropped.length > 0
  }

  /** A fork put these keys out of trust here: unpin, untrust and stop dialing them — locally only (no
   *  tombstone, so nothing is removed for anyone else) until `resume`. */
  suspend(pubs: readonly string[]): void {
    for (const pub of pubs) this.forget(pub)
  }

  /** The suspension was lifted (a review): pin and trust the roster again. */
  resume(): void {
    this.applyAll()
  }

  /** This machine's user unpaired `pub` (`harness unpair`): stop trusting and dialing it HERE, and keep
   *  it that way — without this the next round would put back what the roster still names. */
  unpaired(pub: string): void {
    this.deps.store.block(pub)
    this.forget(pub)
  }

  /** Keys the device key log holds (deviceLogSyncer.ts): members of the group like any link, stamped
   *  when they joined the log, so a device that predates the log hears of them through the group. A key
   *  the roster holds already, as it is, is trusted here too if it is not: the merge has nothing new to
   *  say about it, and when it was all that trusted a key, one roster that outran this machine's trust
   *  (a crash between the two writes, a peer's roster first) kept that device out for good. */
  adoptFromLog(members: Array<{ pub: string; kind: GroupMember['kind']; machineId: string; label: string; addedAt: number }>): void {
    const now = this.now()
    const parsed = members
      .map((m) => parseMember({ pub: m.pub, kind: m.kind, label: m.label, at: Math.min(m.addedAt, now), ...(m.machineId ? { machineId: m.machineId } : {}) }, now))
      .filter((m): m is GroupMember => m !== null)
    if (!parsed.length) return
    const before = rosterDigest(this.deps.store.read())
    const merged = this.deps.store.merge({ members: parsed, removed: [] }, this.selfPub())
    const paired = new Set(this.deps.paired().map((p) => p.identityPub))
    const untrusted = merged.roster.members.filter((m) =>
      !paired.has(m.pub) && parsed.some((p) => p.pub === m.pub) && !merged.upserted.some((u) => u.pub === m.pub))
    const result = { ...merged, upserted: [...merged.upserted, ...untrusted] }
    this.apply(result)
    if (rosterDigest(result.roster) !== before) this.scheduleFanOut(1_000)
  }

  /** Whether the group removed `pub` and nothing has put it back. */
  tombstoned(pub: string): boolean {
    const roster = this.deps.store.read()
    return roster.removed.some((t) => t.pub === pub) && !roster.members.some((m) => m.pub === pub)
  }

  /** Whether `pub` is a member of the group. */
  isMember(pub: string): boolean {
    return this.deps.store.read().members.some((m) => m.pub === pub)
  }

  /** Whether this machine's user unpaired `pub` here. */
  isBlocked(pub: string): boolean {
    return this.deps.store.blocked().has(pub)
  }

  /** A session to `machineId` just opened: a good moment to compare rosters, unless we just did. */
  sessionOpened(machineId: string): void {
    const last = this.lastSynced.get(machineId) ?? 0
    if (this.now() - last < RECONTACT_MS) return
    void this.syncWith(machineId)
  }

  /** Responder side of `group_sync`, for a sealed request from the session identity `peerPub`. */
  handle(peerPub: string, payload: Record<string, unknown>): Record<string, unknown> {
    if (this.deps.ready?.() === false) {
      const none: Roster = { members: [], removed: [] }
      return { ...none, digest: rosterDigest(none) }
    }
    const now = this.now()
    const incoming = parseRoster(payload, now)
    const self = parseMember(payload.self, now)
    // A peer may describe only itself — its `self` must be the key its session proved.
    if (self && self.pub === peerPub) incoming.members.push(self)
    const before = rosterDigest(this.deps.store.read())
    const result = this.deps.store.merge(incoming, this.selfPub())
    this.apply(result)
    // A member that reached us is one we can reach: put back a pin the relay dropped when this machine
    // dialed it before it had heard of us (remoteRelay.ts unlinks a peer that answers e2e_denied).
    this.applyAll()
    if (rosterDigest(result.roster) !== before) this.scheduleFanOut(1_000)
    const devlog = this.devlog?.heard(peerPub, payload.devlog)
    return { self: this.deps.self(), ...result.roster, digest: rosterDigest(result.roster), ...(devlog ? { devlog } : {}) }
  }

  /** Initiator side: exchange rosters with one machine; true when it answered. Never throws. */
  syncWith(machineId: string): Promise<boolean> {
    const running = this.inFlight.get(machineId)
    if (running) return running
    const task = this.exchange(machineId).catch(() => false).finally(() => this.inFlight.delete(machineId))
    this.inFlight.set(machineId, task)
    return task
  }

  /** Every reachable machine member (and every machine pinned outside the roster), one at a time. */
  async syncAll(): Promise<void> {
    if (this.deps.ready?.() === false) { this.retryLater(); return }
    // Put back any pin the relay dropped. A member can hear of another before that one hears of it,
    // and its first dial is then refused — remoteRelay.ts unlinks a peer that answers e2e_denied. The
    // roster still says they belong together, so they are re-pinned and tried again on this round.
    this.applyAll()
    const reachable = this.deps.reachable?.() ?? null
    const self = this.deps.self().machineId
    const targets = new Set<string>()
    const suspended = this.deps.suspended?.() ?? new Set<string>()
    for (const m of this.deps.store.read().members) if (m.kind === 'machine' && m.machineId && !suspended.has(m.pub)) targets.add(m.machineId)
    for (const p of this.deps.peers.list()) if (!suspended.has(p.pub)) targets.add(p.machineId)
    if (self) targets.delete(self)
    // All at once: one machine that never answers (offline, or too old to know the frame) must not
    // hold up the rest for its whole timeout.
    const due = [...targets].filter((machineId) => !reachable || reachable.has(machineId))
    const answered = await Promise.all(due.map((machineId) => this.syncWith(machineId)))
    const members = new Set(this.deps.store.read().members.map((m) => m.machineId))
    const missed = due.some((machineId, i) => !answered[i] && members.has(machineId))
    if (!missed) { this.retryRound = 0; return }
    this.retryLater()
  }

  private retryLater(): void {
    const delay = RETRY_MS[this.retryRound]
    if (delay === undefined) return // the periodic round takes over
    this.retryRound++
    this.scheduleFanOut(delay, true)
  }

  private async exchange(machineId: string): Promise<boolean> {
    const pin = this.deps.peers.get(machineId)
    if (!pin || this.deps.ready?.() === false) return false
    const generation = this.generation
    const local = this.deps.store.read()
    const devlog = this.devlog?.gossip()
    const reply = await this.deps.request(machineId, {
      type: GROUP_SYNC,
      payload: {
        requestId: `gs-${this.now()}-${Math.random().toString(36).slice(2, 8)}`, self: this.deps.self(), ...local, digest: rosterDigest(local),
        ...(devlog ? { devlog } : {}),
      },
    }, SYNC_TIMEOUT_MS).catch(() => null)
    if (!reply || generation !== this.generation) return false
    this.lastSynced.set(machineId, this.now())
    const payload = (reply.payload ?? {}) as Record<string, unknown>
    if (typeof payload.error === 'string') return false
    const now = this.now()
    const incoming = parseRoster(payload, now)
    const theirSelf = parseMember(payload.self, now)
    // The answering machine may describe only itself, as the key this machine dialed and verified.
    if (theirSelf && theirSelf.pub === pin.pub && theirSelf.machineId === machineId) incoming.members.push(theirSelf)
    if (payload.devlog !== undefined) this.devlog?.heard(pin.pub, payload.devlog)
    // Compared with the roster as it is now, not the one sent: a link can land while this was in flight.
    const before = rosterDigest(this.deps.store.read())
    const result = this.deps.store.merge(incoming, this.selfPub())
    this.apply(result)
    if (rosterDigest(result.roster) !== before) {
      this.deps.log?.(`[group] ${machineId.slice(0, 8)}: +${result.upserted.length} −${result.dropped.length}`)
      this.scheduleFanOut(1_000)
    }
    return true
  }

  /** `retry`: a follow-up to a round that missed someone. Anything else is news, which starts the
   *  retry schedule over. */
  private scheduleFanOut(delayMs: number, retry = false): void {
    if (!retry) this.retryRound = 0
    if (this.fanOutTimer) return
    this.fanOutTimer = setTimeout(() => {
      this.fanOutTimer = null
      // What changed reaches every member, not just the recently-contacted ones.
      this.lastSynced.clear()
      void this.syncAll().catch(() => { /* next round */ })
    }, delayMs)
    this.fanOutTimer.unref?.()
  }

  private selfPub(): string { return this.deps.self().pub }

  /** Links made before the group existed: every pinned machine and every paired peer that said what it is. */
  private seedFromExistingLinks(): void {
    const seed: GroupMember[] = []
    for (const p of this.deps.peers.list()) {
      const m = parseMember({ pub: p.pub, machineId: p.machineId, kind: 'machine', label: p.label, at: p.linkedAt || SELF_STAMP }, this.now())
      if (m) seed.push(m)
    }
    for (const p of this.deps.paired()) {
      if (!p.kind) continue
      const m = parseMember({ pub: p.identityPub, machineId: p.machineId, kind: p.kind, label: p.label, at: p.pairedAt || SELF_STAMP }, this.now())
      if (m) seed.push(m)
    }
    if (seed.length) this.deps.store.merge({ members: seed, removed: [] }, this.selfPub())
  }

  private applyAll(): void {
    const roster = this.deps.store.read()
    this.apply({ roster, upserted: roster.members, dropped: [] })
  }

  private apply(result: MergeResult): void {
    const selfMachine = this.deps.self().machineId
    const blocked = this.deps.store.blocked()
    const suspended = this.deps.suspended?.() ?? new Set<string>()
    for (const m of result.upserted) {
      if (blocked.has(m.pub) || suspended.has(m.pub)) continue
      try {
        if (m.kind === 'machine' && m.machineId && m.machineId !== selfMachine) {
          const pin = this.deps.peers.get(m.machineId)
          if (!pin || pin.pub !== m.pub) this.deps.peers.pin(m.machineId, m.pub, m.label, m.at)
        }
        this.deps.trust({ pub: m.pub, machineId: m.machineId, kind: m.kind, label: m.label })
      } catch (err) {
        this.deps.log?.(`[group] could not apply ${m.pub.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    for (const m of result.dropped) {
      this.forget(m.pub)
      try { this.onDropped?.(m.pub) } catch { /* the removal here stands */ }
    }
  }

  private forget(pub: string): void {
    try {
      for (const p of this.deps.peers.list()) {
        if (p.pub !== pub) continue
        this.deps.peers.unlink(p.machineId)
        this.deps.dropSessions?.(p.machineId)
      }
      this.deps.untrust(pub)
    } catch (err) {
      this.deps.log?.(`[group] could not remove ${pub.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** `GroupSyncerDeps.request` over a background relay session (its own pool — it never takes the
 *  window's sink): select the machine, send one sealed frame, wait for its `_result`, detach. */
export function relayRequester(
  pool: { acquireIsolated: (machineId: string, autonomousEnv: string, selectFrame: Frame, sink: LocalClientSink, onClosed: (code: number, reason: string) => void) => Promise<RelaySession> },
  autonomousEnv: () => string,
): GroupSyncerDeps['request'] {
  return (machineId, frame, timeoutMs) => new Promise<Frame | null>((resolve) => {
    const requestId = (frame.payload as Record<string, unknown> | undefined)?.requestId
    let session: RelaySession | null = null
    let done = false
    const finish = (result: Frame | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      session?.detach()
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const sink: LocalClientSink = {
      sendFrame: (f) => {
        const p = (f.payload ?? {}) as Record<string, unknown>
        if (f.type === `${frame.type}_result` && p.requestId === requestId) finish(f)
        return true
      },
      sendBinary: () => true,
    }
    pool.acquireIsolated(machineId, autonomousEnv(), { type: 'machine_select', payload: { machineId } }, sink, () => finish(null))
      .then((s) => {
        session = s
        if (done) { s.detach(); return }
        return s.send(frame)
      })
      .catch(() => finish(null))
  })
}
