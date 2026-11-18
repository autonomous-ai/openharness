import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { draftOf, OWN_FILES, type MovePlan } from './plan.js'

/**
 * A step the move did, so a rollback can undo it and the next start finish it. `before` is a file's previous bytes in
 * base64, null when there was no file (on disk they are in a file of their own beside the journal); `aside` is a name
 * the move renamed out of the way (`path` → `aside`) to put a new one in its place.
 */
export type Done =
  | { did: 'stage'; entry: string; copied: boolean } | { did: 'file'; path: string; before: string | null }
  | { did: 'aside'; path: string; aside: string }
  | { did: 'link'; path: string; before: string } | { did: 'reload' } | { did: 'pane'; id: string }
  | { did: 'commit'; root: 'state' | 'data' } | { did: 'bridge' }

export interface Journal { version: 1; startedAt: number; plan: MovePlan; oldTag: string; newTag: string; done: Done[] }

export interface JournalIo extends Pick<typeof import('node:fs'), 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'rmSync'> {}
/** What the journal is written with: a file's writer, and the folder a file's previous bytes go in. */
export interface OpenIo extends JournalIo, Pick<typeof import('node:fs'), 'mkdirSync'> {}

/** A step as its line spells it: a file's previous bytes are in the file `kept` names beside the journal, null when there was no file. */
type Line = Exclude<Done, { did: 'file' }> | { did: 'file'; path: string; kept: number | null }

const NODE_FS: OpenIo = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, mkdirSync }

const journalPath = (legacy: string): string => join(legacy, OWN_FILES.journal)
const beforeFolder = (legacy: string): string => join(legacy, OWN_FILES.before)

/**
 * The journal: its head written whole, then a line per step added at its end, each on disk, with a file's previous
 * bytes in a file of their own, before the step acts. An add writes its step alone, however many came before. A
 * journal read back, with steps, is added to where it ends.
 */
export function openJournal(journal: Journal, io: OpenIo = NODE_FS): { add(done: Done): void } {
  const { legacy } = journal.plan
  const path = journalPath(legacy), before = beforeFolder(legacy)
  let steps = journal.done.length
  if (steps === 0) {
    // Made before the head: the head's rename, synced in ~/.harness, keeps it.
    io.mkdirSync(before, { recursive: true, mode: 0o700 })
    const { version, startedAt, plan, oldTag, newTag } = journal
    writeWhole(path, JSON.stringify({ version, startedAt, plan, oldTag, newTag }), io)
  }
  return {
    add: (done) => {
      if (done.did === 'file' && done.before !== null) {
        writeSynced(join(before, String(steps)), Buffer.from(done.before, 'base64'), io)
        syncFolder(before, io)
      }
      const line: Line = done.did === 'file' ? { did: 'file', path: done.path, kept: done.before === null ? null : steps } : done
      // A line starts with its own break: one a crash cut short stays apart from the next, and is skipped when read.
      // A pane's tag lives in the tmux server, which a power cut ends with it: its line is flushed with the next.
      appendLine(path, `\n${JSON.stringify(line)}`, done.did !== 'pane', io)
      steps += 1
    },
  }
}

/** The journal on disk, null when there is none: its head, and each step whose line is whole, a line cut short skipped. */
export function readJournal(legacy: string): Journal | null {
  try {
    const [first, ...lines] = readFileSync(journalPath(legacy), 'utf8').split('\n')
    const head = JSON.parse(first) as Omit<Journal, 'done'>
    if (head.version !== 1) return null
    const done = lines.flatMap((text) => {
      const line = parsed(text)
      return line ? [stepOf(line, legacy)] : []
    })
    return { ...head, done }
  } catch {
    return null
  }
}

/** The journal goes last, its previous bytes and its draft (a crash mid-write) just before: any would keep ~/.harness from reading as the bridge. */
export function forgetJournal(legacy: string, io: JournalIo = NODE_FS): void {
  io.rmSync(beforeFolder(legacy), { recursive: true, force: true })
  io.rmSync(draftOf(journalPath(legacy)), { force: true })
  io.rmSync(journalPath(legacy), { force: true })
}

/**
 * Writes [text] to [path] owner-only and whole: to its draft, synced, then renamed into place, the rename synced in its
 * folder. A crash leaves the file as it was before, or as it is after.
 */
export function writeWhole(path: string, text: string, io: JournalIo = NODE_FS): void {
  const draft = draftOf(path)
  try {
    writeSynced(draft, text, io)
    io.renameSync(draft, path)
  } catch (error) {
    io.rmSync(draft, { force: true })
    throw error
  }
  syncFolder(dirname(path), io)
}

function parsed(text: string): Line | null {
  try {
    return JSON.parse(text) as Line
  } catch {
    return null
  }
}

function stepOf(line: Line, legacy: string): Done {
  if (line.did !== 'file') return line
  const before = line.kept === null ? null : readFileSync(join(beforeFolder(legacy), String(line.kept))).toString('base64')
  return { did: 'file', path: line.path, before }
}

function writeSynced(path: string, data: string | Buffer, io: JournalIo): void {
  const file = io.openSync(path, 'w', 0o600)
  try {
    io.writeFileSync(file, data)
    io.fsyncSync(file)
  } finally {
    io.closeSync(file)
  }
}

function appendLine(path: string, line: string, flush: boolean, io: JournalIo): void {
  const file = io.openSync(path, 'a', 0o600)
  try {
    io.writeFileSync(file, line)
    if (flush) io.fsyncSync(file)
  } finally {
    io.closeSync(file)
  }
}

function syncFolder(folder: string, io: JournalIo): void {
  const file = io.openSync(folder, 'r')
  try {
    io.fsyncSync(file)
  } finally {
    io.closeSync(file)
  }
}
