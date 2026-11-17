import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'


// Windows: Copilot CLI copies `command` to its `powershell` field and runs that (docs.github.com, hooks configuration reference).
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
  "win32Runner": "powershell",
  "messages": {
    "current": "[hooks] Copilot lifecycle hooks already installed",
    "installed": "[hooks] installed Copilot lifecycle hooks → {file}",
    "after": "[hooks] (takes effect on the next copilot session start)",
    "failed": "[hooks] failed to write Copilot hook file:"
  }
} as const satisfies import('../kit/nativeHookSettings.js').NativeHookSettings
