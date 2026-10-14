/** Bounded cross-process scratch space for immutable native hook publications.
 * Metadata uses atomic symlinks as bounded values; none are followed as paths. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readlinkSync, symlinkSync, unlinkSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'
import { createNativeHookReadFence } from './nativeHookReadFence.js'
import { flushHookFile, HookPreparationHeld, type HookFileStage } from './nativeHookFiles.js'
import { validNativeHookWriter as validWriter, type NativeHookWriter } from './nativeHookWriter.js'

export type { NativeHookWriter } from './nativeHookWriter.js'
export interface NativeHookStageLease {
  stage(destination: string): HookFileStage
  /** Revoke synchronously, then wait for actual stage cleanup before release. */
  close(): Promise<void>
  verify(): void
}
const LANES = 8, MAX_GENERATIONS = 8_192, MAX_INIT = 8, MAX_METADATA_BYTES = 512
// Completion cannot depend on scratch capacity consumed by later intake.
// Another reader may complete each terminal mirror while its live publisher
// waits for fsync. Reserve both successful operations, plus one existing outside
// tail for each namespace. Eight normal retain operations may still hold their
// leases at cutover: each can add one late intake needing one mirror repair and
// two publisher/repair pairs. (2 * (256 * 25 * 2 + 16 * 64 * 2) + 272 + 40) / 8.
export const NATIVE_HOOK_TERMINAL_GENERATIONS = 3_751
let activeAcquisitions = 0
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.birthtimeNs}`
const stamp = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function held(reason: string): never { throw new HookPreparationHeld(`native hook staging: ${reason}`) }
class ChangedReadRoute extends HookPreparationHeld {
  constructor() { super('native hook staging: directory route changed during scan') }
}
export { ChangedReadRoute as NativeHookReadRouteChanged }
const owned = (info: BigIntStats) => typeof process.getuid !== 'function' || info.uid === BigInt(process.getuid())
const number = (value: number) => String(value).padStart(8, '0')
type Metadata = { file: string; text: string; verify(): void }
type Claim = { record: Metadata; writer: NativeHookWriter; nonce: string }
type Namespace = { directory: string; witnesses: string; verify(): void }

function metadata(file: string, verifyRoute: () => void): Metadata | undefined {
  verifyRoute()
  let before: BigIntStats
  try { before = lstatSync(file, { bigint: true }) } catch (error) { if (missing(error)) return; throw error }
  if (!before.isSymbolicLink() || !owned(before) || before.size > BigInt(MAX_METADATA_BYTES)) held('unsafe metadata')
  const text = readlinkSync(file), expected = stamp(before)
  const verify = () => {
    verifyRoute()
    if (stamp(lstatSync(file, { bigint: true })) !== expected || readlinkSync(file) !== text
      || stamp(lstatSync(file, { bigint: true })) !== expected) held('metadata changed')
    verifyRoute()
  }
  verify()
  return { file, text, verify }
}

/** The exclusive winner alone may publish. Confirmation never acquires a lease. */
function publish(file: string, text: string, verify: () => void, exclusive = false,
  created?: (owned: Metadata) => void, admit: () => void = () => {}): Metadata {
  if (Buffer.byteLength(text) > MAX_METADATA_BYTES) held('metadata exceeds its byte reservation')
  verify()
  const proof = () => {
    const saved = metadata(file, verify)
    if (!saved || saved.text !== text) held('immutable metadata disagrees')
    return saved
  }
  // Admission can expire during the last leaf read. Retained metadata and
  // cleanup keep only their route authority, never this request guard.
  admit()
  try { symlinkSync(text, file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || exclusive) throw error
    return proof()
  }
  // Remember exclusive ownership before any fallible post-publication read.
  // Until proof succeeds this right permits only exact initialization/cleanup.
  created?.({ file, text, verify: () => proof().verify() })
  return proof()
}

function claim(record: Metadata): Claim {
  const value = JSON.parse(record.text)
  if (Buffer.byteLength(record.text) > 384 || JSON.stringify(value) !== record.text
    || !Array.isArray(value) || value.length !== 6 || value[0] !== 2
    || !validWriter({ boot: value[1], pid: value[2], birth: value[3], namespace: value[5] })
    || typeof value[4] !== 'string' || !/^[a-f0-9-]{36}$/.test(value[4])) held('invalid writer claim')
  return { record, writer: { boot: value[1], pid: value[2], birth: value[3], namespace: value[5] }, nonce: value[4] }
}
const claimText = (writer: NativeHookWriter) => JSON.stringify([2, writer.boot, writer.pid, writer.birth, randomUUID(), writer.namespace])
const releaseText = (record: Metadata) => JSON.stringify([1, hash(record.text)])

/** A timeout may end the response, but never closes a descriptor still in fsync. */
async function syncDirectory(path: string, verify: () => void): Promise<void> {
  verify()
  const expected = identity(lstatSync(path, { bigint: true }))
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (identity(fstatSync(fd, { bigint: true })) !== expected) held('directory changed before sync')
    await flushHookFile(fd, verify)
    verify()
    if (identity(lstatSync(path, { bigint: true })) !== expected) held('directory changed during sync')
  } finally { closeSync(fd) }
}
async function syncParents(path: string, verify: () => void) {
  for (let depth = 0; depth < 256; depth++) {
    await syncDirectory(path, verify)
    if (path === dirname(path)) return
    path = dirname(path)
  }
  held('directory confirmation exceeds its depth limit')
}

// Catalog reservations have the same bounded atomic representation as lane
// claims. They must not recursively allocate an unbounded temporary file.
export const nativeHookMetadata = { read: metadata, publish, syncDirectory, syncParents, routeStamps }

function routeStamps(directory: string): () => void {
  const route = new Map<string, string>()
  for (let part = directory;; part = dirname(part)) {
    route.set(part, stamp(lstatSync(part, { bigint: true })))
    if (part === dirname(part)) break
  }
  return () => {
    for (const [part, expected] of route) if (stamp(lstatSync(part, { bigint: true })) !== expected) throw new ChangedReadRoute()
  }
}

async function names(directory: string, limit: number, verifyRoute: () => void) {
  verifyRoute()
  const verifyOpenedRoute = routeStamps(directory), expected = stamp(lstatSync(directory, { bigint: true })), entries: string[] = []
  const verify = () => {
    verifyRoute()
    if (stamp(lstatSync(directory, { bigint: true })) !== expected) held('directory changed during scan')
  }
  const iterator = opendirSync(directory, { bufferSize: 32 })
  let began = performance.now()
  try {
    // Bind this iterator to the route used to open it. Later sibling churn in
    // ancestors is harmless; the opened directory's own frontier stays pinned.
    verifyOpenedRoute(); verify()
    for (;;) {
      const entry = iterator.readSync()
      if (!entry) break
      if (entries.length >= limit) held('directory exceeds its entry bound')
      if (!entry.isSymbolicLink() && !entry.isFile()) held('unexpected staging entry')
      entries.push(entry.name)
      if (entries.length % 64 === 0 || performance.now() - began >= 20) {
        await new Promise<void>(done => setImmediate(done)); began = performance.now(); verify()
      }
    }
  } finally { iterator.closeSync() }
  verify()
  return { entries, verify }
}

/** The root must already be private. A catalog owns its lifetime; this factory
 * may create only its eight fixed namespaces, never recreate a lost authority. */
export function createNativeHookStagePool({ root, writer, verifyWriter, closeWriter, dead, maxGenerations = MAX_GENERATIONS,
  terminalGenerations = maxGenerations === MAX_GENERATIONS ? NATIVE_HOOK_TERMINAL_GENERATIONS : 0,
}: {
  root: string
  writer: NativeHookWriter
  /** Retained local-root proof from captureNativeHookWriter, required on writes too. */
  verifyWriter(root: string): void
  closeWriter(): void
  /** Fresh exact boot/PID/birth evidence. Unknown is an error or false, never dead. */
  dead(writer: NativeHookWriter): Promise<boolean>
  maxGenerations?: number
  terminalGenerations?: number
}) {
  writer = structuredClone(writer)
  if (!validWriter(writer) || !Number.isSafeInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > MAX_GENERATIONS
    || !Number.isSafeInteger(terminalGenerations) || terminalGenerations < 0 || terminalGenerations >= maxGenerations) held('invalid pool configuration')
  const paths = new NativePaths(new NativeEvidenceBudget()), location = paths.resolveSync(root)!, facts = paths.snapshot()
  if (!location.info.isDirectory() || (location.info.mode & 0o777n) !== 0o700n || !owned(location.info)) held('the pool root is not private')
  const poolKey = hash(JSON.stringify([location.path, maxGenerations, terminalGenerations])), rootIdentity = identity(location.info)
  const normalGenerations = maxGenerations - terminalGenerations
  const rootIdentityCheck = () => {
    if (identity(lstatSync(location.path, { bigint: true })) !== rootIdentity) held('pool root changed')
  }
  const rootReads = createNativeHookReadFence(() => {
    rootIdentityCheck()
    verifyWriter(root)
    verifyNativePathFacts(facts)
    rootIdentityCheck()
  }, rootIdentityCheck, () => routeStamps(location.path), error => error instanceof ChangedReadRoute)
  const rootVerify = rootReads.verify
  const initializers = new Map<number, Metadata>()
  const initializing = new Map<number, Promise<Namespace>>()
  const retiring = new Map<number, { busy: boolean; release(): void }>()
  const acquisitions = new Set<Promise<NativeHookStageLease>>(), leases = new Set<NativeHookStageLease>()
  let closed = false, closing: Promise<void> | undefined
  let cursor = 0
  const initialize = async (lane: number, check: () => void, checkOwner: () => void): Promise<Namespace> => {
    check(); rootVerify()
    const directory = join(location.path, `.native-hook-stage-${lane}`), witnesses = directory + '.witnesses'
    const bootstrapFile = directory + '.bootstrap', authorityFile = directory + '.authority', sealFile = directory + '.seal'
    let bootstrap = metadata(bootstrapFile, rootVerify), authority = metadata(authorityFile, rootVerify), seal = metadata(sealFile, rootVerify)
    const inspectDirectories = () => [directory, witnesses].map(path => {
      const info = lstatSync(path, { bigint: true })
      if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n || !owned(info)) held('unsafe lane directory')
      return identity(info)
    })
    const proof = (): Namespace => {
      if (!bootstrap || !authority || !seal) held('incomplete lane authority')
      // Initial publication checks include the request deadline. Retained
      // generation authority must also permit cleanup after that request ends.
      const originalAuthority = [bootstrap, authority, seal]
      for (const record of originalAuthority) record.verify()
      const fresh = originalAuthority.map(record => {
        const saved = metadata(record.file, rootVerify)
        if (!saved) held('lane authority disappeared during rebind')
        return saved
      })
      for (const prior of originalAuthority) prior.verify()
      ;[bootstrap, authority, seal] = fresh
      const value = JSON.parse(bootstrap.text)
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== poolKey || value[2] !== lane
        || typeof value[3] !== 'string' || !/^[a-f0-9-]{36}$/.test(value[3])) held('lane bootstrap changed')
      const expected = JSON.stringify([1, hash(bootstrap.text), ...inspectDirectories()])
      const verify = () => rootReads.run(() => {
        rootVerify(); bootstrap!.verify(); authority!.verify(); seal!.verify()
        if (authority!.text !== expected || JSON.stringify([1, hash(bootstrap!.text), ...inspectDirectories()]) !== expected
          || seal!.text !== JSON.stringify([1, hash(bootstrap!.text), hash(authority!.text)])) held('lane authority changed')
      })
      verify(); return { directory, witnesses, verify }
    }
    if (seal) return proof()
    // Only an exclusive initializer may sync metadata. An interrupted one can
    // be replaced after exact death proof, using another bounded immutable name.
    let previous: Metadata | undefined, index = 0, gap = false
    const observedInitializers: Metadata[] = []
    for (let slot = 0; slot < MAX_INIT; slot++) {
      const saved = metadata(directory + `.init-${slot}`, rootVerify)
      if (!saved) { gap = true; continue }
      if (gap) held('initializer history is incomplete')
      previous = saved; observedInitializers.push(saved); index++
    }
    let initializer = initializers.get(lane)
    let ownedIndex = index - 1
    if (!initializer || initializer.text !== previous?.text) {
      if (previous && !await dead(claim(previous).writer)) held('another initializer owns this lane')
      if (index >= MAX_INIT) held('lane initialization capacity is exhausted')
      const verifyInitial = () => {
        rootVerify(); for (const observed of observedInitializers) observed.verify()
      }
      verifyInitial()
      initializer = publish(directory + `.init-${index}`, claimText(writer), verifyInitial, true,
        owned => initializers.set(lane, owned), checkOwner)
      initializers.set(lane, initializer)
      ownedIndex = index
    }
    const verifyInit = () => rootReads.run(() => {
      rootVerify(); for (const observed of observedInitializers) observed.verify(); initializer!.verify(); check()
      for (let slot = ownedIndex + 1; slot < MAX_INIT; slot++) {
        if (metadata(directory + `.init-${slot}`, rootVerify)) held('a later initializer owns this lane')
      }
    }, checkOwner)
    await syncParents(location.path, verifyInit)
    if (!bootstrap) {
      for (const path of [directory, witnesses, authorityFile, sealFile]) {
        try { lstatSync(path); held('lane bootstrap is missing') } catch (error) { if (!missing(error)) throw error }
      }
      bootstrap = publish(bootstrapFile, JSON.stringify([1, poolKey, lane, randomUUID()]), verifyInit, true)
      await syncDirectory(location.path, verifyInit)
    }
    if (!authority) {
      for (const path of [directory, witnesses]) {
        check(); rootVerify(); bootstrap.verify(); checkOwner()
        try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        if ((await names(path, 1, verifyInit)).entries.length) held('unfinished lane initialization has history')
      }
      authority = publish(authorityFile, JSON.stringify([1, hash(bootstrap.text), ...inspectDirectories()]), verifyInit, true)
    }
    for (const path of [directory, witnesses]) {
      if ((await names(path, 1, verifyInit)).entries.length) held('established lane seal is missing')
      await syncDirectory(path, verifyInit)
    }
    await syncParents(location.path, verifyInit)
    // No async work remains after making initialization visible. The exclusive
    // generation claimant confirms this last name before using scratch space.
    seal = publish(sealFile, JSON.stringify([1, hash(bootstrap.text), hash(authority.text)]), verifyInit, true)
    return proof()
  }
  const namespace = async (lane: number, check: () => void, checkOwner: () => void) => {
    const flight = initializing.get(lane) ?? initialize(lane, check, checkOwner)
    initializing.set(lane, flight)
    try { const value = await flight; check(); value.verify(); checkOwner(); return value }
    finally { if (initializing.get(lane) === flight) initializing.delete(lane) }
  }
  const snapshot = async (space: Namespace) => {
    const inside = await names(space.directory, maxGenerations * 2 + 1, space.verify)
    const outside = await names(space.witnesses, maxGenerations * 2, space.verify)
    const pattern = /^(\d{8})\.(claim|release)$/
    const stages = inside.entries.filter(name => /^\d{8}\.[a-f0-9-]{36}\.\d+\.tmp$/.test(name))
    if (stages.length > 1 || inside.entries.some(name => !pattern.test(name) && !stages.includes(name))
      || outside.entries.some(name => !pattern.test(name))) held('unexpected lane contents')
    const all = new Set([...inside.entries.filter(name => pattern.test(name)), ...outside.entries])
    const claims = [...all].filter(name => name.endsWith('.claim')).sort()
    if (claims.length > maxGenerations || claims.some((name, index) => name !== `${number(index)}.claim`)
      || [...all].some(name => Number(name.slice(0, 8)) >= claims.length)) held('generation history is incomplete')
    // The complete name frontier is bounded; only unreleased claims need process
    // evidence. Old metadata is never pruned or used as new writer permission.
    const pending: Array<{ generation: number; claim: Claim }> = []
    let last: Claim | undefined
    const leaf = (file: string) => metadata(file, () => {})
    for (let cursor = 0; cursor < claims.length;) {
      // Complete route proofs bracket each synchronous batch. Repeating the
      // whole namespace proof for every old leaf would make recovery quadratic
      // in path depth and consume the caller's entire admission deadline.
      for (let attempt = 0;; attempt++) {
        inside.verify(); outside.verify()
        const verifyBatch = routeStamps(space.directory), began = performance.now(), batch: typeof pending = []
        let next = cursor, batchLast: Claim | undefined
        try {
          while (next < claims.length && next - cursor < 64) {
            const generation = next++, name = claims[generation]
            const outsideClaim = leaf(join(space.witnesses, name))
            const insideClaim = leaf(join(space.directory, name))
            if (!outsideClaim || insideClaim && insideClaim.text !== outsideClaim.text) held('claim copies disagree')
            batchLast = claim(outsideClaim)
            const releaseName = `${number(generation)}.release`, released = leaf(join(space.witnesses, releaseName))
            const releaseCopy = leaf(join(space.directory, releaseName))
            if (releaseCopy && !released || released && (released.text !== releaseText(outsideClaim) || releaseCopy && releaseCopy.text !== released.text)) held('release copies disagree')
            if (!released) {
              const record = batchLast.record
              batchLast = { ...batchLast, record: { ...record, verify: () => { space.verify(); record.verify(); insideClaim?.verify(); space.verify() } } }
              batch.push({ generation, claim: batchLast })
            }
            if (performance.now() - began >= 20) break
          }
          verifyBatch(); inside.verify(); outside.verify()
          pending.push(...batch); last = batchLast; cursor = next
          break
        } catch (error) {
          if (!(error instanceof ChangedReadRoute) || attempt >= 2) throw error
          // Ancestor sibling churn invalidates only this read. Keep the original
          // entry list and frontiers, discard every batch result, then re-read.
          // Changed leaves, malformed records and mutations never enter retry.
          inside.verify(); outside.verify()
          await new Promise<void>(done => setImmediate(done))
          inside.verify(); outside.verify()
        }
      }
      if (cursor < claims.length) { await new Promise<void>(done => setImmediate(done)); inside.verify(); outside.verify() }
    }
    if (stages.some(name => !pending.some(item => name.startsWith(`${number(item.generation)}.${item.claim.nonce}.`)))) held('stage has no unreleased writer')
    inside.verify(); outside.verify()
    return { length: claims.length, last, pending, stages, verify: () => { inside.verify(); outside.verify() } }
  }
  const refuseOccupied = async (space: Namespace, limit: number) => {
    // This bounded search can only refuse a lane. Missing or released metadata
    // never grants permission: every admitted writer still reads the full log.
    let low = 0, high = limit, latest: Metadata | undefined
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const found = metadata(join(space.witnesses, `${number(middle)}.claim`), space.verify)
      if (found) { low = middle + 1; latest = found } else high = middle
    }
    if (low === limit) held('generation capacity is exhausted')
    if (latest && !metadata(latest.file.replace(/\.claim$/, '.release'), space.verify)
      && !await dead(claim(latest).writer)) held('another writer owns this lane')
  }
  const terminalBoundary = async (check: () => void, checkOwner: () => void) => {
    const records: Metadata[] = []
    for (let lane = 0; lane < LANES; lane++) {
      check()
      const space = await namespace(lane, check, checkOwner), route = routeStamps(space.directory)
      const name = `${number(normalGenerations - 1)}.claim`
      const last = metadata(join(space.witnesses, name), space.verify), mirror = metadata(join(space.directory, name), space.verify)
      if (!last) held('normal capacity is not proven exhausted')
      claim(last)
      if (mirror && mirror.text !== last.text) held('normal capacity claims disagree')
      route(); check()
      const verify = () => { check(); last.verify(); mirror?.verify(); checkOwner() }
      // The cutover must survive reboot too. An unflushed prefix claim cannot
      // authorize suffix use and then disappear to reopen normal capacity.
      await syncDirectory(space.witnesses, verify)
      await syncParents(space.directory, verify)
      verify(); records.push(last, ...(mirror ? [mirror] : []))
    }
    const verify = () => { check(); records.forEach(record => record.verify()); checkOwner() }
    verify(); return verify
  }
  const acquire = async (current: () => boolean, purpose: 'normal' | 'terminal', terminal = false): Promise<NativeHookStageLease> => {
      const checkOwner = () => { if (!current()) held('the requesting writer was revoked') }
      const check = () => { rootVerify(); checkOwner() }
      const capacity = terminal ? maxGenerations : normalGenerations
      const verifyCapacity = terminal ? await terminalBoundary(check, checkOwner) : check
      const start = cursor++ % LANES
      let lastError: unknown
      for (let offset = 0; offset < LANES; offset++) {
        check()
        const lane = (start + offset) % LANES
        let abandon: (() => void) | undefined
        try {
          const cleanup = retiring.get(lane)
          if (cleanup) {
            if (cleanup.busy) held('another acquisition still owns this lane')
            cleanup.release(); retiring.delete(lane)
          }
          const space = await namespace(lane, check, checkOwner)
          await refuseOccupied(space, capacity); check()
          const before = await snapshot(space)
          if (before.length >= capacity) held('generation capacity is exhausted')
          if (terminal && before.length < normalGenerations) held('normal capacity changed after terminal admission')
          if (before.pending.length && !await dead(before.pending.at(-1)!.claim.writer)) held('another writer owns this lane')
          check(); before.verify(); verifyCapacity()
          const generation = before.length, name = `${number(generation)}.claim`
          let record!: Metadata
          let revoked = false, sequence = 0
          const retiredStages: string[] = []
          const verifyRetiredStages = () => {
            for (const path of retiredStages) {
              try { lstatSync(path); held('predecessor stage was recreated during cleanup') } catch (error) { if (!missing(error)) throw error }
            }
          }
          const verifyGeneration = () => rootReads.run(() => {
            space.verify(); record.verify()
            if (metadata(join(space.witnesses, `${number(generation + 1)}.claim`), space.verify)) held('a later writer owns this lane')
          })
          const verify = () => {
            check(); verifyGeneration(); verifyRetiredStages()
            if (revoked || metadata(join(space.witnesses, `${number(generation)}.release`), space.verify)) held('writer lease was released')
            // The final root/leaf proof can consume the remaining acquisition
            // time or revoke the caller. Cleanup uses verifyGeneration alone.
            checkOwner()
          }
          // Before a stage exists, an interrupted acquisition owns no payload
          // I/O. Its exclusive claim may be released after actual awaits settle.
          const release = () => {
            revoked = true
            const releaseName = `${number(generation)}.release`, text = releaseText(record)
            publish(join(space.directory, name), record.text, verifyGeneration)
            publish(join(space.witnesses, releaseName), text, verifyGeneration)
            publish(join(space.directory, releaseName), text, verifyGeneration)
          }
          verifyCapacity()
          record = publish(join(space.witnesses, name), claimText(writer), space.verify, true, owned => {
            record = owned; abandon = release
            retiring.set(lane, { busy: true, release })
          }, checkOwner)
          const owner = claim(record)
          publish(join(space.directory, name), record.text, verifyGeneration)
          await syncDirectory(space.witnesses, verifyGeneration)
          await syncParents(space.directory, verifyGeneration)
          check()
          // Reserving a successor grants only cleanup permission until every
          // predecessor is released and that fact is durably confirmed.
          for (const pending of before.pending) {
            if (!await dead(pending.claim.writer)) held('predecessor death is unconfirmed')
            check(); verifyGeneration(); pending.claim.record.verify()
            for (const stage of before.stages.filter(name => name.startsWith(`${number(pending.generation)}.${pending.claim.nonce}.`))) {
              const path = join(space.directory, stage), info = lstatSync(path, { bigint: true })
              if (!info.isFile() || !owned(info) || (info.mode & 0o777n) !== 0o600n || info.size > 1024n * 1024n) held('unsafe abandoned stage')
              verifyGeneration(); pending.claim.record.verify()
              if (stamp(lstatSync(path, { bigint: true })) !== stamp(info)) held('abandoned stage changed')
              unlinkSync(path)
              retiredStages.push(path)
            }
            await syncDirectory(space.directory, verifyGeneration)
            verifyRetiredStages()
            const releaseName = `${number(pending.generation)}.release`, text = releaseText(pending.claim.record)
            publish(join(space.witnesses, releaseName), text, verifyGeneration)
            publish(join(space.directory, releaseName), text, verifyGeneration)
          }
          await syncDirectory(space.witnesses, verifyGeneration)
          await syncParents(space.directory, verifyGeneration)
          verify()
          retiring.delete(lane)
          let active: { path: string; done: Promise<void>; settled: boolean; finish(): Promise<void> } | undefined
          let closing: Promise<void> | undefined
          return {
            verify,
            stage(destination) {
              verify()
              if (active) held('this writer already has a stage')
              const destinationInfo = lstatSync(dirname(destination), { bigint: true })
              if (!destinationInfo.isDirectory() || destinationInfo.dev !== lstatSync(space.directory, { bigint: true }).dev) held('destination is on another filesystem')
              checkOwner()
              const path = join(space.directory, `${number(generation)}.${owner.nonce}.${++sequence}.tmp`)
              let finished!: () => void, failed!: (error: unknown) => void, cleanup: Promise<void> | undefined
              const done = new Promise<void>((resolve, reject) => { finished = resolve; failed = reject })
              void done.catch(() => {})
              const finish = () => cleanup ??= (async () => {
                active!.settled = true
                verifyGeneration()
                try { lstatSync(path); held('stage cleanup did not remove its file') } catch (error) { if (!missing(error)) throw error }
                await syncDirectory(space.directory, verifyGeneration)
                try { lstatSync(path); held('stage was recreated during cleanup') } catch (error) { if (!missing(error)) throw error }
                active = undefined; finished()
              })().catch(error => { cleanup = undefined; failed(error); throw error })
              active = { path, done, settled: false, finish }
              return { path, verify, verifyCleanup: verifyGeneration, finish }
            },
            close() {
              revoked = true
              return closing ??= (async () => {
                if (active) {
                  if (active.settled) await active.finish()
                  else await active.done
                }
                verifyGeneration()
                const releaseName = `${number(generation)}.release`, text = releaseText(record)
                // All actual I/O is finished before release becomes visible.
                // Its successor confirms these atomic names before staging.
                publish(join(space.witnesses, releaseName), text, verifyGeneration)
                publish(join(space.directory, releaseName), text, verifyGeneration)
              })().catch(error => { closing = undefined; throw error })
            },
          }
        } catch (error) {
          const cleanup = retiring.get(lane)
          if (abandon && cleanup) {
            cleanup.busy = false
            try { cleanup.release(); retiring.delete(lane) } catch { /* Retain exact cleanup authority for the next attempt. */ }
          }
          lastError = error
        }
      }
      if (!terminal && purpose === 'terminal' && terminalGenerations) return acquire(current, purpose, true)
      throw lastError ?? new HookPreparationHeld('native hook staging lanes are occupied')
  }
  return {
    async acquire(current: () => boolean = () => true, { timeoutMs = 4_500, purpose = 'normal' }: {
      timeoutMs?: number; purpose?: 'normal' | 'terminal'
    } = {}): Promise<NativeHookStageLease> {
      if (closed) held('writer pool is closed')
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000) held('invalid acquisition deadline')
      if (activeAcquisitions >= 16) held('acquisition slots are occupied')
      activeAcquisitions++
      const deadline = performance.now() + timeoutMs
      let expired = false, acquiring = true, timer: ReturnType<typeof setTimeout> | undefined
      const ownerCurrent = () => {
        const allowed = !closed && current()
        if (expired || acquiring && performance.now() >= deadline) held('acquisition exceeded its deadline')
        return allowed
      }
      const actual = acquire(ownerCurrent, purpose)
        .then(async lease => {
          const tracked: NativeHookStageLease = { ...lease, async close() { await lease.close(); leases.delete(tracked) } }
          // Even a throwing guard must leave failed cleanup owned by the pool.
          leases.add(tracked)
          try { if (!ownerCurrent()) held('the requesting writer was revoked before lease delivery') }
          catch (error) { await tracked.close(); throw error }
          acquiring = false
          return tracked
        })
        .finally(() => { acquisitions.delete(actual); activeAcquisitions--; clearTimeout(timer) })
      acquisitions.add(actual)
      return await Promise.race([actual, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new HookPreparationHeld('native hook staging acquisition exceeded its deadline')) }, timeoutMs)
      })])
    },
    close(): Promise<void> {
      closed = true
      return closing ??= (async () => {
        await Promise.allSettled([...acquisitions])
        const outcomes = await Promise.allSettled([...leases].map(lease => lease.close()))
        const failed = outcomes.find(outcome => outcome.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        for (const [lane, cleanup] of retiring) { cleanup.release(); retiring.delete(lane) }
        // Every actual await, descriptor close, cleanup and lease release has
        // settled. Only now may the retained local-filesystem proof be closed.
        closeWriter()
      })().catch(error => { closing = undefined; throw error })
    },
  }
}
