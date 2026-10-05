import type { Verdict } from './model.js'

export const CONDITION_STATES = ['succeeded', 'failed', 'skipped', 'cancelled', 'blocked'] as const
export type ConditionField = 'state' | 'decision' | 'verdict.ready' | 'verdict.errors' | 'verdict.warnings'
export type ConditionOp = '==' | '!=' | '<' | '<=' | '>' | '>='
export interface Condition { task: string; field: ConditionField; op: ConditionOp; value: string; text: string }
/** What a condition may know about its dependency: its state and snapshots, never live files. */
export interface ConditionSubject { state: string; verdict?: Verdict; decision?: string }
export type ConditionResult = { ok: true; value: boolean } | { ok: false; reason: string }

const SHAPE = /^([a-z][a-z0-9-]{0,63})\.(state|decision|verdict\.ready|verdict\.errors|verdict\.warnings)\s*(==|!=|<=|>=|<|>)\s*(\S+)$/
const ONE = 'Write one comparison, like "review.verdict.errors == 0".'

/** One comparison against a direct dependency. No &&, ||, quotes or output references: there is no expression language. */
export function parseCondition(raw: string): Condition | { error: string } {
  const text = raw.trim()
  const match = SHAPE.exec(text)
  if (!match) return { error: ONE }
  const [, task, field, op, value] = match as unknown as [string, string, ConditionField, ConditionOp, string]
  const counted = field === 'verdict.errors' || field === 'verdict.warnings'
  if (!counted && !['==', '!='].includes(op)) return { error: 'Only verdict.errors and verdict.warnings can be compared with <, <=, > or >=.' }
  if (field === 'state' && !(CONDITION_STATES as readonly string[]).includes(value)) return { error: `a state is one of ${CONDITION_STATES.join(', ')}.` }
  if (field === 'verdict.ready' && value !== 'true' && value !== 'false') return { error: 'verdict.ready is true or false.' }
  if (counted && !/^(0|[1-9][0-9]*)$/.test(value)) return { error: `${field} is compared with a whole number.` }
  if (field === 'decision' && !/^[a-z][a-z0-9-]{0,31}$/.test(value)) return { error: 'a decision id looks like ship or needs-work.' }
  return { task, field, op, value, text: `${task}.${field} ${op} ${value}` }
}

export function evaluateCondition(condition: Condition, subject: ConditionSubject): ConditionResult {
  const { task, field, op, value, text } = condition
  let actual: string | number
  if (field === 'state') actual = subject.state
  else if (field === 'decision') {
    if (subject.decision === undefined) return { ok: false, reason: `${task} has no decision; the condition ${text} cannot be evaluated.` }
    actual = subject.decision
  } else {
    if (!subject.verdict) return { ok: false, reason: `${task} wrote no verdict; the condition ${text} cannot be evaluated.` }
    actual = field === 'verdict.ready' ? String(subject.verdict.ready) : field === 'verdict.errors' ? subject.verdict.errors : subject.verdict.warnings
  }
  // Counts are compared as BigInt from the literal text: a literal may exceed 2^53 and must not be rounded.
  if (typeof actual === 'number' && !(Number.isInteger(actual) && actual >= 0)) return { ok: false, reason: `${task} has a ${field} of ${actual}, which is not a whole number; the condition ${text} cannot be evaluated.` }
  const [left, expected] = typeof actual === 'number' ? [BigInt(actual), BigInt(value)] : [actual, value]
  const result = op === '==' ? left === expected : op === '!=' ? left !== expected
    : op === '<' ? left < expected : op === '<=' ? left <= expected : op === '>' ? left > expected : left >= expected
  return { ok: true, value: result }
}
