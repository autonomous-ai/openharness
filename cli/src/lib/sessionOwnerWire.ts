/** The private session-owner transfer. Provider records never cross this boundary. */
import { createHash } from 'node:crypto'
import type { QuestionAnswerResult } from './questionController.js'
import { SESSION_FACTS_FORMAT, type SessionFacts, type SessionFrame } from './sessionPresentation.js'
import type { SessionValueLimit } from './sessionFactValues.js'

export const OWNER_FAILURES = ['SESSION_OWNER_INVALID', 'SESSION_OWNER_LIMIT', 'SESSION_OWNER_CONFLICT',
  'SESSION_OWNER_BUSY', 'SESSION_OWNER_EXPIRED', 'SERVICE_UNAVAILABLE'] as const
export type OwnerFailure = typeof OWNER_FAILURES[number]
export type OwnerResult = { ok: true } | { ok: false; error: OwnerFailure }
export type OwnerCheckpoint = { fingerprint: string } | { ok: false; error: OwnerFailure }
export type OwnerCard = { type: 'commander_event'; agentId: string; dbSessionId: string; name?: string; payload: Record<string, unknown> }
export interface OwnerBegin { format: typeof SESSION_FACTS_FORMAT; transfer: string; factory: string; before: string; after: string; count: number }
export interface OwnerAppend { transfer: string; index: number; rows: Array<{ facts: SessionFacts; card?: OwnerCard }> }
export interface OwnerQuestionFrame {
  type: 'commander_question'; agentId: string; dbSessionId: string
  payload: { requestId: string; questions: Array<{ key: string; q: string; options: string[]; multi: boolean; canText: boolean }>
    notification: { id: string; kind: 'needsYou' } }
}
export interface OwnerQuestionClose { type: 'commander_question_close'; agentId: string; dbSessionId: string; payload: { requestId: string } }
export interface OwnerQuestion { frame: OwnerQuestionFrame; close: OwnerQuestionClose; dial: boolean }
export interface SessionOwnerCore {
  begin(value: OwnerBegin): OwnerResult | Promise<OwnerResult>
  append(value: OwnerAppend): OwnerResult | Promise<OwnerResult>
  end(transfer: string): OwnerResult | Promise<OwnerResult>
  cancel(transfer: string): OwnerResult | Promise<OwnerResult>
  checkpoint(factory: string): OwnerCheckpoint | Promise<OwnerCheckpoint>
  ask(agentId: string, requestId: string, value: OwnerQuestion): OwnerResult | Promise<OwnerResult>
  unask(agentId: string, requestId: string, value: OwnerQuestionClose): OwnerResult | Promise<OwnerResult>
}
export type OwnerRefusal = { error: string; detail?: string }
export type OwnerReply = { agent: SessionFrame } | OwnerRefusal
export type OwnerRenameReply = { agent: SessionFrame; renamed: { type: 'agent_renamed'; payload: { agentId: string; name: string; engine: string } } } | OwnerRefusal
export type OwnerDelivery = { ok: true; detail?: string } | { ok: false; error: string; detail?: string }
export const OWNER_DOWN = { ok: false as const, error: 'SERVICE_UNAVAILABLE', detail: 'Agents are not running here. Try again in a moment.' }
export const OWNER_REPLY_DOWN: OwnerRefusal = { error: OWNER_DOWN.error, detail: OWNER_DOWN.detail }
export const OWNER_ANSWER_DOWN: QuestionAnswerResult = { ok: false, error: 'ANSWER_FAILED', detail: OWNER_DOWN.detail }
export interface SessionOwnerPort {
  create(request: Record<string, unknown>): Promise<OwnerReply>
  deliver(agentId: string, text: string): Promise<OwnerDelivery>
  answer(agentId: string, requestId: string, answers: Record<string, string>): Promise<QuestionAnswerResult>
  rename(agentId: string, name: string, before: SessionFacts): Promise<OwnerRenameReply>
  stopHarness(agentId: string): Promise<{ deleted: true; detail?: string } | OwnerRefusal>
}
/** Ephemeral metadata for lists; it grants no native transcript, path or terminal authority. */
export interface ServiceSessionRow {
  agentId: string; sessionId: string; engine: string; displayName: string; defaultName: string; runtimeProfile: string | null
  registeredAt: number; lastHookAt: number; active: true; tmuxPane: ''; cwd: ''; projectDir: ''; transcriptPath: null
  runtimes: []; primaryRuntimeKey: ''
}

/** Fixed internal accounting supplied by composition, not service-controlled options or a product setting. */
export interface SessionOwnerLimits {
  count: number
  rowBytes: number
  catalogue: SessionValueLimit
  cards: SessionValueLimit
  timeoutMs: number
}
export const SESSION_OWNER_CHUNK_BYTES = 1024 * 1024
export const SESSION_OWNER_CHUNK_ROWS = 256
/** Joint logical bounds proven against all old-valid inputs; these are not V8 heap-byte estimates. */
export const SESSION_OWNER_LIMITS: Readonly<SessionOwnerLimits> = Object.freeze({
  count: 36_554, rowBytes: 224 * 1024, timeoutMs: 10_000,
  catalogue: Object.freeze({ bytes: 18_071_668, objects: 321_513, properties: 1_143_157 + 36_554, slots: 120_046, depth: 32 }),
  cards: Object.freeze({ bytes: 6 * 1024 * 1024, objects: 3 * 36_554, properties: 12 * 36_554, slots: 0, depth: 32 }),
})
/** Domain and punctuation are explicit; no public object's property order participates in authority. */
export const sessionImageHash = () => createHash('sha256').update(SESSION_FACTS_FORMAT).update('\n[')
export const emptySessionFingerprint = (): string => sessionImageHash().update(']').digest('hex')
