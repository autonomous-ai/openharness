import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HarnessRootKind } from '../config/harnessHome.js'
import { OWN_FILES, type MoveEntry, type MovePlan } from './plan.js'

export interface StageIo extends Pick<typeof import('node:fs'),
  'renameSync' | 'symlinkSync' | 'mkdirSync' | 'rmSync' | 'unlinkSync' | 'lstatSync' | 'readdirSync' | 'cpSync' | 'chmodSync' | 'utimesSync'
  | 'openSync' | 'fsyncSync' | 'closeSync'> {}

/** Where an entry copied across filesystems keeps its original, in ~/.harness, until the finish drops it. */
const keptOf = (entry: MoveEntry): string => join(dirname(entry.from), OWN_FILES.kept, entry.name)
const stagingOf = (plan: MovePlan, root: HarnessRootKind): string => `${plan[root]}.moving`

// A copy keeps modes, a file's times and each link's own text.
const COPY = { recursive: true, preserveTimestamps: true, verbatimSymlinks: true } as const
// A file's times come from the kernel's coarse clock, up to a tick behind the one the move's start was read from: the
// margin copies again what changed just before the move began, and never misses what changed during the copy.
const CLOCK_MARGIN_MS = 1_000

const lstatOf = (path: string, io: StageIo): Stats | undefined => io.lstatSync(path, { throwIfNoEntry: false })
const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException).code

/** Removes whatever is at [path], a link and never what it points to; nothing there, nothing done. */
function remove(path: string, io: StageIo): void {
  const st = lstatOf(path, io)
  if (st?.isDirectory()) io.rmSync(path, { recursive: true, force: true })
  // rmSync leaves a link whose target is gone (Node 23 and 24), as every link is before the commit.
  else if (st) io.unlinkSync(path)
}

/**
 * Stage one entry and leave its link; returns the bytes copied (0 on one filesystem). A failure partway puts the
 * entry back at its old path before it is thrown, so a stage is whole or not done. One not there gets its link alone.
 */
export function stageEntry(entry: MoveEntry, plan: MovePlan, io: StageIo, startedAt: number): { copied: boolean; bytes: number } {
  // Owner-only, as the root it becomes.
  io.mkdirSync(stagingOf(plan, entry.kind), { recursive: true, mode: 0o700 })
  if (!entry.present) {
    undoing(entry, false, io, () => mergeRecreated(entry, io))
    return { copied: false, bytes: 0 }
  }
  try {
    io.renameSync(entry.from, entry.staged)
  } catch (error) {
    if (codeOf(error) !== 'EXDEV') throw error
    return { copied: true, bytes: undoing(entry, true, io, () => copyAcross(entry, io, startedAt)) }
  }
  undoing(entry, false, io, () => mergeRecreated(entry, io))
  return { copied: false, bytes: 0 }
}

function undoing<T>(entry: MoveEntry, copied: boolean, io: StageIo, run: () => T): T {
  try {
    return run()
  } catch (error) {
    unstageEntry(entry, copied, io)
    throw error
  }
}

/** The copy, its swap for the link, then a second pass over what changed meanwhile; returns the bytes of the entry. */
function copyAcross(entry: MoveEntry, io: StageIo, startedAt: number): number {
  io.cpSync(entry.from, entry.staged, COPY)
  const kept = keptOf(entry)
  io.mkdirSync(dirname(kept), { recursive: true, mode: 0o700 })
  io.renameSync(entry.from, kept)
  mergeRecreated(entry, io)
  // Nothing writes to the original once its link is in: what it holds now is final.
  return copyChanged(kept, entry.staged, startedAt - CLOCK_MARGIN_MS, io)
}

/**
 * Copies from [src] into [dest] each file or link changed since [since] that [dest] does not hold newer, and each one
 * [dest] lacks; a folder takes [src]'s mode and times, which a copy does not keep (an owner-only one stays so). Returns
 * the bytes of [src]'s files.
 */
function copyChanged(src: string, dest: string, since: number, io: StageIo): number {
  const st = io.lstatSync(src), there = lstatOf(dest, io)
  if (!st.isDirectory()) {
    if (!there || (st.ctimeMs >= since && st.mtimeMs >= there.mtimeMs)) replace(src, dest, io)
    return st.isFile() ? st.size : 0
  }
  if (!there?.isDirectory()) replace(src, dest, io)
  const bytes = io.readdirSync(src).reduce((sum, name) => sum + copyChanged(join(src, name), join(dest, name), since, io), 0)
  // Last, so a folder without write permission is filled first.
  io.chmodSync(dest, st.mode & 0o7777)
  io.utimesSync(dest, st.atimeMs / 1000, st.mtimeMs / 1000)
  return bytes
}

function replace(src: string, dest: string, io: StageIo): void {
  remove(dest, io)
  io.cpSync(src, dest, COPY)
}

/**
 * Merges what was made at an entry's old path once the entry left it (a hook that wrote its event offline) into the
 * staged entry, and links over it. Returns how many paths it merged; with the link in place, 0.
 */
export function mergeRecreated(entry: MoveEntry, io: StageIo): number {
  const there = lstatOf(entry.from, io)
  if (there?.isSymbolicLink()) return 0
  const merged = there ? mergeInto(entry.from, entry.staged, io) : 0
  io.symlinkSync(entry.to, entry.from)
  return merged
}

/** Puts [src] into [dest], the newer of a file both hold winning, and removes [src]. Returns how many paths it put in. */
function mergeInto(src: string, dest: string, io: StageIo): number {
  const st = io.lstatSync(src), there = lstatOf(dest, io)
  if (st.isDirectory() && there?.isDirectory()) {
    const merged = io.readdirSync(src).reduce((sum, name) => sum + mergeInto(join(src, name), join(dest, name), io), 0)
    remove(src, io)
    return merged
  }
  if (there && there.mtimeMs >= st.mtimeMs) {
    remove(src, io)
    return 0
  }
  remove(dest, io)
  try {
    io.renameSync(src, dest)
  } catch (error) {
    if (codeOf(error) !== 'EXDEV') throw error
    io.cpSync(src, dest, COPY)
    remove(src, io)
  }
  return 1
}

/** Puts an entry back at its old path as it was, from whatever its staging reached; one already back is left. */
export function unstageEntry(entry: MoveEntry, copied: boolean, io: StageIo): void {
  if (!entry.present) {
    // Never there: its link goes, and what a late writer made there since, merged into its staged place, comes back.
    if (lstatOf(entry.from, io)?.isSymbolicLink()) io.unlinkSync(entry.from)
    if (lstatOf(entry.staged, io)) mergeInto(entry.staged, entry.from, io)
    return
  }
  const original = copied ? keptOf(entry) : entry.staged
  if (lstatOf(original, io)) {
    const there = lstatOf(entry.from, io)
    if (there?.isSymbolicLink()) io.unlinkSync(entry.from)
    // Made again before its link went in: what was written there stays.
    else if (there) mergeInto(entry.from, original, io)
    io.renameSync(original, entry.from)
  }
  if (!copied) return
  remove(entry.staged, io)
  const folder = dirname(keptOf(entry))
  if (lstatOf(folder, io) && io.readdirSync(folder).length === 0) io.rmSync(folder, { recursive: true })
}

/** Renames a root's staging folder into place: the data root's rename is the commit. One in place already is left. */
export function commitRoot(plan: MovePlan, root: HarnessRootKind, io: StageIo): void {
  if (lstatOf(stagingOf(plan, root), io)) io.renameSync(stagingOf(plan, root), plan[root])
}

/** Puts a committed root back in its staging folder. One there already is left. */
export function uncommitRoot(plan: MovePlan, root: HarnessRootKind, io: StageIo): void {
  if (lstatOf(plan[root], io)) io.renameSync(plan[root], stagingOf(plan, root))
}

/**
 * Before the finish drops anything: each of [written], every file and folder under it, then ~/.harness, each root and
 * the folder it was renamed in, flushed to the device. A copy's writes and a rename may still sit in memory, and the
 * originals and the journal are what a power cut would leave to put them back.
 */
export function syncMoved(plan: MovePlan, written: readonly string[], io: StageIo): void {
  for (const path of written) syncTree(path, io)
  for (const folder of [plan.legacy, plan.state, dirname(plan.state), plan.data, dirname(plan.data)]) syncPath(folder, io)
}

function syncTree(path: string, io: StageIo): void {
  const st = lstatOf(path, io)
  if (st?.isDirectory()) for (const name of io.readdirSync(path)) syncTree(join(path, name), io)
  // A link holds no bytes of its own, and nothing else is copied.
  if (st?.isDirectory() || st?.isFile()) syncPath(path, io)
}

function syncPath(path: string, io: StageIo): void {
  const file = io.openSync(path, 'r')
  try {
    io.fsyncSync(file)
  } finally {
    io.closeSync(file)
  }
}

/** The finish: the originals of entries copied across filesystems go. */
export function dropOriginals(plan: MovePlan, io: StageIo): void {
  io.rmSync(join(plan.legacy, OWN_FILES.kept), { recursive: true, force: true })
}
