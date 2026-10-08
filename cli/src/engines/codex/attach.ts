import { codexGoalOf, codexTaskBoundary, startsCodexTurn } from './normalizer.js'
import type { AttachRules } from '../../lib/attachTranscript.js'
import type { RuntimeField } from '../../lib/runtimeProfile.js'

const bytes = (...markers: string[]): Buffer[] => markers.map((marker) => Buffer.from(marker))

/**
 * Codex: a turn opens on a user message (`user_message`, or `UserMessage` inside `item_completed`) or a
 * `/goal` injection, and its task began at the `task_started` before it. Model, effort and mode arrive
 * together in `turn_context` and `thread_settings_applied`, written just before the turn's first
 * message. A continuing goal's label depends on the goal before it.
 */
export function codexAttachRules(fields: (line: string) => readonly RuntimeField[]): AttachRules {
  return {
    startsTurn: startsCodexTurn,
    turnMarkers: bytes('user_message', 'UserMessage', 'codex_internal_context'),
    turnBegin: {
      begins: (line) => codexTaskBoundary(line) === 'begins',
      ends: (line) => codexTaskBoundary(line) === 'ends',
      markers: bytes('task_started', 'task_complete', 'turn_aborted'),
    },
    fields,
    fieldMarkers: bytes('turn_context', 'thread_settings_applied'),
    required: ['model', 'effort', 'mode'],
    seedFor: (opener) => (codexGoalOf(opener) === null ? null : (line) => codexGoalOf(line) !== null),
    seedMarkers: bytes('codex_internal_context'),
  }
}
