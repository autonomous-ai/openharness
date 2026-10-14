/** Immutable hook intake and effect order for one native process incarnation.
 * An acknowledged input can be recovered; a claimed effect cannot be guessed at.
 */
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { secureStateDirectory } from '../../lib/secureState.js'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'
import type { NativeHookOwner } from './nativeHookOwner.js'
import { validNativeHookWireIdentity, type NativeHookWireIdentity } from './nativeHookClientProtocol.js'
import type { NativeHookStageLease } from './nativeHookStaging.js'
import { MAX_NATIVE_GENERATIONS, nativeGenerationFactState, validNativeGenerationFact,
  type NativeGenerationFactRecord } from './nativeGenerationFact.js'
import { MAX_RETAINED_GENERATION_FACTS, nativeCancellationFact, nativeCancellationTargets,
  validNativeGenerationCancellation, type NativeGenerationCancellation, type NativeGenerationFrontier } from './nativeGenerationCancellation.js'

let activeOperations = 0
type OperationPurpose = 'normal' | 'terminal'
type Operation = { purpose: OperationPurpose; check(): void; checkOwner(): void; preparations: Set<Promise<unknown>>; yieldedAt: number;
  stage?: Promise<NativeHookStageLease>; stagePurpose?: OperationPurpose }

export class NativeHookJournalHeld extends Error {
  constructor(detail: string) { super(`Native hook delivery is held: ${detail}`); this.name = 'NativeHookJournalHeld' }
}
function held(detail: string): never { throw new NativeHookJournalHeld(detail) }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}`
const stamp = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const idPattern = /^[a-zA-Z0-9_-]{16,96}$/
const hashPattern = /^[a-f0-9]{64}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const MAX_RESULT_BYTES = 16_384
// A complete synchronous fence checks both copies. Keep its operation count
// below NativeEvidenceBudget's limit, including reserved terminal records.
const MAX_PROCESS_RECORDS = 4_096
// Reserve both copies of a bounded claim and result before owning an intake.
const TERMINAL_BYTES = 2 * (MAX_RESULT_BYTES + 4_096)
// An outbox ACK records ownership transfer, not a mutable HTTP response. This
// includes both record copies, their chain framing and bounded phase identity.
const ACK_BYTES = 4_096
export type NativeHookPhase = 'registration' | 'stop' | 'event'

export interface NativeHookIntake {
  id: string
  fingerprint: string
  /** Ownership is fenced separately from the process-wide order key. */
  agentId: string
  conversationId: string
  firedAt?: number
  owner?: NativeHookOwner
  payload: Record<string, unknown>
  /** Absent for legacy intake. Its presence cannot be inferred from a retry. */
  wire?: NativeHookWireIdentity
  /** Only outbox logs accept phases; the effect journal cannot interpret ACKs. */
  phases?: readonly NativeHookPhase[]
}
type Event = { kind: 'intake'; intake: NativeHookIntake }
  | { kind: 'generation'; fact: NativeGenerationFactRecord }
  | { kind: 'cancellation'; request: NativeGenerationCancellation }
  | { kind: 'claim'; id: string; token: string; agentId: string; predecessor: string | null }
  | { kind: 'result'; id: string; token: string; value: Record<string, unknown> }
  | { kind: 'ack'; id: string; phase: NativeHookPhase }
type RecordValue = { version: 1; log?: 'native-hook-outbox'; processKey: string; index: number; previous: string | null; event: Event }
type Read = ReturnType<typeof read>
export interface NativeHookDelivery {
  intake: NativeHookIntake
  result?: Record<string, unknown>
  resultToken?: string
  acknowledgements?: Set<NativeHookPhase>
  verify(): void
}
export interface NativeHookClaim {
  readonly id: string
  readonly token: string
  /** Call again inside the registry commit, after asynchronous preparation. */
  verify(): void
  finish(value: Record<string, unknown>): Promise<void>
}
interface Snapshot {
  processKey: string
  deliveries: Map<string, NativeHookDelivery>
  /** Observations share the complete frontier, but never own an effect slot. */
  generations: Map<string, NativeGenerationFactRecord>
  cancellations: Map<string, NativeGenerationCancellation>
  frontier: NativeGenerationFrontier
  cancellationTargets(request: NativeGenerationCancellation): readonly string[]
  /** Counted as one existing conservative terminal obligation, including its
   * staging/repair allowance, until the incarnation's first barrier is retained. */
  controlReserved: boolean
  active?: { id: string; token: string; agentId: string; verify(): void }
  previous: string | null
  lastResult: string | null
  bytes: number
  length: number
  verify(): void
  verifyRecords(): void
  verifyAuthority(): void
  confirm(): Promise<void>
}

/** Reading a journal is observation, never permission to chmod a foreign file. */
function read(file: string): { text: string; file: string; version: string; verify(): void } | undefined {
  const paths = new NativePaths(new NativeEvidenceBudget())
  const location = paths.resolveSync(file, true), facts = paths.snapshot()
  if (!location) return undefined
  if (lstatSync(file).isSymbolicLink()) held('aliased journal record')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  let text: string, expected: string
  try {
    const info = fstatSync(fd, { bigint: true })
    if (!info.isFile() || info.dev !== location.info.dev || info.ino !== location.info.ino
      || info.size > 1024 * 1024 || (info.mode & 0o777n) !== 0o600n
      || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) held('unsafe journal record')
    expected = stamp(info)
    const buffer = Buffer.alloc(Number(info.size))
    let offset = 0
    for (let calls = 0; offset < buffer.length; calls++) {
      if (calls >= 64) held('journal read exceeds its operation limit')
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (!count) held('journal record was truncated')
      offset += count
    }
    if (stamp(fstatSync(fd, { bigint: true })) !== expected) held('journal record changed during its read')
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } finally { closeSync(fd) }
  const verify = () => {
    verifyNativePathFacts(facts)
    if (stamp(lstatSync(file, { bigint: true })) !== expected) held('journal record changed')
  }
  verify()
  return { text, file, version: expected, verify }
}

function validIntake(value: unknown, maxBytes = 300_000): value is NativeHookIntake {
  if (!object(value)) return false
  return typeof value.id === 'string' && idPattern.test(value.id)
    && typeof value.fingerprint === 'string' && hashPattern.test(value.fingerprint)
    && typeof value.agentId === 'string' && value.agentId.length > 0 && value.agentId.length <= 200
    && typeof value.conversationId === 'string' && value.conversationId.length <= 200
    && (value.firedAt === undefined || Number.isSafeInteger(value.firedAt) && Number(value.firedAt) > 0)
    && (value.owner === undefined || object(value.owner) && typeof value.owner.key === 'string' && value.owner.key.length > 0
      && value.owner.key.length <= 512 && typeof value.owner.evidence === 'string' && value.owner.evidence.length > 0
      && value.owner.evidence.length <= 128_000)
    && (value.wire === undefined || validNativeHookWireIdentity(value.wire))
    && object(value.payload) && Buffer.byteLength(JSON.stringify(value)) <= maxBytes
}

class JournalAncestorChanged extends NativeHookJournalHeld {
  constructor() { super('journal directory ancestor changed') }
}

/** A directory walk yields regularly and proves its complete, unchanged boundary.
 * Ancestor sibling writes discard only this observation, never its original
 * route identity or any published record. Repeated churn stays visibly held. */
async function entries(path: string, limit: number, strict = false): Promise<{ names: string[]; inspected: number; verify(): void }> {
  const budget = new NativeEvidenceBudget(), paths = new NativePaths(budget), location = paths.resolveSync(path)!
  for (let attempt = 0;; attempt++) {
    paths.verify()
    try {
      const route = new Map<string, string>()
      for (let part = location.path;; part = dirname(part)) {
        budget.step()
        route.set(part, stamp(lstatSync(part, { bigint: true })))
        if (part === dirname(part)) break
      }
      const verifyRoute = () => {
        paths.verify()
        for (const [part, expected] of route) {
          budget.step()
          if (stamp(lstatSync(part, { bigint: true })) !== expected) throw new JournalAncestorChanged()
        }
      }
      const before = stamp(lstatSync(path, { bigint: true }))
      const iterator = opendirSync(location.path, { bufferSize: 32 })
      const names: string[] = []
      let began = performance.now(), inspected = 0
      const verify = () => { if (stamp(lstatSync(path, { bigint: true })) !== before) held('journal directory changed during recovery') }
      try {
        verify(); verifyRoute()
        for (;;) {
          const entry = iterator.readSync()
          if (!entry) break
          if (++inspected > limit + 64) held('journal directory exceeds its entry limit')
          // An interrupted exclusive publication can leave its private staging file.
          // It carries no authority and is never removed by recovery.
          if (entry.isFile() && /^\.harness-hook-[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
            if (strict) held('unbudgeted legacy staging file in allocated journal')
            read(join(path, entry.name))
            continue
          }
          if (names.length >= limit) held('journal record capacity is exhausted')
          if (!entry.isFile() || !/^\d{8}\.json$/.test(entry.name)) held('unrecognized journal entry')
          names.push(entry.name)
          if (names.length % 64 === 0 || performance.now() - began >= 20) {
            await new Promise<void>(done => setImmediate(done)); began = performance.now(); budget.step(); verify()
          }
        }
      } finally { iterator.closeSync() }
      verify(); verifyRoute()
      // An iterator redirected at an older directory must not report its shorter
      // prefix as a complete frontier, even if path metadata appeared unchanged.
      const next = join(path, `${String(names.length).padStart(8, '0')}.json`)
      if (read(next)) held('journal enumeration omitted a later record')
      verify(); verifyRoute()
      return { names: names.sort(), inspected, verify }
    } catch (error) {
      if (!(error instanceof JournalAncestorChanged) || attempt >= 2) throw error
      await new Promise<void>(done => setImmediate(done))
    }
  }
}

export interface NativeHookJournalAuthority {
  fingerprint: string
  verify(): void
}

/** An outside catalog seal can inspect a journal without initializing it. */
export function inspectNativeHookJournalAuthority(directory: string): NativeHookJournalAuthority {
  const records = ['bootstrap', 'authority', 'seal'].map(suffix => read(`${directory}.${suffix}`))
  if (records.some(record => !record)) held('allocated journal authority is missing')
  const directories = [directory, `${directory}.witnesses`].map(path => ({ path, expected: identity(lstatSync(path, { bigint: true })) }))
  const verify = () => {
    records.forEach(record => record!.verify())
    for (const { path, expected } of directories) if (identity(lstatSync(path, { bigint: true })) !== expected) held('allocated journal directory changed')
  }
  verify()
  return { fingerprint: digest(JSON.stringify([records.map(record => record!.text), directories.map(item => item.expected)])), verify }
}

export interface NativeHookJournalBoundary {
  verify(): void
  /** Coalesce root proofs only while this exact synchronous read is active. */
  read(check: () => void, after: () => void): void
  /** Called before any intake, including recovery of an unfinished bootstrap. */
  authorize(proof: NativeHookJournalAuthority, empty: () => Promise<() => void>, check: () => void): Promise<void>
  /** Retains the full boundary proof; current is the caller's cheap owner/deadline check. */
  acquireStage(purpose: OperationPurpose, current: () => boolean): Promise<NativeHookStageLease>
  track(actual: Promise<unknown>): void
}
interface JournalOptions {
  directory: string; processKey: string; current?: () => boolean; maxRecords?: number; maxBytes?: number; pendingCapacity?: number
  boundary?: NativeHookJournalBoundary
}

function createNativeHookLog({ directory, processKey, current = () => true,
  maxRecords = MAX_PROCESS_RECORDS, maxBytes = 256 * 1024 * 1024, pendingCapacity = 64, boundary,
}: JournalOptions, kind: 'effects' | 'outbox') {
  if (!processKey || processKey.length > 512) held('invalid journal namespace')
  const log = kind === 'outbox' ? { log: 'native-hook-outbox' as const } : {}
  const sameKind = (value: { log?: unknown }) => value.log === log.log
  // Two full 256 KiB HTTP bodies are retained as base64 (~699 KiB). The bounded
  // envelope and record framing still fit the existing 1 MiB publication limit.
  const valid = (value: unknown): value is NativeHookIntake => validIntake(value, kind === 'outbox' ? 720 * 1024 : 300_000) && (kind === 'effects' ? value.phases === undefined
    : Array.isArray(value.phases) && (value.phases.length === 1 && ['registration', 'stop', 'event'].includes(value.phases[0])
      || JSON.stringify(value.phases) === '["registration","stop"]'))
  const outstanding = (delivery: NativeHookDelivery) => delivery.intake.phases!.filter(phase => !delivery.acknowledgements?.has(phase)).length
  const ackBytes = ACK_BYTES + 2 * Buffer.byteLength(JSON.stringify(processKey))
  const witnesses = `${directory}.witnesses`, authorityFile = `${directory}.authority`
  const bootstrapFile = `${directory}.bootstrap`, sealFile = `${directory}.seal`
  maxRecords = Math.min(MAX_PROCESS_RECORDS, maxRecords)
  let closed = false
  const checkOwner = () => { if (closed || !current()) held('the original process owner changed') }
  const check = () => { boundary?.verify(); checkOwner() }
  const operations = new AsyncLocalStorage<Operation>()
  const readFence = (read: () => void) => boundary
    ? boundary.read(read, operations.getStore()?.checkOwner ?? checkOwner) : read()
  const operation = async <T>(purpose: OperationPurpose, work: () => Promise<T>, reuse = false): Promise<T> => {
    const parent = operations.getStore()
    // Only a private confirmation nested in its caller shares a lease. Every
    // public retain has a separate normal scope, even inside a terminal caller.
    if (reuse && parent) { parent.check(); return work() }
    if (!boundary) return work()
    check()
    if (activeOperations >= 16) held('actual journal operation slots are occupied')
    activeOperations++
    const deadline = performance.now() + 4500
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined
    const state: Operation = { purpose, preparations: new Set(), yieldedAt: performance.now(), check: () => { check(); state.checkOwner() }, checkOwner: () => {
      checkOwner()
      if (expired || performance.now() >= deadline) held('the journal operation expired')
    } }
    const actual = operations.run(state, async () => {
      try { state.check(); const result = await work(); state.check(); return result }
      finally {
        expired = true
        // Closing revokes new stages but retains the generation until actual
        // file flush, descriptor close and scratch cleanup have all settled.
        try {
          await Promise.allSettled([...state.preparations])
          await (await state.stage)?.close()
        }
        finally { activeOperations--; clearTimeout(timer) }
      }
    })
    boundary.track(actual)
    return Promise.race([actual, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new NativeHookJournalHeld('journal disk confirmation exceeded its deadline')) }, 4500)
    })])
  }
  const publish = async (file: string, text: string, verify: () => void, exclusive: boolean, normalOnly = false) => {
    const owner = operations.getStore()
    const published = await runHookPreparation([file], async attempt => {
      verify(); check()
      const inspected = inspectHookFile(file, 0o600)
      // Confirming an existing receipt must remain possible with every staging
      // lane occupied. Only a new publication needs scratch capacity.
      let lease: NativeHookStageLease | undefined
      if (boundary && inspected.content !== text) {
        const state = owner
        if (!state) held('journal publication has no operation owner')
        state.check()
        const purpose = normalOnly ? 'normal' : state.purpose
        if (purpose === 'normal' && state.stagePurpose === 'terminal') held('terminal capacity cannot initialize a journal')
        if (!state.stage) {
          state.stagePurpose = purpose
          state.stage = boundary.acquireStage(purpose, () => { state.checkOwner(); return true })
        }
        lease = await state.stage
        state.check(); lease.verify()
      }
      return inspected.replace(text, attempt, exclusive, lease?.stage)
    }, {
      // Recovery and admission can confirm the same immutable bytes at once.
      // Share only that in-flight sync; each waiter still checks its own facts
      // and owner. An exclusive publisher can never join or inherit a claim.
      identity: exclusive ? undefined : `native-hook-confirm:${digest(text)}`,
      retainConflicts: true,
      // Ancestor flushes keep their original descriptors but need no new disk
      // authority. The slow-registration profile showed seconds spent repeating
      // the whole catalog proof at these queue and completion checks.
      current: () => { (owner?.checkOwner ?? checkOwner)(); return true },
      verify: () => readFence(() => { verify(); (owner?.check ?? check)() }),
      track: actual => { owner?.preparations.add(actual) },
    })
    if (owner && performance.now() - owner.yieldedAt >= 20) {
      // Fast confirmations can form a long microtask train. Give eager control
      // callbacks a turn without extending this operation or borrowing a new
      // publication identity after the yield.
      await new Promise<void>(done => setImmediate(done))
      readFence(() => { verify(); published.verify(); owner.check() })
      owner.yieldedAt = performance.now()
    }
    return published.verify
  }
  const confirm = async (records: readonly Exclude<Read, undefined>[], verify: () => void, owner = verify) => {
    verify()
    for (const record of records) {
      record.verify()
      await publish(record.file, record.text, () => { owner(); record.verify() }, false)
    }
    verify()
  }
  const directories = () => {
    for (const path of [directory, witnesses]) {
      const info = lstatSync(path, { bigint: true })
      if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n
        || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) held('unsafe journal directory')
    }
    return { history: identity(lstatSync(directory, { bigint: true })), witnesses: identity(lstatSync(witnesses, { bigint: true })) }
  }
  const readAuthority = async () => {
    const checkAttempt = operations.getStore()?.check ?? check
    checkAttempt()
    let bootstrap = read(bootstrapFile)
    let saved = read(authorityFile)
    let sealed = read(sealFile)
    if (!bootstrap) {
      // The independent bootstrap must precede every namespace side effect.
      // Existing state with a lost bootstrap is never a fresh namespace.
      const absentPaths = [directory, witnesses, authorityFile, sealFile].map(path => {
        const routes = new NativePaths(new NativeEvidenceBudget())
        if (routes.resolveSync(path, true)) held('the journal bootstrap is missing')
        return routes.snapshot()
      })
      const verifyAbsent = () => { for (const facts of absentPaths) verifyNativePathFacts(facts) }
      await publish(bootstrapFile, JSON.stringify({ version: 1, ...log, processKey, token: randomUUID(), directory, witnesses }), verifyAbsent, true, true)
      bootstrap = read(bootstrapFile)
    }
    if (!bootstrap) held('journal bootstrap could not be confirmed')
    const initial = JSON.parse(bootstrap.text)
    if (initial.version !== 1 || !sameKind(initial) || initial.processKey !== processKey || typeof initial.token !== 'string'
      || !idPattern.test(initial.token) || initial.directory !== directory || initial.witnesses !== witnesses) held('journal bootstrap changed')
    const bootstrapHash = digest(bootstrap.text)
    const verifyBootstrap = () => { check(); bootstrap!.verify() }
    if (!saved) {
      if (sealed) held('the journal authority is missing')
      await confirm([bootstrap], verifyBootstrap)
      // Only the unfinished initialization reservation may adopt empty private
      // directories. It can never reinterpret a populated history as empty.
      for (const path of [directory, witnesses]) {
        let exists = false
        try {
          const info = lstatSync(path, { bigint: true })
          if (!info.isDirectory() || (info.mode & 0o777n) !== 0o700n
            || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) held('unsafe journal directory')
          exists = true
        } catch (error) { if (!absent(error)) throw error }
        if (exists && (await entries(path, maxRecords, !!boundary)).inspected !== 0) held('unfinished initialization has journal history')
        checkAttempt(); verifyBootstrap(); secureStateDirectory(path)
      }
      const expected = directories()
      await publish(authorityFile, JSON.stringify({ version: 1, ...log, processKey, bootstrap: bootstrapHash, ...expected }), () => {
        verifyBootstrap()
        if (JSON.stringify(directories()) !== JSON.stringify(expected)) held('journal ownership changed')
      }, true, true)
      saved = read(authorityFile)
    }
    if (!saved) held('journal authority could not be confirmed')
    const value = JSON.parse(saved.text)
    const verifyAuthority = () => readFence(() => {
      verifyBootstrap(); saved!.verify()
      if (value.version !== 1 || !sameKind(value) || value.processKey !== processKey || value.bootstrap !== bootstrapHash || JSON.stringify(directories())
        !== JSON.stringify({ history: value.history, witnesses: value.witnesses })) held('journal namespace changed')
    })
    verifyAuthority()
    const seal = JSON.stringify({ version: 1, ...log, processKey, bootstrap: bootstrapHash, authority: digest(saved.text),
      history: value.history, witnesses: value.witnesses })
    if (!sealed) {
      const history = await entries(directory, maxRecords, !!boundary), outside = await entries(witnesses, maxRecords, !!boundary)
      if (history.inspected || outside.inspected) held('the journal initialization seal is missing')
      await confirm([bootstrap, saved], verifyAuthority)
      await publish(sealFile, seal, () => { verifyAuthority(); history.verify(); outside.verify() }, true, true)
      sealed = read(sealFile)
    }
    if (!sealed || sealed.text !== seal) held('journal initialization seal changed')
    const verify = () => readFence(() => { verifyAuthority(); sealed!.verify() })
    verify()
    if (boundary) {
      const proof = inspectNativeHookJournalAuthority(directory)
      await boundary.authorize(proof, async () => {
        const history = await entries(directory, maxRecords, true), outside = await entries(witnesses, maxRecords, true)
        if (history.inspected || outside.inspected) held('unsealed catalog allocation has journal history')
        const verifyEmpty = () => { verify(); history.verify(); outside.verify() }
        verifyEmpty()
        return verifyEmpty
      }, operations.getStore()?.checkOwner ?? checkOwner)
      verify(); proof.verify()
    }
    return { verify, records: [bootstrap, saved, sealed] }
  }
  let authorityFlight: ReturnType<typeof readAuthority> | undefined
  const authority = async () => {
    check()
    // Recovery and HTTP admission can discover a new process together. Share
    // only their in-progress namespace initialization, never an effect claim
    // or a completed disk observation. Each resumed reader fences it again.
    const flight = authorityFlight ??= readAuthority()
    try {
      const owned = await flight
      check(); owned.verify()
      return owned
    } finally { if (authorityFlight === flight) authorityFlight = undefined }
  }
  const snapshot = async (repairAllowed = true): Promise<Snapshot> => {
    const owned = await authority(), verifyAuthority = owned.verify
    const history = await entries(directory, maxRecords, !!boundary), outside = await entries(witnesses, maxRecords, !!boundary)
    const repair = repairAllowed && outside.names.length === history.names.length + 1
      && history.names.every((name, index) => outside.names[index] === name)
    if (!repair && JSON.stringify(history.names) !== JSON.stringify(outside.names)) held('a journal record or witness is missing')
    const deliveries = new Map<string, NativeHookDelivery>(), generations = new Map<string, NativeGenerationFactRecord>()
    const cancellations = new Map<string, NativeGenerationCancellation>(), positions = new Map<string, number>()
    const chain: string[] = [], cancelled = new Set<string>()
    const generationScope = (fact: NativeGenerationFactRecord) => JSON.stringify([fact.agentId, fact.conversationId, fact.generationId])
    const addGeneration = (fact: NativeGenerationFactRecord, index: number) => {
      generations.set(fact.id, fact); positions.set(fact.id, index)
      if (fact.kind === 'cancelled') cancelled.add(generationScope(fact))
    }
    let active: { id: string; token: string; agentId: string; verify(): void } | undefined
    let previous: string | null = null, lastResult: string | null = null,
      bytes = kind === 'outbox' || boundary ? owned.records.reduce((total, record) => total + Buffer.byteLength(record.text), 0) : 0,
      began = performance.now()
    if (bytes > maxBytes) held('journal metadata exceeds its byte capacity')
    const versions: Array<{ file: string; version: string }> = []
    let tail: Exclude<Read, undefined>[] = owned.records
    let mirror: Exclude<Read, undefined> | undefined
    for (const [index, name] of outside.names.entries()) {
      if (name !== `${String(index).padStart(8, '0')}.json`) held('journal history has a gap')
      let record = read(join(directory, name))
      const witness = read(join(witnesses, name))
      if (!record && repair && index === history.names.length && witness) { mirror = witness; record = witness }
      if (!record || !witness || record.text !== witness.text) held('journal witness disagrees with its record')
      bytes += Buffer.byteLength(record.text) * 2
      if (bytes > maxBytes) held('journal byte capacity is exhausted')
      const value: RecordValue = JSON.parse(record.text)
      if (value.version !== 1 || !sameKind(value) || value.processKey !== processKey || value.index !== index || value.previous !== previous
        || !object(value.event)) held('invalid journal chain')
      const event = value.event
      versions.push({ file: record.file, version: record.version }, { file: witness.file, version: witness.version })
      const verify = () => {
        // A recovered client may send these bytes after this snapshot ends.
        // Keep its namespace and revocation proof, without freezing the mutable
        // append frontier or invalidating it when a sibling delivery arrives.
        if (kind === 'outbox') verifyAuthority()
        record.verify(); witness.verify()
      }
      if (event.kind === 'generation') {
        if (kind !== 'effects' || !validNativeGenerationFact(event.fact) || generations.has(event.fact.id)) held('invalid or repeated generation fact')
        if (event.fact.source.type === 'core' && cancellations.has(event.fact.source.requestId)) held('a cancellation cannot gain later targets')
        addGeneration(event.fact, index)
      } else if (event.kind === 'cancellation') {
        if (kind !== 'effects' || !validNativeGenerationCancellation(event.request) || cancellations.has(event.request.requestId)
          || [...generations.values()].some(fact => fact.source.type === 'core' && fact.source.requestId === event.request.requestId)) {
          held('invalid or repeated native cancellation')
        }
        const targets = nativeCancellationTargets(event.request, generations, positions, chain)
        for (const generationId of targets) {
          const fact = nativeCancellationFact(event.request, generationId)
          if (!cancelled.has(generationScope(fact))) addGeneration(fact, index)
        }
        cancellations.set(event.request.requestId, event.request)
      } else if (event.kind === 'intake') {
        if (!valid(event.intake) || deliveries.has(event.intake.id)) held('invalid or repeated journal intake')
        deliveries.set(event.intake.id, { intake: event.intake, verify, ...(kind === 'outbox' ? { acknowledgements: new Set<NativeHookPhase>() } : {}) })
      } else if (event.kind === 'ack') {
        const delivery = deliveries.get(event.id), phaseIndex = delivery?.intake.phases?.indexOf(event.phase) ?? -1
        if (kind !== 'outbox' || !delivery || phaseIndex < 0 || delivery.acknowledgements!.has(event.phase)
          || delivery.intake.phases!.slice(0, phaseIndex).some(phase => !delivery.acknowledgements!.has(phase))) held('unowned hook phase acknowledgement')
        const before = delivery.verify
        delivery.acknowledgements!.add(event.phase); delivery.verify = () => { before(); verify() }
      } else if (event.kind === 'claim') {
        const delivery = deliveries.get(event.id)
        if (kind !== 'effects' || active || !delivery || delivery.result || event.agentId !== delivery.intake.agentId
          || typeof event.token !== 'string' || !idPattern.test(event.token) || event.predecessor !== lastResult) held('invalid hook effect order')
        active = { id: event.id, token: event.token, agentId: event.agentId, verify }
      } else if (event.kind === 'result') {
        const delivery = deliveries.get(event.id)
        if (kind !== 'effects' || !active || !delivery || active.id !== event.id || active.token !== event.token || !object(event.value)
          || Buffer.byteLength(JSON.stringify(event.value)) > MAX_RESULT_BYTES) held('unowned hook result')
        const before = delivery.verify
        delivery.result = event.value; delivery.resultToken = event.token; delivery.verify = () => { before(); verify() }
        active = undefined; lastResult = digest(record.text)
      } else held('unknown hook journal event')
      previous = digest(record.text); chain.push(previous); tail = [...owned.records, record, witness]
      if (index % 64 === 63 || performance.now() - began >= 20) {
        await new Promise<void>(done => setImmediate(done)); began = performance.now()
        verifyAuthority(); history.verify(); outside.verify()
      }
    }
    const verifyRecords = () => {
      verifyAuthority()
      // Deduplicate ancestor checks through namespace authority; each immutable
      // leaf version consumed by the chain must still be the version inspected.
      const budget = new NativeEvidenceBudget()
      for (const record of versions) {
        budget.step()
        if (stamp(lstatSync(record.file, { bigint: true })) !== record.version) held('journal record changed after recovery')
      }
    }
    const verify = () => { history.verify(); outside.verify(); verifyRecords() }
    verify()
    if (mirror) {
      // The outside slot already chose the event. Completing its exact mirror
      // grants no execution right, including when that event is an effect claim.
      await confirm([...owned.records, mirror], verify, verifyAuthority)
      await publish(join(directory, outside.names.at(-1)!), mirror.text, verifyAuthority, true)
      verifyRecords()
      return snapshot(false)
    }
    if (generations.size > MAX_RETAINED_GENERATION_FACTS || nativeGenerationFactState(generations.values()).size > MAX_NATIVE_GENERATIONS) held('native generation capacity is exhausted')
    const controlReserved = kind === 'effects' && !cancellations.size
      && (generations.size > 0 || [...deliveries.values()].some(delivery => delivery.intake.payload.engine === 'cursor'))
    return { processKey, deliveries, generations, cancellations, controlReserved,
      frontier: Object.freeze({ index: history.names.length - 1, digest: previous }),
      cancellationTargets: request => { verify(); return nativeCancellationTargets(request, generations, positions, chain) },
      active, previous, lastResult, bytes, length: history.names.length, verify, verifyRecords, verifyAuthority,
      confirm: () => operation('terminal', () => confirm(tail, verify, verifyAuthority), true) }
  }
  const append = async (before: Snapshot, event: Event, normalOnly = false) => {
    before.verify()
    if (before.length >= maxRecords) held('journal record capacity is exhausted')
    const text = JSON.stringify({ version: 1, ...log, processKey, index: before.length, previous: before.previous, event } satisfies RecordValue)
    if (Buffer.byteLength(text) * 2 + before.bytes > maxBytes) held('journal byte capacity is exhausted')
    const name = `${String(before.length).padStart(8, '0')}.json`
    // The outside publication exclusively selects this log position across cores.
    // A failed sync never transfers that publisher's execution right to a retry.
    const verifyOutside = await publish(join(witnesses, name), text, before.verifyAuthority, true, normalOnly)
    // A recovery reader may already have completed the mirror. Only the original
    // exclusive outside publisher can reach this return and own a new claim.
    const existing = read(join(directory, name))
    if (existing && existing.text !== text) held('journal publication changed')
    const verifyMirror = await publish(join(directory, name), text, () => { before.verifyAuthority(); verifyOutside(); existing?.verify() }, !existing, normalOnly)
    const record = read(join(directory, name)), witness = read(join(witnesses, name))
    if (!record || !witness || record.text !== text || witness.text !== text) held('journal publication changed')
    const verify = () => { before.verifyRecords(); verifyOutside(); verifyMirror(); record.verify(); witness.verify() }
    verify()
    return verify
  }
  return {
    snapshot: (repairAllowed = true) => operation('terminal', () => snapshot(repairAllowed)),
    recordGeneration: async (input: NativeGenerationFactRecord): Promise<void> => {
      // Capture before even the catalog guard yields. One original operation
      // budget covers reading, classification, confirmation and publication.
      const fact = structuredClone(input)
      if (kind !== 'effects' || !validNativeGenerationFact(fact)) held('invalid native generation fact')
      const scope = JSON.stringify([fact.agentId, fact.conversationId, fact.generationId])
      const terminal = fact.kind === 'stopped' || fact.kind === 'cancelled'
      return operation('terminal', async () => {
        const before = await snapshot(), known = before.generations.get(fact.id)
        if (fact.source.type === 'core' && before.cancellations.has(fact.source.requestId) && !known) held('a cancellation cannot gain later targets')
        if (fact.source.type === 'native' && fact.source.identityV1 !== undefined && before.deliveries.has(fact.source.deliveryId)) {
          held('the native Stop already has an original intake')
        }
        if (known) {
          if (JSON.stringify(known) !== JSON.stringify(fact)) held('NATIVE_GENERATION_CONFLICT')
          await before.confirm(); before.verify(); return
        }
        const latest = nativeGenerationFactState(before.generations.values())
        const reserved = terminal && latest.get(scope) === 'running'
        if (!latest.has(scope) && latest.size >= MAX_NATIVE_GENERATIONS) held('native generation capacity is exhausted')
        const pending = [...before.deliveries.values()].filter(delivery => !delivery.result).length
        // Each generation reserves the same conservative bytes and two records
        // as a pending legacy effect. Facts are at most 4 KiB, so its first
        // Stop/Cancel and independent mirror repair fit that existing allowance.
        const remaining = [...nativeGenerationFactState([...before.generations.values(), fact]).values()]
          .filter(state => state === 'running').length
        const control = Number(!before.cancellations.size)
        const reservedRecords = 2 * (pending + remaining + control) - Number(!!before.active)
        const reservedBytes = (pending + remaining + control) * TERMINAL_BYTES
        const bytes = 2 * Buffer.byteLength(JSON.stringify({ version: 1, ...log, processKey,
          index: before.length, previous: before.previous, event: { kind: 'generation', fact } }))
        if (before.length + 1 + reservedRecords > maxRecords || before.bytes + bytes + reservedBytes > maxBytes) {
          held('generation capacity cannot retain terminal outcomes')
        }
        await before.confirm()
        // Only the exact running generation spends its terminal reservation.
        // A peer's winning Stop/Cancel invalidates this frontier; a later retry
        // reclassifies the fact as normal instead of spending that slot twice.
        await append(before, { kind: 'generation', fact }, !reserved)
      })
    },
    recordCancellation: async (input: NativeGenerationCancellation) => {
      const request = structuredClone(input)
      if (kind !== 'effects' || !validNativeGenerationCancellation(request)) held('invalid native cancellation')
      return operation('terminal', async () => {
        const before = await snapshot(), known = before.cancellations.get(request.requestId)
        if (known) {
          if (JSON.stringify(known) !== JSON.stringify(request)) held('NATIVE_CANCELLATION_CONFLICT')
          await before.confirm(); before.verify()
          return { recorded: false as const, verify: () => { check(); before.verify(); checkOwner() } }
        }
        if ([...before.generations.values()].some(fact => fact.source.type === 'core' && fact.source.requestId === request.requestId)) {
          held('NATIVE_CANCELLATION_CONFLICT')
        }
        const targets = before.cancellationTargets(request), facts = targets.map(id => nativeCancellationFact(request, id))
        const remaining = [...nativeGenerationFactState([...before.generations.values(), ...facts]).values()]
          .filter(state => state === 'running').length
        const pending = [...before.deliveries.values()].filter(delivery => !delivery.result).length
        const event: Event = { kind: 'cancellation', request }
        const bytes = 2 * Buffer.byteLength(JSON.stringify({ version: 1, ...log, processKey,
          index: before.length, previous: before.previous, event }))
        if (bytes > TERMINAL_BYTES || before.length + 1 + 2 * (pending + remaining) - Number(!!before.active) > maxRecords
          || before.bytes + bytes + (pending + remaining) * TERMINAL_BYTES > maxBytes) held('cancellation capacity cannot retain terminal outcomes')
        await before.confirm()
        const verifyPublished = await append(before, event, !before.controlReserved)
        // Retention is not permission to interrupt. Only this exclusive publisher
        // receives an in-memory capability, and only for an unchanged original
        // prefix. Recovery never recreates it or retries an uncertain interrupt.
        const after = await snapshot(); await after.confirm(); after.verify(); verifyPublished(); checkOwner()
        if (JSON.stringify(after.cancellations.get(request.requestId)) !== JSON.stringify(request)) held('the retained cancellation changed')
        const verify = () => { check(); verifyPublished(); after.verify(); checkOwner() }
        let used = false
        return { recorded: true as const, targets, verify,
          dispatch: <T>(effect: (verify: () => void) => T): T => {
            if (used) held('the cancellation dispatch was already consumed')
            used = true
            if (before.frontier.index !== request.frontier.index || before.frontier.digest !== request.frontier.digest
              || after.length !== before.length + 1) held('the cancellation dispatch frontier changed')
            verify()
            return effect(verify)
          },
        }
      })
    },
    retain: (input: NativeHookIntake): Promise<NativeHookDelivery> => operation('normal', async () => {
      const intake = structuredClone(input)
      if (!valid(intake)) held('invalid native delivery')
      const before = await snapshot(), known = before.deliveries.get(intake.id)
      if ([...before.generations.values()].some(fact => fact.source.type === 'native'
        && fact.source.identityV1 !== undefined && fact.source.deliveryId === intake.id)) {
        held('the native Stop already has a direct receipt')
      }
      if (known) {
        if (known.intake.fingerprint !== intake.fingerprint || kind === 'outbox' && JSON.stringify(known.intake) !== JSON.stringify(intake)) held('HOOK_DELIVERY_CONFLICT')
        if (known.intake.agentId !== intake.agentId) held('the native process has a different agent owner')
        await before.confirm(); known.verify(); return known
      }
      const deliveries = [...before.deliveries.values()]
      const pending = deliveries.filter(item => kind === 'outbox' ? outstanding(item) > 0 : !item.result).length
      if (pending >= pendingCapacity) held('too many pending native hooks')
      const generations = [...nativeGenerationFactState(before.generations.values()).values()].filter(state => state === 'running').length
      const control = Number(kind === 'effects' && !before.cancellations.size && (before.controlReserved || intake.payload.engine === 'cursor'))
      const needed = kind === 'outbox' ? deliveries.reduce((count, item) => count + outstanding(item), 0) + intake.phases!.length : (pending + generations + control) * 2 - Number(!!before.active) + 2
      const reservedBytes = kind === 'outbox' ? needed * ackBytes : (pending + generations + control + 1) * TERMINAL_BYTES
      const inputBytes = kind === 'outbox' ? 2 * Buffer.byteLength(JSON.stringify({ version: 1, ...log, processKey,
        index: before.length, previous: before.previous, event: { kind: 'intake', intake } })) : 2 * Buffer.byteLength(JSON.stringify(intake)) + 4096
      if (before.length + needed + 1 > maxRecords) held('journal record capacity cannot retain terminal outcomes')
      if (before.bytes + reservedBytes + inputBytes > maxBytes) held('journal byte capacity cannot retain terminal outcomes')
      await before.confirm()
      const verify = await append(before, { kind: 'intake', intake })
      return { intake, verify, ...(kind === 'outbox' ? { acknowledgements: new Set<NativeHookPhase>() } : {}) }
    }),
    acknowledge: (id: string, fingerprint: string, phase: NativeHookPhase): Promise<void> => operation('terminal', async () => {
      if (kind !== 'outbox') held('an effect journal cannot acknowledge a client phase')
      const before = await snapshot(), delivery = before.deliveries.get(id)
      if (!delivery || delivery.intake.fingerprint !== fingerprint) held('HOOK_DELIVERY_CONFLICT')
      const phaseIndex = delivery.intake.phases!.indexOf(phase)
      if (phaseIndex < 0 || delivery.intake.phases!.slice(0, phaseIndex).some(prior => !delivery.acknowledgements!.has(prior))) held('this hook phase cannot be acknowledged')
      await before.confirm(); delivery.verify()
      // Owned-pending and completed registration replies both transfer ownership.
      // Duplicates confirm the original fact without consuming another slot.
      if (delivery.acknowledgements!.has(phase)) return
      const remaining = [...before.deliveries.values()].reduce((count, item) => count + outstanding(item), 0)
      if (before.length + remaining > maxRecords || before.bytes + remaining * ackBytes > maxBytes) held('journal capacity cannot retain phase acknowledgements')
      await append(before, { kind: 'ack', id, phase })
    }),
    claim: (id: string, agentId: string, inspected?: { previous: string | null }): Promise<NativeHookClaim> => operation('terminal', async () => {
      if (kind !== 'effects') held('a client outbox cannot claim effects')
      const before = await snapshot(), delivery = before.deliveries.get(id)
      if (!delivery || delivery.result || delivery.intake.agentId !== agentId) held('this delivery cannot dispatch')
      if (before.active) held('an earlier native hook effect is unconfirmed')
      if (inspected && inspected.previous !== before.previous) held('native hook order changed after inspection')
      const pending = [...before.deliveries.values()].filter(item => !item.result).length
      if (before.length + pending * 2 > maxRecords || before.bytes + pending * TERMINAL_BYTES > maxBytes) held('journal capacity cannot retain terminal outcomes')
      await before.confirm()
      delivery.verify()
      const token = randomUUID()
      const verifyClaim = await append(before, { kind: 'claim', id, agentId, token, predecessor: before.lastResult })
      let finished = false, terminal: string | undefined
      const verifyOwner = () => { check(); delivery.verify(); verifyClaim() }
      const verify = () => {
        verifyOwner()
        if (finished) held('the hook effect already completed')
        if (terminal !== undefined) held('the hook effect is completing')
      }
      return { id, token, verify, finish: value => operation('terminal', async () => {
        const captured = structuredClone(value), proposed = JSON.stringify(captured)
        if (!object(captured) || Buffer.byteLength(proposed) > MAX_RESULT_BYTES) held('hook result exceeds its byte limit')
        verifyOwner()
        if (terminal !== undefined && terminal !== proposed) held('the original hook result cannot change')
        // Dispatch permission ends before any terminal publication or await. A
        // retry retains only permission to confirm this exact original result.
        terminal = proposed
        if (finished) return
        const latest = await snapshot()
        const completed = latest.deliveries.get(id)
        if (completed?.resultToken === token && JSON.stringify(completed.result) === proposed) {
          await latest.confirm(); verifyOwner(); finished = true; return
        }
        if (latest.active?.id !== id || latest.active.token !== token) held('the hook effect claim changed')
        verifyOwner()
        await append(latest, { kind: 'result', id, token, value: captured })
        finished = true
      }) }
    }),
    close(): void { closed = true },
  }
}

/** The caller supplies boot + native process birth as processKey, never agentId.
 * Each record has a second immutable witness outside its history directory. A
 * lost receipt or replaced directory holds instead of making an old ID new.
 */
export function createNativeHookJournal(options: JournalOptions) {
  const { snapshot, retain, claim, recordGeneration, recordCancellation, close } = createNativeHookLog(options, 'effects')
  return { snapshot, retain, claim, recordGeneration, recordCancellation, close }
}

/** Client receipts record responsibility, never permission to dispatch an effect. */
export function createNativeHookOutboxLog(options: JournalOptions) {
  const { snapshot, retain, acknowledge, close } = createNativeHookLog(options, 'outbox')
  return { snapshot, retain, acknowledge, close }
}
