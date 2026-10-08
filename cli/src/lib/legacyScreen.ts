import type { AgentEngine } from '../engines/types.js'
import { inspectRuntimePane as inspectPane } from './legacyPane.js'
import { assembleScreen } from '../engines/kit/screen.js'
import { parseEngineQuestionPane } from './questionPane.js'
export function legacyScreen(engine: AgentEngine, capture: string | null) {
  if (capture === null) return { pane: { idle: false, plan: false, dialog: false, draft: false }, question: null, messageHold: null,
    teamHold: 'team_waiting_unavailable', activity: null, busy: false, stoppedGoal: false }
  return assembleScreen(engine, capture, inspectPane(engine, capture), parseEngineQuestionPane(engine, capture))
}
