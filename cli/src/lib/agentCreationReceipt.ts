import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { hookPreparationRoutes, inspectHookFile } from '../engines/kit/nativeHookFiles.js'
import { inspectNativeControlFile } from './nativeControlFile.js'
import { parseNativeArchiveLink, type NativeArchiveLink } from './nativeArchive.js'
import { parseNativeTurnProcessReference } from './nativeTurnIntent.js'
import { parseNativeLaunchAllocation, type NativeLaunchAllocation } from './nativeLaunchAllocation.js'
import { nativeCreateFingerprint, parseNativeCreateRequest, type NativeCreateRequest } from './nativeCreateRequest.js'

export type AgentCreationOutcome =
  | { state: 'created'; agentId: string; level?: 'native' | 'handoff'; resumed?: boolean }
  | { state: 'failed'; error: string; detail?: string; preparedFolder?: string }
  | { state: 'unconfirmed' }

export type AgentCreationStatus = AgentCreationOutcome
  | { state: 'pending'; held?: CreationHold }
  | { state: 'missing' | 'cancelled' }

export interface CreationHold { service: string; detail: string }
export interface PendingCreationIntent { id: string; fingerprint: string; request: Record<string, unknown>; held: CreationHold }
export interface CreationAuthority {
  readonly id: string
  /** Actual preparation/effect and receipt cleanup have finished. Never rejects
   * or grants authority; the five-second client reply can finish much earlier. */
  readonly settled?: Promise<void>
  /** The original durable intent still owns preparation, or this callback's exact dispatch claim. */
  current(): boolean
  /** Status only; a hold is never permission to repeat an effect. */
  hold(reason: CreationHold): void
}

export interface NativeRelaunchConfirmation {
  fingerprint: string
  request: Record<string, unknown>
  outcome: { state: 'created'; agentId: string; resumed: boolean }
}
export interface CreationConfirmationFence {
  /** Fresh receipt/reservation/native evidence, including the exact pane token. */
  verify(): void
  /** Disk-free original owner, deadline and shutdown check, last at publication. */
  current(): void
}
export interface NativeRelaunchProcess {
  boot: string
  pid: number
  birth: string
  /** Older witnesses remain readable but cannot prove death across PID views. */
  namespace?: string
  /** Captured before exec; omission in an older receipt remains unknown. */
  allocation?: NativeLaunchAllocation
}
export type NativeRelaunchRequest = Pick<NativeRelaunchConfirmation, 'fingerprint' | 'request'>
export interface NativeCreationRequest { fingerprint: string; request: NativeCreateRequest }
export interface NativeCreationConfirmation extends NativeCreationRequest {
  outcome: { state: 'created'; agentId: string }
}

/** Metadata cleanup only. Neither outcome grants launch, admission or signal
 * permission. The full original request survives later Cancel and Restart. */
export interface NativeResumeCleanupProof {
  readonly link: NativeArchiveLink
  readonly request: Readonly<Record<string, unknown>>
  readonly kind: 'created' | 'not-dispatched'
  readonly outcome: AgentCreationStatus
  verify(): void
}

/** Accounts only for the new allocation. A cancelled-ID tombstone does not
 * store a request: the caller must separately retain the exact original R.
 * Neither kind proves that R's old engine has exited. */
export interface NativeRelaunchNotDispatchedProof {
  readonly kind: 'cancelled-id' | 'cancelled-request' | 'not-dispatched'
  verify(): void
}

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
type IntentProcess = { fingerprint: string; token: string; process: NativeRelaunchProcess; checksum: string }
type IntentConfirmation = IntentResult & { process: string | null }

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

function nativeRelaunchRequest(id: string, request: Record<string, unknown>): boolean {
  return request.kind === 'native-rearm' && request.creationId === id && validCreationId(request.launchToken)
    && typeof request.agentId === 'string' && request.agentId.length > 0 && request.agentId.length <= 200
    && (request.operation === 'restart' || request.operation === 'resume')
}

function nativeCreationRequest(id: string, input: NativeRelaunchRequest): boolean {
  const request = parseNativeCreateRequest(input.request)
  return !!request && request.creationId === id && input.fingerprint === nativeCreateFingerprint(request)
}

function nativeLaunchRequest(id: string, input: NativeRelaunchRequest): boolean {
  return nativeRelaunchRequest(id, input.request) || nativeCreationRequest(id, input)
}

function validNativeSuccess(request: Record<string, unknown>, outcome: AgentCreationOutcome): boolean {
  return outcome?.state === 'created' && outcome.agentId === request.agentId
    && (request.kind === 'native-create-v2' ? Object.keys(outcome).sort().join(',') === 'agentId,state'
      : typeof outcome.resumed === 'boolean' && Object.keys(outcome).sort().join(',') === 'agentId,resumed,state')
}

function completeInitialProcess(request: Record<string, unknown>, process: NativeRelaunchProcess | undefined): boolean {
  return request.kind !== 'native-create-v2' || !!process?.namespace && !!process.allocation
}

function validRelaunchProcess(value: NativeRelaunchProcess | undefined): value is NativeRelaunchProcess {
  const decimal = (text: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
    Number.isSafeInteger(Number(text)) && Number(text) >= minimum && Number(text) <= maximum && String(Number(text)) === text
  return !!value && Object.keys(value).sort().join(',') === ['birth', 'boot', 'pid',
    ...(Object.hasOwn(value, 'namespace') ? ['namespace'] : []), ...(Object.hasOwn(value, 'allocation') ? ['allocation'] : [])].sort().join(',')
    && typeof value.boot === 'string' && /^(linux|darwin):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.boot)
    && Number.isSafeInteger(value.pid) && value.pid > 1 && value.pid <= 0x7fffffff
    && typeof value.birth === 'string' && value.birth.length <= 40
    && (value.boot.startsWith('linux:') ? decimal(value.birth, 1)
      : value.birth.split(':').length === 2 && decimal(value.birth.split(':')[0], 1) && decimal(value.birth.split(':')[1], 0, 999_999))
    && (!Object.hasOwn(value, 'namespace') || typeof value.namespace === 'string' && (value.boot.startsWith('linux:')
      ? /^linux:(?:0|[1-9][0-9]{0,19}):[1-9][0-9]{0,19}$/.test(value.namespace)
        && value.namespace.split(':').slice(1).every(part => BigInt(part) <= 0xffffffffffffffffn)
      : value.namespace === 'darwin'))
    && (!Object.hasOwn(value, 'allocation') || !!parseNativeLaunchAllocation(value.allocation, value))
}

function validIntentProcess(value: IntentProcess, launchToken: unknown): boolean {
  return Object.keys(value).sort().join(',') === 'checksum,fingerprint,process,token' && validRelaunchProcess(value.process)
    && (!value.process.allocation || value.process.allocation.token === launchToken)
    && value.checksum === creationFingerprint({ fingerprint: value.fingerprint, token: value.token, process: value.process })
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
    if (receipt.version === 2) this.intentStatus(id, receipt)
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
      return this.currentReply(id, fingerprint, running.result)
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
   * `prepare` may repeat service-owned credential refreshes and independently
   * journalled preparation. It MUST NOT signal or dispatch the agent process.
   * It hands back that effect only when all dependencies are ready. */
  runIntent(id: string, fingerprint: string, request: Record<string, unknown>, held: CreationHold,
    prepare: (request: Record<string, unknown>, authority: CreationAuthority) => Promise<(() => Promise<AgentCreationOutcome>) | null>,
  ): Promise<AgentCreationStatus> {
    const running = this.inFlight.get(id)
    if (running) {
      if (running.fingerprint !== fingerprint) throw new AgentCreationReceiptError('CREATION_CONFLICT')
      return this.currentReply(id, fingerprint, running.result)
    }
    let receipt = this.read(id)
    if (!receipt) {
      if (request.kind === 'native-create-v2' && !nativeCreationRequest(id, { request, fingerprint })) {
        throw new AgentCreationReceiptError('CREATION_CONFLICT')
      }
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
    let dispatchToken: string | undefined
    let alive = true
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    const authority: CreationAuthority = {
      id, settled,
      current: () => {
        if (!alive) return false
        try {
          if ('cancelled' in currentReceipt()) return false
          const claim = this.claim(id)
          if (!claim) return !dispatchToken && this.intentStatus(id, saved, false).state === 'pending'
          const status = this.intentStatus(id, saved, false)
          return !!dispatchToken && status.state === 'unconfirmed' && !this.intentResults.has(id)
            && !this.readIntentPart(this.intentFile(id, 'result'))
            && claim.kind === 'dispatch' && claim.fingerprint === fingerprint && claim.token === dispatchToken
        } catch { return false }
      },
      hold: reason => {
        if (!authority.current() || dispatchToken) return
        if (!reason.service || reason.service.length > 128 || !reason.detail || reason.detail.length > 2000) return
        // This replaceable sidecar is presentation only. The immutable intent,
        // exclusive claim and exact result remain the entire dispatch authority.
        this.writeHold(id, { checksum: saved.checksum, held: { ...reason } })
      },
    }
    const result = Promise.resolve().then(async (): Promise<AgentCreationStatus> => {
      let effect: (() => Promise<AgentCreationOutcome>) | null
      try { effect = await prepare(saved.request, authority) }
      catch { effect = null }
      const current = this.intentStatus(id, currentReceipt(), false)
      if (!effect || current.state !== 'pending') return current
      const claim: IntentClaim = { fingerprint, token: randomUUID(), kind: 'dispatch' }
      // Exactly the successful publisher executes. In particular, seeing our
      // own claim after a failed directory fsync never grants a second attempt.
      if (!this.publish(this.intentFile(id, 'claim'), claim, true)) return this.intentStatus(id, saved, false)
      dispatchToken = claim.token
      // A directory or primary intent replaced during service preparation must
      // not inherit this callback's authority, even if a later cancel created a
      // fresh tombstone at the same pathname. The open descriptor pins identity.
      if ('cancelled' in currentReceipt() || this.claim(id)?.token !== claim.token) {
        throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      }
      let outcome: AgentCreationOutcome
      try { outcome = await effect() } catch { outcome = { state: 'unconfirmed' } }
      // A recovered native launch can already have a durable success while
      // this original publisher was waiting. Weak uncertainty cannot undo it.
      const observed = this.intentStatus(id, currentReceipt(), false)
      if (observed.state === 'created' && this.readIntentPart(this.intentFile(id, 'confirmation')) && (outcome.state === 'unconfirmed'
        || creationFingerprint(outcome) === creationFingerprint(observed))) return observed
      // A pane opening is not proof of the initial exec or its admitted agent.
      // Only the witnessed confirmation can complete a native-v2 creation.
      if (saved.request.kind === 'native-create-v2' && observed.state !== 'created' && outcome.state === 'created') outcome = { state: 'unconfirmed' }
      const completed: IntentResult = { fingerprint, token: claim.token, outcome }
      let published = false
      try { published = this.publish(this.intentFile(id, 'result'), completed, true) } catch { /* Retain the known outcome under its exact claim. */ }
      if (!published) {
        this.intentResults.set(id, completed)
        // EEXIST or a failed save is not permission to hide conflicting disk
        // evidence beneath a memory-only success.
        return this.intentStatus(id, currentReceipt(), false)
      }
      return this.intentStatus(id, currentReceipt(), false)
    }).finally(() => {
      alive = false
      try { directory.close() }
      finally {
        clearTimeout(replyTimer); this.inFlight.delete(id)
        // Release capacity only after the actual work and directory close,
        // including lost claims and errors. A subscriber may start a new retry.
        settle()
      }
    })
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

  private currentReply(id: string, fingerprint: string, running: Promise<AgentCreationStatus>): Promise<AgentCreationStatus> {
    // The bounded reply can resolve before the original effect. Reconciliation
    // may since have confirmed it, and a retry must validate that durable record
    // rather than reuse an old pending answer or restart preparation.
    const receipt = this.read(id)
    if (!receipt) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    if (!(receipt.version === 2 && 'cancelled' in receipt) && receipt.fingerprint !== fingerprint) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    if (receipt.version === 2) {
      const status = this.intentStatus(id, receipt)
      if (status.state !== 'pending' && status.state !== 'unconfirmed') return Promise.resolve(status)
    }
    return running
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

  /** Recovery can prove the original allocation, never repeat it. Keep this
   * immutable completion beside the original result so later Cancel/rearm cannot
   * turn an acknowledged success back into an uncertain launch. */
  confirmNativeRelaunch(id: string, input: NativeRelaunchConfirmation, authority: CreationConfirmationFence,
    retain?: (proof: { verify(): void }) => void,
  ): AgentCreationStatus {
    if (!nativeRelaunchRequest(id, input.request)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.confirmNativeLaunch(id, input, authority, retain)
  }

  /** First creation confirms its preallocated agent, without claiming a resumed
   * conversation or inventing a predecessor incarnation. */
  confirmNativeCreation(id: string, input: NativeCreationConfirmation, authority: CreationConfirmationFence,
    retain?: (proof: { verify(): void }) => void,
  ): AgentCreationStatus {
    if (!nativeCreationRequest(id, input)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.confirmNativeLaunch(id, input, authority, retain)
  }

  private confirmNativeLaunch(id: string, input: NativeRelaunchConfirmation | NativeCreationConfirmation, authority: CreationConfirmationFence,
    retain?: (proof: { verify(): void }) => void,
  ): AgentCreationStatus {
    const expected = structuredClone(input)
    if (!nativeLaunchRequest(id, expected) || !validNativeSuccess(expected.request, expected.outcome)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    authority.verify(); authority.current()
    const receipt = this.read(id)
    if (receipt?.version !== 2 || 'cancelled' in receipt || receipt.fingerprint !== expected.fingerprint
      || creationFingerprint(receipt.request) !== creationFingerprint(expected.request)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    const claim = this.claim(id), status = this.intentStatus(id, receipt, false)
    if (!claim || claim.kind !== 'dispatch' || status.state !== 'unconfirmed' && status.state !== 'created'
      || status.state === 'created' && creationFingerprint(status) !== creationFingerprint(expected.outcome)) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    const file = this.intentFile(id, 'confirmation'), routes = hookPreparationRoutes([file])
    const original = inspectHookFile(this.file(id), 0o600), claimed = inspectHookFile(this.intentFile(id, 'claim'), 0o600)
    const observedProcess = this.readIntentPart<IntentProcess>(this.intentFile(id, 'process'))
    const process = inspectHookFile(this.intentFile(id, 'process'), 0o600)
    const result = inspectHookFile(this.intentFile(id, 'result'), 0o600), before = inspectHookFile(file, 0o600)
    const completed: IntentConfirmation = { fingerprint: expected.fingerprint, token: claim.token, outcome: expected.outcome,
      process: observedProcess?.checksum ?? null }
    const same = (content: string | null, value: unknown) => content !== null && creationFingerprint(JSON.parse(content)) === creationFingerprint(value)
    const capturedResult = result.content === null ? null : JSON.parse(result.content) as IntentResult | null
    if (!same(original.content, receipt) || !same(claimed.content, claim)
      || receipt.request.kind === 'native-create-v2' && (!observedProcess || !completeInitialProcess(receipt.request, observedProcess.process))
      || observedProcess && (!validIntentProcess(observedProcess, receipt.request.launchToken) || observedProcess.fingerprint !== claim.fingerprint || observedProcess.token !== claim.token)
      || creationFingerprint(process.content === null ? null : JSON.parse(process.content)) !== creationFingerprint(observedProcess)
      || result.content !== null && (!capturedResult || capturedResult.fingerprint !== claim.fingerprint || capturedResult.token !== claim.token
        || !validOutcome(capturedResult.outcome) || capturedResult.outcome.state !== 'unconfirmed'
          && creationFingerprint(capturedResult.outcome) !== creationFingerprint(expected.outcome))
      || before.content !== null && !same(before.content, completed)) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    const retained = () => { original.verify(); claimed.verify(); result.verify(); process.verify(); routes.verify() }
    const fence = () => { authority.verify(); retained(); before.verify(); authority.current() }
    fence()
    let publication = before.content === null ? undefined : before
    if (before.content === null) this.publish(file, completed, true, fence, proof => { publication = proof })
    if (!publication) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    // An identical part left by a failed parent fsync needs real confirmation,
    // not another publication or a successful pathname comparison.
    retained(); publication.verify()
    const published = inspectNativeControlFile(file, this.directory)
    if (!same(published.content, completed)) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    published.confirm(() => { authority.verify(); retained(); publication!.verify(); authority.current() })
    const final = this.read(id)
    if (final?.version !== 2) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    const answer = this.intentStatus(id, final, false)
    const verify = () => { authority.verify(); published.verify(); publication!.verify(); retained(); authority.current() }
    verify(); retain?.({ verify }); verify()
    return answer
  }

  /** A confirmed launch remains successful after its engine exits. This reads
   * the complete original durable receipt; it grants no execution authority. */
  readNativeRelaunchCompletion(id: string, input: NativeRelaunchRequest): {
    outcome: Extract<AgentCreationStatus, { state: 'created' }>; verify(): void
  } {
    if (!nativeRelaunchRequest(id, input.request)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.readNativeLaunchCompletion(id, input)
  }

  readNativeCreationCompletion(id: string, input: NativeCreationRequest): {
    outcome: Extract<AgentCreationStatus, { state: 'created' }>; verify(): void
  } {
    if (!nativeCreationRequest(id, input)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.readNativeLaunchCompletion(id, input)
  }

  private readNativeLaunchCompletion(id: string, input: NativeRelaunchRequest): {
    outcome: Extract<AgentCreationStatus, { state: 'created' }>; verify(): void
  } {
    const expected = structuredClone(input), receipt = this.read(id)
    if (!nativeLaunchRequest(id, expected) || receipt?.version !== 2 || 'cancelled' in receipt
      || receipt.fingerprint !== expected.fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(expected.request)) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    const proof = this.retainNativeRelaunchReceipt(id, receipt), { status, verify } = proof
    if (status.state !== 'created' || !validNativeSuccess(expected.request, status)
      || expected.request.kind !== 'native-create-v2' && status.resumed !== true
      || !proof.confirmation || !proof.process) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    proof.confirm()
    return Object.freeze({ outcome: Object.freeze({ ...status }), verify })
  }

  /** Cancel before receipt publication leaves an immutable ID tombstone. A
   * claimed launch without a witness is still uncertain, never undispatched. */
  readNativeRelaunchNotDispatched(id: string, input: NativeRelaunchRequest): NativeRelaunchNotDispatchedProof {
    if (!nativeRelaunchRequest(id, input.request)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.readNativeLaunchNotDispatched(id, input)
  }

  readNativeCreationNotDispatched(id: string, input: NativeCreationRequest): NativeRelaunchNotDispatchedProof {
    if (!nativeCreationRequest(id, input)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.readNativeLaunchNotDispatched(id, input)
  }

  private readNativeLaunchNotDispatched(id: string, input: NativeRelaunchRequest): NativeRelaunchNotDispatchedProof {
    const expected = structuredClone(input), receipt = this.read(id)
    if (!nativeLaunchRequest(id, expected) || !/^[a-f0-9]{64}$/.test(expected.fingerprint)
      || receipt?.version !== 2 || !('cancelled' in receipt)
        && (receipt.fingerprint !== expected.fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(expected.request))) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    const proof = this.retainNativeRelaunchReceipt(id, receipt)
    const kind = 'cancelled' in receipt && proof.status.state === 'cancelled' ? 'cancelled-id'
      : proof.claim?.kind === 'cancel' && proof.status.state === 'cancelled' ? 'cancelled-request'
      : proof.claim?.kind === 'dispatch' && proof.result?.outcome.state === 'failed'
        && proof.result.outcome.error === (expected.request.kind === 'native-create-v2' ? 'NATIVE_CREATE_NOT_DISPATCHED' : 'NATIVE_REARM_NOT_DISPATCHED')
        && proof.status.state === 'failed' ? 'not-dispatched' : null
    if (!kind || proof.confirmation || proof.process) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    proof.confirm()
    return Object.freeze({ kind, verify: proof.verify })
  }

  /** A completed Resume can finish metadata after its engine exits. An early
   * Cancel needs an exclusive cancel claim or a durable known-not-dispatched
   * result; a missing witness alone cannot account for a claimed allocation. */
  readNativeResumeCleanup(input: NativeArchiveLink): NativeResumeCleanupProof {
    const link = parseNativeArchiveLink(input)
    if (!link) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    const id = link.requestId, receipt = this.read(id)
    if (receipt?.version !== 2 || 'cancelled' in receipt) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    const permission = receipt.request.permissionMode
    if (permission !== undefined && !['ask', 'auto', 'plan', 'full'].includes(permission as string)) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    const scoped = Object.hasOwn(receipt.request, 'sourceProcess')
    const sourceProcess = scoped ? parseNativeTurnProcessReference(receipt.request.sourceProcess) : undefined
    if (scoped && !sourceProcess) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    const request = Object.freeze({ kind: 'native-rearm', creationId: id, agentId: link.agentId,
      operation: 'resume', source: 'saved', target: link.target, launchToken: link.launchToken,
      ...(permission === undefined ? {} : { permissionMode: permission }),
      ...(sourceProcess === undefined ? {} : { sourceProcess }),
    })
    const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId: link.agentId, operation: 'resume', source: 'saved',
      ...(permission === undefined ? {} : { permissionMode: permission }),
    })
    if (receipt.fingerprint !== fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(request)) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    const proof = this.retainNativeRelaunchReceipt(id, receipt), { status, claim, result, confirmation, process, verify } = proof
    const created = status.state === 'created' && status.agentId === link.agentId && status.resumed === true
      && !!confirmation && !!process
    const undispatched = !confirmation && !process && (claim?.kind === 'cancel' && status.state === 'cancelled'
      || claim?.kind === 'dispatch' && result?.outcome.state === 'failed'
        && result.outcome.error === 'NATIVE_REARM_NOT_DISPATCHED' && status.state === 'failed')
    if (!created && !undispatched) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    proof.confirm()
    return Object.freeze({ link, request, kind: created ? 'created' : 'not-dispatched', outcome: Object.freeze({ ...status }), verify })
  }

  private retainNativeRelaunchReceipt(id: string, receipt: IntentReceipt) {
    const files = [this.file(id), ...(['claim', 'result', 'confirmation', 'process'] as const).map(part => this.intentFile(id, part))]
    const retained = files.map(file => inspectHookFile(file, 0o600))
    if (creationFingerprint(JSON.parse(retained[0].content ?? 'null')) !== creationFingerprint(receipt)) {
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    const claim: IntentClaim | null = JSON.parse(retained[1].content ?? 'null')
    const result: IntentResult | null = JSON.parse(retained[2].content ?? 'null')
    const confirmation: IntentConfirmation | null = JSON.parse(retained[3].content ?? 'null')
    const process: IntentProcess | null = JSON.parse(retained[4].content ?? 'null')
    // Validate one coherent image, then retain every original file and absence.
    // Recursively reading status inside durability callbacks exhausted recovery's
    // deadline on healthy receipts. Later verification performs no fsync.
    const status = this.intentStatus(id, receipt, false)
    const verify = () => {
      for (const part of retained) part.verify()
      // A late effect whose result could not be saved remains authoritative in
      // memory. Compatible uncertainty cannot undo an already confirmed success.
      const known = this.intentResults.get(id)
      if (known && ('cancelled' in receipt || claim?.kind !== 'dispatch' || known.fingerprint !== receipt.fingerprint
        || known.token !== claim.token || creationFingerprint(known.outcome) !== creationFingerprint(status)
          && !(status.state === 'created' && known.outcome.state === 'unconfirmed'))) {
        throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      }
    }
    verify()
    const confirm = () => {
      // Observing a peer's rename is not durability. Confirm each present part
      // while retaining the original claim/result and every recorded absence.
      for (let index = 0; index < files.length; index++) if (retained[index].content !== null) {
        inspectNativeControlFile(files[index], this.directory).confirm(verify)
      }
      verify()
    }
    return { status, claim, result, confirmation, process, verify, confirm }
  }

  /** Only the original successful publisher may continue to exec. A matching
   * pre-existing witness, including one left by failed fsync, is never another
   * execution permit. The shell keeps this exact incarnation when it execs. */
  recordNativeRelaunchProcess(id: string, input: NativeRelaunchRequest, process: NativeRelaunchProcess,
    authority: CreationConfirmationFence,
  ): { verify(): void } | null {
    if (!nativeRelaunchRequest(id, input.request)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.recordNativeLaunchProcess(id, input, process, authority)
  }

  recordNativeCreationProcess(id: string, input: NativeCreationRequest, process: NativeRelaunchProcess,
    authority: CreationConfirmationFence,
  ): { verify(): void } | null {
    if (!nativeCreationRequest(id, input)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.recordNativeLaunchProcess(id, input, process, authority)
  }

  private recordNativeLaunchProcess(id: string, input: NativeRelaunchRequest, process: NativeRelaunchProcess,
    authority: CreationConfirmationFence,
  ): { verify(): void } | null {
    const owner = structuredClone(process), source = this.nativeRelaunchDispatch(id, input)
    if (!validRelaunchProcess(owner) || !completeInitialProcess(source.receipt.request, owner)
      || owner.allocation && owner.allocation.token !== source.receipt.request.launchToken
      || source.status.state !== 'unconfirmed') throw new AgentCreationReceiptError('CREATION_CONFLICT')
    const value = { fingerprint: source.receipt.fingerprint, token: source.claim.token, process: owner }
    const completed: IntentProcess = { ...value, checksum: creationFingerprint(value) }
    const file = this.intentFile(id, 'process'), before = inspectHookFile(file, 0o600)
    if (before.content !== null) return null
    const fence = () => { authority.verify(); source.verify(); before.verify(); authority.current() }
    let published: ReturnType<typeof inspectHookFile> | undefined
    if (!this.publish(file, completed, true, fence, proof => { published = proof })) return null
    if (!published) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    const proof = this.readNativeLaunchProcess(id, input)
    if (creationFingerprint(proof.process) !== creationFingerprint(owner)) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    const original = published
    const verify = () => { authority.verify(); source.verify(); proof.verify(); original.verify(); authority.current() }
    verify()
    return { verify }
  }

  /** A witness proves which process was handed the command, not that exec or
   * startup completed. Recovery must separately prove its current native image. */
  readNativeRelaunchProcess(id: string, input: NativeRelaunchRequest): {
    process: NativeRelaunchProcess; verify(): void
    /** Only inside confirmNativeRelaunch, which retains its own exact published
     * confirmation. Every original execution part remains pinned. */
    verifyConfirmation(): void
  } {
    if (!nativeRelaunchRequest(id, input.request)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.readNativeLaunchProcess(id, input)
  }

  readNativeCreationProcess(id: string, input: NativeCreationRequest): {
    process: NativeRelaunchProcess; verify(): void; verifyConfirmation(): void
  } {
    if (!nativeCreationRequest(id, input)) throw new AgentCreationReceiptError('CREATION_CONFLICT')
    return this.readNativeLaunchProcess(id, input)
  }

  private readNativeLaunchProcess(id: string, input: NativeRelaunchRequest): {
    process: NativeRelaunchProcess; verify(): void; verifyConfirmation(): void
  } {
    const source = this.nativeRelaunchDispatch(id, input)
    const part = this.readIntentPart<IntentProcess>(this.intentFile(id, 'process'))
    if (!part || part.fingerprint !== source.claim.fingerprint || part.token !== source.claim.token || !validIntentProcess(part, source.receipt.request.launchToken)
      || !completeInitialProcess(source.receipt.request, part.process)) {
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    const proof = inspectNativeControlFile(this.intentFile(id, 'process'), this.directory)
    if (creationFingerprint(JSON.parse(proof.content!)) !== creationFingerprint(part)) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    proof.confirm(source.verify)
    const verify = () => { source.verify(); proof.verify() }
    verify()
    const verifyConfirmation = () => { source.verifyConfirmation(); proof.verify() }
    return { process: Object.freeze({ ...part.process, ...(part.process.allocation
      ? { allocation: parseNativeLaunchAllocation(part.process.allocation, part.process)! } : {}) }), verify, verifyConfirmation }
  }

  private nativeRelaunchDispatch(id: string, input: NativeRelaunchRequest) {
    const expected = structuredClone(input), receipt = this.read(id)
    if (!nativeLaunchRequest(id, expected) || receipt?.version !== 2 || 'cancelled' in receipt
      || receipt.fingerprint !== expected.fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(expected.request)) {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    const claim = this.claim(id), status = this.intentStatus(id, receipt, false)
    if (!claim || claim.kind !== 'dispatch' || status.state !== 'unconfirmed' && status.state !== 'created') {
      throw new AgentCreationReceiptError('CREATION_CONFLICT')
    }
    const primary = inspectNativeControlFile(this.file(id), this.directory)
    const claimed = inspectNativeControlFile(this.intentFile(id, 'claim'), this.directory)
    const result = inspectHookFile(this.intentFile(id, 'result'), 0o600)
    const confirmation = inspectHookFile(this.intentFile(id, 'confirmation'), 0o600)
    if (creationFingerprint(JSON.parse(primary.content!)) !== creationFingerprint(receipt)
      || creationFingerprint(JSON.parse(claimed.content!)) !== creationFingerprint(claim)) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    const verify = () => { primary.verify(); claimed.verify(); result.verify(); confirmation.verify(); this.intentStatus(id, receipt, false) }
    verify()
    const verifyConfirmation = () => { primary.verify(); claimed.verify(); result.verify(); this.intentStatus(id, receipt, false) }
    return { receipt, claim, status: this.intentStatus(id, receipt, false), verify, verifyConfirmation }
  }

  /** Streaming recovery never loads an unbounded directory into the core. Old
   * receipts and terminal tombstones stay authoritative, but are not scheduled. */
  pendingIntent(id: string): PendingCreationIntent | null {
    const receipt = this.read(id)
    if (receipt?.version !== 2) return null
    const status = this.intentStatus(id, receipt, false)
    if ('cancelled' in receipt || status.state !== 'pending') return null
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

  private intentFile(id: string, part: 'claim' | 'result' | 'confirmation' | 'process'): string { return `${this.file(id)}.${part}` }

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
    const confirmed = this.readIntentPart<IntentConfirmation>(this.intentFile(id, 'confirmation'))
    const process = this.readIntentPart<IntentProcess>(this.intentFile(id, 'process'))
    if ('cancelled' in receipt) {
      if (known || confirmed || process || this.claim(id) || this.readIntentPart(this.intentFile(id, 'result'))) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      return { state: 'cancelled' }
    }
    if (receipt.request.kind === 'native-create-v2' && !nativeCreationRequest(id, receipt)) {
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    const claim = this.claim(id)
    const result = this.readIntentPart<IntentResult>(this.intentFile(id, 'result'))
    // A completed effect cannot become pending or cancelled when its disk
    // evidence disappears. Its retained result still requires the exact claim.
    if (known && (!claim || claim.kind !== 'dispatch' || known.fingerprint !== claim.fingerprint || known.token !== claim.token)) {
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    if (!claim) {
      if (result || confirmed || process) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      return { state: 'pending', held: this.readHold(id, receipt) }
    }
    if (claim.fingerprint !== receipt.fingerprint) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    if (claim.kind === 'cancel') {
      if (result || confirmed || process) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      return { state: 'cancelled' }
    }
    if (result) {
      if (result.fingerprint !== claim.fingerprint || result.token !== claim.token || !validOutcome(result.outcome)
        || (known && creationFingerprint(known.outcome) !== creationFingerprint(result.outcome))) {
        throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      }
    }
    if (receipt.request.kind === 'native-create-v2' && [result, known].some(value => value?.outcome.state === 'created'
      && (!validNativeSuccess(receipt.request, value.outcome) || !confirmed))) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    if (process && (!nativeLaunchRequest(id, receipt) || process.fingerprint !== claim.fingerprint || process.token !== claim.token
      || !validIntentProcess(process, receipt.request.launchToken) || !completeInitialProcess(receipt.request, process.process)
      || result?.outcome.state === 'failed' || known?.outcome.state === 'failed')) {
      throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    }
    if (confirmed) {
      if (!nativeLaunchRequest(id, receipt) || confirmed.fingerprint !== claim.fingerprint || confirmed.token !== claim.token
        || !validNativeSuccess(receipt.request, confirmed.outcome) || receipt.request.kind === 'native-create-v2' && !process
        || confirmed.process !== (process?.checksum ?? null)
        || [result, known].some(previous => previous && previous.outcome.state !== 'unconfirmed'
          && creationFingerprint(previous.outcome) !== creationFingerprint(confirmed.outcome))) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      const original = inspectHookFile(this.file(id), 0o600), claimed = inspectHookFile(this.intentFile(id, 'claim'), 0o600)
      const outcome = inspectHookFile(this.intentFile(id, 'result'), 0o600)
      const launched = inspectHookFile(this.intentFile(id, 'process'), 0o600)
      const proof = inspectNativeControlFile(this.intentFile(id, 'confirmation'), this.directory)
      if (creationFingerprint(JSON.parse(original.content!)) !== creationFingerprint(receipt)
        || creationFingerprint(JSON.parse(claimed.content!)) !== creationFingerprint(claim)
        || creationFingerprint(outcome.content === null ? null : JSON.parse(outcome.content)) !== creationFingerprint(result)
        || creationFingerprint(launched.content === null ? null : JSON.parse(launched.content)) !== creationFingerprint(process)
        || creationFingerprint(JSON.parse(proof.content!)) !== creationFingerprint(confirmed)) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
      const verify = () => { original.verify(); claimed.verify(); outcome.verify(); launched.verify() }
      proof.confirm(verify); verify(); proof.verify()
      return confirmed.outcome
    }
    if (result) return result.outcome
    if (known) return known.outcome
    return { state: live ? 'pending' : 'unconfirmed' }
  }

  private publish(file: string, value: unknown, existingDirectory = false, beforeCommit?: () => void,
    retain?: (proof: ReturnType<typeof inspectHookFile>) => void,
  ): boolean {
    const bytes = JSON.stringify(value)
    if (Buffer.byteLength(bytes) > 262_144) throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
    const temporary = `${file}.${randomUUID()}.tmp`
    let opened = false, fd: number | undefined
    try {
      if (existingDirectory) secureStateDirectory(this.directory, false)
      this.ensureDirectory()
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      opened = true
      writeFileSync(fd, bytes); fsyncSync(fd)
      beforeCommit?.()
      try { linkSync(temporary, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
      if (retain) {
        // Removing the staging hard link changes ctime. Capture only afterwards,
        // while the original descriptor still proves which inode we published.
        rmSync(temporary); opened = false
        const proof = inspectHookFile(file, 0o600), info = fstatSync(fd, { bigint: true })
        if (proof.content !== bytes || proof.stamp !== `${info.dev}:${info.ino}:${info.uid}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`) {
          throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED')
        }
        retain(proof)
      }
      this.syncDirectory()
      return true
    } catch { throw new AgentCreationReceiptError('CREATION_STORAGE_FAILED') }
    finally { try { if (fd !== undefined) closeSync(fd) } finally { if (opened) rmSync(temporary, { force: true }) } }
  }

  private readHold(id: string, receipt: Extract<IntentReceipt, { checksum: string }>): CreationHold {
    try {
      const value = JSON.parse(readPrivateStateFile(join(this.directory, `${id}.hold`), 16_384))
      if (value.checksum === receipt.checksum && typeof value.held?.service === 'string' && value.held.service.length <= 128
        && typeof value.held.detail === 'string' && value.held.detail.length <= 2000) return value.held
    } catch { /* Missing or damaged status cannot grant or revoke dispatch. */ }
    return receipt.held
  }

  private writeHold(id: string, value: { checksum: string; held: CreationHold }): void {
    const target = join(this.directory, `${id}.hold`), temporary = `${target}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
      secureStateDirectory(this.directory, false)
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd)
      renameSync(temporary, target); this.syncDirectory()
    } finally {
      if (fd !== undefined) { closeSync(fd); rmSync(temporary, { force: true }) }
    }
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
      if (completedIntent || this.readIntentPart(this.intentFile(id, 'claim')) || this.readIntentPart(this.intentFile(id, 'result'))
        || this.readIntentPart(this.intentFile(id, 'confirmation')) || this.readIntentPart(this.intentFile(id, 'process'))) {
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
        && !this.readIntentPart(this.intentFile(id, 'claim')) && !this.readIntentPart(this.intentFile(id, 'result'))
        && !this.readIntentPart(this.intentFile(id, 'confirmation')) && !this.readIntentPart(this.intentFile(id, 'process'))) return null
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
