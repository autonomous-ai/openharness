/** Durable, fail-closed clipboard ownership across worker replacement. Nothing here runs in core. */
import { createHash } from 'node:crypto'
import { constants, opendirSync, type BigIntStats } from 'node:fs'
import { mkdir, open, opendir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { NativePaths, nativeFileKey } from '../engines/kit/nativePaths.js'
import { processStartMarker } from '../lib/processLiveness.js'

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const TOKEN = /^([1-9]\d{0,9})-([a-f\d]{64}|unknown)-([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const unsafe = () => new Error('PASTE_CLIPBOARD_UNSAFE_RESERVATION')
export interface ClipboardClaim { release(): Promise<void> }
export interface ClipboardReservation {
  claim(corePid: number, generation: string): Promise<ClipboardClaim | null>
  release(corePid: number, generation: string): Promise<void>
}

export function createClipboardReservation(dataDir: string, deps: {
  exists?: (pid: number) => boolean; identity?: typeof processStartMarker
} = {}): ClipboardReservation {
  const root = join(dataDir, 'paste-drops', 'clipboard-reservations'), directory = join(root, 'held')
  const exists = deps.exists ?? ((pid: number) => {
    try { process.kill(pid, 0); return true } catch (error) {
      // Only the kernel's explicit absence proves death. Permission or unreadable evidence stays live.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }), identity = deps.identity ?? processStartMarker
  const owned = (info: BigIntStats, isDirectory = false): boolean =>
    (isDirectory ? info.isDirectory() : info.isFile() && info.nlink === 1n && info.size === 0n)
    && (process.platform === 'win32' || info.uid === BigInt(process.getuid!()) && (info.mode & 0o077n) === 0n)
  const inspect = async (path: string, optional = false) => {
    const paths = new NativePaths(new NativeEvidenceBudget())
    const base = (await paths.resolve(dataDir))!
    const leaf = await paths.resolve(path, optional)
    if (!leaf) return null
    for (const parent of [dataDir, join(dataDir, 'paste-drops'),
      ...(path.startsWith(root + '/') ? [root] : []), ...(path.startsWith(directory + '/') ? [directory] : [])]) {
      const info = (await paths.resolve(parent))!.info
      if (!info.isDirectory() || process.platform !== 'win32' && (info.uid !== BigInt(process.getuid!()) || (info.mode & (parent === root || parent === directory ? 0o077n : 0o022n)) !== 0n)) throw unsafe()
    }
    if (paths.snapshot().some((fact) => fact.alias && fact.path.startsWith(join(base.path, 'paste-drops')))) throw unsafe()
    return { paths, info: leaf.info }
  }
  const syncDirectory = async (path: string, privateDirectory = true) => {
    const checked = await inspect(path)
    if (!checked || !checked.info.isDirectory() || process.platform !== 'win32'
      && (checked.info.uid !== BigInt(process.getuid!()) || (checked.info.mode & (privateDirectory ? 0o077n : 0o022n)) !== 0n)) throw unsafe()
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (nativeFileKey(await fd.stat({ bigint: true })) !== nativeFileKey(checked.info)) throw unsafe()
      checked.paths.verify(); await fd.sync(); checked.paths.verify()
    } finally { await fd.close() }
  }
  const initialize = async () => {
    await inspect(join(dataDir, 'paste-drops'))
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const checked = await inspect(root)
    if (!checked || !owned(checked.info, true)) throw unsafe()
    await syncDirectory(join(dataDir, 'paste-drops'), false)
  }
  const instance = (pid: number): string => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || !exists(pid)) throw new Error('PASTE_CLIPBOARD_CORE_UNAVAILABLE')
    const marker = identity(pid)
    return `${pid}-${marker ? hash(marker) : 'unknown'}`
  }
  const alive = (name: string): boolean => {
    const parsed = TOKEN.exec(name)
    if (!parsed || Number(parsed[1]) > 0x7fffffff) throw unsafe()
    const pid = Number(parsed[1])
    if (!exists(pid)) return false
    const marker = identity(pid)
    return parsed[2] === 'unknown' || marker === null || hash(marker) === parsed[2]
  }
  const remove = async (token: string): Promise<void> => {
    const checked = await inspect(join(directory, token), true)
    if (!checked) return
    if (!owned(checked.info)) throw unsafe()
    checked.paths.verify()
    // A token is never reused by core (fresh randomUUID at every Begin). A stale releaser can only
    // unlink its own immutable name. It cannot unlink a successor, even if held/ was replaced.
    await unlink(join(directory, token)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code!)) throw error
    })
    await syncDirectory(root)
  }
  const recover = async (): Promise<boolean> => {
    const parent = await inspect(directory, true)
    if (!parent) return true
    if (!owned(parent.info, true)) throw unsafe()
    const entries = await opendir(directory, { bufferSize: 2 }), names: string[] = []
    for await (const entry of entries) {
      if (names.length) throw unsafe()
      names.push(entry.name)
    }
    parent.paths.verify()
    if (names.length) {
      const child = await inspect(join(directory, names[0]!))
      if (!child || !owned(child.info)) throw unsafe()
      if (alive(names[0]!)) return false
      await remove(names[0]!)
    } else {
      // A crashed empty prefix has no native authority. A suspended creator must prove its directory
      // identity and sole durable token before it can mutate the clipboard, or lose this race safely.
      await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code!)) throw error
      })
    }
    return true
  }
  const release = async (corePid: number, generation: string) => {
    if (!UUID.test(generation)) return
    const parent = await inspect(root, true)
    if (!parent) return
    if (!owned(parent.info, true)) throw unsafe()
    // Release removes an existing namespace entry; only claim must publish its parent first.
    await remove(`${instance(corePid)}-${generation}`)
  }
  let preparing = false
  return {
    async claim(corePid, generation) {
      if (!UUID.test(generation)) throw new Error('PASTE_INVALID_UPLOAD')
      const token = `${instance(corePid)}-${generation}`
      // Another local claim must not recover this owner's unfinished directory as a crash prefix.
      if (preparing) return null
      preparing = true
      try {
        await initialize()
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await mkdir(directory, { mode: 0o700 }) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            if (attempt === 0 && await recover()) continue
            return null
          }
          try {
            const parent = await inspect(directory)
            if (!parent || !owned(parent.info, true)) throw unsafe()
            const path = join(directory, token)
            const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            try { parent.paths.verify(); await fd.sync(); parent.paths.verify() } finally { await fd.close() }
            await syncDirectory(directory); parent.paths.verify()
            await syncDirectory(root); parent.paths.verify()
            const child = await inspect(path)
            if (!child || !owned(child.info)) throw unsafe()
            // Final bounded synchronous fence: no asynchronous preparation follows it. Another creator
            // delayed before token creation may add its name later, but cannot pass the same sole-token test.
            const entries = opendirSync(directory, { bufferSize: 2 })
            try { if (entries.readSync()?.name !== token || entries.readSync() !== null) throw unsafe() }
            finally { entries.closeSync() }
            parent.paths.verify(); child.paths.verify()
            return { release: () => release(corePid, generation) }
          } catch (error) {
            await remove(token)
            throw error
          }
        }
        return null
      } finally { preparing = false }
    },
    release,
  }
}
