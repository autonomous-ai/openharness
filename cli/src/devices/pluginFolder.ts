/**
 * A plugin's folder in Harness's data root, holding the files `cli.js` carries. Two use it: the folder Orca installs
 * Harness Device's plugin from (`orca plugin install <folder>`) and copies again at each `orca plugin update`
 * (orcaPlugin.ts), and Claude Code's marketplace, which Claude Code installs and updates its two plugins from
 * (claudePlugin.ts). Each is written by the `harness device` command's process and by the devices' process
 * (cable/orcaPluginSetup.ts, cable/dialPluginSetup.ts). An app must never read half a folder, after a crash or with two
 * writers at once (the devices' pass beside a person's `enable`), so a write goes whole into a folder beside it and is
 * renamed into place.
 *
 * Each process writes into its own staging folder and moves the folder it replaces aside into its own, both named by
 * its pid (`<folder>.new.<pid>`, `<folder>.old.<pid>`), never into ones named for all: a process that cleared a shared
 * `<folder>.new` as a leftover, file by file, could do it while another renamed that folder into place, or make it
 * again half full for the other to rename; one that put a shared `<folder>.old` back as a leftover could do it while
 * another swapped, and the other's rename then failed. What a process left is put back or removed only once it is gone,
 * or by itself at its next write: a write runs whole in one synchronous call, so none of its own is under way then, and
 * the devices' process, which lives on, would otherwise find its own leftover in the way of every later write.
 */
import { chmodSync, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, type Stats, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pidAlive } from '../lib/processProof.js'
import { removePath, removeQuietly } from '../lib/removePath.js'

/** A folder's entries by name: a folder's own, or a file's bytes and the mode it is written with. */
type Tree = Map<string, Tree | { bytes: Buffer; mode: number }>

/** This account's alone. A file Claude Code runs by its path (the device plugin's `hooks/asked`) needs its owner's
 *  execute bit as well. */
const FOLDER = 0o700
const FILE = 0o600
const EXECUTABLE = 0o700
/** Windows has no mode bits: Node makes a file's up from its read-only flag, so comparing them would write the folder
 *  anew at every run. Off Windows they are set and compared, so no umask makes a folder differ at every run. */
const MODES = process.platform !== 'win32'
/** Whether [info]'s mode is [mode], off Windows. */
const hasMode = (info: Stats, mode: number): boolean => !MODES || (info.mode & 0o777) === mode

/** A key's segment: a plain name, so no key reaches outside the folder. The build holds the plugin's names to the same
 *  pattern (scripts/lib/orcaPluginBundle.mjs, claudePluginBundle.mjs). */
const SEGMENT = /^[A-Za-z0-9._-]+$/
/** What a process leaves beside the folder, after `<folder>.`: its staging folder, or the folder its swap moved aside,
 *  by its pid. */
const LEFT = /^(new|old)\.([0-9]+)$/

/** Makes [folder] hold exactly [files], [executable] (keys of files) 0700, other files 0600, folders 0700; writes only
 *  when bytes or, off Windows, modes differ. Never throws: a failure is its error's code (`EACCES`), never its message,
 *  which names a path; a key off the pattern, or an executable that names no file, is `EINVAL`, as Node names a bad
 *  argument. */
export function ensurePluginFolder(folder: string, files: Readonly<Record<string, string>>, executable: readonly string[]): 'same' | 'written' | { failed: string } {
  try {
    const tree = treeOf(files, executable)
    if (!tree) return { failed: 'EINVAL' }
    // Harness's data root, which a CLI run with its own data folder (ADAPTER_DATA_DIR) may not have made yet.
    mkdirSync(dirname(folder), { recursive: true, mode: 0o700 })
    recover(folder)
    if (same(folder, tree)) return 'same'
    write(folder, tree)
    return 'written'
  } catch (error) {
    return { failed: (error as NodeJS.ErrnoException).code ?? 'FAILED' }
  }
}

/** [files] as folders, and bytes with their modes; undefined when a key is not a relative path of plain segments, or
 *  names a file and a folder at once, or an executable is not a key. */
function treeOf(files: Readonly<Record<string, string>>, executable: readonly string[]): Tree | undefined {
  if (!executable.every((key) => Object.hasOwn(files, key))) return undefined
  const root: Tree = new Map()
  for (const [key, text] of Object.entries(files)) {
    const segments = key.split('/')
    if (!segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')) return undefined
    let folder = root
    for (const segment of segments.slice(0, -1)) {
      const inner = folder.get(segment) ?? new Map()
      if (!(inner instanceof Map)) return undefined
      folder.set(segment, inner)
      folder = inner
    }
    const name = segments[segments.length - 1]
    if (folder.has(name)) return undefined
    folder.set(name, { bytes: Buffer.from(text), mode: executable.includes(key) ? EXECUTABLE : FILE })
  }
  return root
}

/** What processes that are gone, or this one, left: their staging folders, removed, and the folders their swaps moved
 *  aside. */
function recover(folder: string): void {
  const parent = dirname(folder)
  const prefix = `${basename(folder)}.`
  for (const name of readdirSync(parent)) {
    const left = name.startsWith(prefix) ? LEFT.exec(name.slice(prefix.length)) : null
    const pid = Number(left?.[2])
    if (left === null || (pid !== process.pid && pidAlive(pid))) continue
    if (left[1] === 'new') rmSync(join(parent, name), { recursive: true, force: true })
    else settle(join(parent, name), folder, removePath)
  }
}

/** A folder a swap moved aside to [old]: put back when nothing took its place, removed by [remove] when something did. */
function settle(old: string, folder: string, remove: (path: string) => void): void {
  if (lstatSync(folder, { throwIfNoEntry: false })) remove(old)
  else renameSync(old, folder)
}

/** Whether [folder] is a real folder holding exactly [tree]. One that cannot be read differs: writing it anew mends it. */
function same(folder: string, tree: Tree): boolean {
  try {
    const info = lstatSync(folder, { throwIfNoEntry: false })
    return info?.isDirectory() === true && hasMode(info, FOLDER) && holds(folder, tree)
  } catch {
    return false
  }
}

/** Each entry of [path] is in [tree], a folder where it has a folder and a regular file with its bytes where it has a
 *  file, each with its mode, and none is missing. Stops at the first difference. */
function holds(path: string, tree: Tree): boolean {
  const names = readdirSync(path)
  if (names.length !== tree.size) return false
  for (const name of names) {
    const want = tree.get(name)
    const inner = join(path, name)
    const info = lstatSync(inner)
    const kept = want instanceof Map
      ? info.isDirectory() && hasMode(info, FOLDER) && holds(inner, want)
      : want !== undefined && info.isFile() && hasMode(info, want.mode) && info.size === want.bytes.length && readFileSync(inner).equals(want.bytes)
    if (!kept) return false
  }
  return true
}

/** [tree] whole into this process's staging folder, then the swap. A step that fails removes the staging folder and
 *  puts the moved folder back, or removes it when another process put a folder in its place meanwhile. A last rename
 *  that lost to another process writing the same files is no failure: the folder holds them. A removal of this call's
 *  own folders that fails (a file an app still holds on Windows) leaves them for its next write, never replacing the
 *  answer. */
function write(folder: string, tree: Tree): void {
  const staging = `${folder}.new.${process.pid}`
  const old = `${folder}.old.${process.pid}`
  let moved = false
  let staged = false
  try {
    put(staging, tree)
    if (lstatSync(folder, { throwIfNoEntry: false })) {
      renameSync(folder, old)
      moved = true
    }
    staged = true
    renameSync(staging, folder)
  } catch (error) {
    try {
      if (moved) settle(old, folder, removeQuietly)
    } finally {
      removeQuietly(staging)
    }
    if (staged && same(folder, tree)) return
    throw error
  }
  removeQuietly(old)
}

/** Folders and files with their modes, each file on disk before the swap. A mode is set after the umask narrowed it,
 *  so one that strips the owner's bits still gives the folder the modes it is compared with. */
function put(path: string, tree: Tree): void {
  mkdirSync(path, { mode: FOLDER })
  if (MODES) chmodSync(path, FOLDER)
  for (const [name, want] of tree) {
    const inner = join(path, name)
    if (want instanceof Map) {
      put(inner, want)
      continue
    }
    const fd = openSync(inner, 'wx', want.mode)
    try {
      if (MODES) fchmodSync(fd, want.mode)
      writeFileSync(fd, want.bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}
