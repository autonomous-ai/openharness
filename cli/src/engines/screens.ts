import type { AgentEngine } from './types.js'
import { screen as claude, inspectRuntimePane as claudePane, paneModal as claudeModal } from './claude/screen.js'
import { screen as codex, inspectRuntimePane as codexPane, paneModal as codexModal } from './codex/screen.js'
import { legacyScreen } from '../lib/legacyScreen.js'
import { paneModal as legacyModal } from './kit/pane.js'
import { inspectRuntimePane as inspectPane } from '../lib/legacyPane.js'
export function screenFor(engine: AgentEngine) { return engine === 'claude' ? claude : engine === 'codex' ? codex : { inspect: (capture: string) => legacyScreen(engine, capture) } }
export function inspectRuntimePane(engine: AgentEngine, capture: string) { return engine === 'claude' ? claudePane(capture) : engine === 'codex' ? codexPane(capture) : inspectPane(engine, capture) }
export function paneModal(engine: AgentEngine, capture: string) { return engine === 'claude' ? claudeModal(capture) : engine === 'codex' ? codexModal(capture) : legacyModal(engine, capture) }
export function parseEngineQuestionPane(engine: AgentEngine, capture: string) { return screenFor(engine).inspect(capture).question }
export function messageHold(engine: AgentEngine, capture: string | null) { return capture === null ? (engine === 'claude' || engine === 'codex' ? 'screen_unreadable' : null) : screenFor(engine).inspect(capture).messageHold }
export function teamWriteHold(engine: AgentEngine, capture: string | null) { return capture ? screenFor(engine).inspect(capture).teamHold : 'team_waiting_unavailable' }
