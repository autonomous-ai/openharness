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
import type { StoppedArchiveAnswer, StoppedArchiveQuery } from './sessionStorageWire.js'
import { sessionStorageFrames } from './sessionStorageFrames.js'
import { privateRegistryDirectory } from './registryPersistence.js'
import { SESSION_STORAGE_ENTRY_ENV, SESSION_STORAGE_HASH_ENV, SESSION_STORAGE_QUEUE, SESSION_STORAGE_REQUEST_MS,
  SessionStorageUnavailable, type CredentialRow, type SessionDocument, type SessionImage, type SessionImageProof,
  storedGridLaunch, sessionDocument, sessionFileIdentity, type SessionImageReservation, type SessionPreparedImage, type SessionStorageFailure,
  type SessionStorageOperation, type StoredGridLaunch } from './sessionStorageWire.js'
import type { GridLaunchOverride } from './gridLaunchWire.js'

const sessionSourceIdentity = sessionFileIdentity
type OwnedReservation = SessionImageReservation & { directoryIdentity: string }

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

  constructor(readonly root: string, private readonly entry: () => SessionStorageChildEntry = () => {
    const file = process.env[SESSION_STORAGE_ENTRY_ENV], sha256 = process.env[SESSION_STORAGE_HASH_ENV]
    if ((!file || !sha256) && import.meta.url.endsWith('.ts')) {
      const source = fileURLToPath(new URL('../storage/entry.ts', import.meta.url)), expected = fingerprint(source)
      if (!expected) throw new SessionStorageUnavailable('disconnected')
      return { file: source, sha256: expected, execArgv: ['--import', import.meta.resolve('tsx')] }
    }
    if (!file || !sha256) throw new SessionStorageUnavailable('disconnected')
    return { file, sha256 }
  }, private readonly stoppedLeaf = 'stopped-agents') {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(stoppedLeaf)) throw new SessionStorageUnavailable('invalid')
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
    const selected = this.entry()
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
        else if (this.child === child) this.terminate()
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
    this.child?.kill('SIGKILL')
  }

  private request<T>(operation: SessionStorageOperation): Promise<T> {
    if (this.closed || this.closeFailed) return Promise.reject(new SessionStorageUnavailable('disconnected'))
    if (this.queue.length >= SESSION_STORAGE_QUEUE) return Promise.reject(new SessionStorageUnavailable('busy'))
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, expires: Date.now() + SESSION_STORAGE_REQUEST_MS, operation,
        resolve: value => resolve(value as T), reject })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.active || !this.queue.length) return
    const pending = this.queue.shift()!
    if (Date.now() >= pending.expires) {
      pending.reject(new SessionStorageUnavailable('expired'))
      void this.drain()
      return
    }
    this.active = pending
    this.timer = setTimeout(() => this.terminate(), Math.max(1, pending.expires - Date.now()))
    try {
      await this.start()
      if (this.active !== pending) return
      await this.frames!.send(pending.id, { expires: pending.expires, operation: pending.operation })
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
    const expires = Date.now() + SESSION_STORAGE_REQUEST_MS, previous = this.preparationTail
    let release!: () => void
    this.preparationTail = new Promise(resolve => { release = resolve })
    this.preparationWaiting++
    await previous
    this.preparationWaiting--
    let reservation: OwnedReservation | undefined
    try {
      if (this.closed || Date.now() >= expires) throw new SessionStorageUnavailable('expired')
      const target = this.path(document)
      await privateRegistryDirectory(dirname(target))
      const directoryIdentity = sessionSourceIdentity(lstatSync(dirname(target), { bigint: true }))
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      const fd = await new Promise<number>((resolve, reject) => open(temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600,
        (error, descriptor) => error ? reject(error) : resolve(descriptor)))
      try {
        fchmodSync(fd, 0o600)
        reservation = { temporary: relative(this.root, temporary), identity: sessionSourceIdentity(fstatSync(fd, { bigint: true })), directoryIdentity }
      } finally { this.closeDescriptor(fd) }
      this.preparation = { reservation, release }
      const pending = this.request<SessionPreparedImage>({ kind: 'prepare', document, source, value,
        reservation: { temporary: reservation.temporary, identity: reservation.identity }, ...(rawSource ? { rawSource } : {}) })
      this.preparation.child = this.child
      const result = await pending
      if (result.temporary !== reservation.temporary || !this.sameInode(result.proof.identity, reservation.identity)) {
        throw new SessionStorageUnavailable('changed')
      }
      this.preparation.writtenIdentity = result.proof.identity
      return result
    } catch (error) {
      if (reservation) this.removeTemporary(reservation)
      this.preparation = undefined
      release()
      throw error
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

  retain(document: SessionDocument): Promise<SessionImageSource> {
    return this.ownDescriptors(() => this.retainImage(document))
  }

  private async retainImage(document: SessionDocument): Promise<SessionImageSource> {
    if (this.closed || this.closeFailed) throw new SessionStorageUnavailable('disconnected')
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
      for (const source of this.retained.values()) this.closeDescriptor(source.fd)
      this.retained.clear()
      stoppedAuthorityHealthy()
      if (this.closeFailed) throw new SessionStorageUnavailable('cleanup-unconfirmed')
    })()
  }
}

export const sessionStorage = new SessionStorage(env.ADAPTER_DATA_DIR)
