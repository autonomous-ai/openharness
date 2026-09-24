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
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { ENGINES } from '../engines/types.js'

/** An engine's own name, which is what a session is titled before it is about anything. */
const ENGINE_TITLES: ReadonlySet<string> = new Set([
  ...ENGINES,
  'claude code', 'openai codex', 'codex cli', 'cursor agent', 'gemini', 'gemini cli', 'hermes agent',
  'command code', 'devin', 'amp', 'kilo code', 'grok', 'github copilot', 'copilot cli', 'antigravity',
])

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
  if (ENGINE_TITLES.has(lower)) return null
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

interface IndexCache { path: string; mtimeMs: number; size: number; names: Map<string, string> }
let codexIndexCache: IndexCache | null = null

/**
 * Codex's own name for a thread, from `session_index.jsonl` under the agent's CODEX_HOME. The file is
 * small (one line per named thread, later lines win) and re-read only when it changes; a missing or
 * unreadable file is simply no name.
 */
export function codexThreadName(sessionId: string | null | undefined, codexHome?: string | null): string | null {
  if (!sessionId) return null
  const home = codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')
  const path = join(home, 'session_index.jsonl')
  let stat
  try { stat = statSync(path) } catch { return null }
  if (!codexIndexCache || codexIndexCache.path !== path || codexIndexCache.mtimeMs !== stat.mtimeMs || codexIndexCache.size !== stat.size) {
    const names = new Map<string, string>()
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
          if (typeof row.id === 'string' && typeof row.thread_name === 'string' && row.thread_name.trim()) {
            names.set(row.id, row.thread_name.trim())
          }
        } catch { /* one torn line (Codex mid-append) costs that line, not the index */ }
      }
    } catch { return null }
    codexIndexCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, names }
  }
  return codexIndexCache.names.get(sessionId) ?? null
}

/** Test seam. */
export function resetCodexThreadNames(): void { codexIndexCache = null }

/**
 * The title the terminal sweep records for a session: Codex's thread name when it has one, else the
 * terminal title as the engine wrote it. Cleaning for display happens in namingTitle, so a title
 * recorded before this existed is read the same way.
 */
export function engineSessionTitle(
  session: { engine?: string | null; sessionId?: string | null; codexHome?: string | null },
  terminalTitle: string | null | undefined,
): string | null {
  if (session.engine === 'codex') {
    const named = codexThreadName(session.sessionId, session.codexHome)
    if (named) return named
  }
  return terminalTitle ?? null
}
