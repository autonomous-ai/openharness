/** Core's required private image transport. It owns only metadata, descriptors and publication permission. */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, open, unlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { env } from '../config/env.js'
import { fingerprint } from '../harnessd/bundleFingerprint.js'
import { baseNode, namedNode } from '../harnessd/processName.js'
import { workerCohortEnvironment } from '../harnessd/workerContract.js'
import { stoppedArchiveWitness, stoppedAuthorityHealthy } from './stoppedAuthorityMetadata.js'
import { STOPPED_LIST_ROWS, sessionImageProof, type StoppedListPage, type StoppedArchiveAnswer, type StoppedArchiveQuery } from './sessionStorageWire.js'
import { sessionStorageFrames } from './sessionStorageFrames.js'
import { privateRegistryDirectory } from './registryPersistence.js'
import { SESSION_STORAGE_QUEUE, SESSION_STORAGE_REQUEST_MS,
  SessionStorageUnavailable, type CredentialRow, type SessionDocument, type SessionImage, type SessionImageProof,
  storedGridLaunch, sessionDocument, sessionFileIdentity, type SessionImageReservation, type SessionPreparedImage, type SessionStorageFailure,
  type SessionStorageOperation, type StoredGridLaunch } from './sessionStorageWire.js'
import type { GridLaunchOverride } from './gridLaunchWire.js'
import { StateFileCleanupUnconfirmed, stateFileCustodyHealthy } from './secureState.js'
import type { PendingCreationDiscovery, PendingCreationPage } from './pendingCreationWire.js'

const sessionSourceIdentity = sessionFileIdentity
type OwnedReservation = Pick<SessionImageReservation, 'temporary'> & {
  directoryIdentity: string
  identity?: string
  descriptor?: number
  closeUnconfirmed?: boolean
}

export interface SessionImageSource {
  readonly image: SessionImage
  readonly lease: string
  check(): void
  release(): Promise<void>
}

interface RetainedImage { fd: number; proof: SessionImageProof; lease: string }
interface Pending {
  id: number
  expires: number
  operation: SessionStorageOperation
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface SessionStorageChildEntry { file: string; sha256: string; execArgv?: string[] }

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const failures = new Set<SessionStorageFailure>(['missing', 'unsafe', 'changed', 'invalid', 'busy', 'expired', 'disconnected', 'cleanup-unconfirmed'])

export class SessionStorage {
  private child: ChildProcess | undefined
  private terminating: ChildProcess | undefined
  private terminationReported = false
  private selectedEntry: SessionStorageChildEntry | undefined
  private frames: ReturnType<typeof sessionStorageFrames> | undefined
  private ready: Promise<void> | undefined
  private active: Pending | undefined
  private readonly queue: Pending[] = []
  private readonly retained = new Map<string, RetainedImage>()
  private nextId = 1
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private closeFailed = false
  private exiting: Promise<void> | undefined
  private preparationTail: Promise<void> = Promise.resolve()
  private preparationWaiting = 0
  private preparation: { reservation: OwnedReservation; child?: ChildProcess; writtenIdentity?: string; release(): void } | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private writeWaiting = 0
  private readonly descriptorOperations = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined
  private listing = false
  private listSettlement: Promise<void> = Promise.resolve()
  private finishListing: (() => void) | undefined
  private readonly listWaiters: Array<{ resolve(release: () => void): void; reject(error: Error): void; expires: number; timer: ReturnType<typeof setTimeout> }> = []

  readonly creations: PendingCreationDiscovery = {
    ensure: id => typeof id === 'string' && /^[a-zA-Z0-9_-]{16,96}$/.test(id)
      ? this.request({ kind: 'creation-ensure', id }) : Promise.reject(new SessionStorageUnavailable('invalid')),
    scan: () => this.pendingCreations(),
  }

  private async *pendingCreations(): AsyncGenerator<string | null> {
    let cursor: string | null = null
    let warned = false
    try {
      for (;;) {
        const page: PendingCreationPage = await this.request({ kind: 'creation-page', cursor })
        if (!page || typeof page.cursor !== 'string' || !(page.cursor === '' && page.done === true || /^[a-f0-9-]{36}$/.test(page.cursor))
          || !Array.isArray(page.ids) || page.ids.length > 64 || page.ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(id))
          || cursor !== null && page.cursor !== cursor
          || typeof page.done !== 'boolean' || !Number.isSafeInteger(page.damaged) || page.damaged < 0 || page.damaged > 64) {
          throw new SessionStorageUnavailable('invalid')
        }
        cursor = page.cursor
        if (page.damaged && !warned) { warned = true; console.warn('[creation] CREATION_EVIDENCE_UNAVAILABLE') }
        for (const id of page.ids) yield id
        if (page.done) { cursor = null; return }
        if (!page.ids.length) yield null
      }
    } finally {
      if (cursor && this.child && this.frames) await this.request({ kind: 'creation-close', cursor })
    }
  }

  constructor(readonly root: string, private readonly entry?: () => SessionStorageChildEntry,
    private readonly stoppedLeaf = 'stopped-agents') {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(stoppedLeaf)) throw new SessionStorageUnavailable('invalid')
  }

  /** The required bootstrap gives this owner its immutable payload directly, never through a child environment. */
  configureEntry(file: string, sha256: string): void {
    if (this.selectedEntry && (this.selectedEntry.file !== file || this.selectedEntry.sha256 !== sha256)) {
      throw new SessionStorageUnavailable('changed')
    }
    this.selectedEntry ??= Object.freeze({ file, sha256 })
  }

  private executionEntry(): SessionStorageChildEntry {
    if (this.selectedEntry) return this.selectedEntry
    let selected = this.entry?.()
    if (!selected && import.meta.url.endsWith('.ts')) {
      const file = fileURLToPath(new URL('../storage/entry.ts', import.meta.url)), sha256 = fingerprint(file)
      if (!sha256) throw new SessionStorageUnavailable('disconnected')
      selected = { file, sha256, execArgv: ['--import', import.meta.resolve('tsx')] }
    }
    if (!selected) throw new SessionStorageUnavailable('disconnected')
    return this.selectedEntry = Object.freeze({ ...selected, ...(selected.execArgv ? { execArgv: [...selected.execArgv] } : {}) })
  }

  path(document: SessionDocument): string {
    if (!sessionDocument(document)) throw new SessionStorageUnavailable('invalid')
    return document.kind === 'registry' ? join(this.root, 'registry.json')
      : document.kind === 'legacy-registry' ? join(this.root, 'registry.pre-v2.json') : document.kind === 'names' ? join(this.root, 'agent-names.json')
      : join(this.root, this.stoppedLeaf, ...(document.kind === 'superseded' ? ['superseded'] : []), `${document.agentId}.json`)
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready
    if (this.closed || this.closeFailed) return Promise.reject(new SessionStorageUnavailable('disconnected'))
    const selected = this.executionEntry()
    if (fingerprint(selected.file) !== selected.sha256) return Promise.reject(new SessionStorageUnavailable('changed'))
    const incarnation = randomUUID(), held = [...this.retained.values()]
    const inherited = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']
      .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
    const node = namedNode(baseNode(process.execPath), 'harnessd-storage', env.ADAPTER_RUNTIME_DIR, { log: line => console.warn(line) })
    const child = spawn(node, [...selected.execArgv ?? [], selected.file, '__storage'], {
      env: { ...inherited, ADAPTER_DATA_DIR: this.root, HARNESSD_SUPERVISED: '1',
        ...workerCohortEnvironment(process.pid, selected.sha256) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', ...held.map(source => source.fd)],
      windowsHide: true,
    })
    this.child = child
    this.terminating = undefined
    this.terminationReported = false
    let ready = false
    let rejectReady: (error: Error) => void
    const started = new Promise<void>((resolve, reject) => {
      rejectReady = reject
      child.on('message', value => {
        if (this.child !== child) return
        if (!ready) {
          const message = value as { protocol?: unknown; incarnation?: unknown }
          if (message?.protocol !== 'session-storage-ready-1' || message.incarnation !== incarnation) {
            this.terminate(); return
          }
          ready = true
          resolve()
          return
        }
        this.frames?.message(value)
      })
    })
    this.ready = started
    const send = (value: unknown): Promise<void> => new Promise((resolve, reject) => {
      if (!child.connected) { reject(new SessionStorageUnavailable('disconnected')); return }
      child.send(value as Parameters<ChildProcess['send']>[0], error => error ? reject(new SessionStorageUnavailable('disconnected')) : resolve())
    })
    this.frames = sessionStorageFrames(incarnation, send, (id, value) => {
      if (this.active?.id !== id) { this.terminate(); return }
      const answer = value as { ok?: unknown; value?: unknown; code?: unknown }
      if (answer?.ok !== true && (answer?.ok !== false || !failures.has(answer.code as SessionStorageFailure))) {
        this.terminate(); return
      }
      if (answer.ok === false && answer.code === 'cleanup-unconfirmed') {
        // Its descriptor may still be open. Reap it before any caller can remove its temporary.
        this.terminate(); return
      }
      const active = this.active
      if (performance.now() >= active.expires) { this.terminate(); return }
      this.active = undefined
      clearTimeout(this.timer)
      answer.ok ? active.resolve(answer.value) : active.reject(new SessionStorageUnavailable(answer.code as SessionStorageFailure))
      void this.drain()
    }, () => this.terminate())
    this.exiting = new Promise(resolve => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (this.child === child) {
          this.child = undefined
          this.ready = undefined
          this.frames?.close()
          this.frames = undefined
          clearTimeout(this.timer)
          const error = new SessionStorageUnavailable('disconnected')
          rejectReady(error)
          this.active?.reject(error)
          this.active = undefined
          for (const waiting of this.queue.splice(0)) waiting.reject(error)
        }
        resolve()
      }
      child.on('error', () => {
        // A running child's failed send or signal is not its exit. Its inherited descriptors
        // stay owned until exit; only a spawn failure has no process to reap.
        if (child.pid === undefined) finish()
        else if (this.child === child) {
          if (this.terminating === child) this.reportTerminationFailure()
          else this.terminate()
        }
      })
      child.once('exit', finish)
    })
    void send({ protocol: 'session-storage-init-1', root: this.root, stoppedLeaf: this.stoppedLeaf, incarnation,
      retained: held.map(source => ({ proof: source.proof, lease: source.lease })) })
      .catch(() => this.terminate())
    return started
  }

  private terminate(): void {
    // A reply is not settlement. The active caller is released only when this child has actually exited.
    const child = this.child
    if (!child || this.terminating === child) return
    this.terminating = child
    try { if (!child.kill('SIGKILL')) this.reportTerminationFailure() }
    catch { this.reportTerminationFailure() }
  }

  private reportTerminationFailure(): void {
    if (this.terminationReported) return
    this.terminationReported = true
    console.error('[session-storage] termination failed; waiting for owned child exit')
  }

  private request<T>(operation: SessionStorageOperation): Promise<T> {
    if (this.closed || this.closeFailed) return Promise.reject(new SessionStorageUnavailable('disconnected'))
    try { stateFileCustodyHealthy() }
    catch { this.closeFailed = true; return Promise.reject(new SessionStorageUnavailable('cleanup-unconfirmed')) }
    if (this.queue.length >= SESSION_STORAGE_QUEUE) return Promise.reject(new SessionStorageUnavailable('busy'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, expires: performance.now() + SESSION_STORAGE_REQUEST_MS, operation,
        resolve: value => resolve(value as T), reject })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.active || !this.queue.length) return
    const pending = this.queue.shift()!
    if (performance.now() >= pending.expires) {
      pending.reject(new SessionStorageUnavailable('expired'))
      void this.drain()
      return
    }
    this.active = pending
    this.timer = setTimeout(() => this.terminate(), Math.max(1, pending.expires - performance.now()))
    try {
      await this.start()
      if (this.active !== pending) return
      const remainingMs = pending.expires - performance.now()
      if (remainingMs <= 0) { this.terminate(); return }
      await this.frames!.send(pending.id, { remainingMs, operation: pending.operation })
    } catch {
      if (this.child) this.terminate()
      else if (this.active === pending) {
        this.active = undefined
        clearTimeout(this.timer)
        pending.reject(new SessionStorageUnavailable('disconnected'))
        void this.drain()
      }
    }
  }

  async stoppedQuery(query: StoppedArchiveQuery): Promise<StoppedArchiveAnswer & { current(): boolean }> {
    return this.withWrite(performance.now() + SESSION_STORAGE_REQUEST_MS, async () => {
      const answer = await this.request<StoppedArchiveAnswer>({ kind: 'stopped-query', query })
      const length = query.kind === 'conversations' ? query.ids.length : query.kind === 'owners' ? query.keys.length : 1
      if (!answer || !(answer.witness === 'missing' || /^[a-f0-9]{64}$/.test(answer.witness))
        || !Array.isArray(answer.matches) || answer.matches.length !== length || !answer.matches.every(value => typeof value === 'boolean')
        || query.kind === 'owners' && !Array.isArray(answer.selected)) throw new SessionStorageUnavailable('invalid')
      return { ...answer, current: () => stoppedArchiveWitness(join(this.root, this.stoppedLeaf)) === answer.witness }
    })
  }

  private startListing(): () => void {
    this.listing = true
    this.listSettlement = new Promise(resolve => { this.finishListing = resolve })
    return () => {
      this.finishListing!()
      this.finishListing = undefined
      this.listing = false
      for (;;) {
        const next = this.listWaiters.shift()
        if (!next) return
        clearTimeout(next.timer)
        if (this.closed || this.closeFailed) next.reject(new SessionStorageUnavailable('disconnected'))
        else if (performance.now() >= next.expires) next.reject(new SessionStorageUnavailable('expired'))
        else { next.resolve(this.startListing()); return }
      }
    }
  }

  private acquireListing(): Promise<() => void> {
    if (this.closed || this.closeFailed) return Promise.reject(new SessionStorageUnavailable('disconnected'))
    if (!this.listing) return Promise.resolve(this.startListing())
    if (this.listWaiters.length >= SESSION_STORAGE_QUEUE) return Promise.reject(new SessionStorageUnavailable('busy'))
    return new Promise((resolve, reject) => {
      const waiting = { resolve, reject, expires: performance.now() + SESSION_STORAGE_REQUEST_MS, timer: setTimeout(() => {
        const index = this.listWaiters.indexOf(waiting)
        if (index !== -1) this.listWaiters.splice(index, 1)
        reject(new SessionStorageUnavailable('expired'))
      }, SESSION_STORAGE_REQUEST_MS) }
      this.listWaiters.push(waiting)
    })
  }

  /** One names snapshot in the child; bounded pages preserve the complete visible-list contract. */
  async stoppedList(accept: (image: SessionImage) => void): Promise<void> {
    const release = await this.acquireListing()
    let cursor: string | null = null, next = 0, total: number | undefined
    let owner: ChildProcess | undefined, uncertain = false
    const delivered = new Set<string>()
    try {
      for (;;) {
        const page: StoppedListPage = await this.request({ kind: 'stopped-list-page', cursor })
        owner ??= this.child
        if (!page || typeof page.cursor !== 'string' || !(page.cursor === '' && page.done === true && page.total === 0 || /^[a-f0-9-]{36}$/.test(page.cursor))
          || cursor !== null && page.cursor !== cursor || owner !== this.child
          || !Number.isSafeInteger(page.offset) || page.offset !== next
          || !Number.isSafeInteger(page.next) || page.next < next || page.next - next > STOPPED_LIST_ROWS
          || !Number.isSafeInteger(page.total) || page.total < page.next || total !== undefined && page.total !== total
          || typeof page.done !== 'boolean' || page.done !== (page.next === page.total) || !page.done && page.next === next
          || !Array.isArray(page.images) || page.images.length > page.next - next
          || page.images.some(image => !image || image.state !== 'image' || typeof image.json !== 'boolean'
            || !sessionImageProof(image.proof) || image.proof.document.kind !== 'stopped')) {
          uncertain = true
          throw new SessionStorageUnavailable('invalid')
        }
        cursor = page.cursor
        next = page.next
        total = page.total
        for (const image of page.images) {
          const id = (image as Extract<SessionImage, { state: 'image' }>).proof.document as { agentId: string }
          if (delivered.has(id.agentId)) {
            uncertain = true
            throw new SessionStorageUnavailable('invalid')
          }
          delivered.add(id.agentId)
          accept(image)
        }
        if (page.done) { cursor = null; return }
      }
    } finally {
      try {
        if (owner && owner === this.child) {
          try {
            if (uncertain) throw new SessionStorageUnavailable('invalid')
            if (cursor) await this.request({ kind: 'stopped-list-close', cursor })
          } catch (error) {
            // A lost close reply cannot free the listing slot while its child still owns the cursor.
            if (owner === this.child) { this.terminate(); await this.exiting }
            throw error
          }
        }
      } finally { release() }
    }
  }

  read(document: SessionDocument): Promise<SessionImage> { return this.request({ kind: 'read', document }) }
  equal(proof: SessionImageProof): Promise<SessionImageProof | null> { return this.request({ kind: 'equal', proof }) }
  /** Explicit one-use launch input only. It is never used by image reads, caches or session persistence. */
  resolveSelected(reference: StoredGridLaunch): Promise<GridLaunchOverride> { return this.request({ kind: 'resolve', reference }) }
  private ownDescriptors<T>(apply: () => Promise<T>): Promise<T> {
    const pending = apply()
    this.descriptorOperations.add(pending)
    void pending.then(() => this.descriptorOperations.delete(pending), () => this.descriptorOperations.delete(pending))
    return pending
  }

  prepare(document: SessionDocument, source: SessionImageProof | null, value: unknown, rawSource?: SessionImageProof): Promise<SessionPreparedImage> {
    if (this.closed || this.closeFailed) return Promise.reject(new SessionStorageUnavailable('disconnected'))
    return this.ownDescriptors(() => this.prepareImage(document, source, value, rawSource))
  }

  private async prepareImage(document: SessionDocument, source: SessionImageProof | null, value: unknown, rawSource?: SessionImageProof): Promise<SessionPreparedImage> {
    if (this.preparationWaiting >= SESSION_STORAGE_QUEUE) throw new SessionStorageUnavailable('busy')
    const expires = performance.now() + SESSION_STORAGE_REQUEST_MS, previous = this.preparationTail
    let release!: () => void
    this.preparationTail = new Promise(resolve => { release = resolve })
    this.preparationWaiting++
    await previous
    this.preparationWaiting--
    let reservation: OwnedReservation | undefined
    try {
      if (this.closed || performance.now() >= expires) throw new SessionStorageUnavailable('expired')
      const target = this.path(document)
      await privateRegistryDirectory(dirname(target))
      const directoryIdentity = sessionSourceIdentity(lstatSync(dirname(target), { bigint: true }))
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      stateFileCustodyHealthy()
      const fd = await new Promise<number>((resolve, reject) => open(temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600,
        (error, descriptor) => error ? reject(error) : resolve(descriptor)))
      // O_EXCL already created a file and returned a descriptor. Own both before any later metadata call can fail.
      reservation = { temporary: relative(this.root, temporary), directoryIdentity, descriptor: fd }
      this.preparation = { reservation, release }
      reservation.identity = sessionSourceIdentity(fstatSync(fd, { bigint: true }))
      fchmodSync(fd, 0o600)
      reservation.identity = sessionSourceIdentity(fstatSync(fd, { bigint: true }))
      this.closeReservationDescriptor(reservation)
      const pending = this.request<SessionPreparedImage>({ kind: 'prepare', document, source, value,
        reservation: { temporary: reservation.temporary, identity: reservation.identity }, ...(rawSource ? { rawSource } : {}) })
      this.preparation.child = this.child
      const result = await pending
      if (!result || !sessionImageProof(result.proof) || result.temporary !== reservation.temporary
        || !this.sameInode(result.proof.identity, reservation.identity)) {
        // An unrecognizable reply cannot settle the child's prepared-image slot or its descriptor custody.
        this.terminate()
        await this.exiting
        throw new SessionStorageUnavailable('changed')
      }
      this.preparation.writtenIdentity = result.proof.identity
      return result
    } catch (error) {
      if (error instanceof StateFileCleanupUnconfirmed) this.closeFailed = true
      if (reservation) this.removeTemporary(reservation)
      this.preparation = undefined
      release()
      throw error instanceof StateFileCleanupUnconfirmed ? new SessionStorageUnavailable('cleanup-unconfirmed') : error
    }
  }
  async discard(prepared: SessionPreparedImage): Promise<void> {
    const owner = this.preparation
    if (!owner || owner.reservation.temporary !== prepared.temporary) throw new SessionStorageUnavailable('invalid')
    this.removeTemporary(owner.reservation)
    if (owner.child === this.child) await this.request({ kind: 'discard', temporary: prepared.temporary, identity: owner.writtenIdentity! })
    this.preparation = undefined
    owner.release()
  }

  private sameInode(a: string, b: string): boolean {
    const left = a.split(':'), right = b.split(':')
    return [0, 1, 5, 6, 7, 8].every(index => left[index] === right[index])
  }

  /** One current write plus an unconfirmed Registry prior; reads do not reserve source descriptors. */
  async withWrite<T>(expires: number, apply: () => Promise<T>): Promise<T> {
    if (this.writeWaiting >= SESSION_STORAGE_QUEUE) throw new SessionStorageUnavailable('busy')
    const previous = this.writeTail
    let release!: () => void
    this.writeTail = new Promise(resolve => { release = resolve })
    this.writeWaiting++
    await previous
    this.writeWaiting--
    try {
      if (this.closed || this.closeFailed) throw new SessionStorageUnavailable('disconnected')
      if (performance.now() >= expires) throw new SessionStorageUnavailable('expired')
      return await apply()
    } finally { release() }
  }

  private removeTemporary(reservation: OwnedReservation): void {
    if (reservation.closeUnconfirmed) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    if (reservation.descriptor !== undefined) {
      // A failed first fstat left the original open descriptor owned. One cleanup attempt can prove that inode.
      try { reservation.identity ??= sessionSourceIdentity(fstatSync(reservation.descriptor, { bigint: true })) }
      catch { this.closeFailed = true; throw new SessionStorageUnavailable('cleanup-unconfirmed') }
      this.closeReservationDescriptor(reservation)
    }
    if (!reservation.identity) { this.closeFailed = true; throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    const file = join(this.root, reservation.temporary)
    try {
      const directory = lstatSync(dirname(file), { bigint: true })
      if (!directory.isDirectory() || !this.sameInode(sessionSourceIdentity(directory), reservation.directoryIdentity)) throw new Error()
    } catch {
      this.closeFailed = true
      throw new SessionStorageUnavailable('cleanup-unconfirmed')
    }
    try {
      const current = lstatSync(file, { bigint: true })
      if (!current.isFile() || !this.sameInode(sessionSourceIdentity(current), reservation.identity)) {
        throw new SessionStorageUnavailable('cleanup-unconfirmed')
      }
      // Proof and unlink stay in one non-yielding fence, under the existing same-user filesystem trust boundary.
      unlinkSync(file)
    } catch (error) {
      if (!missing(error)) { this.closeFailed = true; throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    }
  }

  private closeReservationDescriptor(reservation: OwnedReservation): void {
    if (reservation.descriptor === undefined) return
    try { this.closeDescriptor(reservation.descriptor) }
    catch { reservation.closeUnconfirmed = true; throw new SessionStorageUnavailable('cleanup-unconfirmed') }
    delete reservation.descriptor
  }

  retain(document: SessionDocument): Promise<SessionImageSource> {
    return this.ownDescriptors(() => this.retainImage(document))
  }

  private async retainImage(document: SessionDocument): Promise<SessionImageSource> {
    if (this.closed || this.closeFailed) throw new SessionStorageUnavailable('disconnected')
    stateFileCustodyHealthy()
    if (this.retained.size >= 2) throw new SessionStorageUnavailable('busy')
    const lease = randomUUID()
    let fd: number | undefined
    try {
      fd = await new Promise<number>((resolve, reject) => open(this.path(document),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        (error, descriptor) => error ? reject(error) : resolve(descriptor)))
    } catch (error) { if (!missing(error)) throw new SessionStorageUnavailable('unsafe') }
    try {
      const image = await this.request<SessionImage>({ kind: 'read', document, retain: lease })
      if (image.state === 'image') {
        if (fd === undefined || sessionSourceIdentity(fstatSync(fd, { bigint: true })) !== image.proof.identity) {
          throw new SessionStorageUnavailable('changed')
        }
        this.retained.set(lease, { fd, proof: image.proof, lease })
      } else if (fd !== undefined) throw new SessionStorageUnavailable('changed')
      let released = false
      return { image, lease,
        check: () => {
          if (released) throw new SessionStorageUnavailable('changed')
          if (image.state === 'image' && (fd === undefined
            || sessionSourceIdentity(fstatSync(fd, { bigint: true })) !== image.proof.identity)) throw new SessionStorageUnavailable('changed')
        },
        release: async () => {
          if (released) return
          // Stop retaining plaintext in a live child before closing its parent's recovery descriptor.
          if (this.child) await this.request({ kind: 'release', lease })
          if (fd !== undefined) this.closeDescriptor(fd)
          this.retained.delete(lease)
          released = true
        },
      }
    } catch (error) {
      if (fd !== undefined) this.closeDescriptor(fd)
      if (this.child) await this.request({ kind: 'release', lease }).catch(() => {})
      throw error
    }
  }

  private closeDescriptor(fd: number): void {
    try { closeSync(fd) }
    catch { this.closeFailed = true; throw new SessionStorageUnavailable('cleanup-unconfirmed') }
  }

  async withImport<T>(row: CredentialRow, override: GridLaunchOverride | StoredGridLaunch,
    apply: (reference: StoredGridLaunch) => Promise<T>): Promise<T> {
    if (storedGridLaunch(override)) return apply(override)
    const lease = randomUUID()
    const identity = { agentId: row.agentId, registeredAt: row.registeredAt }
    const reference = await this.request<StoredGridLaunch>({ kind: 'import', lease, row: identity, override })
    try { return await apply(reference) }
    finally { if (this.child) await this.request({ kind: 'release', lease }) }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    return this.closing = (async () => {
      for (const waiting of this.queue.splice(0)) waiting.reject(new SessionStorageUnavailable('disconnected'))
      this.terminate()
      await this.exiting
      if (this.preparation) {
        this.removeTemporary(this.preparation.reservation)
        this.preparation.release()
        this.preparation = undefined
      }
      // A source/temporary open may have reached the OS before close, without returning its FD yet.
      // Reaping the child alone does not settle those parent operations or their write authority.
      await Promise.allSettled([...this.descriptorOperations])
      await this.writeTail
      await this.listSettlement
      for (const source of this.retained.values()) this.closeDescriptor(source.fd)
      this.retained.clear()
      stoppedAuthorityHealthy()
      stateFileCustodyHealthy()
      if (this.closeFailed) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    })()
  }
}

export const sessionStorage = new SessionStorage(env.ADAPTER_DATA_DIR)
