import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/**
 * What the core knows of Command Code without loading its code: declared data, read in line on the hook path
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of Command Code's code.
 */
import { join } from 'path'
import slugify from '@sindresorhus/slugify'
import { env } from '../../config/env.js'

/**
 * Command Code lays its transcripts out deterministically:
 *
 *   <COMMANDCODE_HOME>/projects/<cwd slug>/<sessionId>.jsonl
 *
 * Command Code 1.66.0 uses @sindresorhus/slugify with its defaults and falls back to "root". This
 * splits camelCase and acronyms and transliterates Unicode; simply replacing punctuation loses paths.
 *
 * Deriving it matters because the CLI fires SessionStart BEFORE the file exists, and a path that is not on
 * disk fails the registry's realpath check — so the path used to arrive only with the first Stop hook, i.e.
 * AFTER the first turn. Nothing tailed the transcript for that turn, which is the only signal Command Code
 * has that a message was accepted, so the first message of every new session reported "the agent did not
 * accept this message" and produced no recap.
 */
export function commandcodeProjectSlug(cwd: string): string {
  return slugify(cwd) || 'root'
}

/** null when there is not enough to build a path, or when either part could escape the projects root. */
export function commandcodeTranscriptPath(cwd: string | null | undefined, sessionId: string): string | null {
  if (!cwd || !sessionId) return null
  // The session id becomes a FILENAME, so anything that could climb out of the directory disqualifies it.
  // Command Code uses uuids; this is here so a malformed hook payload cannot point the watcher elsewhere.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') return null
  const slug = commandcodeProjectSlug(cwd)
  if (!slug) return null
  return join(env.COMMANDCODE_HOME, 'projects', slug, `${sessionId}.jsonl`)
}

/** PreToolUse is this engine's only timely turn-open signal: its transcript arrives as one completed flush. There is no UserPromptSubmit or SessionEnd hook. */
export const COMMANDCODE_HOOK_SETTINGS = {
  file: hookPath(hookEnvironment.COMMANDCODE_HOME, 'settings.json'),
  "engine": "commandcode",
  "schema": "nested",
  "events": [
    "SessionStart",
    "PreToolUse",
    "Stop"
  ],
  "timeout": 5,
  "messages": {
    "current": "[hooks] Command Code session hooks already installed",
    "installed": "[hooks] installed Command Code SessionStart/Stop hooks → {file}",
    "after": "[hooks] (takes effect on the next commandcode session start)",
    "failed": "[hooks] failed to write Command Code settings.json:",
    "malformed": [
      "[hooks] Command Code settings file is invalid JSON; leaving it unchanged: {file}"
    ]
  }
} as const satisfies import('../kit/nativeHookSettings.js').NativeHookSettings
