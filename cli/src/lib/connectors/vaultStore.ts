/** Async synchronization of the existing connector files; the bridge/CLI keep their existing lock and format. */
import * as fs from 'node:fs/promises'
import { constants, lstatSync, renameSync, unlinkSync, type BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CODE, MAX_BYTES, cleanClient, removalsIn, tokensIn } from './store.js'
import { fingerprint, merge, type Snapshot } from './vaultSnapshot.js'
import { transport } from './rest.js'

type Document = Record<string, unknown>
const FILES = ['removed.json', 'clients.json', 'tokens.json'] as const
const LOCK_MS = 5_000
const STALE_LOCK_MS = 60_000
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const identity = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.nlink].join(':')
const fileIdentity = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.birthtimeNs}`
const contentsIdentity = (s: BigIntStats) => [fileIdentity(s), s.size, s.mtimeNs, s.mode, s.uid, s.nlink].join(':')
const filesVersion = (directory: string, versions: ReadonlyMap<string, string | null>) =>
  [directory, ...FILES.map(name => versions.get(name) ?? '-')].join('|')

export class VaultStoreError extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'STORE_BUSY' | 'STORE_CHANGED' | 'STORE_WRITE_UNCONFIRMED' | 'STORE_CLEANUP_UNCONFIRMED') {
    super(code); this.name = 'VaultStoreError'
  }
}

/** Explicit IO dependencies let caller tests hold actual operation settlement, not just a reply timer. */
export const vaultStoreIo = {
  open: fs.open, mkdir: fs.mkdir, lstat: fs.lstat, chmod: fs.chmod,
  rename: renameSync, statNow: (file: string) => lstatSync(file, { bigint: true }), unlink: unlinkSync,
  wait: (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }),
}
type StoreIo = typeof vaultStoreIo
interface Cleanup {
  directory: string
  files: Map<string, string | null>
  lock?: { file: string; identity: string | null }
  changed?: () => void
}

function privateFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_BYTES)
    || (process.getuid && stat.uid !== BigInt(process.getuid()))
    || (process.platform !== 'win32' && (stat.mode & 0o077n) !== 0n)) throw new VaultStoreError('STORE_UNAVAILABLE')
}

function snapshot(documents: Map<string, Document>): Snapshot {
  const result: Snapshot = { v: 1, connections: {}, removed: {} }
  const clients = documents.get('clients.json')!
  for (const [code, token] of Object.entries(tokensIn(documents.get('tokens.json')!))) {
    const client = token.source === 'dcr' && token.issuer ? cleanClient(clients[token.issuer]) : undefined
    result.connections[code] = { token, ...(client ? { client } : {}) }
  }
  result.removed = removalsIn(documents.get('removed.json')!)
  return result
}

/** One writer slot survives an expired reply until every accepted OS operation has actually settled. */
export class VaultStore {
  private busy = false
  /** A failed close has unknown OS ownership. No later attempt may allocate another descriptor. */
  private readonly unclosed = new Set<FileHandle>()
  private needsDurability = true
  /** At most this attempt's three temporary files and one lock; no new mutation while any remain. */
  private cleanup: Cleanup | null = null
  constructor(readonly root: string, private readonly io: StoreIo = vaultStoreIo) {}

  /** The existing file check reads only bounded metadata; an unreadable path is never acknowledged as absent. */
  async version(): Promise<string> {
    try {
      const directory = await this.io.lstat(this.root, { bigint: true })
      if (!directory.isDirectory() || directory.isSymbolicLink()
        || (process.getuid && directory.uid !== BigInt(process.getuid()))
        || (process.platform !== 'win32' && (directory.mode & 0o077n) !== 0n)) throw new VaultStoreError('STORE_UNAVAILABLE')
      const probes = await Promise.allSettled(FILES.map(async name => {
        try {
          const stat = await this.io.lstat(join(this.root, name), { bigint: true })
          privateFile(stat)
          return [name, identity(stat)] as const
        } catch (error) { if (missing(error)) return [name, null] as const; throw error }
      }))
      // One failed probe must not release the check while another OS operation is still outstanding.
      const versions = new Map<string, string | null>()
      for (const probe of probes) {
        if (probe.status === 'rejected') throw probe.reason
        versions.set(probe.value[0], probe.value[1])
      }
      return filesVersion(fileIdentity(directory), versions)
    } catch { throw new VaultStoreError('STORE_UNAVAILABLE') }
  }

  private async close(handle: FileHandle): Promise<void> {
    try { await handle.close() }
    catch {
      this.unclosed.add(handle)
      throw new VaultStoreError('STORE_CLEANUP_UNCONFIRMED')
    }
  }

  private async pinDirectory(expected: string): Promise<FileHandle | null> {
    if (process.platform === 'win32') return null
    const handle = await this.io.open(this.root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat({ bigint: true })
      if (!stat.isDirectory() || fileIdentity(stat) !== expected) throw new VaultStoreError('STORE_CHANGED')
      return handle
    } catch (error) { await this.close(handle); throw error }
  }

  private async durable(handle: FileHandle | null): Promise<void> {
    if (handle) await handle.sync()
    this.needsDurability = false
  }

  private reconcile(changed?: () => void): void {
    const cleanup = this.cleanup
    if (!cleanup) return
    // A renamed root still contains our credential files. Missing paths in a replacement root do not discharge ownership.
    try {
      if (fileIdentity(this.io.statNow(this.root)) !== cleanup.directory) throw new Error('replaced directory')
    } catch { throw new VaultStoreError('STORE_CLEANUP_UNCONFIRMED') }
    const remove = (file: string, expected: string | null): boolean => {
      try {
        const actual = this.io.statNow(file)
        if (expected === null) return false // Creation succeeded but its identity could not be established.
        if (fileIdentity(actual) !== expected) return true // Another owner's replacement is never removed.
        this.io.unlink(file)
        return true
      } catch (error) { return missing(error) }
    }
    for (const [file, expected] of cleanup.files) if (remove(file, expected)) cleanup.files.delete(file)
    // Retain the lock while our credential-bearing temporary files still need cleanup.
    if (!cleanup.files.size && cleanup.lock && remove(cleanup.lock.file, cleanup.lock.identity)) delete cleanup.lock
    if (cleanup.files.size || cleanup.lock) throw new VaultStoreError('STORE_CLEANUP_UNCONFIRMED')
    this.cleanup = null
    if (cleanup.changed) { try { (changed ?? cleanup.changed)() } catch { /* Edge reconnect/Refresh recovers the projection. */ } }
  }

  private async directory(): Promise<string> {
    await this.io.mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await this.io.lstat(this.root, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== BigInt(process.getuid()))) {
      throw new VaultStoreError('STORE_UNAVAILABLE')
    }
    await this.io.chmod(this.root, 0o700)
    return fileIdentity(stat)
  }

  private async read(name: string): Promise<{ document: Document; version: string | null }> {
    let handle: FileHandle
    try { handle = await this.io.open(join(this.root, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) }
    catch (error) { if (missing(error)) return { document: {}, version: null }; throw error }
    try {
      const before = await handle.stat({ bigint: true })
      privateFile(before)
      // One extra byte detects growth after fstat without ever reading an unbounded file.
      const buffer = Buffer.alloc(Number(before.size) + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const part = await handle.read(buffer, bytes, buffer.length - bytes, bytes)
        if (!part.bytesRead) break
        bytes += part.bytesRead
      }
      if (bytes > MAX_BYTES || identity(before) !== identity(await handle.stat({ bigint: true }))) throw new VaultStoreError('STORE_CHANGED')
      const document: unknown = JSON.parse(buffer.toString('utf8', 0, bytes))
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new VaultStoreError('STORE_UNAVAILABLE')
      return { document: document as Document, version: identity(before) }
    } finally { await this.close(handle) }
  }

  /** Merge after the old-format lock is acquired; never overwrite a renewal made while HTTP was pending. */
  async merge(theirs: Snapshot, current: () => void, changed: () => void = () => {}): Promise<{ snapshot: Snapshot; version: string }> {
    if (this.unclosed.size) throw new VaultStoreError('STORE_CLEANUP_UNCONFIRMED')
    if (this.busy) throw new VaultStoreError('STORE_BUSY')
    this.busy = true
    const lock = join(this.root, '.lock')
    const temporary = new Map<string, string | null>()
    let owned: string | null | undefined
    let published = false
    let attempted = false
    let projectionChanged = false
    let directory = '', directoryHandle: FileHandle | null = null
    try {
      this.reconcile(changed)
      current()
      directory = await this.directory()
      current()
      const expires = performance.now() + LOCK_MS
      for (;;) {
        current()
        try {
          const handle = await this.io.open(lock, 'wx', 0o600)
          owned = null
          try { const stat = await handle.stat({ bigint: true }); owned = fileIdentity(stat) }
          finally { await this.close(handle) }
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          try {
            const stat = await this.io.lstat(lock, { bigint: true })
            if (Date.now() - Number(stat.mtimeMs) > STALE_LOCK_MS) {
              // Compare immediately before removal; never remove a replacement lock observed during the await.
              if (identity(this.io.statNow(lock)) === identity(stat)) this.io.unlink(lock)
              continue
            }
          } catch (error) { if (!missing(error)) throw error }
          if (performance.now() >= expires) throw new VaultStoreError('STORE_BUSY')
          await this.io.wait(20)
        }
      }
      current()
      const documents = new Map<string, Document>(), versions = new Map<string, string | null>()
      for (const name of FILES) {
        const read = await this.read(name)
        current(); documents.set(name, read.document); versions.set(name, read.version)
      }
      const mine = snapshot(documents), merged = merge(mine, theirs)
      // Pin the exact directory before publication; reopening the pathname afterward could fsync a replacement.
      directoryHandle = await this.pinDirectory(directory)
      current()
      if (fingerprint(mine) === fingerprint(merged)) {
        if (this.needsDurability) await this.durable(directoryHandle)
        return { snapshot: merged, version: filesVersion(directory, versions) }
      }
      const codes = (value: Snapshot) => Object.entries(value.connections).filter(([, entry]) => transport(entry.token) !== 'none').map(([code]) => code).sort().join('|')
      projectionChanged = codes(mine) !== codes(merged)
      const tokens = { ...documents.get('tokens.json')! }
      const clients: Document = Object.assign(Object.create(null), documents.get('clients.json')!)
      for (const code of Object.keys(tokens)) if (CODE.test(code)) delete tokens[code]
      for (const [code, entry] of Object.entries(merged.connections)) {
        tokens[code] = entry.token
        if (entry.client && entry.token.issuer) clients[entry.token.issuer] = entry.client
      }
      const replacements: Document[] = [merged.removed, clients, tokens]
      const prepared: Array<{ name: string; from: string; to: string; stat: BigIntStats }> = []
      for (let i = 0; i < FILES.length; i++) {
        const name = FILES[i], document = replacements[i]
        if (JSON.stringify(documents.get(name)) === JSON.stringify(document)) continue
        const contents = JSON.stringify(document, null, 2) + '\n'
        if (Buffer.byteLength(contents) > MAX_BYTES) throw new VaultStoreError('STORE_UNAVAILABLE')
        const file = join(this.root, `.incoming-${randomUUID()}`)
        const handle = await this.io.open(file, 'wx', 0o600)
        temporary.set(file, null)
        let written!: BigIntStats
        try {
          const stat = await handle.stat({ bigint: true })
          privateFile(stat)
          temporary.set(file, fileIdentity(stat))
          current(); await handle.writeFile(contents); current(); await handle.sync(); current()
          written = await handle.stat({ bigint: true })
          privateFile(written)
          if (fileIdentity(written) !== temporary.get(file) || written.size !== BigInt(Buffer.byteLength(contents))) throw new VaultStoreError('STORE_CHANGED')
        }
        finally { await this.close(handle) }
        current(); prepared.push({ name, from: file, to: join(this.root, name), stat: written })
      }
      // Only bounded metadata probes and <=3 renames are synchronous. No content read, write or fsync here.
      current()
      const lockStat = this.io.statNow(lock), dirStat = this.io.statNow(this.root)
      privateFile(lockStat)
      if (fileIdentity(lockStat) !== owned || fileIdentity(dirStat) !== directory
        || !dirStat.isDirectory() || dirStat.isSymbolicLink()
        || (process.getuid && dirStat.uid !== BigInt(process.getuid()))
        || (process.platform !== 'win32' && (dirStat.mode & 0o077n) !== 0n)) throw new VaultStoreError('STORE_CHANGED')
      for (const name of FILES) {
        let version: string | null = null
        try { version = identity(this.io.statNow(join(this.root, name))) } catch (error) { if (!missing(error)) throw error }
        if (version !== versions.get(name)) throw new VaultStoreError('STORE_CHANGED')
      }
      for (const file of prepared) {
        const stat = this.io.statNow(file.from)
        if (contentsIdentity(stat) !== contentsIdentity(file.stat)
          || (process.platform !== 'win32' && stat.ctimeNs !== file.stat.ctimeNs)) throw new VaultStoreError('STORE_CHANGED')
      }
      current()
      for (const file of prepared) {
        attempted = true; this.needsDurability = true
        this.io.rename(file.from, file.to); published = true
        const stat = this.io.statNow(file.to)
        // Rename can update ctime. Every other field must still identify the exact bytes prepared above.
        if (contentsIdentity(stat) !== contentsIdentity(file.stat)) throw new VaultStoreError('STORE_CHANGED')
        versions.set(file.name, identity(stat))
      }
      // Publication already happened under the checked generation. Durability may settle after invalidation.
      await this.durable(directoryHandle)
      return { snapshot: merged, version: filesVersion(directory, versions) }
    } catch (error) {
      if (attempted) throw new VaultStoreError('STORE_WRITE_UNCONFIRMED')
      throw error instanceof VaultStoreError ? error : new VaultStoreError('STORE_UNAVAILABLE')
    } finally {
      // Every async OS operation has settled before this bounded, identity-checked namespace cleanup.
      // A failure remains owned and blocks another mutation; it cannot silently accumulate secret files.
      try { if (directoryHandle) await this.close(directoryHandle) } catch { /* Retained below after namespace cleanup. */ }
      try {
        if (temporary.size || owned !== undefined) {
          this.cleanup = { directory, files: temporary, ...(owned !== undefined ? { lock: { file: lock, identity: owned } } : {}),
            ...(published && projectionChanged ? { changed } : {}) }
          this.reconcile()
        }
        if (this.unclosed.size) throw new VaultStoreError('STORE_CLEANUP_UNCONFIRMED')
      } finally { this.busy = false }
    }
  }
}
