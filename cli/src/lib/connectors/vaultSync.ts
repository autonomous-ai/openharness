/**
 * The account's connected services, the same on every computer: like the desk (the account's tabs), kept
 * on the backend and announced to every computer when it changes (`connectors_changed`), but sealed for
 * the account's machines so the backend reads none of it (lib/e2ee/connectorVault.ts, through the gateway).
 *
 * Each computer merges what the backend holds into what it holds and writes back what it knew that the
 * backend did not. The merge, per service:
 *   - the token issued last wins (`obtained_at`): a connection made or renewed on any computer reaches the
 *     others, and a stale copy a computer refreshed with too late (its refresh token rotated away, so it
 *     marked it `needs_reconnect`) loses to the one renewed in time;
 *   - between two copies of one token, the one marked `needs_reconnect` wins: that token is dead everywhere;
 *   - a disconnect (`removed.json`) wins over every token issued before it, and loses to one issued after;
 *   - a `dcr` token carries the OAuth client it was issued to (clients.json), since only that client can
 *     renew it.
 * The backend keeps one envelope under a revision: a write over an older revision is refused with the
 * newer envelope, merged into, and written again.
 */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { sync } from './agents.js'
import { cleanToken, locked, type Client, type Store, type Token } from './store.js'

/** What travels, sealed: every connection, its OAuth client, and the disconnects. */
export interface Snapshot {
  v: 1
  connections: Record<string, { token: Token, client?: Client }>
  removed: Record<string, number>
}

/** The backend's side (routes/connectorVault.ts), as the connectors service reaches it. */
export interface VaultPort {
  /** The envelope and its revision; null when the backend cannot be read (signed out, offline). */
  read(): Promise<{ revision: number, envelope: unknown } | null>
  /** Written, or refused with the newer envelope; null when the backend cannot be reached. */
  write(base: number, envelope: Record<string, unknown>): Promise<{ written: boolean, revision: number, envelope: unknown } | null>
  seal(plaintext: string): Promise<Record<string, unknown>>
  /** Null when no machine of the account sealed it for this one; `complete`: sealed for every one. */
  open(envelope: unknown): Promise<{ plaintext: string, complete: boolean } | { stranded: true } | null>
}

type Payload = Record<string, unknown>

/** The account as the core holds it: the backend, signed in, and the gateway's sealing. */
export interface VaultAccount {
  backend(method: string, path: string, body?: unknown): Promise<{ status: number, body: Record<string, unknown> }>
  connectorVault: { seal(plaintext: string): Promise<Record<string, unknown>>, open(envelope: unknown): Promise<{ plaintext: string, complete: boolean } | { stranded: true } | null> }
}

/** One `connector_vault` op answered with the core's account (core/connectorsQueries.ts, and the
 *  connectors service in the core's process): `read`, `write`, `seal`, `open`. */
export async function answerVaultOp(account: VaultAccount, payload: Payload): Promise<Payload> {
  try {
    switch (payload.op) {
      case 'read': return { ...await account.backend('GET', '/api/connector-vault') }
      case 'write': return { ...await account.backend('PUT', '/api/connector-vault', { base: payload.base, envelope: payload.envelope }) }
      case 'seal': return { envelope: await account.connectorVault.seal(typeof payload.plaintext === 'string' ? payload.plaintext : '') }
      case 'open': {
        const opened = await account.connectorVault.open(payload.envelope)
        return opened === null ? {} : { ...opened }
      }
      default: return { error: 'UNKNOWN_OP' }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** The port over the core's `connector_vault` query (core/connectorsQueries.ts), asked in line or over
 *  the service's link: `read`, `write`, `seal`, `open`. */
export function vaultPortOf(call: (op: string, payload?: Payload) => Promise<Payload>): VaultPort {
  const data = (answer: Payload): Payload | null => {
    const body = answer.body as Payload | undefined
    return answer.status === 200 && body?.success === true && body.data && typeof body.data === 'object' ? body.data as Payload : null
  }
  return {
    read: async () => {
      const d = data(await call('read'))
      return d && typeof d.revision === 'number' ? { revision: d.revision, envelope: d.envelope ?? null } : null
    },
    write: async (base, envelope) => {
      const d = data(await call('write', { base, envelope }))
      return d && typeof d.revision === 'number' ? { written: d.written === true, revision: d.revision, envelope: d.envelope ?? null } : null
    },
    seal: async (plaintext) => {
      const answer = await call('seal', { plaintext })
      if (answer.envelope && typeof answer.envelope === 'object') return answer.envelope as Payload
      throw new Error(typeof answer.error === 'string' ? answer.error : 'could not seal the connections')
    },
    open: async (envelope) => {
      const answer = await call('open', { envelope })
      if (answer.stranded === true) return { stranded: true }
      return typeof answer.plaintext === 'string' ? { plaintext: answer.plaintext, complete: answer.complete === true } : null
    },
  }
}

/** Disconnects older than this are forgotten: every computer that was on has heard of them. */
const REMOVED_KEPT_S = 180 * 24 * 3600
const WRITE_ATTEMPTS = 4

const issued = (token: Token | undefined): number => token?.obtained_at ?? 0

/** This computer's connections as a snapshot. */
export function snapshotOf(vault: Store): Snapshot {
  const connections: Snapshot['connections'] = {}
  for (const [code, token] of Object.entries(vault.tokens())) {
    const client = token.source === 'dcr' && token.issuer ? vault.client(token.issuer) : undefined
    connections[code] = client ? { token, client } : { token }
  }
  return { v: 1, connections, removed: vault.removed() }
}

/** A snapshot from another computer, with nothing kept that this one would not write itself. */
export function parseSnapshot(text: string): Snapshot | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const data = raw as Partial<Snapshot> | null
  if (!data || data.v !== 1 || !data.connections || typeof data.connections !== 'object') return null
  const result: Snapshot = { v: 1, connections: {}, removed: {} }
  for (const [code, entry] of Object.entries(data.connections)) {
    try {
      const token = cleanToken((entry as { token?: unknown }).token)
      const client = (entry as { client?: unknown }).client
      result.connections[code] = validClient(client) ? { token, client } : { token }
    } catch { /* A connection this computer could not use is left out. */ }
  }
  for (const [code, at] of Object.entries(data.removed ?? {})) {
    if (typeof at === 'number' && Number.isInteger(at) && at > 0) result.removed[code] = at
  }
  return result
}

function validClient(value: unknown): value is Client {
  const c = value as Partial<Client> | null
  return !!c && typeof c.client_id === 'string' && !!c.client_id && typeof c.token_endpoint === 'string'
    && /^https:\/\//.test(c.token_endpoint) && typeof c.client_secret === 'string'
}

/** The two copies of one service's connection: which is the one to keep. */
function newer(a: Snapshot['connections'][string] | undefined, b: Snapshot['connections'][string] | undefined) {
  if (!a) return b
  if (!b) return a
  if (issued(a.token) !== issued(b.token)) return issued(a.token) > issued(b.token) ? a : b
  return b.token.needs_reconnect && !a.token.needs_reconnect ? b : a
}

/** [a] and [b] merged by the rules above. `now` forgets old disconnects. */
export function merge(a: Snapshot, b: Snapshot, now = Math.floor(Date.now() / 1000)): Snapshot {
  const result: Snapshot = { v: 1, connections: {}, removed: {} }
  for (const code of new Set([...Object.keys(a.removed), ...Object.keys(b.removed)])) {
    const at = Math.max(a.removed[code] ?? 0, b.removed[code] ?? 0)
    if (at > now - REMOVED_KEPT_S) result.removed[code] = at
  }
  for (const code of new Set([...Object.keys(a.connections), ...Object.keys(b.connections)])) {
    const kept = newer(a.connections[code], b.connections[code])
    const removedAt = Math.max(a.removed[code] ?? 0, b.removed[code] ?? 0)
    if (kept && issued(kept.token) > removedAt) result.connections[code] = kept
  }
  return result
}

/** The same snapshot always reads the same: for telling whether anything moved. */
export function fingerprint(snapshot: Snapshot): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Record<string, unknown>)[k])]))
      : value
  return createHash('sha256').update(JSON.stringify(sorted(snapshot))).digest('hex')
}

/** Write [snapshot] as this computer's connections, then give the agents their entries again. */
export function apply(vault: Store, snapshot: Snapshot, env: NodeJS.ProcessEnv = process.env): void {
  const same = (a: Snapshot['connections'][string], b: Snapshot['connections'][string] | undefined) =>
    !!b && fingerprint({ v: 1, connections: { x: a }, removed: {} }) === fingerprint({ v: 1, connections: { x: b }, removed: {} })
  locked(vault.root, () => {
    const now = snapshotOf(vault)
    for (const code of Object.keys(now.connections)) if (!(code in snapshot.connections)) vault.drop(code)
    for (const [code, entry] of Object.entries(snapshot.connections)) {
      if (same(entry, now.connections[code])) continue
      vault.put(code, entry.token)
      if (entry.client && entry.token.issuer) vault.putClient(entry.token.issuer, entry.client)
    }
    vault.putRemoved(snapshot.removed)
  })
  try { sync(vault, env) } catch { /* An agent config that cannot be written leaves the connections saved. */ }
}

export interface VaultSyncDeps {
  vault: Store
  port: VaultPort
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /** How often this computer's own files are looked at, and the backend read again without a notice. */
  pollMs?: number
  refreshMs?: number
}

/**
 * Keeps this computer's connections and the account's in step: read at start, at `connectors_changed`
 * and now and then; written when this computer's own files changed (a connection made, renewed or
 * dropped here, by any process).
 */
export class VaultSync {
  private revision = -1
  private unreadable = false
  private running: Promise<void> | null = null
  private again = false
  private filesAt = ''
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly deps: VaultSyncDeps) {}

  start(): void {
    void this.run()
    const poll = setInterval(() => { if (this.filesChanged()) void this.run() }, this.deps.pollMs ?? 5_000)
    const refresh = setInterval(() => void this.run(), this.deps.refreshMs ?? 10 * 60_000)
    poll.unref(); refresh.unref()
    this.timers.push(poll, refresh)
  }

  stop(): void { for (const timer of this.timers.splice(0)) clearInterval(timer) }

  /** The backend announced a change (`connectors_changed`), or the account's devices changed (a revision
   *  of null): a machine added or confirmed is one to seal for. */
  changed(revision: number | null): void { if (revision === null || revision !== this.revision) void this.run() }

  /** One exchange at a time; a request during one runs once more after it. */
  run(): Promise<void> {
    if (this.running) { this.again = true; return this.running }
    this.running = (async () => {
      do {
        this.again = false
        try { await this.exchange() } catch (error) { this.deps.log?.(`[connectors] could not keep connections in step · ${error instanceof Error ? error.message : String(error)}`) }
      } while (this.again)
    })().finally(() => { this.running = null })
    return this.running
  }

  private filesChanged(): boolean {
    const at = ['tokens.json', 'clients.json', 'removed.json'].map(name => {
      try { return String(statSync(join(this.deps.vault.root, name)).mtimeMs) } catch { return '-' }
    }).join('|')
    const changed = at !== this.filesAt
    this.filesAt = at
    return changed
  }

  private async exchange(): Promise<void> {
    const { vault, port } = this.deps
    let read = await port.read()
    if (!read) return
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      let theirs: Snapshot = { v: 1, connections: {}, removed: {} }
      let complete = true
      if (read.envelope) {
        const opened = await port.open(read.envelope)
        // Not sealed for this computer (yet: a machine nobody has said is theirs, or one added after the
        // last write): nothing of it is taken, and nothing is written over it, or the connections the
        // other computers keep there would be lost. A computer that can open it seals it for this one too.
        if (!opened) {
          if (!this.unreadable) this.deps.log?.('[connectors] the account\'s connections are not shared with this computer yet')
          this.unreadable = true
          this.revision = read.revision
          return
        }
        this.unreadable = false
        if ('stranded' in opened) {
          // Sealed only by or for computers the account no longer has: nobody will open it, and waiting for
          // one left every computer of the account without the others' connections. This one's are written
          // in its place, for the account's machines as they are now.
          this.deps.log?.('[connectors] the account\'s saved connections were sealed for computers no longer in the account: replacing them with this computer\'s')
          complete = false
        } else {
          theirs = parseSnapshot(opened.plaintext) ?? theirs
          complete = opened.complete
        }
      }
      const mine = snapshotOf(vault)
      const merged = merge(mine, theirs)
      if (fingerprint(merged) !== fingerprint(mine)) apply(vault, merged, this.deps.env)
      this.revision = read.revision
      this.filesChanged()
      const empty = !Object.keys(merged.connections).length && !Object.keys(merged.removed).length
      const needed = read.envelope ? fingerprint(merged) !== fingerprint(theirs) || !complete : !empty
      if (!needed) return
      const written = await port.write(read.revision, await port.seal(JSON.stringify(merged)))
      if (!written) return
      if (written.written) { this.revision = written.revision; return }
      read = { revision: written.revision, envelope: written.envelope }
    }
    throw new Error('the connections changed on another computer too quickly')
  }
}
