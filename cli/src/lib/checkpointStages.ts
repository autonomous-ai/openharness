/** Four durable reservations. An unsettled writer keeps its slot across core replacement. */
import { constants, lstatSync, mkdirSync, openSync, readSync, writeSync, writeFileSync, ftruncateSync, fstatSync, fsync,
  unlinkSync, rmdirSync, linkSync, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { errorKind } from './log.js'
import { nativeFileKey } from '../engines/kit/nativePaths.js'
import { exportReceipt, STORAGE_CHUNK_BYTES, STORAGE_IN_FLIGHT, STORAGE_STAGE_BYTES, STORAGE_EXPORT_WAIT_MS, type ExportReceipt,
  type ExportOwnership } from '../engines/worker/storageProtocol.js'
import { closeStateFileDescriptor, directorySyncSupported, readPrivateStateFile, secureStateDirectory, stateFileCustodyHealthy, syncStateDirectory } from './secureState.js'

function privateFile(stat: BigIntStats, links = 1n): void {
  if (!stat.isFile() || stat.nlink !== links || (process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n)
    || (process.getuid && stat.uid !== BigInt(process.getuid()))) throw new Error('unsafe checkpoint stage')
}
function version(stat: BigIntStats): string { return `${nativeFileKey(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` }
function identity(path: string, key: string, links = 1n): BigIntStats {
  const stat = lstatSync(path, { bigint: true }); privateFile(stat, links)
  if (nativeFileKey(stat) !== key) throw new Error('checkpoint stage changed')
  return stat
}
function directoryIdentity(path: string, key: string): void {
  secureStateDirectory(path, false)
  if (nativeFileKey(lstatSync(path, { bigint: true })) !== key) throw new Error('checkpoint slot changed')
}
function flush(fd: number): Promise<void> {
  return new Promise((resolve, reject) => fsync(fd, error => { if (error) reject(error); else resolve() }))
}
async function flushAllocation(owner: number, directory: string, key: string, pool: string, poolKey: string): Promise<void> {
  stateFileCustodyHealthy()
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  const slot = openSync(directory, flags)
  try {
    const parent = openSync(pool, flags)
    try {
      if (nativeFileKey(fstatSync(slot, { bigint: true })) !== key
        || nativeFileKey(fstatSync(parent, { bigint: true })) !== poolKey) throw new Error('checkpoint slot changed')
      directoryIdentity(directory, key); directoryIdentity(pool, poolKey)
      // All names and bytes exist before this barrier. A failed or late flush
      // still owns its descriptor until every actual callback has completed.
      const results = await Promise.allSettled([flush(owner), flush(slot), flush(parent)])
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } finally { closeStateFileDescriptor(parent) }
  } finally { closeStateFileDescriptor(slot) }
}
function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
const historyName = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}-[a-f0-9-]{36}\.history$/.test(value)
type Owner = { core: number; writer: number | null; settled: boolean; key: string; destination?: string }
  & ({ version: 1 } | { version: 2; lease: string })
function parseOwner(text: string): { owner: Owner; text: string } {
  const value = JSON.parse(text) as Owner
  if ((value.version !== 1 && (value.version !== 2 || typeof value.lease !== 'string' || !/^[a-f0-9]{32}$/.test(value.lease)))
    || !Number.isSafeInteger(value.core) || value.core <= 0 || typeof value.settled !== 'boolean'
    || (value.writer !== null && (!Number.isSafeInteger(value.writer) || value.writer <= 0))
    || typeof value.key !== 'string' || !/^\d+:\d+$/.test(value.key)
    || (value.destination !== undefined && !historyName(value.destination))) throw new Error('checkpoint owner unavailable')
  return { owner: value, text }
}
function readOwner(path: string): { owner: Owner; text: string } {
  return parseOwner(readPrivateStateFile(path, 1024))
}
function readOpenedOwner(fd: number, before: BigIntStats): { owner: Owner; text: string } {
  if (before.size > 1024n) throw new Error('checkpoint owner unavailable')
  const bytes = Buffer.alloc(Number(before.size))
  for (let position = 0; position < bytes.length;) {
    // Positioned reads leave the writer at zero, including after a short read.
    const count = readSync(fd, bytes, position, bytes.length - position, position)
    if (!count) throw new Error('checkpoint owner unavailable')
    position += count
  }
  const after = fstatSync(fd, { bigint: true }); privateFile(after)
  if (version(after) !== version(before)) throw new Error('checkpoint owner changed')
  return parseOwner(bytes.toString('utf8'))
}
function retained(): void { console.error('[checkpoint] STAGE_CLEANUP_UNAVAILABLE') }
function expired(): Error { return Object.assign(new Error('checkpoint disk wait expired'), { code: 'CHECKPOINT_STAGE_TIMEOUT' }) }
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const left = Math.ceil(deadline - performance.now())
  const end = left <= 0 ? Promise.reject(expired()) : new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired()), left) })
  try { return await Promise.race([end, work]) } finally { clearTimeout(timer) }
}
export interface CheckpointStage {
  readonly deadline: number
  handoff(): ExportOwnership
  verify(receipt: ExportReceipt): Promise<void>
  publish(current: () => void): Promise<void>
  close(): Promise<void>
}

export class CheckpointStages {
  constructor(private readonly directory: string) {}
  private path(slot: number): string { return join(this.directory, String(slot)) }

  /** Fixed names only. A missing attestation or crashed reaper remains reserved, never aged out. */
  async prepare(): Promise<void> {
    try { secureStateDirectory(this.directory, false) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained(); return }
    for (let slot = 0; slot < STORAGE_IN_FLIGHT; slot++) {
      const directory = this.path(slot)
      let found = false
      try {
        secureStateDirectory(directory, false)
        found = true
        const key = nativeFileKey(lstatSync(directory, { bigint: true }))
        const { owner, text } = readOwner(join(directory, 'owner.json'))
        if (!absent(owner.core) || (!owner.settled && owner.writer !== null && !absent(owner.writer))) { retained(); continue }
        this.remove(directory, key, owner, text, true)
      } catch (error) { if (found || (error as NodeJS.ErrnoException).code !== 'ENOENT') retained() }
    }
  }

  private remove(directory: string, key: string, owner: Owner, expected = JSON.stringify(owner), recovering = false): void {
    directoryIdentity(directory, key)
    // A stale reaper may have read a slot that another core has since reclaimed and leased again.
    const cleanup = join(directory, 'cleanup'), record = join(directory, 'owner.json')
    mkdirSync(cleanup, { mode: 0o700 })
    const cleanupKey = nativeFileKey(lstatSync(cleanup, { bigint: true }))
    let mutated = false
    try {
      directoryIdentity(directory, key)
      const actual = readOwner(record)
      const same = recovering ? actual.text === expected
        : owner.version === 2 && actual.owner.version === 2 && actual.owner.lease === owner.lease
      if (!same || (recovering && (!absent(owner.core)
        || (!owner.settled && owner.writer !== null && !absent(owner.writer))))) throw new Error('checkpoint owner changed')
      const path = join(directory, 'history.tmp')
      let orphan: string | undefined, published = false
      if (owner.destination) {
        const target = join(dirname(this.directory), owner.destination)
        try { identity(target, owner.key, owner.version === 2 ? 2n : 1n); published = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (published) {
          // The live pin prevents inode reuse. A saved dev:ino alone never authorizes an unlink after a crash.
          if (owner.version === 2) identity(path, owner.key, 2n)
          const manifest = join(dirname(this.directory), `${owner.destination.slice(0, 64)}.json`)
          let committed = false
          try {
            const saved = JSON.parse(readPrivateStateFile(manifest, 16384)) as { version: unknown; file: unknown }
            if (saved.version !== 1 || !historyName(saved.file)) throw new Error('checkpoint manifest unavailable')
            committed = saved.file === owner.destination
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          if (!committed) {
            if (owner.version === 1) throw new Error('checkpoint generation unavailable')
            orphan = target
          }
        }
      }
      // Remove an uncommitted destination before its pin. A crash after an unlink reserves this slot.
      directoryIdentity(directory, key)
      if (orphan) {
        identity(path, owner.key, 2n); identity(orphan, owner.key, 2n)
        mutated = true
        unlinkSync(orphan); syncStateDirectory(dirname(this.directory))
      }
      try {
        identity(path, owner.key, owner.version === 2 && published && !orphan ? 2n : 1n)
        mutated = true
        unlinkSync(path)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      mutated = true
      unlinkSync(record)
      rmdirSync(cleanup)
      rmdirSync(directory)
      syncStateDirectory(this.directory)
    } catch (error) {
      // A refused proof changed nothing: allow a later recovery to inspect it again.
      if (!mutated) {
        directoryIdentity(directory, key)
        directoryIdentity(cleanup, cleanupKey)
        rmdirSync(cleanup)
      }
      throw error
    }
  }

  async acquire(destination: string, writer: number, deadline = performance.now() + STORAGE_EXPORT_WAIT_MS): Promise<CheckpointStage> {
    if (!Number.isSafeInteger(writer) || writer <= 0) throw new Error('checkpoint writer unavailable')
    if (!Number.isFinite(deadline) || performance.now() >= deadline) throw expired()
    if (dirname(destination) !== dirname(this.directory) || !historyName(basename(destination))) throw new Error('checkpoint destination refused')
    const work = this.create(destination, writer, deadline)
    try { return await beforeDeadline(work, deadline) }
    catch (error) {
      // The kernel may complete open/stat after the caller has left. Its returned descriptor remains ours to close.
      void work.then(stage => stage.close(), () => {}).catch(retained)
      throw error
    }
  }

  private async create(destination: string, writer: number, deadline: number): Promise<CheckpointStage> {
    secureStateDirectory(this.directory)
    const poolKey = directorySyncSupported() ? nativeFileKey(lstatSync(this.directory, { bigint: true })) : undefined
    for (let slot = 0; slot < STORAGE_IN_FLIGHT; slot++) {
      const directory = this.path(slot), path = join(directory, 'history.tmp'), record = join(directory, 'owner.json')
      try { mkdirSync(directory, { mode: 0o700 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
      const directoryKey = nativeFileKey(lstatSync(directory, { bigint: true }))
      let file: FileHandle
      try { file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
      catch (error) { this.discardAllocation(directory, directoryKey, []); throw error }
      let key: string
      try { const before = await file.stat({ bigint: true }); privateFile(before); key = nativeFileKey(before) }
      catch (error) {
        let before: BigIntStats | undefined
        try { before = fstatSync(file.fd, { bigint: true }) } catch { retained() }
        try { await file.close(); if (before) this.discardAllocation(directory, directoryKey, [[path, before]]) }
        catch { retained() }
        throw error
      }
      let owner: Owner = { version: 2, lease: randomBytes(16).toString('hex'), core: process.pid, writer, settled: false, key }
      let recordKey: string | undefined, confirmedOwner: string | undefined, ownerWrite: Promise<void> | undefined
      const retainOwner = process.platform !== 'win32'
      let ownerFd: number | undefined, allocatedOwnerKey: string | undefined
      const closeOwner = () => {
        if (ownerFd === undefined) return
        const fd = ownerFd; ownerFd = undefined
        closeStateFileDescriptor(fd)
      }
      const writeOwner = (next: Owner): Promise<void> => {
        if (ownerWrite) throw new Error('checkpoint owner update busy')
        owner = next
        confirmedOwner = undefined
        const text = JSON.stringify(next)
        const work = (async () => {
          directoryIdentity(directory, directoryKey)
          if (recordKey) identity(record, recordKey)
          const access = retainOwner ? constants.O_RDWR : constants.O_WRONLY
          const fd = ownerFd ?? openSync(record, access | constants.O_NOFOLLOW | (recordKey ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
          if (retainOwner) ownerFd = fd
          try {
            const opened = fstatSync(fd, { bigint: true }); privateFile(opened)
            const openedKey = nativeFileKey(opened)
            if (!recordKey) allocatedOwnerKey = openedKey
            if (recordKey && recordKey !== openedKey) throw new Error('checkpoint stage changed')
            directoryIdentity(directory, directoryKey)
            identity(record, openedKey)
            if (recordKey) {
              // Windows' secure reader also proves native root containment; retain that path.
              const saved = process.platform === 'win32' ? readOwner(record).owner : readOpenedOwner(fd, opened).owner
              if (saved.version !== 2 || owner.version !== 2 || saved.lease !== owner.lease) throw new Error('checkpoint owner changed')
            }
            // Keep the previous complete owner if a write is refused before any bytes reach disk.
            if (retainOwner) {
              // The same handle survives updates and explicit publication retries; never append to its offset.
              const bytes = Buffer.from(text)
              for (let position = 0; position < bytes.length;) {
                const count = writeSync(fd, bytes, position, bytes.length - position, position)
                if (!count) throw new Error('checkpoint owner write incomplete')
                position += count
              }
            } else writeFileSync(fd, text)
            ftruncateSync(fd, Buffer.byteLength(text))
            const written = fstatSync(fd, { bigint: true }); privateFile(written)
            const verifyOwner = () => {
              directoryIdentity(directory, directoryKey)
              const actual = fstatSync(fd, { bigint: true }); privateFile(actual)
              if (version(actual) !== version(written) || version(identity(record, openedKey)) !== version(written)) {
                throw new Error('checkpoint stage changed')
              }
            }
            if (!recordKey && poolKey !== undefined) {
              await flushAllocation(fd, directory, directoryKey, this.directory, poolKey)
              directoryIdentity(this.directory, poolKey)
            } else await flush(fd)
            // Admission follows all three initial flushes and fresh proofs. An
            // update, or Windows without directory flushes, needs its file only.
            verifyOwner()
            if (!recordKey && poolKey !== undefined) identity(path, key)
            recordKey ??= openedKey
          } finally { if (!retainOwner) closeStateFileDescriptor(fd) }
          confirmedOwner = text
        })()
        // Keep the actual callback/close alive after a bounded caller reply. This work never calls stage.close().
        ownerWrite = work
        void work.then(() => { ownerWrite = undefined }, () => { ownerWrite = undefined })
        return work
      }
      try { await writeOwner(owner) } catch (error) {
        // No handoff has occurred. Keep versions through the actual closes so a
        // replaced name (including inode reuse) cannot inherit this allocation.
        let files: Array<[string, BigIntStats]> | undefined
        try {
          files = [[path, fstatSync(file.fd, { bigint: true })]]
          if (allocatedOwnerKey) files.push([record, ownerFd === undefined
            ? identity(record, allocatedOwnerKey) : fstatSync(ownerFd, { bigint: true })])
        } catch { files = undefined; retained() }
        try {
          try { await file.close() } finally { closeOwner() }
          if (files) this.discardAllocation(directory, directoryKey, files)
        } catch { retained() }
        throw error
      }
      const verifyConfirmedOwner = () => {
        if (!confirmedOwner || (retainOwner && ownerFd === undefined)) throw new Error('checkpoint owner unconfirmed')
        const before = retainOwner ? fstatSync(ownerFd!, { bigint: true }) : identity(record, recordKey!)
        privateFile(before)
        if (nativeFileKey(before) !== recordKey) throw new Error('checkpoint stage changed')
        const saved = retainOwner ? readOpenedOwner(ownerFd!, before) : readOwner(record)
        // Matching visible bytes are insufficient without the successful actual flush above.
        if (saved.text !== confirmedOwner) throw new Error('checkpoint owner changed')
        if (version(identity(record, recordKey!)) !== version(before)) throw new Error('checkpoint stage changed')
      }
      let closed = false, exposed = false, verified: string | undefined, verification: Promise<void> | undefined, cleanup: Promise<void> | undefined
      let descriptorClose: Promise<void> | undefined, publication: Promise<void> | undefined
      const closeDescriptor = () => descriptorClose ??= file.close()
      const current = () => { if (closed || performance.now() >= deadline) throw expired() }
      return {
        deadline,
        // Only this synchronous handoff exposes a writer path. A late create
        // that was never handed off can still release its slot after timeout.
        handoff: () => {
          current()
          if (exposed) throw new Error('checkpoint lease already exposed')
          exposed = true
          return {
            deadline,
            stage: { path, key },
            settled: async () => {
              current()
              if (publication) throw new Error('checkpoint publication busy')
              await beforeDeadline(writeOwner({ ...owner, settled: true, destination: basename(destination) }), deadline)
              current()
            },
          }
        },
        verify: async receipt => {
          current()
          if (verification || ownerWrite || publication) throw new Error('checkpoint verification busy')
          const work = (async () => {
            if (!exportReceipt(receipt)) throw new Error('invalid checkpoint receipt')
            const before = await file.stat({ bigint: true }); current(); privateFile(before)
            if (Number(before.size) !== receipt.bytes || before.size > BigInt(STORAGE_STAGE_BYTES)) throw new Error('invalid checkpoint size')
            const first = await lstat(path, { bigint: true }); current(); privateFile(first)
            if (nativeFileKey(first) !== key) throw new Error('checkpoint stage changed')
            const hash = createHash('sha256'), buffer = Buffer.alloc(STORAGE_CHUNK_BYTES)
            for (let position = 0; position < receipt.bytes;) {
              current()
              const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, receipt.bytes - position), position)
              current()
              if (!bytesRead) throw new Error('checkpoint stage incomplete')
              hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
            }
            const after = await file.stat({ bigint: true }); current(); privateFile(after)
            if (version(after) !== version(before) || nativeFileKey(after) !== key || hash.digest('hex') !== receipt.sha256) throw new Error('checkpoint stage changed')
            await file.sync()
            current()
            const last = await lstat(path, { bigint: true }); current(); privateFile(last)
            if (version(last) !== version(after)) throw new Error('checkpoint stage changed')
            verified = version(after)
          })()
          verification = work
          void work.then(() => { verification = undefined }, () => { verification = undefined })
          await beforeDeadline(work, deadline)
        },
        publish: async allowed => {
          current()
          if (publication) throw new Error('checkpoint publication busy')
          const work = (async () => {
            if (ownerWrite || verification || !verified || !owner.settled || !confirmedOwner
              || owner.destination !== basename(destination)) throw new Error('checkpoint stage unconfirmed')
            await closeDescriptor()
            current()
            directoryIdentity(directory, directoryKey)
            verifyConfirmedOwner()
            if (version(identity(path, key)) !== verified) throw new Error('checkpoint stage changed')
            allowed()
            current()
            // Keep the original name until cleanup; this pins the inode even if the core dies.
            try { linkSync(path, destination) }
            catch (error) {
              console.error(`[checkpoint] STAGE_PIN_UNAVAILABLE · ${errorKind(error)}`)
              throw Object.assign(new Error('checkpoint publication link unavailable'), { code: 'CHECKPOINT_STAGE_PIN_UNAVAILABLE' })
            }
            verified = undefined
          })()
          // Retain the destination through actual descriptor close, not just its journal write or bounded reply.
          publication = work
          void work.then(() => { publication = undefined }, () => { publication = undefined })
          await beforeDeadline(work, deadline)
        },
        close: async () => {
          cleanup ??= (async () => {
            closed = true
            // Closing revokes new work first. These raw operations never await this cleanup continuation.
            await ownerWrite?.catch(() => {})
            await publication?.catch(() => {})
            await verification?.catch(() => {})
            try { await closeDescriptor() } finally { closeOwner() }
            if (exposed && owner.writer !== null && !owner.settled) { retained(); return }
            identity(record, recordKey!)
            this.remove(directory, directoryKey, owner)
          })().catch(retained)
          await beforeDeadline(cleanup, deadline).catch(retained)
        },
      }
    }
    throw Object.assign(new Error('checkpoint stages busy'), { code: 'CHECKPOINT_STAGES_BUSY' })
  }

  private discardAllocation(directory: string, key: string, files: Array<[string, BigIntStats]>): void {
    try {
      directoryIdentity(directory, key)
      const verify = ([path, before]: [string, BigIntStats]) => {
        privateFile(before)
        if (version(identity(path, nativeFileKey(before))) !== version(before)) throw new Error('checkpoint stage changed')
      }
      // Refuse the entire set before the first unlink; never delete an unknown
      // name or recursively remove a slot that another call may have replaced.
      for (const file of files) verify(file)
      for (const file of files) { directoryIdentity(directory, key); verify(file); unlinkSync(file[0]) }
      directoryIdentity(directory, key)
      rmdirSync(directory)
      syncStateDirectory(this.directory)
    } catch { retained() }
  }
}
