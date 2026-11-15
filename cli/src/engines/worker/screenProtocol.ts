/** Private, stateless screen reads. A worker receives text, never a terminal handle. */
import type { PaneView, QuestionRow, ScreenReading } from '../facets/screen.js'
import { record } from './protocol.js'

export const SCREEN_VERSION = 1
export const SCREEN_READ = 'engine_screen_read'
export const SCREEN_CAPABILITIES = 'engine_screen_capabilities'
export const SCREEN_WAIT_MS = 1_000
export const SCREEN_IN_FLIGHT = 8
export const SCREEN_QUEUED = 64
export const SCREEN_CAPTURE_BYTES = 256 * 1024
export const SCREEN_REPLY_BYTES = 1024 * 1024
const HOLDS = ['permission_open', 'question_open', 'menu_open', 'rewind_picker_open', 'transcript_open',
  'search_open', 'trust_open', 'update_prompt_open', 'model_prompt_open', 'sign_in_open', 'popup_open',
  'prompt_hidden', 'screen_unreadable']
const TEAM_HOLDS = ['team_waiting_unavailable', 'team_waiting_user', 'team_waiting_draft', 'team_waiting_idle']
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).every(key => names.includes(key))
const text = (value: unknown, max = SCREEN_CAPTURE_BYTES): value is string => typeof value === 'string' && value.length <= max
const flag = (value: unknown) => value === undefined || typeof value === 'boolean'

export function screenCapture(value: unknown): value is string {
  return text(value) && Buffer.byteLength(value) <= SCREEN_CAPTURE_BYTES
}

function questionRow(value: unknown, keyed = false): value is QuestionRow {
  return record(value) && fields(value, ['number', 'label', 'checked', 'walk'])
    && typeof value.number === 'string' && (keyed ? /^(?:[a-z0-9]|Tab|BTab|Enter)$/.test(value.number) : (/^[1-9]\d?$/.test(value.number) || (value.walk !== undefined && value.number === '0')))
    && text(value.label) && typeof value.checked === 'boolean'
    && (value.walk === undefined || value.walk === 'right' || value.walk === 'down')
}

function questionView(value: unknown, engine?: string): value is PaneView {
  if (value === null) return true
  if (!record(value)) return false
  if (value.kind === 'review') return fields(value, ['kind', 'submitRow'])
    && typeof value.submitRow === 'string' && /^(?:[1-9]\d?|Enter)$/.test(value.submitRow)
  return value.kind === 'question' && fields(value, ['kind', 'permission', 'partial', 'enterSubmits', 'question', 'rows', 'multi', 'typeRow', 'dialog'])
    && flag(value.permission) && flag(value.partial) && flag(value.enterSubmits) && text(value.question)
    && Array.isArray(value.rows) && value.rows.length <= 99 && value.rows.every(row => questionRow(row, engine === 'cursor' || engine === 'grok'))
    && typeof value.multi === 'boolean' && (value.typeRow === null || questionRow(value.typeRow, engine === 'cursor' || engine === 'grok'))
    && (value.dialog === undefined || text(value.dialog))
}

/** Malformed or oversized evidence cannot make a screen writable. */
export function screenReading(value: unknown, engine?: string): value is ScreenReading {
  return record(value) && fields(value, ['pane', 'question', 'messageHold', 'teamHold', 'activity', 'busy', 'stoppedGoal']) && record(value.pane)
    && fields(value.pane, ['idle', 'plan', 'dialog', 'draft'])
    && ['idle', 'plan', 'dialog', 'draft'].every(key => typeof (value.pane as Record<string, unknown>)[key] === 'boolean')
    && typeof value.busy === 'boolean' && typeof value.stoppedGoal === 'boolean'
    && (value.activity === null || (record(value.activity) && fields(value.activity, ['label', 'indicator']) && text(value.activity.label, 100) && text(value.activity.indicator)))
    && questionView(value.question, engine) && (value.messageHold === null || HOLDS.includes(value.messageHold as string))
    && (value.teamHold === null || TEAM_HOLDS.includes(value.teamHold as string))
    && !(value.pane.idle && (value.pane.dialog || value.pane.draft))
    && !(value.question && value.messageHold === null)
}
