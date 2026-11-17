import { join as hookPath } from 'node:path'
import { cursorConfigDir } from './contract.js'


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
