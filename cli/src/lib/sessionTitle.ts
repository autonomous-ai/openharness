/**
 * The name an engine gives its own session — which is what a harness is called until the person
 * names it (registry.ts, projectDisplayName). "Unitree Go2 squats and wave" says what the agent is
 * doing; harness-43 says only that it was the forty-third.
 *
 *  - Claude Code titles its terminal after the conversation, once there is one ("✳ Harness Store
 *    launch video"; the leading glyph is its activity marker and is cleaned off by titleDisplayName).
 *  - OpenCode titles it "OC | <session title>"; the prefix is dropped.
 *  - Codex keeps a thread name per session in `$CODEX_HOME/session_index.jsonl`, updated when it
 *    names a thread and on `/rename`. Its terminal title carries the same name between status words
 *    and the folder — "[ ! ] Action Required | Build 555 LED flasher | harness-36" — so that is the
 *    fallback, with the status words and the folder taken out.
 *
 * What is left after cleaning can still be no name at all: an engine's own name before the first
 * prompt ("Claude Code"), or just the folder. Those fall through to the numbered default.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ENGINES } from '../engines/types.js'
import { launchCodexHome, sessionCodexHome } from './engineHomes.js'

/** An engine's own name, which is what a session is titled before it is about anything. */
const ENGINE_TITLES: ReadonlySet<string> = new Set([
  ...ENGINES,
  'claude code', 'openai codex', 'codex cli', 'cursor agent', 'gemini', 'gemini cli', 'hermes agent',
  'command code', 'devin', 'amp', 'kilo code', 'grok', 'github copilot', 'copilot cli', 'antigravity',
])

/** OpenClaw's title line, `openclaw tui - <gateway> - agent <id> - session <key>`: its own, and it names a Gateway. */
const OPENCLAW_TITLE = /^openclaw tui - /i

/** OpenCode (and Kilo, its fork) put their short name in front: "OC | Greeting". */
const OPENCODE_PREFIX = /^(?:oc|opencode|kilo)\s+\|\s+/i

/** Codex's status text, including the ellipsis and Braille spinner shown while naming a thread.
 *  Accepting `renaming... ⠹` as a title permanently names the worktree branch `renaming`. */
const CODEX_STATUS = /^(?:\[\s*[!.]\s*\]\s*)?(?:starting|ready|working|waiting|thinking|renaming|action required)(?:\s*(?:\.{3}|…))?(?:\s*[\u2800-\u28ff])?$/i

/**
 * A title that names the session, or null when it only names the engine, the folder or the default.
 * `title` is already cleaned of leading glyphs (titleDisplayName).
 */
export function namingTitle(
  title: string | null | undefined,
  context: { engine?: string | null; cwd?: string | null; defaultName?: string | null },
): string | null {
  if (!title) return null
  const cleaned = context.engine === 'codex'
    ? cleanCodexTitle(title, context.cwd)
    : title.trim().replace(OPENCODE_PREFIX, '').trim()
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  if (ENGINE_TITLES.has(lower) || OPENCLAW_TITLE.test(cleaned)) return null
  if (context.cwd && lower === basename(context.cwd).toLowerCase()) return null
  if (context.defaultName && lower === context.defaultName.toLowerCase()) return null
  return cleaned
}

/** Codex's terminal title without its status words and its folder item. */
export function cleanCodexTitle(title: string, cwd?: string | null): string {
  const folder = cwd ? basename(cwd).toLowerCase() : null
  return title
    .split(' | ')
    .map((part) => part.trim())
    .filter((part) => part && !CODEX_STATUS.test(part) && part.toLowerCase() !== folder && part.toLowerCase() !== 'codex')
    .join(' | ')
}

/**
 * The most of Codex's index read at once: its end first, where the latest names are. One line per name given, so
 * 1 MiB holds about 7,000; a session named longer ago than that keeps the name it was given then (registry.ts).
 */
const INDEX_READ_BYTES = 1024 * 1024
/** The names kept of one index, and the indexes kept: one for each Codex home in use. */
const INDEX_NAMES = 10_000
const INDEX_HOMES = 16

/** What has been read of one home's index, the file `key` names: its lines up to `offset` when it was `size` long (-1
 *  before any read). `offset` is a line's start unless `aligned` is false: the middle of a line longer than a read. */
interface IndexRead { key: string; offset: number; aligned: boolean; size: number; mtimeMs: number; names: Map<string, string> }
const codexIndexes = new Map<string, IndexRead>()

/** The lines of `text` into `names`, later lines winning; a line that is not a name costs that line alone. */
function readNames(text: string, names: Map<string, string>): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
      if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.trim()) {
        names.delete(row.id)
        names.set(row.id, row.thread_name.trim())
        if (names.size > INDEX_NAMES) names.delete(names.keys().next().value!)
      }
    } catch { /* one torn line (Codex mid-append) costs that line, not the index */ }
  }
}

/**
 * Codex's own name for a thread, from `session_index.jsonl` under the agent's CODEX_HOME: one line per named thread,
 * later lines win, and Codex appends. Asked of every Codex session at each terminal sweep, so it reads only what was
 * appended since it last looked, and at most the index's last MiB: read whole, it grows with every thread ever named.
 * A missing or unreadable file is simply no name.
 */
export function codexThreadName(sessionId: string | null | undefined, codexHome?: string | null): string | null {
  if (!sessionId) return null
  const home = launchCodexHome(codexHome)
  const path = join(home, 'session_index.jsonl')
  let stat
  try { stat = statSync(path) } catch { return null }
  const key = `${stat.dev}:${stat.ino}`
  let index = codexIndexes.get(path)
  // Another file, or one rewritten rather than appended to, is read again from its end.
  if (!index || index.key !== key || stat.size < index.size || (stat.size === index.size && stat.mtimeMs !== index.mtimeMs)) {
    index = { key, offset: 0, aligned: true, size: -1, mtimeMs: 0, names: new Map() }
  }
  if (stat.size !== index.size || stat.mtimeMs !== index.mtimeMs) {
    // Far behind, only the end is read: every line after the skip is newer than all it skips.
    const start = Math.max(index.offset, stat.size - INDEX_READ_BYTES)
    // A read that may begin mid-line reads the byte before it too: a newline there makes the first line whole.
    const mid = start > 0 && (start > index.offset || !index.aligned)
    const at = mid ? start - 1 : start
    let bytes = Buffer.alloc(stat.size - at)
    try {
      const fd = openSync(path, 'r')
      try { bytes = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, at)) } finally { closeSync(fd) }
    } catch { codexIndexes.delete(path); return null }
    // A line begun before the read is dropped. The end after the last newline is read again next time, whole by then,
    // and taken now too: Codex's last name may have no newline yet.
    const first = bytes.indexOf(10)
    const from = !mid ? 0 : first < 0 ? bytes.length : first + 1
    const end = bytes.lastIndexOf(10) + 1
    readNames(bytes.subarray(from).toString('utf8'), index.names)
    index.offset = at + Math.max(from, end)
    index.aligned = !mid || end > 0
    index.size = stat.size
    index.mtimeMs = stat.mtimeMs
  }
  codexIndexes.delete(path)
  codexIndexes.set(path, index)
  if (codexIndexes.size > INDEX_HOMES) codexIndexes.delete(codexIndexes.keys().next().value!)
  return index.names.get(sessionId) ?? null
}

/** Test seam. */
export function resetCodexThreadNames(): void { codexIndexes.clear() }

/** omp's terminal title: "π ⠴ 󰣳 Fix login: …": its name, a status mark (a Braille spinner frame
 *  while working, ">" when idle, or another single mark), then an optional Nerd Font icon. */
const OMP_TITLE_PREFIX = /^π\s+(?:[\u2800-\u28ff]|[^\s\p{L}\p{N}])?\s*/u
/** A leading Nerd Font / private-use icon, as omp puts on its own session titles. */
const PRIVATE_USE_ICON = /^[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+\s*/u

/**
 * An omp title with the parts that churn stripped: the "π" name, the status/spinner mark (so a
 * working pane does not retitle on every spinner frame) and the topic icon. A title that is not
 * omp's is only trimmed of a leading icon.
 */
export function cleanOmpTitle(title: string | null | undefined): string | null {
  if (!title) return null
  const cleaned = title.trim().replace(OMP_TITLE_PREFIX, '').replace(PRIVATE_USE_ICON, '').trim()
  return cleaned || null
}

/** How much of the head of an omp session file is read for its `{"type":"title"}` line. */
const OMP_TITLE_HEAD_BYTES = 16 * 1024

/**
 * omp's own session title: the `{"type":"title"}` line it keeps (padded, rewritten in place) at the
 * head of its session .jsonl. Null for a missing file or no title line; the last title line in the
 * head wins.
 */
export function ompSessionTitle(transcriptPath: string | null | undefined): string | null {
  if (!transcriptPath) return null
  let head = ''
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const buffer = Buffer.alloc(OMP_TITLE_HEAD_BYTES)
      const read = readSync(fd, buffer, 0, buffer.length, 0)
      head = buffer.subarray(0, read).toString('utf8')
    } finally { closeSync(fd) }
  } catch { return null }
  let title: string | null = null
  for (const line of head.split('\n')) {
    if (!line.includes('"type":"title"')) continue
    try {
      const row = JSON.parse(line) as { type?: unknown; title?: unknown }
      if (row.type === 'title' && typeof row.title === 'string') title = cleanOmpTitle(row.title) ?? title
    } catch { /* a line cut by the head limit, or mid-rewrite */ }
  }
  return title
}

/**
 * The title the terminal sweep records for a session: Codex's thread name when it has one, else the
 * terminal title as the engine wrote it. Cleaning for display happens in namingTitle, so a title
 * recorded before this existed is read the same way.
 */
export function engineSessionTitle(
  session: { engine?: string | null; sessionId?: string | null; codexHome?: string | null; transcriptPath?: string | null },
  terminalTitle: string | null | undefined,
): string | null {
  if (session.engine === 'codex') {
    const named = codexThreadName(session.sessionId, sessionCodexHome(session))
    if (named) return named
  }
  // The live terminal title first (it follows /rename at once), else omp's own session file.
  if (session.engine === 'omp') return cleanOmpTitle(terminalTitle) ?? ompSessionTitle(session.transcriptPath)
  return terminalTitle ?? null
}
