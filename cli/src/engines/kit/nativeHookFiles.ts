/** Hook preparation owns only a verified file version. Unknown contents are
 * never an empty configuration, and a completed write includes its directory. */
import { randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants, fchmodSync, fstatSync, fsync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'

export class HookPreparationHeld extends Error {
  constructor(detail: string) { super(`Hook preparation is waiting: ${detail}`); this.name = 'HookPreparationHeld' }
}
const version = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.uid}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const fileIdentity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.uid}:${info.mode}`
export interface HookFilePublication { verify(): void }
export interface HookPreparationProof {
  files: readonly { file: string; target: string; stamp: string | null; facts: ReturnType<NativePaths['snapshot']> }[]
  current(): boolean
}
const MAX_BYTES = 1024 * 1024
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function syncDirectory(path: string, attempt: HookPreparationAttempt): Promise<void> {
  attempt.check()
  const expected = fileIdentity(lstatSync(path, { bigint: true }))
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (fileIdentity(fstatSync(fd, { bigint: true })) !== expected) throw new HookPreparationHeld('the directory changed before sync')
    await attempt.flush(fd)
    if (fileIdentity(lstatSync(path, { bigint: true })) !== expected) throw new HookPreparationHeld('the directory changed during sync')
  } finally { closeSync(fd) }
}

/** Retry must also confirm names created before an earlier parent sync failed.
 * Seeing an existing ancestor cannot prove that its publication was durable. */
async function syncDirectoryChain(path: string, attempt: HookPreparationAttempt): Promise<void> {
  for (let depth = 0; depth < 256; depth++) {
    attempt.check(); await syncDirectory(path, attempt)
    if (path === '/') return
    path = dirname(path)
  }
  throw new HookPreparationHeld('the directory sync exceeds its path limit')
}

/** Create only absent directories. The final leaf-to-root flush confirms every name. Existing
 * aliases are resolved before use; no directory is chmodded or replaced. */
function ensureDirectory(path: string, attempt: HookPreparationAttempt): void {
  attempt.check()
  try {
    if (!lstatSync(path).isDirectory()) throw new HookPreparationHeld('the configuration directory changed type')
  } catch (error) {
    if (!missing(error)) throw error
    ensureDirectory(dirname(path), attempt)
    attempt.verify(); attempt.check()
    try { mkdirSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
}

/** Resolve a missing descendant through a bounded, verified existing ancestor. */
function directoryPath(path: string): string {
  const suffix: string[] = []
  for (let depth = 0; depth < 256; depth++) {
    const route = new NativePaths(new NativeEvidenceBudget()).resolveSync(path, true)
    if (route) {
      if (!route.info.isDirectory()) throw new HookPreparationHeld('the configuration parent is not a directory')
      return join(route.path, ...suffix)
    }
    suffix.unshift(basename(path)); path = dirname(path)
  }
  throw new HookPreparationHeld('the configuration directory exceeds its path limit')
}

/** The result is local to one preparation attempt, not a settings cache.
 * A changed alias, owner, file or contents invalidates the whole observation. */
export function inspectHookFile(file: string, defaultMode = 0o666) {
  const paths = new NativePaths(new NativeEvidenceBudget())
  const located = paths.resolveSync(file, true)
  const facts = paths.snapshot()
  const directory = directoryPath(dirname(file))
  const target = located?.path ?? join(directory, basename(file))
  let before: string | null = null, content: string | null = null, mode = defaultMode
  if (located) {
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = fstatSync(fd, { bigint: true })
      if (!info.isFile() || info.size > MAX_BYTES || info.dev !== located.info.dev || info.ino !== located.info.ino
        || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) {
        throw new HookPreparationHeld('the settings file is not a bounded file owned by this account')
      }
      before = version(info); mode = Number(info.mode & 0o777n)
      const bytes = Buffer.alloc(Number(info.size))
      let offset = 0
      for (let reads = 0; offset < bytes.length; reads++) {
        if (reads >= 128) throw new HookPreparationHeld('the settings read exceeded its operation limit')
        const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (!read) throw new HookPreparationHeld('the settings file changed while being read')
        offset += read
      }
      if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings file changed while being read')
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } finally { closeSync(fd) }
  }
  const verify = () => {
    verifyNativePathFacts(facts.filter(fact => fact.identity !== null))
    // Another destination in the same preparation may have created a shared
    // absent directory. New ordinary directories are fine; a newly inserted
    // alias is not authority to write at a different location.
    const fresh = new NativePaths(new NativeEvidenceBudget())
    fresh.resolveSync(file, true)
    const knownAliases = new Set(facts.filter(fact => fact.alias).map(fact => fact.path))
    if (fresh.snapshot().some(fact => fact.alias && !knownAliases.has(fact.path))) {
      throw new HookPreparationHeld('the settings route gained an unconfirmed alias')
    }
    let now: BigIntStats | null
    try { now = lstatSync(target, { bigint: true }) } catch (error) { if (!missing(error)) throw error; now = null }
    if ((now ? version(now) : null) !== before) throw new HookPreparationHeld('the settings file changed before publication')
  }
  const prepare = (next: string | null) => {
    verify()
    if (next !== null && Buffer.byteLength(next) > MAX_BYTES) throw new HookPreparationHeld('the prepared settings exceed their size limit')
    if (next === null && content !== null && lstatSync(file).isSymbolicLink()) throw new HookPreparationHeld('the plugin entry is an alias')
    if (content === next) return
    if (content !== null && next !== null && (mode & 0o200) === 0) throw new HookPreparationHeld('the settings file is read-only')
    let parent = dirname(target)
    for (let depth = 0; depth < 256; depth++) {
      const route = new NativePaths(new NativeEvidenceBudget()).resolveSync(parent, true)
      if (route) { accessSync(route.path, constants.W_OK | constants.X_OK); return }
      parent = dirname(parent)
    }
    throw new HookPreparationHeld('the configuration parent exceeds its path limit')
  }
  verify()
  return {
    content, directory, stamp: before,
    verify, prepare,
    async replace(next: string, attempt: HookPreparationAttempt, exclusive = false): Promise<HookFilePublication> {
      attempt.verify(); prepare(next)
      if (exclusive && content !== null) throw new HookPreparationHeld('another owner already published this claim')
      if (content === next) {
        // A previous rename may have succeeded before directory sync failed.
        // Equality alone cannot turn that uncertainty into a durable success.
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings changed before sync')
          await attempt.flush(fd)
          if (version(fstatSync(fd, { bigint: true })) !== before) throw new HookPreparationHeld('the settings changed during sync')
        } finally { closeSync(fd) }
        await syncDirectoryChain(dirname(target), attempt)
        verify()
        return { verify }
      }
      // Resolve an existing ancestor before creating descendants; this preserves
      // relocated config homes without following a replaced alias at publish.
      const parent = directoryPath(dirname(target))
      ensureDirectory(parent, attempt)
      const actual = join(parent, target.slice(dirname(target).length + 1))
      // Creation invalidates absent-ancestor facts; capture the new route and
      // still require the exact old leaf (or its observed absence).
      const fresh = inspectHookFile(actual)
      if (fresh.content !== content) throw new HookPreparationHeld('the settings changed while their directory was prepared')
      const temporary = join(parent, `.harness-hook-${randomUUID()}.tmp`)
      let fd: number | undefined
      let stagedIdentity: string | undefined
      try {
        fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
        stagedIdentity = fileIdentity(fstatSync(fd, { bigint: true }))
        if (content !== null) { fchmodSync(fd, mode); stagedIdentity = fileIdentity(fstatSync(fd, { bigint: true })) }
        writeFileSync(fd, next)
        const stagedVersion = version(fstatSync(fd, { bigint: true }))
        await attempt.flush(fd)
        if (version(fstatSync(fd, { bigint: true })) !== stagedVersion || version(lstatSync(temporary, { bigint: true })) !== stagedVersion) {
          throw new HookPreparationHeld('the staging file changed before publication')
        }
        fresh.verify()
        // Retained existing ancestors/aliases must still name the original
        // route; only directories created above can replace an absent fact.
        verifyNativePathFacts(facts.filter(fact => fact.identity !== null))
        attempt.verify()
        if (exclusive) { linkSync(temporary, actual); unlinkSync(temporary) }
        else renameSync(temporary, actual)
        const committed = inspectHookFile(file)
        if (committed.content !== next || committed.stamp !== version(fstatSync(fd, { bigint: true }))) {
          throw new HookPreparationHeld('the published settings changed before sync')
        }
        attempt.observe(file, committed.verify)
        await syncDirectoryChain(parent, attempt)
        attempt.verify()
        verifyNativePathFacts(facts.filter(fact => fact.identity !== null && fact.path !== target))
        const published = inspectHookFile(file)
        if (published.content !== next || published.stamp !== version(fstatSync(fd, { bigint: true }))) {
          throw new HookPreparationHeld('the published settings changed before confirmation')
        }
        return { verify: published.verify }
      } finally {
        try { if (fd !== undefined) closeSync(fd) } finally {
          try {
            if (fileIdentity(lstatSync(temporary, { bigint: true })) !== stagedIdentity) throw new HookPreparationHeld('the staging file changed before cleanup')
            unlinkSync(temporary)
          } catch (error) { if (!missing(error)) throw error }
        }
      }
    },
    async remove(attempt: HookPreparationAttempt): Promise<HookFilePublication> {
      attempt.verify(); prepare(null)
      // Removing a discovered entry never authorizes deleting another profile's
      // shared target. A leaf alias requires the owner to resolve that conflict.
      if (content !== null && lstatSync(file).isSymbolicLink()) throw new HookPreparationHeld('the plugin entry is an alias')
      attempt.check()
      if (content !== null) unlinkSync(target)
      attempt.observe(file, inspectHookFile(file).verify)
      let parent = dirname(target)
      for (let depth = 0; depth < 256; depth++) {
        const route = new NativePaths(new NativeEvidenceBudget()).resolveSync(parent, true)
        if (route) { await syncDirectoryChain(route.path, attempt); break }
        parent = dirname(parent)
      }
      verifyNativePathFacts(facts.filter(fact => fact.identity !== null && fact.path !== target))
      const removed = inspectHookFile(file)
      if (removed.content !== null) throw new HookPreparationHeld('the removed plugin was recreated before confirmation')
      return { verify: removed.verify }
    },
  }
}


export interface HookPreparationAttempt {
  /** The original caller and deadline still authorize another effect. */
  check(): void
  /** All unfinished destinations and already-published outputs still match. */
  verify(): void
  observe(file: string, verify: () => void): void
  /** Own the descriptor until the actual syscall settles, even after a reply timeout. */
  flush(fd: number): Promise<void>
}
export interface HookPreparationOptions {
  /** Join only the same port, executable, command and complete destination set. */
  identity?: string
  current?(): boolean
  timeoutMs?: number
  /** Immutable effect claims must let a competing publisher finish. */
  retainConflicts?: boolean
  /** Evidence retained by this launch; never a global success cache. */
  confirmed?(proof: HookPreparationProof): void
}
interface PendingPreparation { identity?: string; keys: string[]; revoke(): void; reply: Promise<unknown>; waiters: number; proof?: HookPreparationProof }
function preparationProof(files: readonly string[], verifyRoutes: () => void): HookPreparationProof {
  verifyRoutes()
  const confirmed = files.map(file => {
    const paths = new NativePaths(new NativeEvidenceBudget()), located = paths.resolveSync(file, true)
    const observed = inspectHookFile(file)
    return { file, target: located?.path ?? join(directoryPath(dirname(file)), basename(file)), stamp: observed.stamp, facts: paths.snapshot(), verify: observed.verify }
  })
  const proof = { files: confirmed.map(({ verify: _verify, ...file }) => file), current: () => {
    try { verifyRoutes(); for (const file of confirmed) file.verify(); return true } catch { return false }
  } }
  if (!proof.current()) throw new HookPreparationHeld('the prepared settings changed before acknowledgement')
  return proof
}
async function joinPreparation<T>(pending: PendingPreparation, options: HookPreparationOptions, verifyRoutes: () => void, files: readonly string[]): Promise<T> {
  const deadline = performance.now() + (options.timeoutMs ?? 5_000)
  verifyRoutes()
  if (options.current?.() === false) throw new HookPreparationHeld('the joining owner changed')
  if (pending.waiters >= 16) throw new HookPreparationHeld('the preparation waiters are occupied')
  pending.waiters++
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([pending.reply, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HookPreparationHeld('the joining preparation exceeded its deadline')), options.timeoutMs ?? 5_000)
    })])
    verifyRoutes()
    if (pending.proof && !pending.proof.current()) throw new HookPreparationHeld('the prepared settings changed before acknowledgement')
    // Joining shares the publication, not the caller's aliases. Retain this
    // caller's route all the way through the final pane guard.
    const proof = preparationProof(files, verifyRoutes)
    if (!pending.proof?.current() || proof.files.some(file => !pending.proof!.files.some(expected => expected.target === file.target && expected.stamp === file.stamp))) {
      throw new HookPreparationHeld('the prepared settings changed while their proof was captured')
    }
    if (performance.now() >= deadline) throw new HookPreparationHeld('the joining preparation exceeded its deadline')
    if (options.current?.() === false) throw new HookPreparationHeld('the joining owner changed')
    options.confirmed?.(proof)
    return result as T
  } finally { clearTimeout(timer); pending.waiters-- }
}
const pendingPreparations = new Set<PendingPreparation>()
const MAX_PREPARATIONS = 16
// fsync shares libuv's pool with native transcript reads. Leave capacity for
// those reads even when a disk confirmation never completes. Core starts with
// a fixed process environment; a one-thread pool cannot spare a disk writer.
const configuredThreads = Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '4', 10)
const MAX_FLUSHES = Math.max(0, Math.min(2, (Number.isFinite(configuredThreads) ? configuredThreads : 1) - 1))
let activeFlushes = 0
const flushQueue = new Set<() => void>()
function dispatchFlushes(): void {
  while (activeFlushes < MAX_FLUSHES && flushQueue.size) {
    const next = flushQueue.values().next().value!
    flushQueue.delete(next); next()
  }
}

/** A caller keeps its own aliases even when it later follows a newer publisher. */
export function hookPreparationRoutes(files: readonly string[]): { verify(): void; keys: string[]; facts: ReturnType<NativePaths['snapshot']> } {
  if (!files.length || files.length > 32) throw new HookPreparationHeld('the destination set exceeds its limit')
  const reservations = files.map(file => {
    const paths = new NativePaths(new NativeEvidenceBudget())
    const located = paths.resolveSync(file, true), facts = paths.snapshot()
    const key = located?.path ?? join(directoryPath(dirname(file)), basename(file))
    return { file, key, facts: facts.filter(fact => fact.identity !== null && fact.path !== located?.path),
      aliases: new Set(facts.filter(fact => fact.alias).map(fact => fact.path)) }
  })
  const verifyRoutes = () => {
    for (const { file, key, facts, aliases } of reservations) {
      if (facts.length) verifyNativePathFacts(facts)
      const fresh = new NativePaths(new NativeEvidenceBudget()), located = fresh.resolveSync(file, true)
      const target = located?.path ?? join(directoryPath(dirname(file)), basename(file))
      if (target !== key || fresh.snapshot().some(fact => fact.alias && !aliases.has(fact.path))) {
        throw new HookPreparationHeld('the reserved destination route changed')
      }
    }
  }
  const keys = [...new Set(reservations.map(reservation => reservation.key))].sort()
  return { verify: verifyRoutes, keys, facts: [...new Map(reservations.flatMap(item => item.facts).map(fact => [fact.path, fact])).values()] }
}

/** Disk waits remain in eager core code. Reservations survive a timeout until
 * actual I/O settles: a late fsync must never use a closed, recycled descriptor. */
export async function runHookPreparation<T>(files: readonly string[], work: (attempt: HookPreparationAttempt) => Promise<T>, options: HookPreparationOptions = {}): Promise<T> {
  const { verify: verifyRoutes, keys } = hookPreparationRoutes(files)
  const conflicts = [...pendingPreparations].filter(pending => pending.keys.some(key => keys.includes(key)))
  if (conflicts.length) {
    const same = conflicts.length === 1 && options.identity !== undefined && conflicts[0].identity === options.identity
      && JSON.stringify(conflicts[0].keys) === JSON.stringify(keys)
    if (same) return await joinPreparation<T>(conflicts[0], options, verifyRoutes, files)
    if (!options.retainConflicts) for (const pending of conflicts) pending.revoke()
    throw new HookPreparationHeld('another preparation still owns these destinations')
  }
  if (pendingPreparations.size >= MAX_PREPARATIONS) throw new HookPreparationHeld('the disk preparation slots are occupied')
  const deadline = performance.now() + (options.timeoutMs ?? 5_000)
  let revoked = false
  const cancellations = new Set<() => void>()
  const revoke = () => { revoked = true; for (const cancel of [...cancellations]) cancel() }
  const check = () => {
    if (revoked || performance.now() >= deadline || options.current?.() === false) {
      throw new HookPreparationHeld('the preparation expired or its owner changed')
    }
  }
  const observations = new Map<string, () => void>()
  const verify = () => { check(); verifyRoutes(); for (const inspect of observations.values()) inspect(); check() }
  const attempt: HookPreparationAttempt = {
    check, verify,
    observe: (file, inspect) => { observations.set(file, inspect) },
    async flush(fd) {
      check()
      if (!MAX_FLUSHES) throw new HookPreparationHeld('filesystem capacity cannot spare a disk confirmation')
      await new Promise<void>((done, reject) => {
        const cancel = () => {
          flushQueue.delete(start); cancellations.delete(cancel)
          reject(new HookPreparationHeld('the queued disk confirmation was revoked'))
        }
        const start = () => {
          cancellations.delete(cancel)
          try { check() } catch (error) { reject(error); return }
          activeFlushes++
          const settled = (error: Error | null) => {
            activeFlushes--; dispatchFlushes()
            if (error) reject(error); else done()
          }
          try { fsync(fd, settled) } catch (error) { settled(error as Error) }
        }
        cancellations.add(cancel); flushQueue.add(start); dispatchFlushes()
      })
      check()
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending: PendingPreparation = { identity: options.identity, keys, revoke, reply: Promise.resolve(), waiters: 0 }
  pendingPreparations.add(pending)
  // Dispatch only after the reservation is visible. A timeout ends the caller's
  // wait; the finally below runs only when the actual work (and its FDs) finishes.
  const actual = Promise.resolve().then(() => {
    verify()
    for (const file of files) observations.set(file, inspectHookFile(file).verify)
    return work(attempt)
  }).then(result => {
    verify()
    pending.proof = preparationProof(files, verifyRoutes)
    // The proof may describe only the outputs just published, never peer bytes
    // that arrived between the last verification and its filesystem reads.
    verify()
    options.confirmed?.(pending.proof)
    return result
  }).finally(() => {
    pendingPreparations.delete(pending)
    clearTimeout(timer)
  })
  pending.reply = Promise.race([actual, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { revoke(); reject(new HookPreparationHeld('disk confirmation exceeded its deadline')) }, options.timeoutMs ?? 5_000)
  })])
  return await pending.reply as T
}
