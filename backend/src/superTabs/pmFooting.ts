// placeholder so the test fails on behavior, not on a missing module
import type { Agent, MessageDraft, SuperTabState } from './model.js'
export const pmFooting = (_state: SuperTabState, _pm: Agent, _now: number): string | null => null
export const addFooting = (_state: SuperTabState, _pm: Agent, _drafts: readonly MessageDraft[], _now: number): void => {}
