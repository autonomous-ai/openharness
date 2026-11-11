/**
 * Where `harness browser` puts what is too big for the agent's terminal: screenshots, and the whole of a long output.
 * The folder is in the agent's own `$TMPDIR` (../lib/agentTmp.ts), which a Swarm agent reads without being asked.
 */
import { lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareAgentTmp } from '../lib/agentTmp.js'

/** 80% of the smaller of what the engines keep of a command's output: Claude Code 30,000 characters (measured), Codex 10,000
 *  tokens (read from its model catalog), so at least 10,000 characters
 *  (docs/superpowers/specs/2026-11-11-browser-from-chat-measurements.md). Past it, an engine cuts the output itself. */
export const OUTPUT_CAP_CHARS = 8_000
/** A screenshot is read once, soon after it is taken: the folder is a short memory, not an archive. */
export const KEPT_FILES = 50

export class BrowserFilesError extends Error {}

/** `$TMPDIR/browser`, made this account's alone (0700). Never a fallback elsewhere: an agent with no private folder gets
 *  no files, rather than its screenshots in a folder other accounts can read. */
export function browserFolder(env: NodeJS.ProcessEnv): string {
  if (!env.TMPDIR) throw new BrowserFilesError("Can't save browser files: TMPDIR is not set")
  const folder = join(env.TMPDIR, 'browser')
  // prepareAgentTmp refuses a file, a link or another account's folder in its place, so nothing is written through one.
  if (!prepareAgentTmp(folder)) throw new BrowserFilesError("Can't save browser files in $TMPDIR/browser")
  return folder
}

/** Writes the JPEG as `shot-<yyyymmdd-hhmmss-mmm>.jpg`, keeps the newest 50 files, and gives its path. */
export function saveScreenshot(env: NodeJS.ProcessEnv, base64: string, now: Date = new Date()): string {
  return save(env, 'shot', 'jpg', Buffer.from(base64, 'base64'), now)
}

/** `text` as it is when it fits; else its first OUTPUT_CAP_CHARS characters, the whole saved as
 *  `output-<stamp>.txt`, then the line `Cut at <cap> characters. The whole output: <path>`. */
export function capOutput(env: NodeJS.ProcessEnv, text: string, now: Date = new Date()): string {
  if (text.length <= OUTPUT_CAP_CHARS) return text
  const path = save(env, 'output', 'txt', Buffer.from(text, 'utf8'), now)
  // A cut between the two halves of an emoji would print a broken character.
  const end = isHighSurrogate(text.charCodeAt(OUTPUT_CAP_CHARS - 1)) ? OUTPUT_CAP_CHARS - 1 : OUTPUT_CAP_CHARS
  return `${text.slice(0, end)}\nCut at ${OUTPUT_CAP_CHARS} characters. The whole output: ${path}`
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** UTC, so two machines' names for the same moment agree. */
const stamp = (now: Date): string => {
  const iso = now.toISOString() // 2026-11-11T09:05:07.042Z
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}-${iso.slice(20, 23)}`
}

function save(env: NodeJS.ProcessEnv, kind: string, extension: string, bytes: Buffer, now: Date): string {
  const folder = browserFolder(env)
  const base = `${kind}-${stamp(now)}`
  for (let n = 0; ; n++) {
    const path = join(folder, `${n ? `${base}-${n}` : base}.${extension}`)
    try {
      // Exclusive: never over another file of the same moment, and never through a link someone left in its place.
      writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw new BrowserFilesError("Can't save browser files in $TMPDIR/browser")
    }
    keepNewest(folder, path)
    return path
  }
}

/** Deletes the oldest entries, by time and whatever their kind, until KEPT_FILES are left; never [written]. */
function keepNewest(folder: string, written: string): void {
  const entries = readdirSync(folder).map(name => {
    const path = join(folder, name)
    try { return { path, at: lstatSync(path).mtimeMs } } catch { return { path, at: 0 } }
  }).filter(entry => entry.path !== written)
  entries.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path))
  // A file that will not go stays one more, and the next save tries again: the new file is saved either way.
  for (const entry of entries.slice(0, Math.max(0, entries.length + 1 - KEPT_FILES))) {
    try { rmSync(entry.path, { recursive: true, force: true }) } catch { /* said above */ }
  }
}
