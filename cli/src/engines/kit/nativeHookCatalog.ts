/** Fixed reservations shared by the daemon and short-lived hook clients.
 * Allocation is permanent: full or damaged storage holds, never evicts receipts. */
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, opendirSync, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'
import { createNativeHookReadFence } from './nativeHookReadFence.js'
import { createNativeHookJournal, inspectNativeHookJournalAuthority, NativeHookJournalHeld,
  type NativeHookJournalBoundary } from './nativeHookJournal.js'
import { createNativeHookOutbox, NATIVE_HOOK_OUTBOX_SHARDS } from './nativeHookOutbox.js'
import { nativeHookMetadata as metadata, NativeHookReadRouteChanged, type createNativeHookStagePool } from './nativeHookStaging.js'

export const NATIVE_HOOK_STORAGE_LIMITS = Object.freeze({
  processes: 256, outboxes: NATIVE_HOOK_OUTBOX_SHARDS,
  effectBytes: 1024 * 1024, outboxBytes: 8 * 1024 * 1024,
  records: 4096, retainedIntakes: 382_208, contentBytes: 512 * 1024 * 1024,
})
type Kind = 'effects' | 'outbox'
type Metadata = NonNullable<ReturnType<typeof metadata.read>>
type Pair = { record: Metadata; mirror?: Metadata; verify(): void }
type Allocation = { kind: Kind; index: number; key: string; pair: Pair; seal?: Pair }
type Pool = Pick<ReturnType<typeof createNativeHookStagePool>, 'acquire'>
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.birthtimeNs}`
const stamp = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
function held(detail: string): never { throw new NativeHookJournalHeld(`catalog: ${detail}`) }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const count = (kind: Kind) => kind === 'effects' ? NATIVE_HOOK_STORAGE_LIMITS.processes : NATIVE_HOOK_STORAGE_LIMITS.outboxes
let activeOperations = 0
// Ancestor stamps detect a route moved away and back during a read. A sibling
// write changes those stamps too. Discard the complete observation and reacquire
// it; no publication or retained authority is retried under this permission.
function stableRead<T>(read: () => T): T {
  for (let attempt = 0;; attempt++) {
    try { return read() } catch (error) {
      if (!(error instanceof NativeHookReadRouteChanged) || attempt >= 2) throw error
    }
  }
}

/** The caller supplies an already-private data root and its retained local
 * writer proof. This factory neither creates that root nor owns its lifetime. */
export function createNativeHookCatalog({ root, verifyRoot, pool, operationTimeoutMs = 4500 }: {
  root: string; verifyRoot(root: string): void; pool: Pool; operationTimeoutMs?: number
}) {
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0 || operationTimeoutMs > 4500) held('invalid operation deadline')
  const paths = new NativePaths(new NativeEvidenceBudget()), location = paths.resolveSync(root)!, facts = paths.snapshot()
  if (!location.info.isDirectory() || (location.info.mode & 0o777n) !== 0o700n
    || typeof process.getuid === 'function' && location.info.uid !== BigInt(process.getuid())) held('the storage root is not private')
  const expectedRoot = identity(location.info), canonical = location.path
  let closed = false
  const operations = new Set<Promise<unknown>>()
  const journalOperations = new Set<Promise<unknown>>()
  // Retained proofs ask for the calling operation's guard. Capturing the guard
  // which first read them would make later recovery inherit an expired request.
  const operationGuard = new AsyncLocalStorage<() => void>()
  const checkOperation = () => operationGuard.getStore()?.()
  const admitPublication = () => {
    const guard = operationGuard.getStore()
    if (!guard) held('publication has no active catalog operation')
    guard()
  }
  const publish: typeof metadata.publish = (file, text, verify, exclusive, created) =>
    metadata.publish(file, text, verify, exclusive, created, admitPublication)
  const rootIdentity = () => {
    if (closed) held('the catalog is closed')
    if (identity(lstatSync(canonical, { bigint: true })) !== expectedRoot) held('the storage root changed')
  }
  const rootReads = createNativeHookReadFence(() => {
    rootIdentity(); verifyRoot(root); verifyNativePathFacts(facts); rootIdentity(); checkOperation()
  }, () => { rootIdentity(); checkOperation() }, () => metadata.routeStamps(canonical), error => error instanceof NativeHookReadRouteChanged)
  const checkRoot = rootReads.verify
  const run = async <T>(work: (check: () => void) => Promise<T>, owner: () => void = () => {}): Promise<T> => {
    if (activeOperations >= 16) held('actual catalog operation slots are occupied')
    activeOperations++
    const deadline = performance.now() + operationTimeoutMs
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined
    const parent = operationGuard.getStore()
    const checkOwner = () => {
      parent?.(); owner()
      if (closed) held('the catalog is closed')
      if (expired || performance.now() >= deadline) held('the catalog operation expired')
    }
    const check = () => { checkRoot(); checkOwner() }
    const actual = operationGuard.run(checkOwner, () => Promise.resolve().then(() => { check(); return work(check) })
      .then(value => { check(); return value }))
      .finally(() => { activeOperations--; operations.delete(actual); clearTimeout(timer) })
    operations.add(actual)
    return await Promise.race([actual, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true; reject(new NativeHookJournalHeld('catalog: disk confirmation exceeded its deadline'))
      }, operationTimeoutMs)
    })])
  }
  const base = (kind: Kind, index: number) => join(canonical, `.native-hook-${kind}-${String(index).padStart(3, '0')}`)
  const history = (kind: Kind, index: number) => `${base(kind, index)}.history`
  const versionFile = join(canonical, '.native-hook-catalog')
  const versionText = JSON.stringify([1, expectedRoot, 256, 16, 1024 * 1024, 8 * 1024 * 1024, 4096])
  const exists = (file: string) => {
    try { lstatSync(file); return true } catch (error) { if (!missing(error)) throw error; return false }
  }
  const pairOnce = (file: string, verify = checkRoot): Pair | undefined => {
    verify()
    const route = metadata.routeStamps(canonical)
    // These fixed names are direct children of the already pinned root. Fence
    // that route around the pair, rather than multiplying the same ancestry
    // walk into each leaf's two stamp checks and every enclosing authority.
    const record = metadata.read(`${file}.witness`, () => {}), mirror = metadata.read(file, () => {})
    route(); verify()
    if (!record) { if (mirror) held('an allocation witness is missing'); return }
    if (mirror && mirror.text !== record.text) held('allocation mirrors disagree')
    const result = { record, mirror, verify: () => rootReads.run(() => { verify(); record.verify(); mirror?.verify(); checkRoot() }) }
    result.verify()
    return result
  }
  const pair = (file: string, verify = checkRoot): Pair | undefined => rootReads.run(() => pairOnce(file, verify))
  const confirm = async (file: string, text: string, verify: () => void, retainedVerify = checkRoot): Promise<Pair> => {
    verify()
    const publishedOutside = publish(`${file}.witness`, text, verify)
    const outside = metadata.read(`${file}.witness`, () => {})!
    publishedOutside.verify(); outside?.verify()
    if (outside?.text !== text) held('outside publication changed during confirmation')
    const fence = () => { verify(); outside.verify() }
    // The outside intent is durable before creating its mirror or a journal.
    await metadata.syncDirectory(canonical, fence)
    const publishedInside = publish(file, text, fence)
    const inside = metadata.read(file, () => {})!
    publishedInside.verify(); inside?.verify()
    if (inside?.text !== text) held('inside publication changed during confirmation')
    const complete = () => { fence(); inside.verify() }
    await metadata.syncParents(canonical, complete)
    complete()
    // Rebind to the original authority, not the previous confirmation closure.
    // Retaining that closure would recursively multiply every later read fence.
    const retained = pair(file, retainedVerify)
    if (!retained?.mirror || retained.record.text !== text) held('confirmed metadata changed')
    complete(); retained.verify()
    return retained
  }
  const journalAbsent = (kind: Kind, index: number) => {
    for (const suffix of ['', '.witnesses', '.bootstrap', '.authority', '.seal']) {
      if (exists(history(kind, index) + suffix)) held('a journal has no allocation authority')
    }
  }
  const inspectAllocation = (kind: Kind, index: number, verify: () => void): Allocation | undefined => rootReads.run(() => {
    const route = metadata.routeStamps(canonical)
    const saved = pairOnce(`${base(kind, index)}.allocation`, verify), seal = pairOnce(`${base(kind, index)}.seal`, verify)
    if (!saved) {
      if (seal) held('an allocation seal has no reservation')
      journalAbsent(kind, index)
      route()
      return
    }
    const value: unknown = JSON.parse(saved.record.text)
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== kind || value[2] !== index
      || typeof value[3] !== 'string' || !hashPattern.test(value[3]) || JSON.stringify(value) !== saved.record.text) held('invalid allocation reservation')
    if (seal) {
      const value: unknown = JSON.parse(seal.record.text)
      if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1 || value[1] !== hash(saved.record.text)
        || typeof value[2] !== 'string' || !hashPattern.test(value[2]) || JSON.stringify(value) !== seal.record.text) held('invalid allocation seal')
    }
    route()
    return { kind, index, key: value[3], pair: saved, seal }
  })
  const scan = async (verify: () => void) => {
    verify()
    const frontier = stamp(lstatSync(canonical, { bigint: true }))
    const unchanged = () => {
      verify()
      if (stamp(lstatSync(canonical, { bigint: true })) !== frontier) held('the allocation catalog changed during its scan')
    }
    const allocations: Allocation[] = [], keys = new Set<string>()
    // Recovery used to probe nine absent paths in each of 272 slots, for every
    // replay shard and receipt. Those repeated ENOENT calls starved even a local
    // acknowledgement. A complete, fenced directory listing proves absence;
    // occupied slots still pass the same allocation and journal authority checks.
    const budget = new NativeEvidenceBudget(), candidates = new Map<string, { kind: Kind; index: number }>()
    const entries = stableRead(() => {
      checkRoot()
      const route = metadata.routeStamps(canonical), opened = opendirSync(canonical, { bufferSize: 32 })
      try { route(); checkRoot(); return opened }
      catch (error) { opened.closeSync(); throw error }
    })
    try {
      let complete = false
      while (!complete) {
        const began = performance.now()
        for (let reads = 0; reads < 64 && performance.now() - began < 20; reads++) {
          budget.step()
          const entry = entries.readSync()
          if (!entry) { complete = true; break }
          budget.step(Buffer.byteLength(entry.name))
          const name = entry.name.toLowerCase()
          const match = /^\.native-hook-(effects|outbox)-(\d{3})(?:\.(?:allocation|seal)(?:\.witness)?|\.history(?:\.(?:witnesses|bootstrap|authority|seal))?)$/.exec(name)
          if (!match) continue
          const kind = match[1] as Kind, index = Number(match[2])
          if (index >= count(kind)) continue
          // A case-insensitive filesystem can resolve this spelling through the
          // canonical path. Never misread an established slot as empty.
          if (entry.name !== name) held('a catalog slot has a noncanonical name')
          candidates.set(`${kind}:${index}`, { kind, index })
        }
        // The acquired descriptor pins this directory. Ancestor content stamps
        // must not span an await: unrelated sibling writes change them too.
        unchanged()
        if (!complete) { await new Promise<void>(done => setImmediate(done)); unchanged() }
      }
    } finally { entries.closeSync() }
    unchanged()
    const slots = [...candidates.values()].sort((a, b) => a.kind === b.kind ? a.index - b.index : a.kind === 'effects' ? -1 : 1)
    for (let cursor = 0; cursor < slots.length;) {
      const batch = rootReads.run(() => {
        const found: Allocation[] = [], began = performance.now()
        let next = cursor
        do {
          verify()
          const { kind, index } = slots[next++]!, allocation = inspectAllocation(kind, index, verify)
          if (allocation) found.push(allocation)
        } while (next < slots.length && next - cursor < 64 && performance.now() - began < 20)
        return { found, next }
      })
      unchanged()
      // Only successful batches enter the complete scan. A changed route
      // discards all temporary results, including apparent empty reservations.
      for (const allocation of batch.found) {
        const { kind } = allocation
        const key = `${kind}:${allocation.key}`
        if (keys.has(key)) held('a process has multiple allocations')
        keys.add(key); allocations.push(allocation)
      }
      cursor = batch.next
      if (cursor < slots.length) { await new Promise<void>(done => setImmediate(done)); unchanged() }
    }
    // A scan must represent one complete allocation view. Its temporary root
    // stamp ends at exclusive publication; retained journal proofs use identity
    // only, so unrelated namespaces do not revoke an existing owner.
    const fence = () => { verify(); allocations.forEach(item => { item.pair.verify(); item.seal?.verify() }) }
    unchanged(); fence()
    return { allocations, verify: () => { fence(); unchanged() }, verifyRecords: fence }
  }
  const initialize = async (check: () => void) => {
    check()
    const saved = pair(versionFile)
    if (saved && saved.record.text !== versionText) held('the catalog format or root changed')
    let verifyEmpty = () => {}
    if (!saved) {
      if ((await scan(check)).allocations.length) held('the catalog authority is missing')
      // Staging may start only after the catalog exists. Losing its independent
      // boundary cannot turn retained writer generations into a fresh pool.
      let emptyRoute: (() => void) | undefined
      verifyEmpty = () => {
        check()
        if (emptyRoute) {
          try { emptyRoute(); return } catch (error) {
            if (!(error instanceof NativeHookReadRouteChanged)) throw error
            emptyRoute = undefined
          }
        }
        stableRead(() => {
        const route = metadata.routeStamps(canonical), budget = new NativeEvidenceBudget()
        // A previous draft's hash-named journal is retained evidence too. It
        // cannot disappear from authority merely because today's fixed-name
        // allocation scan does not recognize its format.
        const entries = opendirSync(canonical, { bufferSize: 2 })
        try {
          for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
            budget.step()
            if (![versionFile, versionFile + '.witness'].includes(join(canonical, entry.name))) held('unallocated storage remains before catalog initialization')
          }
        } finally { entries.closeSync() }
        for (const kind of ['effects', 'outbox'] as const) for (let index = 0; index < count(kind); index++) {
          budget.step()
          for (const suffix of ['.allocation', '.allocation.witness', '.seal', '.seal.witness']) {
            if (exists(base(kind, index) + suffix)) held('the catalog authority is missing')
          }
          journalAbsent(kind, index)
        }
        for (let lane = 0; lane < 8; lane++) {
          for (const suffix of ['', '.witnesses', '.bootstrap', '.authority', '.seal', ...Array.from({ length: 8 }, (_, i) => `.init-${i}`)]) {
            if (exists(join(canonical, `.native-hook-stage-${lane}${suffix}`))) held('the catalog authority is missing before staging')
          }
        }
        route(); check(); emptyRoute = route
        })
      }
    }
    return confirm(versionFile, versionText, () => { check(); verifyEmpty() })
  }
  let initializing: ReturnType<typeof initialize> | undefined
  const version = async (check: () => void) => {
    const actual = initializing ??= initialize(check)
    try { const result = await actual; check(); return result } finally { if (initializing === actual) initializing = undefined }
  }
  const allocate = async (kind: Kind, key: string, check: () => void, fixed?: number): Promise<Allocation> => {
    if (!key || key.length > 512) held('invalid process key')
    const control = await version(check), hashed = hash(key)
    const verify = () => { checkRoot(); control.verify() }
    const current = () => { check(); verify() }
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await scan(current)
      let selected = before.allocations.find(item => item.kind === kind && item.key === hashed)
      if (selected && fixed !== undefined && selected.index !== fixed) held('an outbox changed its fixed allocation')
      if (!selected) {
        const occupied = new Set(before.allocations.filter(item => item.kind === kind).map(item => item.index))
        const start = fixed ?? Number.parseInt(hashed.slice(0, 8), 16) % count(kind)
        const index = Array.from({ length: fixed === undefined ? count(kind) : 1 }, (_, step) => (start + step) % count(kind))
          .find(candidate => !occupied.has(candidate))
        if (index === undefined) held(`${kind} namespace capacity is exhausted`)
        const file = `${base(kind, index)}.allocation`, text = JSON.stringify([1, kind, index, hashed])
        before.verify()
        try { publish(`${file}.witness`, text, before.verifyRecords, true) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          // Another process chose this exact slot. Re-read its immutable key
          // before deciding whether this is our reservation or a collision.
          const winner = inspectAllocation(kind, index, current)
          if (!winner) held('the winning allocation disappeared')
          if (winner.key !== hashed) continue
        }
        selected = inspectAllocation(kind, index, current)
        if (!selected || selected.key !== hashed) held('the allocation changed before confirmation')
      }
      const saved = await confirm(`${base(kind, selected.index)}.allocation`, selected.pair.record.text, () => {
        current(); selected!.pair.verify()
      }, verify)
      return { ...selected, pair: saved }
    }
    return held('allocation contention requires a retry')
  }
  const boundary = (allocation: Allocation, current: () => boolean, retainedVerify: () => void = () => {}): NativeHookJournalBoundary => {
    const directory = history(allocation.kind, allocation.index), file = `${base(allocation.kind, allocation.index)}.seal`
    let authorized: { pair: Pair; authority: ReturnType<typeof inspectNativeHookJournalAuthority> } | undefined
    const checkOwner = () => { if (!current()) held('the original journal owner changed') }
    const baseVerify = () => rootReads.run(() => {
      checkRoot(); allocation.pair.verify(); retainedVerify()
      checkOwner()
    }, checkOwner)
    const inspectSeal = () => {
      const sealed = pair(file, () => { checkRoot(); allocation.pair.verify() })
      if (sealed) {
        const authority = inspectNativeHookJournalAuthority(directory)
        if (sealed.record.text !== JSON.stringify([1, hash(allocation.pair.record.text), authority.fingerprint])) held('the allocated journal changed')
        return { pair: sealed, authority }
      }
    }
    const verify = () => rootReads.run(() => {
      baseVerify()
      // Observe an existing seal before the journal may initialize anything.
      // A discarded read must not install its temporary view as retained state.
      const observed = authorized ?? inspectSeal()
      if (observed) { observed.pair.verify(); observed.authority.verify() }
    }, checkOwner)
    return {
      verify,
      read: rootReads.run,
      authorize(proof, empty, checkOwner) {
        return run(async check => {
          checkOwner(); verify(); proof.verify()
          const expected = JSON.stringify([1, hash(allocation.pair.record.text), proof.fingerprint])
          const prior = authorized ?? rootReads.run(inspectSeal)
          let verifyEmpty = () => {}
          if (!prior) { verifyEmpty = await empty(); check(); verify(); proof.verify() }
          if (prior && prior.pair.record.text !== expected) held('the journal seal changed')
          if (authorized) {
            // This exact immutable seal was already durably confirmed by this
            // boundary. Fresh proofs above still fence every use; observations
            // from a reconstructed boundary or a failed sync never enter here.
            check(); checkOwner(); return
          }
          const saved = await confirm(file, expected, () => { checkOwner(); check(); baseVerify(); prior?.pair.verify(); proof.verify(); verifyEmpty() }, baseVerify)
          checkOwner(); check(); authorized = { pair: saved, authority: proof }
          verify()
        }, checkOwner)
      },
      acquireStage: (purpose, current) => pool.acquire(() => { verify(); return current() }, { purpose }),
      track(actual) {
        journalOperations.add(actual)
        void actual.then(() => journalOperations.delete(actual), () => journalOperations.delete(actual))
      },
    }
  }
  const existing = async (kind: Kind, processKeys: readonly string[], current: () => boolean) => {
    const keys = [...new Set(processKeys)]
    if (keys.length > 33 || keys.some(key => !key || key.length > 512)) held('invalid receipt lookup keys')
    return run(async check => {
      const control = pair(versionFile)
      if (control && (!control.mirror || control.record.text !== versionText)) held('the receipt catalog authority is incomplete')
      const before = await scan(check)
      if (!control) {
        if (before.allocations.length) held('the receipt catalog authority is missing')
        return []
      }
      const matches = keys.flatMap(processKey => {
        const allocation = before.allocations.find(item => item.kind === kind && item.key === hash(processKey))
        if (!allocation) return []
        if (!allocation.pair.mirror || !allocation.seal?.mirror) held('the receipt namespace is not sealed')
        const proof = inspectNativeHookJournalAuthority(history(kind, allocation.index))
        if (allocation.seal.record.text !== JSON.stringify([1, hash(allocation.pair.record.text), proof.fingerprint])) {
          held('the receipt namespace authority changed')
        }
        proof.verify()
        const verify = () => rootReads.run(() => {
          checkRoot(); control.verify(); allocation.pair.verify(); allocation.seal!.verify(); proof.verify()
          if (!current()) held('the receipt lookup expired')
        })
        return [{ processKey, allocation, verify }]
      })
      before.verify(); control.verify(); check()
      return matches
    }, () => { if (!current()) held('the receipt lookup expired') })
  }
  return {
    /** Receipt recovery has no live process owner and grants no effect claim.
     * Select only already sealed namespaces; absence must never allocate one. */
    async readEffects(processKeys: readonly string[], current: () => boolean = () => true) {
      const selected = await existing('effects', processKeys, current)
      return new Map(selected.map(({ processKey, allocation, verify }) => {
        const journal = createNativeHookJournal({ directory: history('effects', allocation.index), processKey, current,
          maxBytes: NATIVE_HOOK_STORAGE_LIMITS.effectBytes, maxRecords: NATIVE_HOOK_STORAGE_LIMITS.records,
          boundary: boundary(allocation, current, verify) })
        return [processKey, { snapshot: async () => {
          verify()
          const snapshot = await journal.snapshot(false)
          verify()
          return { ...snapshot, verify: () => { verify(); snapshot.verify() },
            confirm: async () => { verify(); await snapshot.confirm(); verify() } }
        }, close: journal.close }] as const
      }))
    },
    async effects(processKey: string, current: () => boolean = () => true) {
      const allocation = await run(check => allocate('effects', processKey, check),
        () => { if (!current()) held('the original journal owner changed') })
      return createNativeHookJournal({ directory: history('effects', allocation.index), processKey, current,
        maxBytes: NATIVE_HOOK_STORAGE_LIMITS.effectBytes, maxRecords: NATIVE_HOOK_STORAGE_LIMITS.records,
        boundary: boundary(allocation, current) })
    },
    /** Recovery can finish only an existing client outbox. Missing shards stay
     * absent, and lost seals cannot be rebuilt by a reader or an ACK writer. */
    async readOutbox(shard: number, current: () => boolean = () => true) {
      if (!Number.isSafeInteger(shard) || shard < 0 || shard >= NATIVE_HOOK_STORAGE_LIMITS.outboxes) held('invalid outbox shard')
      const selected = await existing('outbox', [`native-hook-client:v1:shard:${shard}`], current)
      if (!selected.length) return undefined
      const { allocation, verify } = selected[0]!
      if (allocation.index !== shard) held('an outbox changed its fixed allocation')
      const actualOperations = new Set<Promise<unknown>>()
      // Owner/deadline callbacks run after the shared read fence. Putting the
      // selected disk proof in current() restarted its whole walk each time.
      const scope = boundary(allocation, current, verify)
      const outbox = createNativeHookOutbox({ directory: history('outbox', shard), shard, current,
        maxBytes: NATIVE_HOOK_STORAGE_LIMITS.outboxBytes, maxRecords: NATIVE_HOOK_STORAGE_LIMITS.records,
        boundary: { ...scope, track(actual) {
          scope.track(actual); actualOperations.add(actual)
          void actual.then(() => actualOperations.delete(actual), () => actualOperations.delete(actual))
        } } })
      return {
        async snapshot() {
          verify()
          const snapshot = await outbox.snapshot()
          verify()
          return { ...snapshot, verify: () => { verify(); snapshot.verify() },
            confirm: async () => { verify(); await snapshot.confirm(); verify() } }
        },
        async acknowledge(...args: Parameters<typeof outbox.acknowledge>) {
          verify(); await outbox.acknowledge(...args); verify()
        },
        async close() {
          outbox.close()
          await Promise.allSettled([...actualOperations])
        },
      }
    },
    async outbox(shard: number, current: () => boolean = () => true) {
      if (!Number.isSafeInteger(shard) || shard < 0 || shard >= NATIVE_HOOK_STORAGE_LIMITS.outboxes) held('invalid outbox shard')
      const allocation = await run(check => allocate('outbox', `native-hook-client:v1:shard:${shard}`, check, shard),
        () => { if (!current()) held('the original journal owner changed') })
      return createNativeHookOutbox({ directory: history('outbox', shard), shard, current,
        maxBytes: NATIVE_HOOK_STORAGE_LIMITS.outboxBytes, maxRecords: NATIVE_HOOK_STORAGE_LIMITS.records,
        boundary: boundary(allocation, current) })
    },
    async close(): Promise<void> {
      closed = true
      // Reply timeout cannot release a descriptor or its capacity while fsync
      // is still using it. Storage composition closes its writer proof after this.
      await Promise.allSettled([...operations, ...journalOperations])
    },
  }
}
