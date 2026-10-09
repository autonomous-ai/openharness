import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
/**
 * What the core knows of agy without loading its code: declared data, read in line on the hook path
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of agy's code.
 */
import { join } from 'node:path'
import type { ProcessSessionLocation, TranscriptLocation } from '../kit/sessionLocation.js'

/** A conversation id: its folder's name. */
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const AGY_TRANSCRIPT: TranscriptLocation = {
  id: CONVERSATION_ID, kind: 'direct', root: 'brain', file: ['.system_generated', 'logs', 'transcript_full.jsonl'],
}
export const AGY_PROCESS_SESSION: ProcessSessionLocation = {
  id: CONVERSATION_ID, kind: 'open-lock', root: 'presence', suffix: '.lock', timeoutMs: 4_000,
}

/** `<AGY_HOME>/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`. */
export function agyTranscriptPath(agyHome: string, conversationId: string): string | null {
  if (!CONVERSATION_ID.test(conversationId)) return null
  return join(agyHome, 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
}

/** Hooks live in the shared customization root. Pre/PostToolUse can deny tools, so omit them; PostInvocation is a model round, not a turn. Only our named block is replaced. */
export const AGY_HOOK_SETTINGS = {
  file: hookPath(hookEnvironment.AGY_CONFIG_DIR, 'hooks.json'),
  "engine": "agy",
  "schema": "named",
  "events": [
    "PreInvocation",
    "Stop"
  ],
  "timeout": 10,
  "eventFlag": "--agy-event",
  "block": "harness",
  "messages": {
    "current": "[hooks] agy lifecycle hooks already installed",
    "installed": "[hooks] installed agy lifecycle hooks → {file}",
    "after": "[hooks] (takes effect on the next agy session start)",
    "failed": "[hooks] failed to write agy hook file:",
    "malformed": [
      "[hooks] agy hooks file is invalid JSON; leaving it unchanged: {file}",
      "[hooks] fix the file, then restart harness login"
    ]
  }
} as const satisfies import('../kit/nativeHookSettings.js').NativeHookSettings
