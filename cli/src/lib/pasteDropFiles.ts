/**
 * Where bytes from a client-side paste/drop land on disk on THIS machine, and how long they stick
 * around. Two callers share this one directory and one prune sweep:
 *
 *  - `pasteImage()`'s no-native-clipboard fallback (osClipboard.ts returned 'unavailable') — needs
 *    the file only long enough for the OS to ingest it on a successful clipboard write, but on the
 *    fallback path the path itself is what gets pasted, so it has to keep resolving afterwards.
 *  - `pasteFile()` (a dropped non-image file) — ALWAYS just writes and pastes the path; there is no
 *    clipboard step to skip.
 *
 * Both need the same thing: a durable-enough file and a bound on how much accumulates over time.
 */
import { randomUUID } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { env } from '../config/env.js'

/** Where they land; a Buddy's guard reads its own person's files there (lib/buddyGuard.ts). */
export const PASTE_DROPS_DIR = join(env.ADAPTER_DATA_DIR, 'paste-drops')
const RETENTION_MS = 24 * 60 * 60 * 1000

/** Best-effort: a prune failure must never block a paste/drop that is otherwise fine. */
async function pruneStale(): Promise<void> {
  try {
    const now = Date.now()
    const entries = await readdir(PASTE_DROPS_DIR)
    await Promise.all(entries.map(async (name) => {
      const path = join(PASTE_DROPS_DIR, name)
      try {
        const info = await stat(path)
        if (now - info.mtimeMs > RETENTION_MS) await rm(path, { force: true })
      } catch { /* raced with something else touching the same file — ignore */ }
    }))
  } catch { /* directory not there yet, or unreadable — nothing to prune */ }
}

async function ensureDir(): Promise<void> {
  await mkdir(PASTE_DROPS_DIR, { recursive: true })
  await pruneStale()
}

/** Strips anything that could escape the drops directory or corrupt a path (separators, null
 *  bytes), caps length, and falls back to a generic name if nothing usable survives — this name is
 *  attacker/careless-client controlled (it travels over the wire as-is) and only ever used as ONE
 *  path segment, appended after a random prefix, never interpreted as a path itself. */
function sanitizeFilename(name: string): string {
  const stripped = name.replaceAll(/[/\\\0]/g, '_').trim().slice(-120)
  return stripped.length > 0 ? stripped : 'file'
}

/** Writes `bytes` to a freshly named PNG file under the harness data dir, pruning anything older
 *  than a day from the same directory first, and returns its absolute path. Used only by
 *  `pasteImage()`'s fallback path — the name is opaque (a PNG needs no recognizable name) and does
 *  not carry a client-supplied filename. */
export async function writePasteImageFile(bytes: Uint8Array): Promise<string> {
  await ensureDir()
  const path = join(PASTE_DROPS_DIR, `${randomUUID()}.png`)
  await writeFile(path, bytes)
  return path
}

/** Writes `bytes` under a name derived from `originalFilename` (sanitized, prefixed with a short
 *  random id to avoid collisions) so the path pasted into the pane stays recognizable — e.g.
 *  `.../a1b2c3d4-report.pdf` rather than an opaque id. Used by `pasteFile()` for a dropped file. */
export async function writePasteDropFile(originalFilename: string, bytes: Uint8Array): Promise<string> {
  await ensureDir()
  const path = dropPath(originalFilename)
  await writeFile(path, bytes)
  return path
}

const dropPath = (originalFilename: string) => join(PASTE_DROPS_DIR, `${randomUUID().slice(0, 8)}-${sanitizeFilename(originalFilename)}`)

/** As `writePasteDropFile`, written as [source] yields, never held whole: a Super Tab chat file of up to 256 MB
 *  (superTabs/attachments.ts). A source that throws (past its size, short, stalled) leaves no file, not even part of one. */
export async function writePasteDropStream(originalFilename: string, source: AsyncIterable<Uint8Array>): Promise<string> {
  await ensureDir()
  const path = dropPath(originalFilename)
  try {
    await pipeline(source, createWriteStream(path, { flags: 'wx' }))
  } catch (error) {
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
  return path
}

/** A copy of [source], a file in this folder, under its own name: each delivery of a file two agents were sent has its own,
 *  so one agent editing it never changes the other's (nor its Buddy guard's hash of it). A clone that takes no room where the
 *  disk can (APFS, btrfs), a copy elsewhere. A failed copy leaves no file. */
export async function copyPasteDropFile(source: string, originalFilename: string): Promise<string> {
  await ensureDir()
  const path = dropPath(originalFilename)
  try {
    await copyFile(source, path, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  } catch (error) {
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
  return path
}
