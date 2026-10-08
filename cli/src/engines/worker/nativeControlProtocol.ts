/**
 * Private native-control messages: an engine's own connection to its conversation server, run in its
 * worker. Core sends the conversation it identified; a stop asks core every question that decides it.
 */
import { isAbsolute } from 'node:path'
import type { NativeActivity, NativeConversation } from '../facets/nativeControl.js'
import { record } from './protocol.js'
import { controlEnvelope, controlFields as fields } from './controlWire.js'

export const NATIVE_CONTROL_VERSION = 1
/** The engines whose CLI leaves work on a server of its own (Codex's shared app-server), which a stop
 *  must unload: data, so a stop of any other engine never waits on a worker. */
export const NATIVE_CONTROL_ENGINES: readonly string[] = ['codex']
export const NATIVE_CONTROL_CAPABILITIES = 'engine_native_control_capabilities'
export const NATIVE_ACTIVITY = 'engine_native_activity'
export const NATIVE_STOP = 'engine_native_stop'
/** The query a stop asks core through, under its grant. */
export const NATIVE_CONTROL_HOST = 'engine.nativeControl'
/** A cold read connects (3 s handshake), initializes and reads (5 s each): above that the worker is stuck. */
export const NATIVE_ACTIVITY_WAIT_MS = 15_000
export const NATIVE_ACTIVITY_IN_FLIGHT = 8
export const NATIVE_ACTIVITY_QUEUED = 64
/** A connect and at most eight requests of 5 s each, with core's answers between them. */
export const NATIVE_STOP_WAIT_MS = 60_000
export const NATIVE_STOP_IN_FLIGHT = 4
/** Core's answer to one question, an unused chat's screen proof included. */
export const NATIVE_QUERY_MS = 10_000
export const NATIVE_STOP_QUERIES = 32
export const NATIVE_REPLY_BYTES = 4 * 1024
const MESSAGE_CHARS = 600

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !value.includes('\0')
export const nativeEnvelope = (payload: Record<string, unknown>, names: string[]) => controlEnvelope(payload, NATIVE_CONTROL_VERSION, names)

export function nativeConversation(value: unknown): value is NativeConversation {
  return record(value) && fields(value, ['home', 'sessionId', 'owner']) && text(value.home, 4096) && isAbsolute(value.home)
    && text(value.sessionId, 200) && (value.owner === null || (Array.isArray(value.owner) && value.owner.length <= 512
      && value.owner.every(arg => text(arg, 32_768))))
}

export function nativeActivity(value: unknown): value is NativeActivity {
  return value === 'working' || value === 'idle' || value === 'unknown'
}

/** What a person is told of a refused stop: a line of text, never terminal control. */
export function nativeMessage(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MESSAGE_CHARS && !/[\x00-\x1f\x7f]/.test(value)
}

export type NativeStopAnswer = { stopped: true } | { refused: string }
export function nativeStopAnswer(value: unknown): value is NativeStopAnswer {
  return record(value) && (fields(value, ['stopped']) && value.stopped === true || fields(value, ['refused']) && nativeMessage(value.refused))
    && Object.keys(value).length === 1
}

export type NativeStopAction = { kind: 'current' } | { kind: 'running'; pid: number; startedAt: string } | { kind: 'unused' }
export function nativeStopAction(value: unknown): value is NativeStopAction {
  if (!record(value)) return false
  if (value.kind === 'current' || value.kind === 'unused') return fields(value, ['kind'])
  return value.kind === 'running' && fields(value, ['kind', 'pid', 'startedAt']) && Number.isSafeInteger(value.pid)
    && (value.pid as number) > 0 && text(value.startedAt, 200)
}
