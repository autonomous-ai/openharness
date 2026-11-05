// Task #3462 (docs/plans/2026-11-06-crew-wake-move-times-plan.md): not implemented yet.
import type { Agent, MessageDraft, SuperTabState } from './model.js'
export interface CrewTiming { what: 'wake' | 'move'; agentId: string; startedAt: number; runningAt: number; reason: string }
export function startWake(_agent: Agent, _conversationId: string, _now: number): void {}
export function finishedWakes(_state: SuperTabState, _now: number): MessageDraft[] { return [] }
export function moveTimingRow(_state: SuperTabState, _agentId: string, _startedAt: number, _reason: string, _now: number): MessageDraft | null { return null }
export function crewTimingOf(_source: unknown): CrewTiming | null { return null }
