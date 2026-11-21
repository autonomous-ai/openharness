import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'


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
