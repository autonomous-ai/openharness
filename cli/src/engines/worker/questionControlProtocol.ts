import type { QuestionStep } from '../facets/questionControl.js'
import type { QuestionRow } from '../facets/screen.js'
import { record } from './protocol.js'
import { controlEnvelope, controlFields as fields, controlSize } from './controlWire.js'

export const QUESTION_CONTROL_VERSION = 1
export const QUESTION_CONTROL_CAPABILITIES = 'engine_question_control_capabilities'
export const QUESTION_CONTROL_APPLY = 'engine_question_control_apply'
export const QUESTION_CONTROL_HOST = 'engine.questionControl'
export const QUESTION_CONTROL_WAIT_MS = 30_000
export const QUESTION_CONTROL_QUERY_MS = 5_000
// One step per agent's dialog at a time (the controller drives one answer per terminal). Four refused two of
// six Claude Code agents answered at once in the question workload (e2e/perf.e2e.ts, PERF_QUESTIONS=1), which
// the inline path never did; sixteen covers a machine's agents and still bounds the worker.
export const QUESTION_CONTROL_IN_FLIGHT = 16
export const QUESTION_CONTROL_WRITES = 128
export const questionControlEnvelope = (payload: Record<string, unknown>, names: string[]) => controlEnvelope(payload, QUESTION_CONTROL_VERSION, names)
const digit = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d?$/.test(value)
const text = (value: unknown): value is string => typeof value === 'string' && Buffer.byteLength(value) <= 32768 && !/[\x00-\x09\x0b-\x1f\x7f]/.test(value)
const row = (value: unknown): value is QuestionRow => record(value) && fields(value, ['number', 'label', 'checked', 'walk'])
  && digit(value.number) && typeof value.label === 'string' && value.label.length <= 262144 && typeof value.checked === 'boolean'
  && (value.walk === undefined || value.walk === 'right' || value.walk === 'down')
export function questionControlStep(value: unknown): value is QuestionStep {
  if (!record(value) || !controlSize(value)) return false
  if (value.kind === 'select') return fields(value, ['kind', 'row', 'enterSubmits']) && row(value.row)
    && (value.enterSubmits === undefined || typeof value.enterSubmits === 'boolean')
  if (value.kind === 'text') return fields(value, ['kind', 'row', 'text']) && row(value.row) && text(value.text)
  if (value.kind === 'review') return fields(value, ['kind', 'key']) && (digit(value.key) || value.key === 'Enter')
  if (value.kind !== 'multiple' || !fields(value, ['kind', 'rows', 'freeText']) || !Array.isArray(value.rows)
    || value.rows.length > 99 || !value.rows.every(row)) return false
  return value.freeText === undefined || (record(value.freeText) && fields(value.freeText, ['row', 'text']) && row(value.freeText.row) && text(value.freeText.text))
}
export type QuestionControlAction = { kind: 'text'; text: string } | { kind: 'key'; key: string }
export function questionControlAction(value: unknown): value is QuestionControlAction {
  if (!record(value)) return false
  if (value.kind === 'text') return fields(value, ['kind', 'text']) && text(value.text)
  return value.kind === 'key' && fields(value, ['kind', 'key']) && (digit(value.key) || ['Enter', 'Tab', 'Right', 'Down'].includes(value.key as string))
}
export function questionStepText(step: QuestionStep): string | undefined {
  return step.kind === 'text' ? step.text : step.kind === 'multiple' ? step.freeText?.text : undefined
}
