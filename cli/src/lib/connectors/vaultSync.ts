/** Account connector synchronization belongs to the gateway; only metadata leaves that process. */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Store } from './store.js'
import { fingerprint, parseSnapshot, type Snapshot } from './vaultSnapshot.js'
import { VaultStore, VaultStoreError } from './vaultStore.js'
import { VAULT_PLAINTEXT_BYTES } from './vaultBounds.js'
export * from './vaultSnapshot.js'

/** The backend and local crypto as gateway-owned synchronization reaches them. */
export interface VaultPort {
  /** The envelope and its revision; null when the backend cannot be read (signed out, offline). */
  read(waitMs?: number): Promise<{ revision: number, envelope: unknown } | null>
  /** Written, or refused with the newer envelope; null when the backend cannot be reached. */
  write(base: number, envelope: Record<string, unknown>, waitMs?: number): Promise<{ written: boolean, revision: number, envelope: unknown } | null>
  seal(plaintext: string): Promise<Record<string, unknown>>
  /** Null when no machine of the account sealed it for this one; `complete`: sealed for every one. */
  open(envelope: unknown): Promise<{ plaintext: string, complete: boolean } | { stranded: true } | null>
}

type Payload = Record<string, unknown>

/** Gateway-local operation adapter; secret-bearing operations never go through CoreApi. */
export function vaultPortOf(call: (op: string, payload?: Payload, waitMs?: number) => Promise<Payload>): VaultPort {
  const data = (answer: Payload): Payload | null => {
    const body = answer.body as Payload | undefined
    return answer.status === 200 && body?.success === true && body.data && typeof body.data === 'object' ? body.data as Payload : null
  }
  return {
    read: async (waitMs) => {
      const d = data(await call('read', undefined, waitMs))
      return d && typeof d.revision === 'number' ? { revision: d.revision, envelope: d.envelope ?? null } : null
    },
    write: async (base, envelope, waitMs) => {
      const d = data(await call('write', { base, envelope }, waitMs))
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

export type VaultSyncResult = 'synced' | 'unavailable' | 'stopped' | 'unconfirmed'
export interface VaultSyncDeps {
  vault: Pick<Store, 'root'>
  port: VaultPort
  /** Kept for source-compatible callers; profile projection now belongs to edge. */
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  pollMs?: number
  refreshMs?: number
  current?: () => boolean
  changed?: () => void
  store?: VaultStore
}

const WRITE_ATTEMPTS = 4
const EXCHANGE_MS = 15_000

/** One exchange and one coalesced trigger; notices never allocate a waiting callback. */
export class VaultSync {
  private revision = -1
  private unreadable = false
  private running: Promise<VaultSyncResult> | null = null
  private again = false
  private stopped = false
  private checking = false
  private scheduled: NodeJS.Immediate | null = null
  private filesAt = ''
  private projected = false
  private timers: NodeJS.Timeout[] = []
  private readonly store: VaultStore

  constructor(private readonly deps: VaultSyncDeps) { this.store = deps.store ?? new VaultStore(deps.vault.root) }

  start(): void {
    if (this.stopped || this.timers.length) return
    void this.run()
    const poll = setInterval(() => { void this.look() }, this.deps.pollMs ?? 5_000)
    const refresh = setInterval(() => { void this.run() }, this.deps.refreshMs ?? 10 * 60_000)
    poll.unref(); refresh.unref(); this.timers.push(poll, refresh)
  }

  stop(): void {
    this.stopped = true
    this.again = false
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = null }
    for (const timer of this.timers.splice(0)) clearInterval(timer)
  }

  /** Actual settlement, not a caller deadline, controls when the next account may own the writer. */
  settled(): Promise<unknown> { return this.running ?? Promise.resolve() }

  changed(revision: number | null): void {
    if (!this.stopped && (revision === null || revision !== this.revision)) void this.run()
  }

  run(): Promise<VaultSyncResult> {
    if (!this.current()) return Promise.resolve('stopped')
    if (this.running) { this.again = true; return this.running }
    if (this.scheduled) { clearImmediate(this.scheduled); this.scheduled = null }
    this.running = (async () => {
      let result: VaultSyncResult = 'unavailable'
      let rounds = 0
      const expires = performance.now() + EXCHANGE_MS
      do {
        this.again = false
        try { result = await this.exchange(expires) }
        catch (error) {
          result = error instanceof VaultStoreError && error.code.endsWith('_UNCONFIRMED') ? 'unconfirmed'
            : !this.current() ? 'stopped' : 'unavailable'
          if (result !== 'stopped') {
            const code = error instanceof VaultStoreError ? error.code : result
            this.say(`[connectors] synchronization ${code}`)
          }
        }
      } while (++rounds < 2 && this.again && this.current() && performance.now() < expires)
      return result
    })().finally(() => {
      this.running = null
      if (this.again && this.current()) {
        this.scheduled = setImmediate(() => { this.scheduled = null; void this.run() })
        this.scheduled.unref()
      }
    })
    return this.running
  }

  private current(): boolean { return !this.stopped && (this.deps.current?.() ?? true) }
  private say(line: string): void { try { this.deps.log?.(line) } catch { /* A log sink cannot change synchronization authority. */ } }
  private changedLocal = (): void => {
    this.projected = true
    try { this.deps.changed?.() } catch { /* Edge reconnect/Refresh rereads current local state. */ }
  }

  private async look(): Promise<void> {
    if (this.checking || !this.current()) return
    this.checking = true
    try {
      const stamps = await Promise.all(['tokens.json', 'clients.json', 'removed.json'].map(async name => {
        try { const info = await stat(join(this.deps.vault.root, name)); return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` }
        catch { return '-' }
      }))
      if (!this.current()) return
      const at = stamps.join('|')
      if (at !== this.filesAt) { this.filesAt = at; void this.run() }
    } finally { this.checking = false }
  }

  private async exchange(expires: number): Promise<VaultSyncResult> {
    const check = () => { if (!this.current() || performance.now() >= expires) throw new Error('SYNC_UNAVAILABLE') }
    const left = () => { check(); return Math.max(1, Math.ceil(expires - performance.now())) }
    const port = this.deps.port
    let read = await port.read(left())
    check()
    if (!read) return 'unavailable'
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      let theirs: Snapshot = { v: 1, connections: {}, removed: {} }
      let complete = true
      if (read.envelope) {
        const opened = await port.open(read.envelope)
        check()
        if (!opened) {
          if (!this.unreadable) this.say('[connectors] account connections are not shared with this computer yet')
          this.unreadable = true; this.revision = read.revision
          return 'unavailable'
        }
        this.unreadable = false
        if ('stranded' in opened) {
          this.say('[connectors] connections were sealed for computers no longer in the account; sharing local connections')
          complete = false
        } else {
          const parsed = parseSnapshot(opened.plaintext)
          if (!parsed) return 'unavailable'
          theirs = parsed; complete = opened.complete
        }
      }
      const merged = await this.store.merge(theirs, check, this.changedLocal)
      // A previous gateway may have committed before its notice arrived. Never notify while a disk lock is held.
      if (!this.projected) this.changedLocal()
      check()
      this.revision = read.revision
      const empty = !Object.keys(merged.connections).length && !Object.keys(merged.removed).length
      const needed = read.envelope ? fingerprint(merged) !== fingerprint(theirs) || !complete : !empty
      if (!needed) return 'synced'
      const plain = JSON.stringify(merged)
      // Backend ciphertext is capped at one million base64 characters, including the authentication tag.
      if (Buffer.byteLength(plain) > VAULT_PLAINTEXT_BYTES) return 'unavailable'
      const envelope = await port.seal(plain)
      check()
      const written = await port.write(read.revision, envelope, left())
      check()
      if (!written) return 'unavailable'
      if (written.written) { this.revision = written.revision; return 'synced' }
      read = { revision: written.revision, envelope: written.envelope }
    }
    return 'unavailable'
  }
}
