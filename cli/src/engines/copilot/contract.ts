import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/**
 * What the core knows of Copilot without loading its code: declared data, read in line on the hook path
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of Copilot's code.
 */
import { join } from 'node:path'
import type { ProcessSessionLocation, TranscriptLocation } from '../kit/sessionLocation.js'

/** A session id: its folder's name. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const COPILOT_TRANSCRIPT: TranscriptLocation = {
  id: SESSION_ID, kind: 'direct', root: 'session-state', file: ['events.jsonl'],
}
export const COPILOT_PROCESS_SESSION: ProcessSessionLocation = {
  id: SESSION_ID, kind: 'newest-lock', root: 'session-state', prefix: 'inuse.', suffix: '.lock',
}
export const COPILOT_CWD = { type: 'session.start', field: ['data', 'context', 'cwd'] } as const

/**
 * `<COPILOT_HOME>/session-state/<sessionId>/events.jsonl`.
 *
 * Deterministic from the session id alone, and confirmed by Copilot itself: the `agentStop` hook
 * reports this exact path in `transcriptPath`.
 */
export function copilotTranscriptPath(copilotHome: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  return join(copilotHome, 'session-state', sessionId, 'events.jsonl')
}

/** The engine reads each JSON file in its hooks directory. This file is ours; preToolUse is fail-closed and is deliberately absent. Tool cards come from its transcript. */
export const COPILOT_HOOK_SETTINGS = {
  file: hookPath(hookEnvironment.COPILOT_HOME, 'hooks', 'harness.json'),
  "engine": "copilot",
  "schema": "file",
  "events": [
    "sessionStart",
    "userPromptSubmitted",
    "agentStop",
    "sessionEnd"
  ],
  "version": 1,
  "eventFlag": "--copilot-event",
  "messages": {
    "current": "[hooks] Copilot lifecycle hooks already installed",
    "installed": "[hooks] installed Copilot lifecycle hooks → {file}",
    "after": "[hooks] (takes effect on the next copilot session start)",
    "failed": "[hooks] failed to write Copilot hook file:"
  }
} as const satisfies import('../kit/nativeHookSettings.js').NativeHookSettings
