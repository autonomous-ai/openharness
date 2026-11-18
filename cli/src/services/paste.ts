/** Bounded file-drop storage in the edge process. This component cannot type into a terminal. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { CoreApi, CorePorts, PasteArtifact, PasteBegin, PastePort, PasteResult, ServiceRequests } from '../core/api.js'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { NativePaths, nativeFileKey, verifyNativePathFacts, type NativePathFact } from '../engines/kit/nativePaths.js'
import { pasteFileVersion } from '../lib/pasteArtifact.js'
import { secureStateDirectory } from '../lib/secureState.js'
import { createPasteClipboard } from './pasteClipboard.js'

export const PASTE_LIMITS = { uploads: 32, perConnection: 4, chunks: 4, chunkBytes: 256 * 1024,
  fileBytes: 20 * 1024 * 1024, imageBytes: 8 * 1024 * 1024, storedBytes: 2 * 1024 * 1024 * 1024, files: 1024,
  inventory: 4096, operationMs: 30_000, lifetimeMs: 60 * 60 * 1000, retentionMs: 24 * 60 * 60 * 1000 } as const
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const STORED = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}-.+$/i
const PART = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.part$/i
const LEGACY_IMAGE = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.png$/i
const safeName = (name: string) => {
  // One portable component. Control bytes in a pasted path must never become terminal input.
  const clean = name.replace(/[\x00-\x1f\x7f/\\:]/g, '_').replace(/[. ]+$/g, '').trim()
  let suffix = clean.slice(-120) || 'file'
  while (Buffer.byteLength(suffix) > 120) suffix = suffix.slice(1)
  return suffix
}
type Entry = { name: string; size: number; version: string; expires: number; legacy?: boolean }
type Upload = { request: PasteBegin; part: string; name: string; handle?: FileHandle; seen: Set<number>;
  bytes: number; pending: number; cancelled: boolean; published: boolean; created: boolean; ready: Promise<void>;
  tail: Promise<void>; timer: ReturnType<typeof setTimeout>; started: number; cleaning?: Promise<void>;
  fileKey?: string; stagedVersion?: string }
export interface PasteDeps { now?: () => number; log?: (code: string) => void; clipboard?: typeof createPasteClipboard }

export function createPasteFiles(dataDir: string, deps: PasteDeps = {}): Omit<PastePort, 'stop'> & { stop(): Promise<void> } {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((code) => console.warn(`[paste] ${code}`))
  const directory = join(dataDir, 'paste-drops', 'file-uploads')
  const active = new Map<string, Upload>()
  const clipboard = (deps.clipboard ?? createPasteClipboard)(dataDir, { busy: (connection) => ({
    total: active.size, connection: [...active.values()].filter((upload) => upload.request.connection === connection).length,
  }) })
  // Publication facts, never body buffers. Expiry or the single clipboard claim removes each entry.
  const images = new Map<string, { request: PasteBegin; artifact: PasteArtifact }>()
  // A replay must not replace a published file after its active upload slot was released.
  const retained = new Map<string, number>()
  const expiry: Entry[] = []
  let bytesUsed = 0, filesUsed = 0, fault: string | null = null, stopped = false
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let expiring: Promise<void> | undefined
  const fail = (code: string) => { log(code); return { error: code } }
  const failure = (error: unknown) => fail(error instanceof Error && /^PASTE_[A-Z_]+$/.test(error.message) ? error.message : 'PASTE_STORAGE_FAILED')
  let facts: NativePathFact[] = []
  const verify = () => verifyNativePathFacts(facts)

  const schedule = (): void => {
    clearTimeout(expiryTimer)
    if (stopped || expiring || !expiry.length) return
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined
      expiring = expire().finally(() => { expiring = undefined; schedule() })
    }, Math.min(2 ** 31 - 1, Math.max(1, expiry[0].expires - now())))
    expiryTimer.unref()
  }
  const remember = (entry: Entry): void => {
    const generation = entry.name.slice(0, 36)
    if (UUID.test(generation)) retained.set(generation, (retained.get(generation) ?? 0) + 1)
    if (Number.isFinite(entry.expires)) {
      const index = expiry.findIndex((other) => other.expires > entry.expires)
      expiry.splice(index < 0 ? expiry.length : index, 0, entry)
    }
  }
  const forget = (entry: Entry): void => {
    bytesUsed -= entry.size; filesUsed--
    // Only recognized artifacts expire; remember indexed their generation before enqueueing them.
    const generation = entry.name.slice(0, 36), count = retained.get(generation)!
    if (count > 1) retained.set(generation, count - 1)
    else { retained.delete(generation); images.delete(generation) }
  }
  const expire = async (): Promise<void> => {
    const due: Entry[] = []
    while (due.length < 128 && expiry[0]?.expires <= now()) due.push(expiry.shift()!)
    for (let offset = 0; offset < due.length; offset += 4) {
      await Promise.all(due.slice(offset, offset + 4).map(async (entry) => {
        try {
          if (!entry.version) { log('PASTE_CLEANUP_UNVERIFIED'); return }
          const file = join(entry.legacy ? join(dataDir, 'paste-drops') : directory, entry.name)
          const current = await lstat(file, { bigint: true })
          if (!current.isFile() || current.nlink !== 1n || pasteFileVersion(current) !== entry.version) {
            log('PASTE_CLEANUP_CHANGED'); return
          }
          verify()
          await unlink(file)
          forget(entry)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            forget(entry)
          } else { fault = 'PASTE_CLEANUP_FAILED'; log(fault) }
        }
      }))
    }
  }
  const inspectParents = async (paths: NativePaths): Promise<void> => {
    const dataRoot = (await paths.resolve(dataDir))!.path
    for (const parent of [dataDir, join(dataDir, 'paste-drops')]) {
      const located = await paths.resolve(parent, true)
      if (!located) continue
      const info = located.info
      if (!info.isDirectory() || process.platform !== 'win32' && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o022n) !== 0n)) {
        throw new Error('PASTE_UNSAFE_DIRECTORY')
      }
    }
    if (paths.snapshot().some((fact) => fact.alias && fact.path.startsWith(join(dataRoot, 'paste-drops')))) throw new Error('PASTE_UNSAFE_DIRECTORY')
  }
  const inventory = async (): Promise<void> => {
    const before = new NativePaths(new NativeEvidenceBudget())
    await inspectParents(before)
    before.verify()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    secureStateDirectory(directory)
    const paths = new NativePaths(new NativeEvidenceBudget())
    await paths.resolve(directory)
    await inspectParents(paths)
    facts = paths.snapshot()
    const dir = await opendir(directory, { bufferSize: 128 })
    let count = 0
    for await (const entry of dir) {
      if (++count > PASTE_LIMITS.inventory) throw new Error('PASTE_INVENTORY_LIMIT')
      const info = await lstat(join(directory, entry.name), { bigint: true })
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('PASTE_UNSAFE_DIRECTORY')
      const size = Number(info.size)
      bytesUsed += size; filesUsed++
      remember({ name: entry.name, size, version: pasteFileVersion(info),
        expires: PART.test(entry.name) ? Number(info.mtimeMs) + PASTE_LIMITS.lifetimeMs
          : STORED.test(entry.name) ? Number(info.mtimeMs) + PASTE_LIMITS.retentionMs : Infinity })
    }
    // The old image writer used this flat directory. Recognized owned PNGs expire in place; foreign
    // names, directories and links are neither adopted nor removed. Both inventories share one bound.
    const legacy = await opendir(join(dataDir, 'paste-drops'), { bufferSize: 128 })
    for await (const entry of legacy) {
      if (++count > PASTE_LIMITS.inventory) throw new Error('PASTE_INVENTORY_LIMIT')
      if (!LEGACY_IMAGE.test(entry.name)) continue
      const info = await lstat(join(dataDir, 'paste-drops', entry.name), { bigint: true })
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
        || process.platform !== 'win32' && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o022n) !== 0n)) continue
      const size = Number(info.size)
      bytesUsed += size; filesUsed++
      remember({ name: entry.name, size, version: pasteFileVersion(info), legacy: true,
        expires: Number(info.mtimeMs) + PASTE_LIMITS.retentionMs })
    }
    verify()
    await expire()
    schedule()
  }
  const initialized = inventory().catch((error: unknown) => {
    fault = error instanceof Error && /^PASTE_[A-Z_]+$/.test(error.message) ? error.message : 'PASTE_STORAGE_FAILED'
    log(fault)
  })
  const ownedStage = async (upload: Upload, missingOkay = false): Promise<boolean> => {
    if (!upload.fileKey) throw new Error('PASTE_STAGING_UNCONFIRMED')
    let info: BigIntStats
    try { info = await lstat(join(directory, upload.part), { bigint: true }) } catch (error) {
      if (missingOkay && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (!info.isFile() || info.nlink !== 1n || nativeFileKey(info) !== upload.fileKey
      || process.platform !== 'win32' && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n)
      || upload.stagedVersion && pasteFileVersion(info) !== upload.stagedVersion) throw new Error('PASTE_STAGING_CHANGED')
    verify()
    return true
  }
  const cleanup = (upload: Upload): Promise<void> => {
    if (upload.cleaning) return upload.cleaning
    if (upload.pending || !upload.cancelled && !upload.published) return Promise.resolve()
    clearTimeout(upload.timer)
    upload.cleaning = (async () => { try {
      if (!upload.published) {
        if (upload.created) {
          try {
            if (await ownedStage(upload, true)) await unlink(join(directory, upload.part)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
          } finally {
            const handle = upload.handle; upload.handle = undefined
            await handle?.close()
          }
        }
        bytesUsed -= upload.request.totalBytes; filesUsed--
      }
      active.delete(upload.request.generation)
    } catch { fault = 'PASTE_CLEANUP_FAILED'; log(fault) } })()
    return upload.cleaning
  }
  const cancel = (generation: string | null): void => {
    clipboard.cancel(generation)
    if (generation === null) { images.clear(); for (const id of active.keys()) cancel(id); return }
    images.delete(generation)
    const upload = active.get(generation)
    if (!upload) return
    upload.cancelled = true
    void cleanup(upload)
  }
  const arm = (upload: Upload): void => {
    clearTimeout(upload.timer)
    upload.timer = setTimeout(() => { log('PASTE_UPLOAD_TIMEOUT'); cancel(upload.request.generation) },
      Math.max(1, Math.min(PASTE_LIMITS.operationMs, upload.started + PASTE_LIMITS.lifetimeMs - now())))
    upload.timer.unref()
  }
  const bounded = <T>(operation: Promise<T>, upload: Upload, ms: number): Promise<T | { error: string }> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => { cancel(upload.request.generation); resolve(fail('PASTE_UPLOAD_TIMEOUT')) }, ms)
      timer.unref()
      void operation.then((answer) => { clearTimeout(timer); resolve(answer) }, (error: unknown) => {
        clearTimeout(timer); cancel(upload.request.generation); resolve(failure(error))
      })
    })
  return {
    async begin(request) {
      if (stopped || fault) return fail(fault ?? 'PASTE_UNAVAILABLE')
      if (!UUID.test(request.generation) || !UUID.test(request.streamId) || !request.connection || request.connection.length > 512
        || !request.filename || request.filename.length > 4096 || !Number.isSafeInteger(request.totalBytes)
        || request.kind !== undefined && request.kind !== 'image' && request.kind !== 'file'
        || request.totalBytes <= 0 || request.totalBytes > (request.kind === 'image' ? PASTE_LIMITS.imageBytes : PASTE_LIMITS.fileBytes)) return fail('PASTE_INVALID_UPLOAD')
      if (active.has(request.generation) || retained.has(request.generation)) return fail('PASTE_UPLOAD_BUSY')
      const owners = clipboard.usage(request.connection)
      if (active.size + owners.total >= PASTE_LIMITS.uploads
        || [...active.values()].filter((u) => u.request.connection === request.connection).length + owners.connection >= PASTE_LIMITS.perConnection
        || filesUsed >= PASTE_LIMITS.files || bytesUsed + request.totalBytes > PASTE_LIMITS.storedBytes) return fail('PASTE_CAPACITY')
      const upload: Upload = { request: { ...request }, part: `${request.generation}.part`, name: `${request.generation}-${request.kind === 'image' ? 'image.png' : safeName(request.filename)}`,
        seen: new Set(), bytes: 0, pending: 1, cancelled: false, published: false, created: false, ready: Promise.resolve(), tail: Promise.resolve(),
        timer: undefined as unknown as ReturnType<typeof setTimeout>, started: now() }
      active.set(request.generation, upload); bytesUsed += request.totalBytes; filesUsed++
      arm(upload)
      upload.ready = initialized.then(async () => {
        if (fault) throw new Error(fault)
        if (retained.has(request.generation)) throw new Error('PASTE_UPLOAD_BUSY')
        // Inventory may have discovered old files after this begin reserved its slot.
        if (filesUsed > PASTE_LIMITS.files || bytesUsed > PASTE_LIMITS.storedBytes) throw new Error('PASTE_CAPACITY')
        if (upload.cancelled) return
        verify()
        upload.handle = await open(join(directory, upload.part), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        upload.created = true
        upload.fileKey = nativeFileKey(await upload.handle.stat({ bigint: true }))
      }).catch((error: unknown) => { upload.cancelled = true; throw error }).finally(() => {
        upload.pending--; void cleanup(upload)
      })
      upload.tail = upload.ready.catch(() => {})
      return bounded(upload.ready.then(() => upload.cancelled ? { error: 'PASTE_CANCELLED' } : { accepted: true as const }), upload, 7_500)
    },
    async chunk(request, bytes): Promise<PasteResult> {
      const upload = active.get(request.generation)
      if (upload?.published || !upload && retained.has(request.generation)) return { ignored: true }
      if (!upload || upload.cancelled) return fail('PASTE_UPLOAD_UNAVAILABLE')
      if (upload.request.connection !== request.connection || upload.request.streamId !== request.streamId) return fail('PASTE_INVALID_UPLOAD')
      const chunks = Math.ceil(upload.request.totalBytes / PASTE_LIMITS.chunkBytes)
      const expected = Math.min(PASTE_LIMITS.chunkBytes, upload.request.totalBytes - request.seq * PASTE_LIMITS.chunkBytes)
      if (!Number.isSafeInteger(request.seq) || request.seq < 0 || request.seq >= chunks || bytes.byteLength !== expected) {
        cancel(request.generation); return fail('PASTE_INVALID_CHUNK')
      }
      if (upload.pending >= PASTE_LIMITS.chunks) { cancel(request.generation); return fail('PASTE_WINDOW_EXCEEDED') }
      upload.pending++; arm(upload)
      const operation = upload.tail.then(async (): Promise<PasteResult> => {
        if (upload.cancelled || upload.published) return { ignored: true }
        if (!upload.seen.has(request.seq)) {
          let written = 0
          for (let writes = 0; written < bytes.byteLength; writes++) {
            if (writes >= 64) throw new Error('PASTE_WRITE_LIMIT')
            const result = await upload.handle!.write(bytes, written, bytes.byteLength - written, request.seq * PASTE_LIMITS.chunkBytes + written)
            if (!result.bytesWritten) throw new Error('PASTE_WRITE_STALLED')
            written += result.bytesWritten
          }
          upload.seen.add(request.seq); upload.bytes += bytes.byteLength
        }
        if (upload.cancelled) return { ignored: true }
        const progress = { bytesWritten: upload.bytes, totalBytes: upload.request.totalBytes }
        if (upload.seen.size !== chunks) return progress
        const staged = await upload.handle!.stat({ bigint: true })
        if (staged.size !== BigInt(upload.request.totalBytes)) throw new Error('PASTE_STAGING_CHANGED')
        upload.stagedVersion = pasteFileVersion(staged)
        await upload.handle!.close(); upload.handle = undefined
        if (upload.cancelled) return { ignored: true }
        await ownedStage(upload)
        if (upload.cancelled) return { ignored: true }
        await rename(join(directory, upload.part), join(directory, upload.name))
        // Once the rename settles, even cancellation retains the complete artifact for its normal lifetime.
        upload.published = true
        const entry: Entry = { name: upload.name, size: upload.request.totalBytes, version: '', expires: now() + PASTE_LIMITS.retentionMs }
        remember(entry); schedule()
        const info: BigIntStats = await lstat(join(directory, upload.name), { bigint: true })
        const version = pasteFileVersion(info)
        entry.version = version
        if (!upload.cancelled && upload.request.kind === 'image') images.set(request.generation, { request: upload.request, artifact: { name: upload.name, version } })
        return upload.cancelled ? { ignored: true } : { ...progress, artifact: { name: upload.name, version } }
      }).catch((error: unknown) => { upload.cancelled = true; return failure(error) }).finally(() => {
        upload.pending--; void cleanup(upload)
      })
      upload.tail = operation.then(() => {})
      return bounded(operation, upload, PASTE_LIMITS.operationMs)
    },
    clipboard(request) {
      const image = images.get(request.generation)
      if (!image || image.request.connection !== request.connection || image.request.streamId !== request.streamId
        || image.artifact.name !== request.artifact.name || image.artifact.version !== request.artifact.version) {
        return Promise.resolve({ state: 'unavailable', reason: 'PASTE_UPLOAD_UNAVAILABLE' })
      }
      images.delete(request.generation)
      return clipboard.prepare(request)
    },
    releaseClipboard: (generation, corePid) => { void clipboard.release(generation, corePid) },
    cancel,
    async stop() {
      stopped = true; clearTimeout(expiryTimer)
      const stoppingClipboard = clipboard.stop(); images.clear()
      for (const generation of active.keys()) cancel(generation)
      await initialized
      await expiring
      await Promise.all([...active.values()].map(async (upload) => { await upload.tail; await cleanup(upload) }))
      await stoppingClipboard
    },
  }
}

export function startPaste(core: CoreApi, ports: CorePorts): ServiceRequests {
  ports.paste = createPasteFiles(core.dataDir)
  return {}
}
