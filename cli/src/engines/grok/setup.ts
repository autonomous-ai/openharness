import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'


/** Normal Stop precedes the final assistant chunk; only StopFailure closes through this hook. */
export const GROK_HOOK_SETTINGS = {
  file: hookPath(hookEnvironment.GROK_HOME, 'hooks', 'harness.json'),
  "engine": "grok",
  "schema": "nested",
  "events": [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "StopFailure"
  ],
  "timeout": 5,
  "messages": {
    "current": "[hooks] Grok lifecycle/StopFailure hooks already installed",
    "installed": "[hooks] installed Grok lifecycle/StopFailure hooks → {file}",
    "after": "[hooks] (takes effect on the next Grok session start)",
    "failed": "[hooks] failed to write Grok hook file:",
    "malformed": [
      "[hooks] Grok hooks file is invalid JSON; leaving it unchanged: {file}",
      "[hooks] fix the file, then restart harness login"
    ]
  }
} as const satisfies import('../kit/nativeHookSettings.js').NativeHookSettings
