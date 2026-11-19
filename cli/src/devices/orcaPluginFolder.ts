/**
 * The folder Orca installs Harness Device's plugin from (`orca plugin install <folder>`) and copies again at each
 * `orca plugin update`: the plugin's files `cli.js` carries, written in Harness's data root by the `harness device orca`
 * command's own process. Orca must never read half a folder, after a crash or with two commands at once (the app's
 * `status` beside a person's `connect`), so a write goes whole into a folder beside it and is renamed into place.
 *
 * Each command writes into a folder named by its pid (`<folder>.new.<pid>`), never into one named for all: a command
 * that cleared a shared `<folder>.new` as a leftover, file by file, could do it while another renamed that folder into
 * place, or make it again half full for the other to rename. A staging folder is removed only once its command is gone.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pidAlive } from '../lib/processProof.js'

/** A folder's entries by name: a folder's own, or a file's bytes. */
type Tree = Map<string, Tree | Buffer>

/** A key's segment: a plain name, so no key reaches outside the folder. The build holds the plugin's names to the same
 *  pattern (scripts/lib/orcaPluginBundle.mjs). */
const SEGMENT = /^[A-Za-z0-9._-]+$/
const PID = /^[0-9]+$/

/** Makes [folder] hold exactly [files], writing only when it differs. Never throws: a failure is its error's code
 *  (`EACCES`), never its message, which names a path; a key off the pattern is `EINVAL`, as Node names a bad argument. */
export function ensureOrcaPluginFolder(folder: string, files: Readonly<Record<string, string>>): 'same' | 'written' | { failed: string } {
  try {
    const tree = treeOf(files)
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

/** [files] as folders and bytes; undefined when a key is not a relative path of plain segments, or names a file and a
 *  folder at once. */
function treeOf(files: Readonly<Record<string, string>>): Tree | undefined {
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
    folder.set(name, Buffer.from(text))
  }
  return root
}

/** What an earlier run left: the staging folders of commands that are gone, and the folder a swap moved aside, put back
 *  when nothing took its place and removed when something did. */
function recover(folder: string): void {
  const parent = dirname(folder)
  const prefix = `${basename(folder)}.new.`
  for (const name of readdirSync(parent)) {
    const pid = name.slice(prefix.length)
    if (name.startsWith(prefix) && PID.test(pid) && !pidAlive(Number(pid))) rmSync(join(parent, name), { recursive: true, force: true })
  }
  const old = `${folder}.old`
  if (!lstatSync(old, { throwIfNoEntry: false })) return
  if (lstatSync(folder, { throwIfNoEntry: false })) rmSync(old, { recursive: true, force: true })
  else renameSync(old, folder)
}

/** Whether [folder] is a real folder holding exactly [tree]. One that cannot be read differs: writing it anew mends it. */
function same(folder: string, tree: Tree): boolean {
  try {
    return lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() === true && holds(folder, tree)
  } catch {
    return false
  }
}

/** Each entry of [path] is in [tree], a folder where it has a folder and a regular file with its bytes where it has a
 *  file, and none is missing. Stops at the first difference. */
function holds(path: string, tree: Tree): boolean {
  const names = readdirSync(path)
  if (names.length !== tree.size) return false
  for (const name of names) {
    const want = tree.get(name)
    const inner = join(path, name)
    const info = lstatSync(inner)
    const kept = want instanceof Map
      ? info.isDirectory() && holds(inner, want)
      : want !== undefined && info.isFile() && info.size === want.length && readFileSync(inner).equals(want)
    if (!kept) return false
  }
  return true
}

/** [tree] whole into this command's staging folder, then the swap. A step that fails puts the moved folder back and
 *  removes the staging folder. */
function write(folder: string, tree: Tree): void {
  const staging = `${folder}.new.${process.pid}`
  const old = `${folder}.old`
  let moved = false
  try {
    put(staging, tree)
    if (lstatSync(folder, { throwIfNoEntry: false })) {
      renameSync(folder, old)
      moved = true
    }
    renameSync(staging, folder)
  } catch (error) {
    try {
      if (moved) renameSync(old, folder)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
    throw error
  }
  rmSync(old, { recursive: true, force: true })
}

/** This account's alone: folders 0700, files 0600, each file on disk before the swap. */
function put(path: string, tree: Tree): void {
  mkdirSync(path, { mode: 0o700 })
  for (const [name, want] of tree) {
    const inner = join(path, name)
    if (want instanceof Map) {
      put(inner, want)
      continue
    }
    const fd = openSync(inner, 'wx', 0o600)
    try {
      writeFileSync(fd, want)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}
