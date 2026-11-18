/** Historical receipt inspection belongs to the required storage child, never the core's loop. */
import { randomUUID } from 'node:crypto'
import { constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, type BigIntStats, type Dir } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AgentCreationReceipts, validCreationId } from '../lib/agentCreationReceipt.js'
import type { PendingCreationPage } from '../lib/pendingCreationWire.js'
import { closeStateDirectoryIterator, closeStateFileDescriptor, directorySyncSupported, secureStateDirectory,
  stateFileCustodyHealthy, StateFileCleanupUnconfirmed } from '../lib/secureState.js'
import { SessionStorageUnavailable } from '../lib/sessionStorageWire.js'

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const directoryProof = (stat: BigIntStats): string => {
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || process.platform !== 'win32' && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n)) {
    throw new SessionStorageUnavailable('unsafe')
  }
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid].join(':')
}
const identity = (file: string): string => directoryProof(lstatSync(file, { bigint: true }))

export function createPendingCreationIndex(directory: string) {
  const root = dirname(directory), markers = join(directory, '.pending-v1')
  const receipts = new AgentCreationReceipts(directory)
  const durable = new Map<string, string>()
  let scan: { token: string; parent: string; index: string | null; dirs: Array<Dir | null>; next: number } | undefined

  const flushDirectory = (path: string, expected: string) => {
    stateFileCustodyHealthy()
    if (!directorySyncSupported()) return
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      if (directoryProof(fstatSync(fd, { bigint: true })) !== expected) throw new SessionStorageUnavailable('changed')
      fsyncSync(fd)
      if (directoryProof(fstatSync(fd, { bigint: true })) !== expected) throw new SessionStorageUnavailable('changed')
    } finally { closeStateFileDescriptor(fd) }
  }
  const markerProof = (stat: BigIntStats): string => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0n || stat.nlink !== 1n
      || process.platform !== 'win32' && (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n)) {
      throw new SessionStorageUnavailable('unsafe')
    }
    return [stat.dev, stat.ino, stat.ctimeNs, stat.birthtimeNs, stat.mode, stat.uid, stat.gid].join(':')
  }
  const markerIdentity = (id: string): string => markerProof(lstatSync(join(markers, id), { bigint: true }))
  const ensure = (id: string): void => {
    stateFileCustodyHealthy()
    if (!validCreationId(id)) throw new SessionStorageUnavailable('invalid')
    // The configured data root may itself be an alias; directories below that root may not be.
    const resolvedRoot = realpathSync.native(root)
    secureStateDirectory(resolvedRoot, false)
    const rootProof = identity(resolvedRoot)
    secureStateDirectory(directory)
    const parent = identity(directory)
    secureStateDirectory(markers)
    const index = identity(markers)
    const verify = () => {
      if (realpathSync.native(root) !== resolvedRoot || identity(resolvedRoot) !== rootProof
        || identity(directory) !== parent || identity(markers) !== index) {
        throw new SessionStorageUnavailable('changed')
      }
    }
    try {
      if (durable.get(id) === `${parent}/${index}/${markerIdentity(id)}`) { verify(); return }
    } catch (error) { if (!missing(error)) throw error }
    let fd: number
    try { fd = openSync(join(markers, id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      fd = openSync(join(markers, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    }
    let marker: string
    try {
      marker = markerProof(fstatSync(fd, { bigint: true }))
      fsyncSync(fd)
      if (markerProof(fstatSync(fd, { bigint: true })) !== marker) throw new SessionStorageUnavailable('changed')
    } finally { closeStateFileDescriptor(fd) }
    flushDirectory(markers, index); flushDirectory(directory, parent); flushDirectory(resolvedRoot, rootProof)
    verify()
    if (markerIdentity(id) !== marker) throw new SessionStorageUnavailable('changed')
    if (durable.size >= 128) durable.delete(durable.keys().next().value!)
    durable.set(id, `${parent}/${index}/${marker}`)
  }
  const closeOwn = (own: NonNullable<typeof scan>): void => {
    let failed: unknown
    for (let n = 0; n < own.dirs.length; n++) {
      const dir = own.dirs[n]
      if (dir) {
        try { closeStateDirectoryIterator(dir); own.dirs[n] = null }
        catch (error) { failed ??= error }
      }
    }
    if (failed) throw failed
    if (scan === own) scan = undefined
  }
  const close = async (token: string): Promise<void> => {
    stateFileCustodyHealthy()
    if (scan?.token === token) closeOwn(scan)
  }
  const open = async (): Promise<void> => {
    if (scan) await close(scan.token)
    let parent: string
    try { secureStateDirectory(directory, false); parent = identity(directory) }
    catch (error) { if (missing(error)) return; throw error }
    const own: NonNullable<typeof scan> = { token: randomUUID(), parent, index: null, dirs: [null, null], next: 0 }
    scan = own
    try {
      try { own.index = identity(markers); own.dirs[0] = await opendir(markers) }
      catch (error) { if (!missing(error)) throw error }
      own.dirs[1] = await opendir(directory)
      if (identity(directory) !== parent || own.index !== null && identity(markers) !== own.index) throw new SessionStorageUnavailable('changed')
    } catch (error) { closeOwn(own); throw error }
  }
  const page = async (cursor: string | null, deadline: number): Promise<PendingCreationPage> => {
    stateFileCustodyHealthy()
    if (cursor !== null && (typeof cursor !== 'string' || !/^[a-f0-9-]{36}$/.test(cursor))) throw new SessionStorageUnavailable('invalid')
    if (cursor === null) await open()
    else if (scan?.token !== cursor) throw new SessionStorageUnavailable('changed')
    if (!scan) return { cursor: '', ids: [], done: true, damaged: 0 }
    const own = scan, ids: string[] = []
    let damaged = 0
    const started = performance.now()
    const verify = () => {
      if (performance.now() >= deadline) throw new SessionStorageUnavailable('expired')
      if (identity(directory) !== own.parent || own.index !== null && identity(markers) !== own.index) throw new SessionStorageUnavailable('changed')
    }
    try {
      for (let n = 0; n < 64 && performance.now() - started < 20; n++) {
        verify()
        let which = own.next++ % 2
        if (!own.dirs[which]) which = 1 - which
        const dir = own.dirs[which]
        if (!dir) break
        const entry = await dir.read()
        verify()
        if (!entry) { closeStateDirectoryIterator(dir); own.dirs[which] = null; continue }
        const id = which === 0 ? entry.name : entry.name.endsWith('.json') ? entry.name.slice(0, -5) : ''
        if (!entry.isFile() || !validCreationId(id)) continue
        try {
          const marker = which === 0 ? markerIdentity(id) : null
          const status = receipts.status(id)
          if (status.state === 'pending') { ensure(id); ids.push(id) }
          else if (which === 0 && status.state !== 'missing') {
            // Even unconfirmed dispatch claims forbid redispatch. Missing or damaged primary evidence does not.
            verify()
            if (markerIdentity(id) !== marker) throw new SessionStorageUnavailable('changed')
            unlinkSync(join(markers, id)); durable.delete(id)
          }
        } catch (error) {
          if (error instanceof StateFileCleanupUnconfirmed) throw error
          stateFileCustodyHealthy()
          verify()
          damaged++
        }
      }
      verify()
      const done = own.dirs.every(dir => dir === null)
      if (done) scan = undefined
      return { cursor: own.token, ids, done, damaged }
    } catch (error) { closeOwn(own); throw error }
  }
  return { ensure, page, close }
}
