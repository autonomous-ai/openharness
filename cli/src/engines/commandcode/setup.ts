import { join as hookPath } from 'node:path'
import { env as hookEnvironment } from '../../config/env.js'
import slugify from '@sindresorhus/slugify'


// Windows: Command Code runs a hook with Node's `spawn(command, [], { shell: true })`, i.e. `cmd.exe /d /s /c`
// (command-code 1.82.3 dist/cli.mjs `hookShell`).
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
  "win32Runner": "cmd",
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
