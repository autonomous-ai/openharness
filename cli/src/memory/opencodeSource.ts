/** OpenCode 1.18.34's native message/part records, before live-view clipping. */
import { digest } from './admission.js'
import { memoryUserParts, type NativeRecord } from './native.js'
import type { SourceEvent } from './types.js'

export interface OpenCodeSourceMessage {
  id: string; sessionId: string; created: number; updated: number; data: string | null
  parts: Array<{ id: string; created: number; updated: number; data: string | null }>
  hasReply: boolean; hasLaterUser: boolean
  /** Reader-derived native overflow boundary, not an authored field on the message. */
  afterOverflow?: boolean
}
export interface OpenCodeSourceRecord extends NativeRecord {
  started: boolean
  /** Summaries and their generated continuation are not new statements by the person. */
  compacted: boolean
  observedAt: number | null
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function json(value: string | null): Record<string, unknown> | null {
  try { return value === null ? null : object(JSON.parse(value)) } catch { return null }
}
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }

export function openCodeMessageSettled(message: OpenCodeSourceMessage, busy: boolean, now: number): boolean {
  const data = json(message.data), time = object(data?.time)
  if (data?.role === 'assistant' && timestamp(time.completed)) return true
  if (data?.role === 'user' && message.parts.length && message.hasReply) return true
  // A crashed/interrupted message must not hold a later real user turn forever.
  if (message.hasLaterUser) return true
  const updated = Math.max(message.updated, ...message.parts.map(part => part.updated))
  return (!busy || data?.role === 'user') && now - updated >= 5_000
}

export function decodeOpenCodeMemoryMessage(message: OpenCodeSourceMessage): OpenCodeSourceRecord {
  const result: OpenCodeSourceRecord = { parts: [], ended: false, incomplete: false, started: false,
    compacted: false, observedAt: null }
  const data = json(message.data), at = object(data?.time).created
  if (!data || !timestamp(at) || !['user', 'assistant'].includes(String(data.role))) return { ...result, incomplete: true }
  result.observedAt = at
  const decoded = message.parts.map(part => ({ part, data: json(part.data) }))
  const origins = decoded.filter(({ data }) => data && !data.synthetic && !data.ignored)
    .map(({ data }) => object(object(data!.metadata).harness_submission))
    .filter(origin => origin.v === 1 && origin.sessionID === message.sessionId
      && typeof origin.messageID === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(origin.messageID))
  const copied = origins.some(origin => origin.messageID !== message.id)
  const submitted = origins.some(origin => origin.messageID === message.id)
  // Forking copies this native timestamp while minting new SQL row IDs/timestamps.
  // The capture boundary compares this timestamp with the new session's creation time.
  // A new submission stamped by the plugin remains learnable even if the previous process died
  // after compacting but before replaying. Legacy unmarked records at that boundary are ambiguous;
  // withholding them is safer than promoting a framework-generated copy into fresh user evidence.
  if ((data.role === 'user' && (copied || (message.afterOverflow && !submitted)))
    || data.summary === true || data.agent === 'compaction' || data.mode === 'compaction') {
    return { ...result, compacted: true, ended: true }
  }
  if (decoded.some(part => part.data?.type === 'compaction')) return { ...result, compacted: true, ended: true }
  let ordinal = 0
  const add = (partId: string, role: SourceEvent['role'], text: string): void => {
    if (!text.trim()) return
    if (text.length > 32_000) { result.incomplete = true; return }
    result.parts.push({ nativeEventId: digest(['opencode', message.id, partId, ordinal++, role]), role, text, observedAt: at })
  }
  for (const { part, data: value } of decoded) {
    if (!value) { result.incomplete = true; continue }
    if (value.synthetic === true || value.ignored === true) continue
    if (value.type === 'text' && typeof value.text === 'string') {
      if (data.role === 'user') {
        const fragments = memoryUserParts(value.text)
        for (const fragment of fragments) add(part.id, fragment.role, fragment.text)
        if (fragments.some(fragment => fragment.role === 'user')) result.started = true
      } else if (timestamp(object(value.time).end)) add(part.id, 'assistant', value.text)
      else result.incomplete = true
    } else if (value.type === 'tool' && data.role === 'assistant') {
      const state = object(value.state)
      if (typeof value.tool !== 'string' || typeof value.callID !== 'string'
        || !['completed', 'error'].includes(String(state.status))) { result.incomplete = true; continue }
      add(part.id, 'assistant', JSON.stringify({ tool: value.tool, callId: value.callID, input: state.input }))
      const output = state.status === 'error' ? state.error : state.output
      if (typeof output === 'string') add(part.id, 'tool', JSON.stringify({ callId: value.callID,
        isError: state.status === 'error', output }))
      else result.incomplete = true
    } else if (!['reasoning', 'step-start', 'step-finish', 'snapshot', 'patch', 'retry', 'agent'].includes(String(value.type))) {
      // Attachments and unsupported parts can explain ambiguous prose. Preserve that gap.
      result.incomplete = true
    }
  }
  if (message.parts.length > 64 || result.parts.length > 64) {
    result.parts = result.parts.slice(0, 64)
    result.incomplete = true
  }
  if (data.role === 'assistant') {
    const completed = timestamp(object(data.time).completed)
    result.ended = completed && (data.finish === 'stop' || !!data.error)
    if (!completed || data.error) result.incomplete = true
  }
  return result
}
