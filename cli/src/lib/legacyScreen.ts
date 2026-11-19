import type { AgentEngine } from '../engines/types.js'
import { inspectRuntimePane as inspectPane } from './legacyPane.js'
import { assembleScreen, uncapturedScreen } from '../engines/kit/screen.js'
import { parseEngineQuestionPane } from './questionPane.js'
import { openclawActivity } from '../engines/openclaw/runtimeProfile.js'
/**
 * A pane of one of the engines besides Claude Code and Codex. The core loads this file, and the dialog and pane
 * readers it imports, only when one of their sessions needs them (engines/inProcess.ts `screens`).
 */
export function legacyScreen(engine: AgentEngine, capture: string | null) {
  if (capture === null) return uncapturedScreen()
  // OpenClaw's run draws no words the kit reads as busy, so its status line is read as the activity.
  return assembleScreen(engine, capture, inspectPane(engine, capture), parseEngineQuestionPane(engine, capture), null,
    undefined, engine === 'openclaw' ? openclawActivity(capture) : null)
}
