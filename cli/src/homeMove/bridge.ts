/**
 * The bridge (docs/plans/2026-11-18-linux-xdg-paths-design.md, The bridge): after the move ~/.harness holds a link per moved
 * entry, so an old session's paths land in their new place. What a link cannot give an old reader is put here: the entries
 * it refuses as a link are real folders, and a socket it looks for where the socket no longer is gets a hard link there.
 * It imports nothing that resolves a path: its caller hands it what to serve, and the route record's writer.
 */
import { createHash } from 'node:crypto'
import { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const BRIDGE_FILE = 'bridge.json'
/** The entries the bridge keeps as real folders, because an old reader refuses a link there. */
export const REAL_ENTRIES = ['hook-routes', 'connections'] as const

/** A boot of this computer (/proc/sys/kernel/random/boot_id) and how long it had run, in seconds (/proc/uptime). */
export interface Boot { id: string; uptime: number }

/** `boot`: the boot the move ran in, when it was written; none where /proc has none, as no move is. */
export interface BridgeRecord { version: 1; movedAt: number; oldHome: string; oldDataDir: string; oldTag: string; newTag: string; panes: string[]; boot?: Boot }

/**
 * What the bridge serves, from the daemon's own paths. `routes`: its data folder and port. `sockets`: each socket an old
 * client looks for, by the folder it names (`oldFolder`), with the folder the socket is in now. `files`: what the real
 * `connections` holds for an old agent's MCP shim, by its name there.
 */
export interface Served { routes: { dataDir: string; port: number }; sockets: { oldFolder: string; folder: string; name: string }[]; files: { from: string; name: string }[] }

/** sockaddr_un's room, as lib/localSocket.ts MAX_SOCKET_PATH_BYTES counts it. */
const MAX_SOCKET_PATH_BYTES = 96

export function readBridge(stateRoot: string): BridgeRecord | null {
  let text: string
  try {
    text = readFileSync(join(stateRoot, BRIDGE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(text) as BridgeRecord
}

const readText = (path: string): string => readFileSync(path, 'utf8')

/**
 * Whole or not at all, and owner only: it names the old home. With the boot it is written in, read from /proc through
 * [read]: the old users are counted on that boot's clock.
 */
export function writeBridge(stateRoot: string, record: Omit<BridgeRecord, 'boot'>, read: (path: string) => string = readText): void {
  const boot = bootNow(read)
  const file = join(stateRoot, BRIDGE_FILE), temporary = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(boot ? { ...record, boot } : record)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * This boot, and how long it has run: the clock /proc's start times count on, which no step of the wall clock moves.
 * Null where /proc has neither file, off Linux, where nothing moves.
 */
export function bootNow(read: (path: string) => string = readText): Boot | null {
  let id: string, uptime: number
  try {
    id = read('/proc/sys/kernel/random/boot_id').trim()
    uptime = Number.parseFloat(read('/proc/uptime'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!id || !Number.isFinite(uptime)) throw new Error('/proc gives no boot id or uptime')
  return { id, uptime }
}

/** The move's time in seconds since the epoch, as /proc reckons it: btime of /proc/stat plus /proc/uptime. */
export function procNow(read: (path: string) => string = readText): number {
  const now = Number(/^btime (\d+)$/m.exec(read('/proc/stat'))?.[1]) + Number.parseFloat(read('/proc/uptime'))
  if (!Number.isFinite(now)) throw new Error('/proc gives no boot time or uptime')
  return now
}

export function makeRealFolders(legacy: string): void {
  for (const name of REAL_ENTRIES) {
    const path = join(legacy, name)
    if (lstatOrNull(path)?.isSymbolicLink()) unlinkSync(path)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
  }
}

/** Put in the bridge what a link cannot give; returns what it could not link. */
export function serveOldPaths(bridge: BridgeRecord, served: Served, publish: (dataDir: string, port: number, folder: string) => void): string[] {
  const { oldHome } = bridge
  publish(served.routes.dataDir, served.routes.port, join(oldHome, 'hook-routes'))
  const unlinked: string[] = []
  const serve = (source: string, place: string | null, name: string): void => {
    if (place === null || !hardLink(source, place)) unlinked.push(name)
  }
  for (const { oldFolder, folder, name } of served.sockets) {
    const looked = oldSocketPath(oldHome, oldFolder, name)
    // An old client with no socket path in reach takes TCP: nothing to serve it here.
    if (looked) serve(join(folder, name), throughBridge(oldHome, looked), name)
  }
  for (const { from, name } of served.files) serve(from, throughBridge(oldHome, join(oldHome, 'connections', name)), name)
  return unlinked
}

/** Links, the real folders, the socket links, then ~/.harness. 'left' when something else is in it. */
export function removeBridge(bridge: BridgeRecord, stateRoot: string): 'removed' | 'left' {
  const { oldHome } = bridge
  // Found first: the links say where the old folders went.
  const socketLinks = [bridge.oldDataDir, join(oldHome, 'connections')]
    .filter((folder) => folder.startsWith(`${oldHome}/`))
    .flatMap((folder) => socketLinksOf(oldHome, folder, stateRoot))
  let left = false
  for (const name of list(oldHome)) {
    const part = bridgePart(oldHome, name)
    if (part === 'link') unlinkSync(join(oldHome, name))
    else if (part === 'folder') rmSync(join(oldHome, name), { recursive: true })
    else left = true
  }
  for (const path of socketLinks) rmSync(path, { recursive: true, force: true })
  if (left) return 'left'
  try {
    rmdirSync(oldHome)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return 'removed'
}

export function isBridge(legacy: string): boolean {
  const names = list(legacy)
  return names.length > 0 && names.every((name) => bridgePart(legacy, name) !== null)
}

/** What the bridge put at [name] in the old home: a link, one of its real folders, or nothing of its own (null). */
function bridgePart(oldHome: string, name: string): 'link' | 'folder' | null {
  const entry = lstatSync(join(oldHome, name))
  if (entry.isSymbolicLink()) return 'link'
  return (REAL_ENTRIES as readonly string[]).includes(name) && entry.isDirectory() ? 'folder' : null
}

/**
 * Where [path] really is: under the old home, through its entry's link, read and not resolved so it is spelled as the move
 * wrote it, or in a real folder of the bridge. Null when the bridge holds no such entry, as nothing else is made in it.
 */
function throughBridge(oldHome: string, path: string): string | null {
  if (!path.startsWith(`${oldHome}/`)) return path
  const [entry, ...rest] = path.slice(oldHome.length + 1).split('/')
  try {
    const part = bridgePart(oldHome, entry)
    if (part === 'link') return join(resolve(oldHome, readlinkSync(join(oldHome, entry))), ...rest)
    return part === 'folder' ? path : null
  } catch {
    return null
  }
}

/** Where an old client looks for socket [name] of [oldFolder] (lib/localSocket.ts socketPathIn, its short folders in the old home); null where it takes TCP. */
function oldSocketPath(oldHome: string, oldFolder: string, name: string): string | null {
  const beside = join(oldFolder, name)
  if (Buffer.byteLength(beside) <= MAX_SOCKET_PATH_BYTES) return beside
  const short = join(oldHome, 's', shortFolderName(oldFolder), name)
  return Buffer.byteLength(short) <= MAX_SOCKET_PATH_BYTES ? short : null
}

const shortFolderName = (folder: string): string => createHash('sha256').update(folder).digest('hex').slice(0, 16)

/** [place] made a hard link to [source], unless it is one already; false when it cannot be. A source not there yet is served at the next call. */
function hardLink(source: string, place: string): boolean {
  const wanted = lstatOrNull(source)
  if (!wanted) return true
  const there = lstatOrNull(place)
  if (there && there.dev === wanted.dev && there.ino === wanted.ino) return true
  const temporary = `${place}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(place), { recursive: true, mode: 0o700 })
    linkSync(source, temporary)
    // In one step: an old client finds the old socket or the new one, never none.
    renameSync(temporary, place)
    return true
  } catch {
    rmSync(temporary, { force: true })
    return false
  }
}

/**
 * The hard links serveOldPaths can have made for [oldFolder]'s sockets. Its short folder in the state root, named for a path
 * only old clients use. And beside the folder's new place, a socket at a path too long for a daemon to bind, where an old
 * client's shorter path still reached it. In a real folder of the bridge they go with that folder.
 */
function socketLinksOf(oldHome: string, oldFolder: string, stateRoot: string): string[] {
  const short = join(stateRoot, 's', shortFolderName(oldFolder))
  const folder = throughBridge(oldHome, oldFolder)
  if (folder === null || folder === oldFolder) return [short]
  const beside = list(folder).filter((name) => Buffer.byteLength(join(oldFolder, name)) <= MAX_SOCKET_PATH_BYTES
    && Buffer.byteLength(join(folder, name)) > MAX_SOCKET_PATH_BYTES && lstatOrNull(join(folder, name))?.isSocket())
  return [short, ...beside.map((name) => join(folder, name))]
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path) } catch { return null }
}

function list(folder: string): string[] {
  try { return readdirSync(folder) } catch { return [] }
}
