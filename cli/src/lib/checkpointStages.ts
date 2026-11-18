/** Four durable reservations. An unsettled writer keeps its slot across core replacement. */
import { constants, lstatSync, mkdirSync, openSync, writeFileSync, ftruncateSync, fstatSync, fsync,
  unlinkSync, rmdirSync, renameSync, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { nativeFileKey } from '../engines/kit/nativePaths.js'
import { exportReceipt, STORAGE_CHUNK_BYTES, STORAGE_IN_FLIGHT, STORAGE_STAGE_BYTES, STORAGE_EXPORT_WAIT_MS, type ExportReceipt, type ExportStage,
  type ExportOwnership } from '../engines/worker/storageProtocol.js'
import { closeStateFileDescriptor, directorySyncSupported, readPrivateStateFile, secureStateDirectory, syncStateDirectory } from './secureState.js'

function privateFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || (process.platform !== 'win32' && (stat.mode & 0o777n) !== 0o600n)
    || (process.getuid && stat.uid !== BigInt(process.getuid()))) throw new Error('unsafe checkpoint stage')
}
function version(stat: BigIntStats): string { return `${nativeFileKey(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` }
function identity(path: string, key: string): BigIntStats {
  const stat = lstatSync(path, { bigint: true }); privateFile(stat)
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
async function flushSlot(directory: string, key: string): Promise<void> {
  if (!directorySyncSupported()) return
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    if (nativeFileKey(fstatSync(fd, { bigint: true })) !== key) throw new Error('checkpoint slot changed')
    directoryIdentity(directory, key)
    await flush(fd)
    directoryIdentity(directory, key)
  } finally { closeStateFileDescriptor(fd) }
}
function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
const historyName = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}-[a-f0-9-]{36}\.history$/.test(value)
interface Owner { version: 1; core: number; writer: number | null; settled: boolean; key: string; destination?: string }
function readOwner(path: string): Owner {
  const value = JSON.parse(readPrivateStateFile(path, 1024)) as Owner
  if (value.version !== 1 || !Number.isSafeInteger(value.core) || value.core <= 0 || typeof value.settled !== 'boolean'
    || (value.writer !== null && (!Number.isSafeInteger(value.writer) || value.writer <= 0))
    || typeof value.key !== 'string' || !/^\d+:\d+$/.test(value.key)
    || (value.destination !== undefined && !historyName(value.destination))) throw new Error('checkpoint owner unavailable')
  return value
}
function retained(): void { console.error('[checkpoint] STAGE_CLEANUP_UNAVAILABLE') }
function expired(): Error { return Object.assign(new Error('checkpoint disk wait expired'), { code: 'CHECKPOINT_STAGE_TIMEOUT' }) }
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const left = Math.ceil(deadline - performance.now())
  const end = left <= 0 ? Promise.reject(expired()) : new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired()), left) })
  try { return await Promise.race([end, work]) } finally { clearTimeout(timer) }
}
export interface CheckpointStage extends ExportOwnership {
  stage: ExportStage
  verify(receipt: ExportReceipt): Promise<void>
  publish(destination: string, current: () => void): Promise<void>
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
        const owner = readOwner(join(directory, 'owner.json'))
        if (!absent(owner.core) || (!owner.settled && owner.writer !== null && !absent(owner.writer))) { retained(); continue }
        this.remove(directory, key, owner)
      } catch (error) { if (found || (error as NodeJS.ErrnoException).code !== 'ENOENT') retained() }
    }
  }

  private remove(directory: string, key: string, owner: Owner): void {
    directoryIdentity(directory, key)
    let orphan: string | undefined
    if (owner.destination) {
      const target = join(dirname(this.directory), owner.destination)
      let exists = false
      try { identity(target, owner.key); exists = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (exists) {
        const manifest = join(dirname(this.directory), `${owner.destination.slice(0, 64)}.json`)
        let committed = false
        try {
          const saved = JSON.parse(readPrivateStateFile(manifest, 16384)) as { version: unknown; file: unknown }
          if (saved.version !== 1 || !historyName(saved.file)) throw new Error('checkpoint manifest unavailable')
          committed = saved.file === owner.destination
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (!committed) orphan = target
      }
    }
    // Exclusive across cores. A crash while reaping reserves this same slot for manual inspection.
    const cleanup = join(directory, 'cleanup')
    mkdirSync(cleanup, { mode: 0o700 })
    directoryIdentity(directory, key)
    const path = join(directory, 'history.tmp')
    try { identity(path, owner.key); unlinkSync(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (orphan) { identity(orphan, owner.key); unlinkSync(orphan); syncStateDirectory(dirname(this.directory)) }
    unlinkSync(join(directory, 'owner.json'))
    rmdirSync(cleanup)
    rmdirSync(directory)
    syncStateDirectory(this.directory)
  }

  async acquire(deadline = performance.now() + STORAGE_EXPORT_WAIT_MS): Promise<CheckpointStage> {
    const work = this.create(deadline)
    try { return await beforeDeadline(work, deadline) }
    catch (error) {
      // The kernel may complete open/stat after the caller has left. Its returned descriptor remains ours to close.
      void work.then(stage => stage.close(), () => {}).catch(retained)
      throw error
    }
  }

  private async create(deadline: number): Promise<CheckpointStage> {
    secureStateDirectory(this.directory)
    for (let slot = 0; slot < STORAGE_IN_FLIGHT; slot++) {
      const directory = this.path(slot), path = join(directory, 'history.tmp'), record = join(directory, 'owner.json')
      try { mkdirSync(directory, { mode: 0o700 }); syncStateDirectory(this.directory) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error }
      const directoryKey = nativeFileKey(lstatSync(directory, { bigint: true }))
      const file: FileHandle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let key: string
      try { const before = await file.stat({ bigint: true }); privateFile(before); key = nativeFileKey(before) }
      catch (error) { await file.close(); throw error }
      let owner: Owner = { version: 1, core: process.pid, writer: null, settled: false, key }
      let recordKey: string | undefined, ownerWrite: Promise<void> | undefined
      const writeOwner = (next: Owner): Promise<void> => {
        if (ownerWrite) throw new Error('checkpoint owner update busy')
        owner = next
        const work = (async () => {
          directoryIdentity(directory, directoryKey)
          if (recordKey) identity(record, recordKey)
          const fd = openSync(record, constants.O_WRONLY | constants.O_NOFOLLOW | (recordKey ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
          try {
            const opened = fstatSync(fd, { bigint: true }); privateFile(opened)
            const openedKey = nativeFileKey(opened)
            if (recordKey && recordKey !== openedKey) throw new Error('checkpoint stage changed')
            directoryIdentity(directory, directoryKey)
            identity(record, openedKey)
            ftruncateSync(fd, 0); writeFileSync(fd, JSON.stringify(next))
            const written = fstatSync(fd, { bigint: true }); privateFile(written)
            const verifyOwner = () => {
              directoryIdentity(directory, directoryKey)
              const actual = fstatSync(fd, { bigint: true }); privateFile(actual)
              if (version(actual) !== version(written) || version(identity(record, openedKey)) !== version(written)) {
                throw new Error('checkpoint stage changed')
              }
            }
            await flush(fd)
            verifyOwner()
            // Initial owner creation still requires both durable names before a lease may escape.
            if (!recordKey) await flushSlot(directory, directoryKey)
            verifyOwner()
            recordKey ??= openedKey
          } finally { closeStateFileDescriptor(fd) }
        })()
        // Keep the actual callback/close alive after a bounded caller reply. This work never calls stage.close().
        ownerWrite = work
        void work.then(() => { ownerWrite = undefined }, () => { ownerWrite = undefined })
        return work
      }
      try { await writeOwner(owner) } catch (error) { await file.close(); throw error }
      let closed = false, verified: string | undefined, verification: Promise<void> | undefined, cleanup: Promise<void> | undefined
      let descriptorClose: Promise<void> | undefined, publication: Promise<void> | undefined
      const closeDescriptor = () => descriptorClose ??= file.close()
      const current = () => { if (closed || performance.now() >= deadline) throw expired() }
      return {
        deadline,
        stage: { path, key },
        writer: async pid => {
          current()
          if (publication) throw new Error('checkpoint publication busy')
          if (owner.writer !== null || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('checkpoint writer unavailable')
          await beforeDeadline(writeOwner({ ...owner, writer: pid }), deadline)
          current()
        },
        settled: async () => {
          current()
          if (publication) throw new Error('checkpoint publication busy')
          await beforeDeadline(writeOwner({ ...owner, settled: true }), deadline)
          current()
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
        publish: async (destination, allowed) => {
          current()
          if (publication) throw new Error('checkpoint publication busy')
          const work = (async () => {
            if (ownerWrite || verification || !verified || (owner.writer !== null && !owner.settled)) throw new Error('checkpoint stage unconfirmed')
            if (dirname(destination) !== dirname(this.directory) || !historyName(basename(destination))) throw new Error('checkpoint destination refused')
            await writeOwner({ ...owner, destination: basename(destination) })
            current()
            await closeDescriptor()
            current()
            directoryIdentity(directory, directoryKey)
            if (version(identity(path, key)) !== verified) throw new Error('checkpoint stage changed')
            allowed()
            current()
            renameSync(path, destination)
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
            await closeDescriptor()
            if (owner.writer !== null && !owner.settled) { retained(); return }
            identity(record, recordKey!)
            this.remove(directory, directoryKey, owner)
          })().catch(retained)
          await beforeDeadline(cleanup, deadline).catch(retained)
        },
      }
    }
    throw Object.assign(new Error('checkpoint stages busy'), { code: 'CHECKPOINT_STAGES_BUSY' })
  }
}
