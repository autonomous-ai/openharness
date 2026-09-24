// The owner's machines, and which of them is this computer.
//
// A REST read, not a socket subscription — and that is the point. `GET /api/machines` is already proxied
// by this daemon with its own SSO session (cli.ts `proxyBackend`), which is exactly what the desktop app
// consumes; reusing it means the dial's wheel and the app's machine list cannot disagree, and it means the
// wheel exists before any lane to another machine does.
//
// The cache is SYNCHRONOUS to read. The cable session ticks every second and must never await a network
// call to decide whether to redraw a list that has not changed.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { env } from '../config/env.js'
import type { FleetMachine } from '../cable/machineFleet.js'

/** What `GET /api/machines` returns per row (MachineService.toOwner). Only the fields the dial uses. */
interface OwnerMachine {
  machineId?: unknown
  computerId?: unknown
  name?: unknown
  hostname?: unknown
  status?: unknown
  authMode?: unknown
}

/** A fleet row plus the flag the wheel needs; `local` is derived here and nowhere else. */
export type ListedMachine = FleetMachine & { local: boolean }

/**
 * Compare two computer ids the way the backend stores them.
 *
 * BOTH sides must be normalized and it is not defensive padding: this CLI mints a dashed `randomUUID()`
 * while the backend de-dashes and lowercases before storing, so a raw `===` never matches and every
 * machine — including this computer's own — reads as remote.
 */
export function sameComputer(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase().replace(/-/g, '')
  const na = norm(a)
  return na.length > 0 && na === norm(b)
}

export type MachineSource = 'backend' | 'local' | 'signed-out'

/** How long an UNCHANGED list may go without a rewrite — see `saveCache`. Matches the refresh poll. */
const REWRITE_UNCHANGED_AFTER_MS = 60_000

/** Where the cache lives. Exported so sign-out can delete exactly the file this class writes. */
export function machineListCachePath(dataDir = env.ADAPTER_DATA_DIR): string {
  return join(dataDir, 'machines.json')
}

function stateOf(status: string): FleetMachine['state'] {
  // `toOwner.status` is resolved live for computer-backed machines (`applyRemoteStatus`), so it is a real
  // presence signal for exactly the machines where presence is a question.
  if (status === 'running') return 'ready'
  if (status === 'stopped' || status === 'offline') return 'offline'
  return 'unknown'
}

/**
 * Tag a cached machine-list body as stale, where the client actually reads it.
 *
 * The backend answers `{success:true,data:{…}}` and this daemon forwards that verbatim, so the flag has
 * to go INSIDE `data` — a local client unwraps to `data` and would never see a top-level field. Older
 * shapes that return the machines at the top level get it there instead.
 */
export function withStaleMarker(body: Record<string, unknown>, fetchedAt: number): Record<string, unknown> {
  const marker = { stale: true, staleSince: new Date(fetchedAt).toISOString() }
  const data = body.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { ...body, data: { ...(data as Record<string, unknown>), ...marker } }
  }
  return { ...body, ...marker }
}

export class MachineListCache {
  private machines: ListedMachine[] = []
  private source: MachineSource = 'local'
  private readonly path: string
  // The last SUCCESSFUL `GET /api/machines` body, kept verbatim. The dial only needs `ListedMachine`, but
  // the desktop app reads the raw backend row (computerId, hostname, …) straight off this endpoint, so a
  // fallback that served the lossy projection would silently change the wire shape. Keeping the original
  // is what lets `onMachinesList` answer from cache during an outage without the app noticing a difference.
  private lastBody: Record<string, unknown> | null = null
  private fetchedAt = 0
  private bodyOwner: string | null = null
  /** The CONTENT `saveCache` last wrote (timestamp excluded), so an unchanged list costs no disk write. */
  private lastWrittenContent = ''
  private lastWrittenAt = 0
  private readonly listeners = new Set<(body: Record<string, unknown> | null) => void>()

  constructor(
    private readonly fetchMachines: () => Promise<{ status: number; body: Record<string, unknown> }>,
    private readonly localComputerId: () => string,
    private readonly log: (line: string) => void,
    dataDir = env.ADAPTER_DATA_DIR,
    /** The machine row this session belongs to. A machine row is per (user, computer), so it is the one
     *  local fact that tells two ACCOUNTS on this computer apart — see `lastResponse`. */
    private readonly owner: () => string | null = () => null,
  ) {
    this.path = machineListCachePath(dataDir)
    this.loadCache()
  }

  /**
   * Be told of every list this cache takes as known-good (its body, as the backend answered it), and of a
   * sign-out (null). For readers that keep their own history of it — which of the owner's computers have
   * been reading offline, and for how long (`lib/gridPresence.ts`).
   */
  listen(listener: (body: Record<string, unknown> | null) => void): void {
    this.listeners.add(listener)
  }

  private tell(body: Record<string, unknown> | null): void {
    for (const listener of this.listeners) {
      try { listener(body) } catch { /* a listener's failure is its own */ }
    }
  }

  /** Synchronous by contract — see the file header. */
  list(): { machines: ListedMachine[]; source: MachineSource } {
    return { machines: this.machines, source: this.source }
  }

  find(machineId: string): ListedMachine | undefined {
    return this.machines.find((m) => m.machineId === machineId)
  }

  /**
   * The last known-good response body and when it was read, or null if there is none to serve.
   *
   * Withheld unless it provably belongs to the session asking for it. `harness logout` deletes this file,
   * but a session can also be replaced in place (sign in as someone else without logging out), and
   * answering THAT with the previous account's machines would be a straight disclosure. Both ids must be
   * present and equal: a cache with no stamp — written by a daemon older than this check — is not served.
   */
  lastResponse(): { body: Record<string, unknown>; fetchedAt: number } | null {
    if (!this.lastBody) return null
    const mine = this.owner()
    if (!mine || !this.bodyOwner || this.bodyOwner !== mine) return null
    return { body: this.lastBody, fetchedAt: this.fetchedAt }
  }

  /**
   * Re-read the list.
   *
   * Never throws. A daemon that cannot reach the backend still has one machine that works perfectly — the
   * one on the other end of the cable — so an outage downgrades `source` and keeps the last known rows
   * rather than emptying the wheel.
   */
  async refresh(): Promise<void> {
    let res: { status: number; body: Record<string, unknown> }
    try {
      res = await this.fetchMachines()
    } catch (err) {
      this.degrade(`unreachable (${(err as Error).message})`)
      return
    }
    if (res.status === 401 || res.status === 403) { this.signedOut(); return }
    if (res.status >= 400) { this.degrade(`HTTP ${res.status}`); return }
    if (!this.adopt(res.body)) this.degrade('no machines in the response')
  }

  /**
   * Take a body that a `GET /api/machines` just returned as the new known-good list.
   *
   * Split out of `refresh()` so the proxy handler can hand over the response it already has instead of
   * spending a second round trip to tell this cache the same thing.
   *
   * Returns false when the body carries no machine array — the caller decides whether that is a degrade
   * (a real read that came back wrong) or simply not its business.
   */
  adopt(body: Record<string, unknown>): boolean {
    const raw = (body?.machines ?? (body?.data as Record<string, unknown> | undefined)?.machines) as unknown
    if (!Array.isArray(raw)) return false

    const mine = this.localComputerId()
    this.machines = raw.map((r) => this.toListed(r as OwnerMachine, mine)).filter((m) => m.machineId)
    this.source = 'backend'
    this.lastBody = body
    this.bodyOwner = this.owner()
    this.fetchedAt = Date.now()
    this.saveCache()
    this.tell(body)
    return true
  }

  private toListed(r: OwnerMachine, mine: string): ListedMachine {
    const machineId = typeof r.machineId === 'string' ? r.machineId : ''
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim()
      : typeof r.hostname === 'string' && r.hostname.trim() ? r.hostname.trim()
        : `machine-${machineId.slice(0, 6)}`
    const authMode = r.authMode === 'managed' || r.authMode === 'remote' || r.authMode === 'provider' ? r.authMode : 'self'
    return {
      machineId,
      name,
      state: stateOf(typeof r.status === 'string' ? r.status : ''),
      authMode,
      // Derived, never declared — the same rule the desktop app follows.
      local: sameComputer(typeof r.computerId === 'string' ? r.computerId : '', mine),
    }
  }

  /**
   * Overlay live presence from a `machines_status` frame.
   *
   * The REST list is a SNAPSHOT — it is re-read on a timer, so on its own a machine that just came up
   * stays grey for up to a minute. This is the stream that fixes that, and it is why the socket is worth
   * holding while the dial is plugged in.
   *
   * Presence only: the name, the auth mode and which row is local all keep coming from REST, which is the
   * source that knows them. Returns true when something actually changed, so the caller can push a wheel
   * that differs and stay silent about one that does not.
   */
  applyLive(rows: Array<{ machineId?: unknown; online?: unknown }>): boolean {
    let changed = false
    let unknown = false
    for (const r of rows) {
      const id = typeof r.machineId === 'string' ? r.machineId : ''
      if (!id) continue
      const row = this.machines.find((m) => m.machineId === id)
      if (!row) { unknown = true; continue }
      const next = r.online === true ? 'ready' : 'offline'
      if (row.state !== next) { row.state = next; changed = true }
    }
    // A machine nobody has heard of means the account gained one since the last read. Go and find out
    // what it is called rather than inventing a row from a presence frame.
    if (unknown) void this.refresh()
    return changed
  }

  /** The list is stale but not wrong: keep the rows, stop claiming they are live. */
  private degrade(why: string): void {
    if (this.source !== 'local') this.log(`machines: ${why} — showing the last known list`)
    this.source = 'local'
    for (const m of this.machines) m.state = 'unknown'
  }

  private signedOut(): void {
    if (this.source !== 'signed-out') this.log('machines: not signed in')
    this.source = 'signed-out'
    this.machines = []
    // Drop the body as well: a signed-out session must never be answered from a previous user's list.
    this.lastBody = null
    this.bodyOwner = null
    this.fetchedAt = 0
    this.saveCache()
    this.tell(null)
  }

  /** So a daemon that starts offline still draws the list the user saw last time. */
  private loadCache(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as {
        machines?: ListedMachine[]
        body?: Record<string, unknown>
        fetchedAt?: number
        bodyOwner?: string
      }
      if (Array.isArray(parsed.machines)) {
        this.machines = parsed.machines.map((m) => ({ ...m, state: 'unknown' as const }))
      }
      // `body`/`fetchedAt` arrived after this file already existed in the wild, so a cache written by an
      // older daemon has rows but no body. Rows still draw the wheel; the proxy fallback simply has
      // nothing to serve until the next successful read fills it in.
      if (parsed.body && typeof parsed.body === 'object') {
        this.lastBody = parsed.body
        this.fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0
        this.bodyOwner = typeof parsed.bodyOwner === 'string' ? parsed.bodyOwner : null
      }
    } catch { /* no cache yet, or unreadable — an empty wheel plus the local row is correct */ }
  }

  private saveCache(): void {
    // `adopt` now runs on every local `/api/machines` too, not just the 60s poll, and this is a
    // synchronous write on the event loop of a daemon that is streaming terminals. An unchanged list is
    // the common case, so skip those. `fetchedAt` is deliberately NOT part of the comparison — it moves
    // on every read and would defeat the check entirely — but it must not drift arbitrarily either,
    // since it is what `staleSince` reports after a restart, so an unchanged list is still rewritten
    // once a minute (the poll's own cadence).
    const content = JSON.stringify({
      machines: this.machines,
      body: this.lastBody,
      bodyOwner: this.bodyOwner,
    })
    const now = Date.now()
    if (content === this.lastWrittenContent && now - this.lastWrittenAt < REWRITE_UNCHANGED_AFTER_MS) return
    try {
      writeFileSync(this.path, JSON.stringify({ ...JSON.parse(content), fetchedAt: this.fetchedAt }), { mode: 0o600 })
      this.lastWrittenContent = content
      this.lastWrittenAt = now
    } catch { /* best effort */ }
  }
}
