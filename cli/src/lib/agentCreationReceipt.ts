import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'

export type AgentCreationOutcome =
  | { state: 'created'; agentId: string; level?: 'native' | 'handoff'; resumed?: boolean }
  | { state: 'failed'; error: string; detail?: string; preparedFolder?: string }
  | { state: 'unconfirmed' }

export type AgentCreationStatus = AgentCreationOutcome
  | { state: 'pending'; held?: CreationHold }
  | { state: 'missing' | 'cancelled' }

export interface CreationHold { service: string; detail: string }
export interface PendingCreationIntent { id: string; fingerprint: string; request: Record<string, unknown>; held: CreationHold }

/** An undispatched request can be recovered. A claimed request cannot: even a
 * dead owner may have left a live child, or changed a project before it died. */
type IntentReceipt = {
  version: 2
  fingerprint: string
  request: Record<string, unknown>
  held: CreationHold
  checksum: string
} | { version: 2; cancelled: true }
type IntentClaim = { fingerprint: string; token: string; kind: 'dispatch' | 'cancel' }
type IntentResult = { fingerprint: string; token: string; outcome: AgentCreationOutcome }

type Receipt = {
  version: 1
  fingerprint: string
  outcome: AgentCreationOutcome | { state: 'pending' }
}

function validOutcome(outcome: AgentCreationOutcome | undefined): outcome is AgentCreationOutcome {
  return !!outcome && (outcome.state === 'unconfirmed'
    || (outcome.state === 'failed' && typeof outcome.error === 'string')
    || (outcome.state === 'created' && typeof outcome.agentId === 'string' && !!outcome.agentId
      && (outcome.level === undefined || outcome.level === 'native' || outcome.level === 'handoff')
      && (outcome.resumed === undefined || typeof outcome.resumed === 'boolean')))
}

export class AgentCreationReceiptError extends Error {
  constructor(readonly code: 'INVALID_CREATION_ID' | 'CREATION_CONFLICT' | 'CREATION_STORAGE_FAILED') {
    super(code)
  }
}

export function validCreationId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(value)
}

/** Stable semantic identity. Legacy receipts retain only this hash; recoverable
 * model intents also retain their private request, never a resolved credential. */
export function creationFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]))
      : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/**
 * Reserve an intent before starting its process. A lost reply, reconnect, or
 * daemon restart never turns that same intent into another process launch.
 *
 * Pending receipts survive crashes. If the daemon stopped between starting a
 * process and saving its result, its outcome is unconfirmed; we never guess
 * that nothing started and run the operation again. Receipts are not evicted by
 * age: even an old retry must not silently become a fresh launch.
 */
export class AgentCreationReceipts {
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<AgentCreationStatus> }>()
  // A failed outcome write must not forget an agent we already know was created.
  // The on-disk reservation still prevents a duplicate after a later restart.
  private readonly unsaved = new Map<string, Receipt>()
  private readonly intentResults = new Map<string, IntentResult>()

  constructor(private readonly directory: string) {}

  /** An existing ID is consulted before mutable installation checks. A fresh
   * legacy request still gets its original, correctable validation refusal. */
  has(id: string, fingerprint: string): boolean {
    const receipt = this.read(id)
    if (!receipt) return false
    if (!(receipt.version === 2 && 'cancelled' in receipt) && receipt.fingerprint !== fingerprint) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    return true
  }

  status(id: string): AgentCreationStatus {
    const receipt = this.read(id)
    if (!receipt) return { state: 'missing' }
    if (receipt.version === 2) return this.intentStatus(id, receipt)
    return receipt.outcome.state === 'pending' && !this.inFlight.has(id)
      ? { state: 'unconfirmed' }
      : receipt.outcome
  }

  run(id: string, fingerprint: string, create: () => Promise<AgentCreationOutcome>): Promise<AgentCreationStatus> {
    const running = this.inFlight.get(id)
    if (running) {
      if (running.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
      return running.result
    }
    const receipt = this.read(id)
    if (receipt) {
      if (receipt.version === 2 && 'cancelled' in receipt) return Promise.resolve(this.intentStatus(id, receipt))
      if (receipt.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
      return Promise.resolve(this.status(id))
    }
    // O_EXCL is also the guard against another daemon reaching the same intent.
    // A partial/corrupt reservation is refused, never treated as a missing one.
    try {
      this.write(id, { version: 1, fingerprint, outcome: { state: 'pending' } }, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = this.read(id)
        if (existing?.version === 2 && 'cancelled' in existing) return Promise.resolve(this.intentStatus(id, existing))
        if (existing?.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
        return Promise.resolve(this.status(id))
      }
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    const result = Promise.resolve().then(async (): Promise<AgentCreationStatus> => {
      let outcome: AgentCreationOutcome
      try { outcome = await create() }
      catch { outcome = { state: 'unconfirmed' } }
      const completed: Receipt = { version: 1, fingerprint, outcome }
      try { this.write(id, completed, false) }
      catch { this.unsaved.set(id, completed) }
      return outcome
    }).finally(() => { this.inFlight.delete(id) })
    this.inFlight.set(id, { fingerprint, result })
    return result
  }

  /** Persist the complete private request before looking up its dependencies.
   * `prepare` may repeat service-owned credential refreshes, but MUST NOT prepare
   * projects, write launch configuration, signal or dispatch a process. It hands
   * back the effect callback only when its dependencies are ready. */
  runIntent(id: string, fingerprint: string, request: Record<string, unknown>, held: CreationHold,
    prepare: (request: Record<string, unknown>) => Promise<(() => Promise<AgentCreationOutcome>) | null>,
  ): Promise<AgentCreationStatus> {
    const running = this.inFlight.get(id)
    if (running) {
      if (running.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
      return running.result
    }
    let receipt = this.read(id)
    if (!receipt) {
      const intended: IntentReceipt = { version: 2, fingerprint, request: structuredClone(request), held: { ...held },
        checksum: creationFingerprint({ fingerprint, request, held }) }
      this.publish(this.file(id), intended)
      receipt = this.read(id)
    }
    if (!receipt) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    if (receipt.version === 2 && 'cancelled' in receipt) return Promise.resolve(this.intentStatus(id, receipt))
    if (receipt.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    if (receipt.version === 1) return Promise.resolve(this.status(id))
    const before = this.intentStatus(id, receipt, false)
    if (before.state !== 'pending') return Promise.resolve(before)
    // Decode our own durable bytes, not a caller's later-mutated request object.
    const saved = receipt
    const directory = this.holdDirectory()
    const currentReceipt = (): IntentReceipt => {
      directory.verify()
      const current = this.read(id)
      if (current?.version !== 2 || (!('cancelled' in current) && current.checksum !== saved.checksum)) {
        throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      }
      return current
    }
    const result = Promise.resolve().then(async (): Promise<AgentCreationStatus> => {
      let effect: (() => Promise<AgentCreationOutcome>) | null
      try { effect = await prepare(saved.request) }
      catch { effect = null }
      const current = this.intentStatus(id, currentReceipt(), false)
      if (!effect || current.state !== 'pending') return current
      const claim: IntentClaim = { fingerprint, token: randomUUID(), kind: 'dispatch' }
      // Exactly the successful publisher executes. In particular, seeing our
      // own claim after a failed directory fsync never grants a second attempt.
      if (!this.publish(this.intentFile(id, 'claim'), claim, true)) return this.intentStatus(id, saved, false)
      // A directory or primary intent replaced during service preparation must
      // not inherit this callback's authority, even if a later cancel created a
      // fresh tombstone at the same pathname. The open descriptor pins identity.
      if ('cancelled' in currentReceipt() || this.claim(id)?.token !== claim.token) {
        throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      }
      let outcome: AgentCreationOutcome
      try { outcome = await effect() } catch { outcome = { state: 'unconfirmed' } }
      const completed: IntentResult = { fingerprint, token: claim.token, outcome }
      let published = false
      try { published = this.publish(this.intentFile(id, 'result'), completed, true) } catch { /* Retain the known outcome under its exact claim. */ }
      if (!published) {
        this.intentResults.set(id, completed)
        // EEXIST or a failed save is not permission to hide conflicting disk
        // evidence beneath a memory-only success.
        return this.intentStatus(id, currentReceipt(), false)
      }
      return outcome
    }).finally(() => { directory.close(); clearTimeout(replyTimer); this.inFlight.delete(id) })
    // The client gets its held receipt promptly while the SAME preparation
    // continues. A slow successful service answer can still win dispatch;
    // reconnects must not start several preparations for that one request.
    let replyTimer: ReturnType<typeof setTimeout>
    const answer = new Promise<AgentCreationStatus>((resolve, reject) => {
      replyTimer = setTimeout(() => {
        try { resolve(this.intentStatus(id, saved)) } catch (error) { reject(error) }
      }, 5_000)
      replyTimer.unref?.()
      void result.then(resolve, reject)
    })
    this.inFlight.set(id, { fingerprint, result: answer })
    return answer
  }

  /** Cancellation shares dispatch's exclusive slot. A missing ID gets a durable
   * tombstone too: a delayed create cannot undo an acknowledged cancellation. */
  cancelIntent(id: string): AgentCreationStatus {
    let receipt = this.read(id)
    if (!receipt) {
      this.publish(this.file(id), { version: 2, cancelled: true })
      receipt = this.read(id)
    }
    if (!receipt) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    if (receipt.version === 1) return this.status(id)
    if ('cancelled' in receipt) { this.ensureDirectory(); this.syncDirectory(); return this.intentStatus(id, receipt) }
    // Incomplete evidence cannot be repaired into an acknowledged cancellation.
    this.intentStatus(id, receipt, false)
    this.publish(this.intentFile(id, 'claim'), { fingerprint: receipt.fingerprint, token: randomUUID(), kind: 'cancel' }, true)
    const status = this.intentStatus(id, receipt, false)
    if (status.state === 'cancelled') this.syncDirectory()
    return status
  }

  /** Streaming recovery never loads an unbounded directory into the core. Old
   * receipts and terminal tombstones stay authoritative, but are not scheduled. */
  pendingIntent(id: string): PendingCreationIntent | null {
    const receipt = this.read(id)
    if (receipt?.version !== 2 || 'cancelled' in receipt || this.intentStatus(id, receipt, false).state !== 'pending') return null
    return { id, fingerprint: receipt.fingerprint, request: receipt.request, held: receipt.held }
  }

  async *pendingIntents(): AsyncGenerator<PendingCreationIntent | null> {
    this.ensureDirectory()
    const entries = await opendir(this.directory)
    for await (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) { yield null; continue }
      const id = entry.name.slice(0, -5)
      if (!validCreationId(id)) { yield null; continue }
      try {
        yield this.pendingIntent(id)
      } catch { yield null /* Corrupt evidence remains held; one bad ID cannot block its siblings. */ }
    }
  }

  private intentFile(id: string, part: 'claim' | 'result'): string { return `${this.file(id)}.${part}` }

  private readIntentPart<T>(file: string): T | null {
    try {
      const value: unknown = JSON.parse(readPrivateStateFile(file, 262_144))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid receipt part')
      return value as T
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
  }

  private claim(id: string): IntentClaim | null {
    const claim = this.readIntentPart<IntentClaim>(this.intentFile(id, 'claim'))
    if (claim && (!/^[a-f0-9]{64}$/.test(claim.fingerprint) || typeof claim.token !== 'string' || !claim.token
      || (claim.kind !== 'dispatch' && claim.kind !== 'cancel'))) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    return claim
  }

  private intentStatus(id: string, receipt: IntentReceipt, live = this.inFlight.has(id)): AgentCreationStatus {
    const known = this.intentResults.get(id)
    if ('cancelled' in receipt) {
      if (known || this.claim(id) || this.readIntentPart(this.intentFile(id, 'result'))) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      return { state: 'cancelled' }
    }
    const claim = this.claim(id)
    const result = this.readIntentPart<IntentResult>(this.intentFile(id, 'result'))
    // A completed effect cannot become pending or cancelled when its disk
    // evidence disappears. Its retained result still requires the exact claim.
    if (known && (!claim || claim.kind !== 'dispatch' || known.fingerprint !== claim.fingerprint || known.token !== claim.token)) {
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    if (!claim) {
      if (result) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      return { state: 'pending', held: receipt.held }
    }
    if (claim.fingerprint !== receipt.fingerprint) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    if (claim.kind === 'cancel') {
      if (result) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      return { state: 'cancelled' }
    }
    if (result) {
      if (result.fingerprint !== claim.fingerprint || result.token !== claim.token || !validOutcome(result.outcome)
        || (known && creationFingerprint(known.outcome) !== creationFingerprint(result.outcome))) {
        throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      }
      return result.outcome
    }
    if (known) return known.outcome
    return { state: live ? 'pending' : 'unconfirmed' }
  }

  private publish(file: string, value: unknown, existingDirectory = false): boolean {
    const bytes = JSON.stringify(value)
    if (Buffer.byteLength(bytes) > 262_144) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    const temporary = `${file}.${randomUUID()}.tmp`
    let opened = false
    try {
      if (existingDirectory) secureStateDirectory(this.directory, false)
      this.ensureDirectory()
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      opened = true
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
      try { linkSync(temporary, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
      this.syncDirectory()
      return true
    } catch { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }
    finally { if (opened) rmSync(temporary, { force: true }) }
  }

  private syncDirectory(path = this.directory, ancestor = false): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | (ancestor ? 0 : constants.O_NOFOLLOW))
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  private holdDirectory(): { verify(): void; close(): void } {
    let fd: number | undefined
    try {
      fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const identity = fstatSync(fd)
      return {
        verify: () => {
          try {
            const current = lstatSync(this.directory)
            if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Replaced receipt directory')
          } catch { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }
        },
        close: () => closeSync(fd!),
      }
    } catch {
      if (fd !== undefined) closeSync(fd)
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
  }

  /** Publish every new directory name before using a child beneath it, in the
   * same order as engine-home adoption. Ancestors are flushed, never chmodded. */
  private ensureDirectory(path = this.directory, depth = 0): void {
    if (depth > 32) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    try {
      if (path === this.directory) secureStateDirectory(path, false)
      else if (!statSync(path).isDirectory()) throw new Error('Not a directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.ensureDirectory(dirname(path), depth + 1)
      try { mkdirSync(path, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      if (path === this.directory) secureStateDirectory(path, false)
    }
    this.syncDirectory(dirname(path), true)
  }

  private file(id: string): string {
    if (!validCreationId(id)) throw new AgentCreationReceiptError('INVALID_CREATION_ID')
    return join(this.directory, `${id}.json`)
  }

  private read(id: string): Receipt | IntentReceipt | null {
    const file = this.file(id)
    const unsaved = this.unsaved.get(id)
    if (unsaved) return unsaved
    const completedIntent = this.intentResults.has(id)
    try { secureStateDirectory(this.directory, false) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !completedIntent) return null
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    try {
      const value = JSON.parse(readPrivateStateFile(file, 262_144)) as Partial<Receipt> | Partial<IntentReceipt>
      if (value.version === 2) {
        if ('cancelled' in value && value.cancelled === true && Object.keys(value).sort().join(',') === 'cancelled,version') return { version: 2, cancelled: true }
        if ('request' in value && value.request && typeof value.request === 'object' && !Array.isArray(value.request)
          && /^[a-f0-9]{64}$/.test(value.fingerprint ?? '') && value.held && typeof value.held.service === 'string'
          && typeof value.held.detail === 'string'
          && value.checksum === creationFingerprint({ fingerprint: value.fingerprint, request: value.request, held: value.held })) return value as IntentReceipt
        throw new Error('Invalid creation intent')
      }
      const outcome = value.version === 1 ? value.outcome : undefined
      if (completedIntent || this.readIntentPart(this.intentFile(id, 'claim')) || this.readIntentPart(this.intentFile(id, 'result'))) {
        throw new Error('Legacy receipt has conflicting intent evidence')
      }
      if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint ?? '') || !outcome ||
          !['pending', 'unconfirmed', 'created', 'failed'].includes(outcome.state) ||
          (outcome.state === 'created' && (typeof outcome.agentId !== 'string' || !outcome.agentId ||
            (outcome.level !== undefined && outcome.level !== 'native' && outcome.level !== 'handoff') ||
            (outcome.resumed !== undefined && typeof outcome.resumed !== 'boolean'))) ||
          (outcome.state === 'failed' && typeof outcome.error !== 'string')) {
        throw new Error('Invalid creation receipt')
      }
      return value as Receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !completedIntent
        && !this.readIntentPart(this.intentFile(id, 'claim')) && !this.readIntentPart(this.intentFile(id, 'result'))) return null
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
  }

  private write(id: string, receipt: Receipt, exclusive: boolean): void {
    if (exclusive) this.ensureDirectory()
    else secureStateDirectory(this.directory, false)
    const file = this.file(id)
    const writing = exclusive ? file : `${file}.${process.pid}.${randomUUID()}.tmp`
    let opened = false
    try {
      const fd = openSync(writing, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      opened = true
      try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd) }
      finally { closeSync(fd) }
      if (!exclusive) renameSync(writing, file)
      const directoryFd = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } finally {
      // Failed reservations stay on disk so a partial write cannot permit a
      // duplicate. Only this write's private replacement file is disposable.
      if (!exclusive && opened) rmSync(writing, { force: true })
    }
  }
}
