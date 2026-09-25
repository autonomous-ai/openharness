import { randomUUID } from 'node:crypto'
import type { LiveEvent } from '../normalize.js'
import type { AutonomousDeviceFrame } from './service.js'

/**
 * Opt-in, expiring live view of one agent for one paired device: tool calls, answer text as it is
 * written, and the turn's final answer. Nothing streams without a subscription, and the daemon — not
 * the device — owns the clock: at `expiresAt` the subscription ends and no further frame is sent.
 *
 * Stream frames are deliberately NOT in the service's replay log. A burst of text would evict the
 * receipts and focus changes that log exists for, and a subscription is bound to the live link: a
 * device that reconnects subscribes again.
 */
export type StreamKind = 'tool' | 'text' | 'final'
export type StreamEndReason = 'expired' | 'unsubscribed' | 'replaced'
export const STREAM_KINDS: readonly StreamKind[] = ['tool', 'text', 'final']
export const STREAM_TTL_MAX_SEC = 300
export const STREAM_TTL_DEFAULT_SEC = 60
/** Per device. Re-subscribing to the same agent replaces, so this bounds distinct agents watched at once. */
export const STREAM_MAX_PER_DEVICE = 2
/** Text is coalesced to at most one frame per window, or sooner once this many bytes are waiting. */
const TEXT_FLUSH_MS = 250
const TEXT_FLUSH_BYTES = 4096
/** Bounds the per-agent turn text kept for `stream.final`, and the final frame itself. */
const FINAL_MAX_BYTES = 16384
const TOOL_INPUT_MAX_BYTES = 1024

export interface AgentStreamsOptions {
  machineId: string
  serverInstanceId: string
  send: (deviceId: string, frame: AutonomousDeviceFrame) => void
  now?: () => number
}
export class StreamRequestError extends Error { constructor(readonly code: string, message: string) { super(message) } }

interface Subscription {
  id: string; deviceId: string; agentId: string; include: ReadonlySet<StreamKind>
  expiresAt: number; seq: number; expiry: ReturnType<typeof setTimeout>
  text: string; flush: ReturnType<typeof setTimeout> | undefined
}

/** Cut to at most `max` UTF-8 bytes without splitting a code point. */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false }
  let out = Buffer.from(text).subarray(0, max).toString('utf8')
  if (out.endsWith('�')) out = out.slice(0, -1)
  return { text: out, truncated: true }
}
function toolInput(input: unknown): string {
  if (input === undefined) return ''
  try { return clip(typeof input === 'string' ? input : JSON.stringify(input) ?? '', TOOL_INPUT_MAX_BYTES).text } catch { return '' }
}

export class AgentStreams {
  private readonly subs = new Map<string, Subscription>()
  /** The open turn's answer text per agent, kept whether or not anyone watches, so a mid-turn subscriber still gets the whole final. */
  private readonly turnText = new Map<string, string>()
  private readonly now: () => number
  constructor(private readonly options: AgentStreamsOptions) { this.now = options.now ?? Date.now }

  subscribe(deviceId: string, agentId: string, ttlSec: number, include: ReadonlySet<StreamKind>): { subscriptionId: string; expiresAt: number; ttlMs: number } {
    const existing = [...this.subs.values()].find(s => s.deviceId === deviceId && s.agentId === agentId)
    // The old subscription's frames all carry its own id, so the device can tell the two apart.
    if (existing) this.end(existing, 'replaced')
    else if ([...this.subs.values()].filter(s => s.deviceId === deviceId).length >= STREAM_MAX_PER_DEVICE) {
      throw new StreamRequestError('SUBSCRIPTION_LIMIT', `At most ${STREAM_MAX_PER_DEVICE} agents can be watched at once`)
    }
    const ttlMs = ttlSec * 1000
    const sub: Subscription = { id: randomUUID(), deviceId, agentId, include, expiresAt: this.now() + ttlMs, seq: 0,
      expiry: setTimeout(() => this.end(sub, 'expired'), ttlMs), text: '', flush: undefined }
    sub.expiry.unref?.()
    this.subs.set(sub.id, sub)
    return { subscriptionId: sub.id, expiresAt: sub.expiresAt, ttlMs }
  }

  /** False when the id is unknown, already ended, or belongs to another device — indistinguishable on purpose. */
  unsubscribe(deviceId: string, subscriptionId: string): boolean {
    const sub = this.subs.get(subscriptionId)
    if (!sub || sub.deviceId !== deviceId) return false
    this.end(sub, 'unsubscribed')
    return true
  }

  /** The device can no longer be reached (unpaired, or its last link closed): end silently. */
  dropDevice(deviceId: string): void {
    for (const sub of [...this.subs.values()]) if (sub.deviceId === deviceId) this.end(sub)
  }

  /** Live events for one agent, in order. Replayed history must not be passed here. */
  ingest(agentId: string, events: readonly LiveEvent[]): void {
    for (const e of events) {
      if (e.type === 'turn_started') this.turnText.set(agentId, '')
      else if (e.type === 'text_delta') {
        const kept = (this.turnText.get(agentId) ?? '') + e.payload.content
        // Past the cap the final is already truncated; keep the head, stop growing.
        this.turnText.set(agentId, Buffer.byteLength(kept) > FINAL_MAX_BYTES + 4 ? clip(kept, FINAL_MAX_BYTES + 4).text : kept)
        for (const sub of this.watching(agentId, 'text')) this.queueText(sub, e.payload.content)
      } else if (e.type === 'tool_start') {
        for (const sub of this.watching(agentId, 'tool')) {
          this.flushText(sub)
          this.send(sub, 'stream.tool', { phase: 'start', toolUseId: e.payload.id, tool: e.payload.tool, input: toolInput(e.payload.input) })
        }
      } else if (e.type === 'tool_end') {
        for (const sub of this.watching(agentId, 'tool')) {
          this.flushText(sub)
          this.send(sub, 'stream.tool', { phase: 'end', toolUseId: e.payload.id, tool: e.payload.tool, isError: e.payload.isError,
            ...(e.payload.durationSeconds !== undefined ? { durationSeconds: e.payload.durationSeconds } : {}) })
        }
      } else if (e.type === 'turn_ended') {
        const final = clip((this.turnText.get(agentId) ?? '').trim(), FINAL_MAX_BYTES)
        this.turnText.delete(agentId)
        for (const sub of this.watching(agentId)) this.flushText(sub)
        for (const sub of this.watching(agentId, 'final')) {
          this.send(sub, 'stream.final', e.payload.aborted ? { aborted: true } : { text: final.text, ...(final.truncated ? { truncated: true } : {}) })
        }
      }
    }
  }

  count(): number { return this.subs.size }

  private watching(agentId: string, kind?: StreamKind): Subscription[] {
    const at = this.now()
    return [...this.subs.values()].filter(s => s.agentId === agentId && s.expiresAt > at && (!kind || s.include.has(kind)))
  }
  private queueText(sub: Subscription, content: string): void {
    sub.text += content
    if (Buffer.byteLength(sub.text) >= TEXT_FLUSH_BYTES) { this.flushText(sub); return }
    if (!sub.flush) { sub.flush = setTimeout(() => this.flushText(sub), TEXT_FLUSH_MS); sub.flush.unref?.() }
  }
  private flushText(sub: Subscription): void {
    if (sub.flush) { clearTimeout(sub.flush); sub.flush = undefined }
    if (!sub.text) return
    const text = sub.text
    sub.text = ''
    this.send(sub, 'stream.text', { text })
  }
  /** Idempotent. With a reason the device is told; without one it is unreachable anyway. */
  private end(sub: Subscription, reason?: StreamEndReason): void {
    if (!this.subs.has(sub.id)) return
    clearTimeout(sub.expiry)
    // Text written before the deadline was inside the window: deliver it, then close.
    if (reason) this.flushText(sub)
    else if (sub.flush) clearTimeout(sub.flush)
    if (reason) this.send(sub, 'stream.end', { reason })
    this.subs.delete(sub.id)
  }
  private send(sub: Subscription, kind: string, payload: Record<string, unknown>): void {
    if (!this.subs.has(sub.id)) return
    this.options.send(sub.deviceId, { type: 'event', serverInstanceId: this.options.serverInstanceId, machineId: this.options.machineId,
      agentId: sub.agentId, subscriptionId: sub.id, seq: ++sub.seq, kind, payload })
  }
}
