import { env as hookEnvironment } from '../../config/env.js'
/** Native facts needed by session control without optional interpretation. */

/** The vendor reads Claude's nested hook schema. Merge only Harness's blocks into its general config. */
export const DEVIN_HOOK_SETTINGS = {
  file: hookEnvironment.DEVIN_CONFIG_PATH,
  "engine": "devin",
  "schema": "nested",
  "events": [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd"
  ],
  "timeout": 5,
  "messages": {
    "current": "[hooks] Devin session hooks already installed",
    "installed": "[hooks] installed Devin SessionStart/UserPromptSubmit/Stop/SessionEnd hooks → {file}",
    "after": "[hooks] (takes effect on the next devin session start)",
    "failed": "[hooks] failed to write Devin config.json:",
    "malformed": [
      "[hooks] Devin config file is invalid JSON; leaving it unchanged: {file}"
    ]
  }
} as const satisfies import('../kit/nativeHookSettings.js').NativeHookSettings
