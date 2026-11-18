import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { draftOf, OWN_FILES, type MovePlan } from './plan.js'

/**
 * A step the move did, so a rollback can undo it and the next start finish it. `before` is a file's previous bytes in
 * base64, null when there was no file; `aside` is a name the move renamed out of the way (`path` → `aside`) to put a
 * new one in its place.
 */
export type Done =
  | { did: 'stage'; entry: string; copied: boolean } | { did: 'file'; path: string; before: string | null }
  | { did: 'aside'; path: string; aside: string }
  | { did: 'link'; path: string; before: string } | { did: 'reload' } | { did: 'pane'; id: string }
  | { did: 'commit'; root: 'state' | 'data' } | { did: 'bridge' }

export interface Journal { version: 1; startedAt: number; plan: MovePlan; oldTag: string; newTag: string; done: Done[] }

export interface JournalIo extends Pick<typeof import('node:fs'), 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'rmSync'> {}

const NODE_FS: JournalIo = { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync }

const journalPath = (legacy: string): string => join(legacy, OWN_FILES.journal)

/** Writes [journal] now, and again whole at each step added: a step is on disk before the next one begins. */
export function openJournal(journal: Journal, io: JournalIo = NODE_FS): { add(done: Done): void; close(): void } {
  const path = journalPath(journal.plan.legacy)
  let done = journal.done
  const write = (next: Done[]): void => {
    writeWhole(path, JSON.stringify({ ...journal, done: next }), io)
    done = next
  }
  write(done)
  return {
    add: (step) => write([...done, step]),
    // A move that ended, by its finish or its rollback, leaves no journal.
    close: () => io.rmSync(path, { force: true }),
  }
}

/** The last journal written whole, null when there is none. */
export function readJournal(legacy: string): Journal | null {
  try {
    const journal = JSON.parse(readFileSync(journalPath(legacy), 'utf8')) as Journal
    return journal.version === 1 ? journal : null
  } catch {
    return null
  }
}

/**
 * Writes [text] to [path] owner-only and whole: to its draft, synced, then renamed into place, the rename synced in its
 * folder. A crash leaves the file as it was before, or as it is after.
 */
export function writeWhole(path: string, text: string, io: JournalIo = NODE_FS): void {
  const draft = draftOf(path)
  try {
    const file = io.openSync(draft, 'w', 0o600)
    try {
      io.writeFileSync(file, text)
      io.fsyncSync(file)
    } finally {
      io.closeSync(file)
    }
    io.renameSync(draft, path)
  } catch (error) {
    io.rmSync(draft, { force: true })
    throw error
  }
  const folder = io.openSync(dirname(path), 'r')
  try {
    io.fsyncSync(folder)
  } finally {
    io.closeSync(folder)
  }
}
