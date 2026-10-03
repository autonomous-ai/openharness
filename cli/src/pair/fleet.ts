/**
 * The fleet: every harness on every machine, as the brain on this computer sees it (daemons/BRAIN.md).
 *
 * This machine's harnesses come straight from its own PairSensor. Every other LINKED machine is read
 * through a background relay session (`RemoteRelayPool.acquireIsolated`) and sealed `pair_*` requests:
 * one `pair_watch` for a snapshot and the `pair_event` pushes after it, `pair_journal` for what happened
 * while nobody watched. A machine that is not linked cannot be read and stays invisible (status
 * `unlinked`); one whose daemon predates the pair brain answers UNSUPPORTED (status `old`).
 *
 * A remote daemon that restarts drops its E2EE session without closing our socket, and its pushes simply
 * stop. So the watch is renewed on a timer: a renewal that fails is a machine to reconnect to, and a
 * renewal that succeeds replaces the state wholesale (it is a fresh snapshot).
 */
import type { PairEvent, PairHarness, PairJournalEntry, PairJournalPage, PairSnapshot } from './protocol.js'

/**
 * `asleep`: the account's list says the machine is offline (a closed laptop) — calm, never a failure.
 * `unreachable`: it should be up and did not answer.
 */
export type MachineStatus = 'ok' | 'connecting' | 'unreachable' | 'asleep' | 'unlinked' | 'old' | 'off'

export interface FleetMachineInfo {
  machineId: string
  name: string
  /** A pinned peer key exists (`harness link connect`). Without one nothing can be read. */
  linked: boolean
  /** False when the account's list already says it is offline: named unreachable, not dialled. */
  online?: boolean
}

/** One relay session to one machine, speaking sealed `pair_*`. */
export interface PairLink {
  request: (type: string, payload: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>
  close: () => void
}

export type PairLinkOpener = (
  machineId: string,
  on: { event: (event: PairEvent) => void; closed: (reason: string) => void },
) => Promise<PairLink>

export interface FleetLocal {
  machineId: () => string
  name: () => string
  snapshot: () => PairSnapshot
  subscribe: (listener: (event: PairEvent) => void) => () => void
  journal: (payload: Record<string, unknown>) => PairJournalPage
}

export interface FleetChange {
  machineId: string
  machine: string
  local: boolean
  /** A harness changed (null when only the machine's status did). */
  event: PairEvent | null
  status?: MachineStatus
}

export interface FleetDeps {
  local: FleetLocal
  /** The account's OTHER machines. */
  machines: () => FleetMachineInfo[]
  open: PairLinkOpener
  onChange: (change: FleetChange) => void
  now?: () => number
  requestTimeoutMs?: number
  renewMs?: number
  /** How often the machine list is re-read and unreachable machines retried while running. */
  syncMs?: number
}

interface Remote {
  machineId: string
  name: string
  status: MachineStatus
  harnesses: Map<string, PairHarness>
  rev: number
  link: PairLink | null
  failures: number
  retryAt: number
  renew: ReturnType<typeof setInterval> | null
  /** Bumped on every (re)connect, so a late answer from a superseded link is ignored. */
  generation: number
  /** Settles once a dial in progress has its first snapshot (or has failed). */
  connecting: Promise<void> | null
}

export interface FleetHarness { machineId: string; machine: string; local: boolean; harness: PairHarness }

export interface MachineJournal {
  machineId: string
  machine: string
  local: boolean
  entries: PairJournalEntry[]
  error?: string
}

const REQUEST_TIMEOUT_MS = 8_000
const RENEW_MS = 2 * 60_000
const SYNC_MS = 30_000
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 5 * 60_000

export class PairFleet {
  private readonly remotes = new Map<string, Remote>()
  private unsubscribe: (() => void) | null = null
  private localHarnesses = new Map<string, PairHarness>()
  private running = false
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly deps: FleetDeps) {
    this.now = deps.now ?? Date.now
  }

  get isRunning(): boolean { return this.running }

  start(): void {
    if (this.running) return
    this.running = true
    this.localHarnesses = new Map(this.deps.local.snapshot().harnesses.map((h) => [h.agentId, h]))
    this.unsubscribe = this.deps.local.subscribe((event) => {
      if (event.harness) this.localHarnesses.set(event.agentId, event.harness)
      else this.localHarnesses.delete(event.agentId)
      this.deps.onChange({ machineId: this.deps.local.machineId(), machine: this.deps.local.name(), local: true, event })
    })
    this.syncTimer = setInterval(() => this.sync(), this.deps.syncMs ?? SYNC_MS)
    this.sync()
  }

  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null }
    for (const remote of this.remotes.values()) this.disconnect(remote)
    this.remotes.clear()
  }

  /** Bring the set of watched machines in line with the account's list: connect what is new or due. */
  sync(): void {
    if (!this.running) return
    const self = this.deps.local.machineId()
    const listed = this.deps.machines().filter((m) => m.machineId && m.machineId !== self)
    const ids = new Set(listed.map((m) => m.machineId))
    for (const [id, remote] of [...this.remotes]) {
      if (ids.has(id)) continue
      this.disconnect(remote)
      this.remotes.delete(id)
      this.deps.onChange({ machineId: id, machine: remote.name, local: false, event: null, status: 'off' })
    }
    for (const info of listed) {
      let remote = this.remotes.get(info.machineId)
      if (!remote) {
        remote = { machineId: info.machineId, name: info.name, status: 'connecting', harnesses: new Map(), rev: 0,
          link: null, failures: 0, retryAt: 0, renew: null, generation: 0, connecting: null }
        this.remotes.set(info.machineId, remote)
      }
      remote.name = info.name || remote.name
      if (!info.linked) { this.setStatus(remote, 'unlinked'); continue }
      if (remote.link || remote.status === 'old') continue
      if (info.online === false) { this.setStatus(remote, 'asleep'); continue }
      if (remote.status === 'unreachable' && this.now() < remote.retryAt) continue
      if (remote.connecting) continue
      const connecting = this.connect(remote).finally(() => { if (remote.connecting === connecting) remote.connecting = null })
      remote.connecting = connecting
    }
  }

  harnesses(): FleetHarness[] {
    const local = this.deps.local
    const out: FleetHarness[] = [...this.localHarnesses.values()]
      .map((harness) => ({ machineId: local.machineId(), machine: local.name(), local: true, harness }))
    for (const remote of this.remotes.values()) {
      for (const harness of remote.harnesses.values()) out.push({ machineId: remote.machineId, machine: remote.name, local: false, harness })
    }
    return out
  }

  machines(): Array<{ machineId: string; name: string; status: MachineStatus; local: boolean }> {
    return [
      { machineId: this.deps.local.machineId(), name: this.deps.local.name(), status: 'ok', local: true },
      ...[...this.remotes.values()].map((r) => ({ machineId: r.machineId, name: r.name, status: r.status, local: false })),
    ]
  }

  find(machineId: string, agentId: string): FleetHarness | null {
    return this.harnesses().find((h) => h.machineId === machineId && h.harness.agentId === agentId) ?? null
  }

  /** A request to one remote machine over its watch link. Throws when the machine cannot be reached. */
  async request(machineId: string, type: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const remote = this.remotes.get(machineId)
    if (!remote?.link) throw new Error(remote ? `MACHINE_${remote.status.toUpperCase()}` : 'UNKNOWN_MACHINE')
    return remote.link.request(type, payload, timeoutMs ?? this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
  }

  /**
   * Every machine's journal since `at`, this one's included — each asked in parallel and given
   * `timeoutMs` (3 s for the brief). A machine that does not answer in time is named, not waited for.
   */
  async journals(at: number, timeoutMs: number): Promise<MachineJournal[]> {
    const local = this.deps.local
    const mine: MachineJournal = { machineId: local.machineId(), machine: local.name(), local: true, entries: local.journal({ at }).entries }
    const remote = await Promise.all([...this.remotes.values()].map(async (r): Promise<MachineJournal | null> => {
      // A machine still being dialled (the brain just woke for this return) gets the same few seconds.
      if (r.connecting) await this.withTimeout(r.connecting, timeoutMs).catch(() => {})
      if (r.status === 'unlinked' || r.status === 'old' || r.status === 'off') return null
      if (!r.link) return { machineId: r.machineId, machine: r.name, local: false, entries: [], error: r.status === 'asleep' ? 'asleep' : 'unreachable' }
      try {
        const page = await this.withTimeout(r.link.request('pair_journal', { at }, timeoutMs), timeoutMs)
        if (typeof page.error === 'string') return { machineId: r.machineId, machine: r.name, local: false, entries: [], error: page.error }
        return { machineId: r.machineId, machine: r.name, local: false, entries: Array.isArray(page.entries) ? page.entries as PairJournalEntry[] : [] }
      } catch {
        return { machineId: r.machineId, machine: r.name, local: false, entries: [], error: 'unreachable' }
      }
    }))
    return [mine, ...remote.filter((j): j is MachineJournal => j !== null)]
  }

  // ── one remote machine ────────────────────────────────────────────────────────────────────────────

  private async connect(remote: Remote): Promise<void> {
    const generation = ++remote.generation
    this.setStatus(remote, 'connecting')
    let link: PairLink
    try {
      link = await this.deps.open(remote.machineId, {
        event: (event) => { if (remote.generation === generation) this.apply(remote, event) },
        closed: (reason) => { if (remote.generation === generation) this.lost(remote, reason) },
      })
    } catch (err) {
      if (remote.generation !== generation) return
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'NO_PEER_LINK') this.setStatus(remote, 'unlinked')
      else this.fail(remote)
      return
    }
    if (!this.running || remote.generation !== generation) { link.close(); return }
    remote.link = link
    await this.watch(remote, generation)
    if (remote.link === link && !remote.renew) {
      remote.renew = setInterval(() => { void this.watch(remote, remote.generation) }, this.deps.renewMs ?? RENEW_MS)
    }
  }

  /** Ask for the snapshot (again). A snapshot replaces the machine's state outright. */
  private async watch(remote: Remote, generation: number): Promise<void> {
    const link = remote.link
    if (!link) return
    let result: Record<string, unknown>
    try {
      result = await link.request('pair_watch', {}, this.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)
    } catch {
      if (remote.generation === generation) this.fail(remote)
      return
    }
    if (remote.generation !== generation) return
    const error = typeof result.error === 'string' ? result.error : null
    if (error === 'UNSUPPORTED') { this.disconnect(remote); this.setStatus(remote, 'old'); return }
    if (error === 'PAIR_OFF') { this.clear(remote); this.setStatus(remote, 'off'); return }
    const snapshot = result.snapshot as PairSnapshot | undefined
    if (error || !snapshot || !Array.isArray(snapshot.harnesses)) { this.fail(remote); return }
    remote.failures = 0
    remote.rev = typeof snapshot.rev === 'number' ? snapshot.rev : 0
    const before = new Set(remote.harnesses.keys())
    remote.harnesses = new Map(snapshot.harnesses.map((h) => [h.agentId, h]))
    this.setStatus(remote, 'ok')
    // The snapshot is a baseline: whatever it holds was already true, so the brain moves its state and
    // says nothing about it (no journal entry rides a snapshot).
    for (const h of remote.harnesses.values()) {
      before.delete(h.agentId)
      this.deps.onChange({ machineId: remote.machineId, machine: remote.name, local: false,
        event: { machineId: remote.machineId, rev: remote.rev, agentId: h.agentId, harness: h, baseline: true } })
    }
    for (const gone of before) {
      this.deps.onChange({ machineId: remote.machineId, machine: remote.name, local: false,
        event: { machineId: remote.machineId, rev: remote.rev, agentId: gone, harness: null, removed: true, baseline: true } })
    }
  }

  private apply(remote: Remote, raw: PairEvent): void {
    if (!raw || typeof raw.agentId !== 'string' || typeof raw.rev !== 'number' || raw.rev <= remote.rev) return
    remote.rev = raw.rev
    // Whose event it is is decided by the link it came over, never by what the event says.
    const event: PairEvent = { ...raw, machineId: remote.machineId }
    if (event.harness) remote.harnesses.set(event.agentId, event.harness)
    else remote.harnesses.delete(event.agentId)
    this.deps.onChange({ machineId: remote.machineId, machine: remote.name, local: false, event })
  }

  private lost(remote: Remote, _reason: string): void {
    this.disconnect(remote)
    this.fail(remote)
  }

  private fail(remote: Remote): void {
    this.disconnect(remote)
    remote.failures++
    remote.retryAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (remote.failures - 1))
    this.setStatus(remote, 'unreachable')
  }

  private disconnect(remote: Remote): void {
    remote.generation++
    if (remote.renew) { clearInterval(remote.renew); remote.renew = null }
    const link = remote.link
    remote.link = null
    try { link?.close() } catch { /* already gone */ }
  }

  private clear(remote: Remote): void {
    for (const agentId of [...remote.harnesses.keys()]) {
      remote.harnesses.delete(agentId)
      this.deps.onChange({ machineId: remote.machineId, machine: remote.name, local: false,
        event: { machineId: remote.machineId, rev: remote.rev, agentId, harness: null, removed: true, baseline: true } })
    }
  }

  private setStatus(remote: Remote, status: MachineStatus): void {
    // A machine that cannot be reached for a moment keeps what it last said (marked by its status); one
    // that cannot be read at all, or has pairing off, has nothing to show.
    if (status === 'unlinked' || status === 'old' || status === 'off') this.clear(remote)
    if (remote.status === status) return
    remote.status = status
    this.deps.onChange({ machineId: remote.machineId, machine: remote.name, local: false, event: null, status })
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
  }
}

/**
 * The production opener: a background relay session per machine (`acquireIsolated`, so the window's own
 * session is never displaced) carrying sealed `pair_*` requests. Correlates replies by requestId; the
 * relay client has already opened each sealed frame and dropped any pair frame the relay wrote itself.
 */
export function relayPairLinkOpener(deps: {
  acquire: (machineId: string, sink: { sendFrame: (frame: Record<string, unknown>) => boolean; sendBinary: (frame: Uint8Array) => boolean },
    onClosed: (code: number, reason: string) => void) => Promise<{ send: (frame: Record<string, unknown>) => Promise<void>; detach: () => void }>
  newId: () => string
}): PairLinkOpener {
  return async (machineId, on) => {
    const pending = new Map<string, { resolve: (payload: Record<string, unknown>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    let closed = false
    const failAll = (reason: string): void => {
      for (const [id, wait] of pending) { clearTimeout(wait.timer); wait.reject(new Error(reason)); pending.delete(id) }
    }
    const session = await deps.acquire(machineId, {
      sendFrame: (frame) => {
        if (closed) return false
        const type = typeof frame.type === 'string' ? frame.type : ''
        const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload as Record<string, unknown> : {}
        if (type === 'pair_event') { on.event(payload as unknown as PairEvent); return true }
        if (type.startsWith('pair_') && type.endsWith('_result') && typeof payload.requestId === 'string') {
          const wait = pending.get(payload.requestId)
          if (wait) { clearTimeout(wait.timer); pending.delete(payload.requestId); wait.resolve(payload) }
        }
        return true
      },
      sendBinary: () => !closed,
    }, (_code, reason) => {
      if (closed) return
      closed = true
      failAll('closed')
      on.closed(reason || 'closed')
    })
    return {
      request: (type, payload, timeoutMs) => new Promise((resolve, reject) => {
        if (closed) { reject(new Error('closed')); return }
        const requestId = deps.newId()
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('timeout')) }, timeoutMs)
        pending.set(requestId, { resolve, reject, timer })
        session.send({ type, payload: { ...payload, requestId } }).catch((err) => {
          clearTimeout(timer)
          pending.delete(requestId)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      }),
      close: () => {
        if (closed) return
        closed = true
        failAll('closed')
        // Stop the far side pushing into a session that is going back on the shelf.
        void session.send({ type: 'pair_watch', payload: { requestId: deps.newId(), off: true } }).catch(() => {})
        session.detach()
      },
    }
  }
}
