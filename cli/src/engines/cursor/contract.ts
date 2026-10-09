import { join as hookPath } from 'node:path'
/**
 * What the core knows of Cursor without loading its code: declared data, read in line on the hook path and in
 * the hook command (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of Cursor's code.
 */
import { join } from 'node:path'
import { env } from '../../config/env.js'
import type { TranscriptLocation } from '../kit/sessionLocation.js'

export const CURSOR_TRANSCRIPT: TranscriptLocation = {
  id: /^[0-9a-f-]{16,}$/i, kind: 'projects', root: 'projects', folder: 'agent-transcripts', suffix: '.jsonl',
}
export const CURSOR_TRANSCRIPT_POLL_MS = 1000

/** Cursor's hooks and chat databases follow its config root, which can differ from its data root. */
export function cursorConfigDir(vars: NodeJS.ProcessEnv = process.env): string {
  return vars.CURSOR_CONFIG_DIR?.trim()
    || (vars.XDG_CONFIG_HOME?.trim() ? join(vars.XDG_CONFIG_HOME.trim(), 'cursor') : env.CURSOR_HOME)
}

/** Agent transcripts live under projects in Cursor's data root. */
export function cursorDataDir(vars: NodeJS.ProcessEnv = process.env): string {
  return vars.CURSOR_DATA_DIR?.trim() || env.CURSOR_HOME
}

/** Cursor's Task hooks a hook queued while no daemon ran (hook/notify.mjs writes it), in the data folder. */
export const PENDING_TASKS_FILE = 'cursor-pending-tasks.json'

/** Lower-camel events and direct command entries. A failed notification must never deny an engine tool. */
export const CURSOR_HOOK_SETTINGS = {
  file: hookPath(cursorConfigDir(), 'hooks.json'),
  "engine": "cursor",
  "schema": "entries",
  "events": [
    "sessionStart",
    "beforeSubmitPrompt",
    "preToolUse",
    "stop",
    "sessionEnd"
  ],
  "version": 1,
  "failClosed": false,
  "messages": {
    "current": "[hooks] Cursor lifecycle/task hooks already installed",
    "installed": "[hooks] installed Cursor lifecycle/task hooks → {file}",
    "failed": "[hooks] failed to write Cursor hooks.json:",
    "malformed": [
      "[hooks] Cursor hooks file is invalid JSON; leaving it unchanged: {file}"
    ]
  }
} as const satisfies import('../kit/nativeHookSettings.js').NativeHookSettings
