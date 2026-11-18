/** Directory durability may wait; publication and final admission each keep their own no-yield fence. */
import { constants, fstatSync, lstatSync, openSync, opendirSync, readSync, rmdirSync, unlinkSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { closeStateDirectoryIterator, closeStateFileDescriptor, closeStateFileHandle, insideWindowsRoots,
  requireWindowsStateFile, StateFileCleanupUnconfirmed, stateFileCustodyHealthy, windowsStateRoots } from './secureState.js'
import { lockStartMarker, processExists } from './processLiveness.js'
import { psEnv } from './childLocale.js'
import { ownProcessGroup } from './windows/noWindow.js'

const REQUEST_MS = 5_000
const LOCK_MS = 2_000
const WAIT_MS = 20
const OWNERLESS_MS = 5_000
const CAPACITY = 64
const OWNER_BYTES = 4_096

type PersistencePhase = 'queue' | 'lock' | 'prepare' | 'publish'
const reported = new Map<PersistencePhase, number>()
function measure(phase: PersistencePhase, started: number, depth = 0): void {
  const now = performance.now(), elapsed = now - started
  if (elapsed < (phase === 'publish' ? 25 : 250) || now - (reported.get(phase) ?? -Infinity) < 60_000) return
  reported.set(phase, now)
  // Fixed phase names and numeric bounds only; never include rows, paths or tokens.
  console.warn(`[registry] slow persistence phase=${phase} elapsedMs=${Math.round(elapsed)} queueDepth=${depth}`)
}

export class RegistryPersistenceUnavailable extends Error {
  constructor(reason: string) { super(`Registry persistence unavailable: ${reason}`); this.name = 'RegistryPersistenceUnavailable' }
}

/** The row is admitted; its caller must not undo the launch as if publication were refused. */
export class RegistryCleanupUnavailable extends RegistryPersistenceUnavailable {
  constructor(override readonly cause: unknown) {
    super('admitted write cleanup failed; restart required')
    this.name = 'RegistryCleanupUnavailable'
  }
}

export interface RegistryWriteDeadline {
  readonly expires: number
  check(): void
  beginPublication(): void
  markPublished(): void
  markAdmitted(): void
  /** An uncertain close owns at most this one descriptor and writer until the process exits. */
  failClosed(): never
  readonly failedClose: boolean
  /** Result delivery may finish first; this one cleanup keeps the writer occupied until actual settlement. */
  retain?: (cleanup: Promise<void>) => void
}

/** One active OS operation retains its place after reply expiry, until it really settles. */
export class RegistryWriteQueue {
  private active = false
  private closed = false
  private failedClose = false
  private settlement: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private readonly waiting: Array<() => Promise<void>> = []

  assertOpen(): void {
    stateFileCustodyHealthy()
    if (this.failedClose) throw new RegistryPersistenceUnavailable('directory close failed; restart required')
    if (this.closed) throw new RegistryPersistenceUnavailable('registry is closing')
  }

  run<T>(apply: (deadline: RegistryWriteDeadline) => Promise<T>, expires = Infinity): Promise<T> {
    try { this.assertOpen() } catch (error) { return Promise.reject(error) }
    return this.enqueue(apply, Math.min(expires, performance.now() + REQUEST_MS))
  }

  /** The exit caller retains process ownership until every accepted OS request has settled. */
  finish(apply: (deadline: RegistryWriteDeadline) => Promise<void>): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const expires = performance.now() + REQUEST_MS
    return this.closing = (async () => {
      await this.settlement
      try { await this.enqueue(apply, expires) }
      finally { await this.settlement }
    })()
  }

  private enqueue<T>(apply: (deadline: RegistryWriteDeadline) => Promise<T>, expires: number): Promise<T> {
    if (this.waiting.length >= CAPACITY) return Promise.reject(new RegistryPersistenceUnavailable('write queue is full'))
    return new Promise<T>((resolve, reject) => {
      let expired = false, running = false, published = false, admitted = false
      let cleanup: Promise<void> | undefined
      const retain = (pending: Promise<void>) => {
        if (cleanup) throw new RegistryPersistenceUnavailable('duplicate write cleanup')
        cleanup = pending
      }
      const failure = (reason: string) => published
        ? new AtomicWriteUnconfirmed(new RegistryPersistenceUnavailable(reason), false)
        : admitted ? new RegistryCleanupUnavailable(new RegistryPersistenceUnavailable(reason)) : new RegistryPersistenceUnavailable(reason)
      const check = () => {
        if (expired || performance.now() >= expires) throw failure('write deadline exceeded')
      }
      const failClosed = (): never => {
        this.failedClose = true
        console.error('[registry] directory close failed; restart required')
        throw failure('directory close failed; restart required')
      }
      const timer = setTimeout(() => {
        expired = true
        if (!running) {
          const index = this.waiting.indexOf(run)
          if (index !== -1) this.waiting.splice(index, 1)
        }
        reject(failure('write deadline exceeded'))
      }, Math.max(0, expires - performance.now()))
      const run = async () => {
        running = true
        measure('queue', expires - REQUEST_MS, this.waiting.length)
        const queue = this
        try {
          check()
          const result = await apply({ expires, check, retain, failClosed,
            beginPublication: () => {
              if (published) throw failure('previous publication remains unconfirmed')
              admitted = false
              check()
            },
            markPublished: () => { published = true; admitted = false },
            markAdmitted: () => { if (published) admitted = true; published = false },
            get failedClose() { return queue.failedClose },
          })
          if (this.failedClose) throw failure('directory close failed; restart required')
          resolve(result)
        }
        catch (error) {
          // A cleanup failure cannot undo an already visible, unadmitted rename.
          // Keep the caller's uncertain result even when discard or source release is what failed last.
          reject(published && !(error instanceof AtomicWriteUnconfirmed) ? new AtomicWriteUnconfirmed(error, false)
            : admitted && !(error instanceof RegistryCleanupUnavailable) ? new RegistryCleanupUnavailable(error) : error)
        }
        finally {
          clearTimeout(timer)
          // A thrown close cannot establish descriptor ownership. Never admit another write or a clean handoff.
          if (this.failedClose) await new Promise<void>(() => {})
          // The durable result is already known. Cleanup still owns admission,
          // and its rejection is observed without replacing that result.
          await cleanup?.catch(async error => {
            console.warn('[registry] write cleanup failed')
            if (error instanceof StateFileCleanupUnconfirmed) {
              this.failedClose = true
              await new Promise<void>(() => {})
            }
          })
        }
      }
      this.waiting.push(run)
      if (!this.active) this.settlement = this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    try { while (this.waiting.length) await this.waiting.shift()!() }
    finally { this.active = false }
  }
}

const uid = () => typeof process.getuid === 'function' ? process.getuid() : null
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function windowsRoot(path: string): Promise<void> {
  const roots = (await Promise.all(windowsStateRoots().map(root => fs.realpath(root).catch(() => null))))
    .filter((root): root is string => root !== null)
  if (!insideWindowsRoots(await fs.realpath(path), roots)) throw new Error('state path is outside the configured private roots')
}

async function privateDescriptor(handle: FileHandle, directory: boolean, maxBytes = Number.MAX_SAFE_INTEGER): Promise<number> {
  const stat = await handle.stat()
  const owner = uid()
  if (!(directory ? stat.isDirectory() : stat.isFile()) || (owner !== null && stat.uid !== owner)) {
    throw new Error('state file has unsafe owner or type')
  }
  if (!directory && stat.size > maxBytes) throw new Error('state file exceeds its size limit')
  if (process.platform === 'win32') return stat.size
  const mode = directory ? 0o700 : 0o600
  if ((stat.mode & 0o022) !== 0) throw new Error('state file is group/world writable')
  if ((stat.mode & 0o777) !== mode) {
    await handle.chmod(mode)
    if (((await handle.stat()).mode & 0o777) !== mode) throw new Error('state permissions could not be tightened')
  }
  return stat.size
}

export async function privateRegistryDirectory(directory: string): Promise<void> {
  stateFileCustodyHealthy()
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('state directory has unsafe owner or type')
    await windowsRoot(directory)
    return
  }
  stateFileCustodyHealthy()
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await privateDescriptor(handle, true) } finally { await closeStateFileHandle(handle) }
}

export async function readPrivateRegistryOwner(file: string, maxBytes = OWNER_BYTES): Promise<string> {
  stateFileCustodyHealthy()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > OWNER_BYTES) throw new Error('invalid owner read limit')
  if (process.platform === 'win32') await windowsRoot(file)
  stateFileCustodyHealthy()
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const size = await privateDescriptor(handle, false, maxBytes)
    const limit = maxBytes + 1
    let bytes = Buffer.alloc(Math.min(size + 1, limit))
    let offset = 0
    while (offset < limit) {
      // Stat sizes the first allocation, but a growing file must still be read through EOF or the cap.
      if (offset === bytes.length) {
        const grown = Buffer.alloc(Math.min(limit, bytes.length * 2))
        bytes.copy(grown)
        bytes = grown
      }
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    if (offset > maxBytes) throw new Error('state file exceeds its size limit')
    return bytes.toString('utf8', 0, offset)
  }
  finally { await closeStateFileHandle(handle) }
}

export class AtomicWriteUnconfirmed extends Error {
  constructor(cause: unknown, readonly retryable = true) { super(cause instanceof Error ? cause.message : String(cause), { cause }) }
}

async function startMarker(pid: number, budget: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19])
      if (Number.isSafeInteger(ticks) && ticks >= 0) return `linux:${ticks}`
    } catch { /* PID liveness remains authoritative when generation cannot be read. */ }
  }
  if (process.platform === 'win32' || budget <= 0) return null
  return new Promise(resolve => execFile('ps', ['-p', String(pid), '-o', 'lstart='], {
    ...ownProcessGroup(), encoding: 'utf8', timeout: Math.max(1, Math.min(1_000, budget)), env: { ...psEnv(), TZ: 'UTC' },
  }, (error, stdout) => resolve(!error && stdout.trim() ? `ps-c:${stdout.trim()}` : null)))
}

let ownGeneration: string | null = null
async function alive(pid: number, marker: string, budget: number): Promise<boolean> {
  if (!processExists(pid)) return false
  if (!marker) return true
  const current = await startMarker(pid, budget)
  return current === null || !['linux:', 'ps-c:'].some(prefix => current.startsWith(prefix) && marker.startsWith(prefix)) || current === marker
}

type Owner = { pid?: unknown; startMarker?: unknown; generationMarker?: unknown; token?: unknown }
const sameOwner = (a: Owner, b: Owner) => a.pid === b.pid && a.token === b.token && lockStartMarker(a) === lockStartMarker(b)

function parseOwner(contents: string): Owner | null {
  try {
    const value: unknown = JSON.parse(contents)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Owner : null
  } catch { return null }
}

async function readOwner(file: string): Promise<Owner | null> {
  try { return parseOwner(await readPrivateRegistryOwner(file)) }
  catch (error) {
    if (error instanceof StateFileCleanupUnconfirmed) throw error
    if (missing(error)) return null
    throw new RegistryPersistenceUnavailable('registry lock owner could not be read safely')
  }
}

/** This bounded read and the following removal/publication are one no-yield ownership fence. */
function readOwnerNow(file: string): { owner: Owner | null; modified: number } {
  stateFileCustodyHealthy()
  try {
    if (process.platform === 'win32') requireWindowsStateFile(file)
    const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = fstatSync(handle), owner = uid()
      if (!stat.isFile() || (owner !== null && stat.uid !== owner)
        || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
        || stat.size > OWNER_BYTES) throw new Error('unsafe owner file')
      const bytes = Buffer.alloc(OWNER_BYTES + 1)
      let offset = 0
      while (offset < bytes.length) {
        const size = readSync(handle, bytes, offset, bytes.length - offset, offset)
        if (!size) break
        offset += size
      }
      if (offset > OWNER_BYTES) throw new Error('oversized owner file')
      return { owner: parseOwner(bytes.toString('utf8', 0, offset)), modified: stat.mtimeMs }
    } finally { closeStateFileDescriptor(handle) }
  } catch (error) {
    if (error instanceof StateFileCleanupUnconfirmed) throw error
    if (missing(error)) return { owner: null, modified: 0 }
    throw new RegistryPersistenceUnavailable('registry lock owner could not be read safely')
  }
}

function lockNow(lock: string, identity: { ino: number; dev: number }) {
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(lock) } catch (error) { if (missing(error)) return null; throw error }
  const owner = uid()
  if (!stat.isDirectory() || stat.isSymbolicLink() || (owner !== null && stat.uid !== owner)
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) {
    throw new RegistryPersistenceUnavailable('registry lock has unsafe owner, mode, or type')
  }
  return stat.ino === identity.ino && stat.dev === identity.dev ? stat : null
}

function removeLockNow(lock: string, identity: { ino: number; dev: number }, expected?: Owner): boolean {
  const stat = lockNow(lock, identity)
  if (!stat) return false
  const current = readOwnerNow(join(lock, 'owner.json'))
  if (expected ? !current.owner || !sameOwner(current.owner, expected)
    : Number(current.owner?.pid) > 0 && !!current.owner?.token
      || Date.now() - Math.max(stat.mtimeMs, current.modified) <= OWNERLESS_MS) return false
  // A protocol lock contains at most one file. Read at most two entries;
  // unexpected state must never turn core cleanup into a recursive walk.
  stateFileCustodyHealthy()
  const directory = opendirSync(lock, { bufferSize: 1 })
  try {
    const first = directory.readSync()
    if (first && (first.name !== 'owner.json' || !first.isFile() || directory.readSync())) {
      console.warn('[registry] lock cleanup refused unexpected contents')
      return false
    }
  } finally { closeStateDirectoryIterator(directory) }
  if (!lockNow(lock, identity)) return false
  const final = readOwnerNow(join(lock, 'owner.json'))
  if (expected ? !final.owner || !sameOwner(final.owner, expected)
    : Number(final.owner?.pid) > 0 && !!final.owner?.token
      || Date.now() - Math.max(stat.mtimeMs, final.modified) <= OWNERLESS_MS) return false
  try { unlinkSync(join(lock, 'owner.json')) } catch (error) { if (!missing(error)) throw error }
  if (!lockNow(lock, identity)) return false
  try { rmdirSync(lock) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    console.warn('[registry] lock cleanup refused unexpected contents')
    return false
  }
  return true
}

/** Kept byte/protocol compatible with the last thirty days' synchronous writers. */
export async function registryFileLock<T>(directory: string,
  deadline: Pick<RegistryWriteDeadline, 'expires' | 'check'> & Partial<Pick<RegistryWriteDeadline, 'retain' | 'failedClose'>>,
  apply: (checkOwner: () => void) => Promise<T>): Promise<T> {
  const started = performance.now()
  const expires = Math.min(deadline.expires, started + LOCK_MS)
  const check = () => { deadline.check(); if (performance.now() >= expires) throw new RegistryPersistenceUnavailable('registry lock is busy') }
  await privateRegistryDirectory(directory)
  check()
  ownGeneration ||= await startMarker(process.pid, expires - performance.now())
  check()
  const lock = join(directory, 'registry.json.lock')
  const ownerFile = join(lock, 'owner.json')
  for (;;) {
    check()
    const token = randomUUID()
    let created = false, entered = false
    let identity: { ino: number; dev: number } | undefined
    const checkOwner = () => {
      deadline.check()
      const stat = identity && lockNow(lock, identity)
      const saved = readOwnerNow(ownerFile).owner
      if (!stat || saved?.token !== token || saved.pid !== process.pid) {
        throw new RegistryPersistenceUnavailable('registry lock ownership changed')
      }
    }
    const removeOwned = async () => {
      if (!identity) return
      try {
        const stat = await fs.lstat(lock)
        if (stat.ino !== identity.ino || stat.dev !== identity.dev) return
        const owner = await readOwner(ownerFile)
        if (owner?.token === token && owner.pid === process.pid) removeLockNow(lock, identity, owner)
      } catch (error) {
        if (error instanceof StateFileCleanupUnconfirmed) throw error
        console.warn('[registry] lock cleanup refused an unsafe owner')
      }
    }
    try {
      await fs.mkdir(lock, { mode: 0o700 })
      created = true
      check()
      identity = await fs.lstat(lock)
      check()
      stateFileCustodyHealthy()
      const handle = await fs.open(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        check()
        await handle.writeFile(JSON.stringify({ pid: process.pid, startMarker: ownGeneration?.startsWith('ps-c:') ? '' : ownGeneration ?? '',
          generationMarker: ownGeneration ?? '', token }))
        check()
        await handle.sync()
        check()
      } finally { await closeStateFileHandle(handle) }
      check()
      checkOwner()
      entered = true
      measure('lock', started)
      try { return await apply(checkOwner) }
      finally {
        if (!deadline.failedClose) {
          const cleanup = removeOwned()
          if (deadline.retain) deadline.retain(cleanup)
          else await cleanup
        }
        created = false
      }
    } catch (error) {
      if (entered) throw error
      if (created) {
        await removeOwned()
        // No token means no safe deletion once setup yielded. The old ownerless
        // debris rule reclaims it; never erase a new owner's directory here.
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      check()
      let owner: Owner | undefined
      let since = Date.now()
      let lockIdentity: { ino: number; dev: number } | undefined
      try {
        const stat = await fs.lstat(lock)
        lockIdentity = stat
        since = stat.mtimeMs
        const ownerUid = uid()
        if (!stat.isDirectory() || stat.isSymbolicLink() || (ownerUid !== null && stat.uid !== ownerUid)
          || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) throw new RegistryPersistenceUnavailable('registry lock has unsafe owner, mode, or type')
        const ownerStat = await fs.lstat(ownerFile)
        since = Math.max(since, ownerStat.mtimeMs)
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || (ownerUid !== null && ownerStat.uid !== ownerUid)
          || (process.platform !== 'win32' && (ownerStat.mode & 0o777) !== 0o600)) throw new RegistryPersistenceUnavailable('registry lock owner has unsafe owner, mode, or type')
        owner = await readOwner(ownerFile) ?? undefined
      } catch (error) { if (error instanceof RegistryPersistenceUnavailable || error instanceof StateFileCleanupUnconfirmed) throw error }
      check()
      if (!(Number(owner?.pid) > 0 && owner?.token)) {
        if (Date.now() - since > OWNERLESS_MS && lockIdentity) {
          const current = await fs.lstat(lock).catch(() => null)
          if (current?.ino === lockIdentity.ino && current.dev === lockIdentity.dev
            && removeLockNow(lock, lockIdentity)) continue
        }
      } else if (!await alive(Number(owner!.pid), lockStartMarker(owner), expires - performance.now())) {
        check()
        try {
          const current = await readOwner(ownerFile)
          if (current && sameOwner(current, owner!) && !await alive(Number(current.pid), lockStartMarker(current), expires - performance.now())) {
            check()
            if (lockIdentity && removeLockNow(lock, lockIdentity, current)) continue
          }
        } catch (error) { if (error instanceof RegistryPersistenceUnavailable || error instanceof StateFileCleanupUnconfirmed) throw error }
      }
      check()
      await new Promise(resolve => setTimeout(resolve, Math.min(WAIT_MS, Math.max(1, expires - performance.now()))))
    }
  }
}
