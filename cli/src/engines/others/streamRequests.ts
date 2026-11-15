/**
 * The other engines' live streams on their worker's link (engines/others/streams.ts): open one, act on one, and the one
 * wait the core holds for all of them (engines/others/streamProtocol.ts). Each answer is checked and bounded by the core
 * as well (core/engines/otherStreams.ts); these check what the core sends, and answer only the core's own call.
 */
import type { ServiceRequests } from '../../core/api.js'
import { isOtherEngine } from '../otherEngines.js'
import { record } from '../worker/protocol.js'
import { readerPath } from '../worker/readerChecks.js'
import { createReplyParts, type ReplyParts } from './readerRequests.js'
import {
  STREAM_ANSWER_BYTES, STREAM_OP, STREAM_OPEN, STREAM_VERSION, STREAMS_WAIT, STREAMS_WAIT_MS, type StreamFrame, type StreamOp,
} from './streamProtocol.js'
import type { OtherStreams, StreamOpen } from './streams.js'

const OPS: readonly StreamOp[] = ['close', 'abort', 'cancel', 'open', 'drain', 'tail', 'task', 'pane', 'release', 'forget']
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
/** What a Task hook's input may hold: Cursor's own, as its hook sent it, bounded. */
const TASK_INPUT_BYTES = 256 * 1024

function openOf(payload: Record<string, unknown>): StreamOpen | null {
  const s = payload.session, resume = payload.resume
  if (!id(payload.token) || !record(s) || !id(s.agentId) || !id(s.sessionId) || typeof s.engine !== 'string' || !isOtherEngine(s.engine)
    || (s.transcriptPath !== null && !readerPath(s.transcriptPath)) || (s.store !== null && !readerPath(s.store))
    || typeof payload.live !== 'boolean' || typeof payload.abandon !== 'boolean' || typeof payload.held !== 'boolean'
    || (resume !== undefined && !(record(resume) && typeof resume.turnOpen === 'boolean'
      && (resume.offset === undefined || (Number.isSafeInteger(resume.offset) && (resume.offset as number) >= 0))))) return null
  return { token: payload.token, live: payload.live, abandon: payload.abandon, held: payload.held,
    session: { agentId: s.agentId, sessionId: s.sessionId, engine: s.engine, transcriptPath: s.transcriptPath as string | null, store: s.store as string | null },
    ...(resume !== undefined ? { resume: resume as StreamOpen['resume'] } : {}) }
}

export interface OtherStreamRequestDeps {
  streams: OtherStreams
  /** The replies kept in parts, shared with the reads' (engines/others/readerRequests.ts). */
  parts?: ReplyParts
  waitMs?: number
  answerBytes?: number
}

export function otherStreamRequests(deps: OtherStreamRequestDeps): ServiceRequests {
  const { streams } = deps
  const parts = deps.parts ?? createReplyParts()
  const waitMs = deps.waitMs ?? STREAMS_WAIT_MS
  const answerBytes = deps.answerBytes ?? STREAM_ANSWER_BYTES
  const failure = (code: string) => ({ version: STREAM_VERSION, error: code })
  const fromCore = (payload: Record<string, unknown>, asker: Parameters<ServiceRequests[string]>[1]): boolean =>
    asker.owner && asker.local && asker.connection === undefined && payload.version === STREAM_VERSION
  const answer = (value: Record<string, unknown>) => parts.send({ version: STREAM_VERSION, answer: value })
  /** One wait at a time: the core's next one ends the last, answered with nothing. */
  let waiting: { done: (answer: Record<string, unknown>) => void } | null = null
  const pages = (): Record<string, unknown> => {
    const out: Array<{ token: string; frames: StreamFrame[] }> = []
    let bytes = 0
    // Every stream's oldest frames first, until the answer is full: one frame larger than that goes alone.
    for (const stream of streams.pending()) {
      const frames: StreamFrame[] = []
      for (const entry of stream.outbox) {
        if (bytes && bytes + entry.bytes > answerBytes) break
        frames.push(entry.frame); bytes += entry.bytes
      }
      if (frames.length) out.push({ token: stream.token, frames })
      if (bytes >= answerBytes) break
    }
    return { pages: out, lost: streams.ack({}) }
  }
  // What one read made goes in one answer: the frames its lines made at once, before anything else runs, together.
  let flushing = false
  streams.onMade(() => {
    if (!waiting || flushing) return
    flushing = true
    queueMicrotask(() => {
      flushing = false
      const held = waiting
      if (!held || (!streams.pending().length && !streams.lost())) return
      waiting = null
      held.done(pages())
    })
  })

  return {
    [STREAM_OPEN]: async (payload, asker, closed) => {
      if (!fromCore(payload, asker)) return failure('ENGINE_INVALID_REQUEST')
      const ask = openOf(payload)
      if (!ask) return failure('ENGINE_INVALID_REQUEST')
      let opened
      try { opened = await streams.open(ask) } catch (error) {
        console.warn(`[engine ${ask.session.engine}] live stream not opened · ${error instanceof Error ? error.message : String(error)}`)
        streams.forget(ask.token)
        return failure('ENGINE_UNAVAILABLE')
      }
      // A core that went while this opened has nobody to follow it for.
      if (closed?.aborted) { streams.forget(ask.token); return failure('ENGINE_UNAVAILABLE') }
      return opened ? answer(opened as unknown as Record<string, unknown>) : failure('ENGINE_UNAVAILABLE')
    },
    [STREAM_OP]: async (payload, asker) => {
      if (!fromCore(payload, asker) || typeof payload.op !== 'string' || !OPS.includes(payload.op as StreamOp)) return failure('ENGINE_INVALID_REQUEST')
      const op = payload.op as StreamOp
      // A drain with no stream named is of every stream: the core's reconciliation, which reads every transcript.
      if (op === 'drain' && payload.token === undefined) {
        await Promise.all(streams.all().map(stream => streams.drain(stream).catch(() => undefined)))
        return answer({ frames: [] })
      }
      if (!id(payload.token)) return failure('ENGINE_INVALID_REQUEST')
      const stream = streams.stream(payload.token)
      if (!stream) return failure('ENGINE_STREAM_GONE')
      if (op === 'forget') { streams.forget(stream.token); return answer({ frames: [] }) }
      const reply: Record<string, unknown> = {}
      switch (op) {
        case 'close': case 'abort': case 'cancel': {
          // A close about a turn the stream has since moved past is stale: the turn the core asked about is over.
          if (payload.identity !== undefined && payload.identity !== stream.turn().identity) { reply.closed = false; break }
          const events = streams.close(stream, { abort: op === 'abort', cancel: op === 'cancel', error: payload.error === true, stop: payload.stop === true })
          reply.closed = true
          reply.events = events
          break
        }
        case 'open': {
          if (payload.text !== undefined && (typeof payload.text !== 'string' || payload.text.length > 1024 * 1024)) return failure('ENGINE_INVALID_REQUEST')
          reply.events = streams.openTurn(stream, payload.text as string | undefined)
          break
        }
        case 'drain': await streams.drain(stream); break
        case 'tail': {
          if (!readerPath(payload.path) || typeof payload.fromStart !== 'boolean') return failure('ENGINE_INVALID_REQUEST')
          await streams.tail(stream, payload.path, payload.fromStart)
          break
        }
        case 'task': {
          if (!id(payload.toolUseId) || JSON.stringify(payload.input ?? null).length > TASK_INPUT_BYTES) return failure('ENGINE_INVALID_REQUEST')
          streams.task(stream, payload.toolUseId, payload.input)
          break
        }
        case 'pane': {
          const reading = payload.reading
          if (!record(reading) || typeof reading.ready !== 'boolean' || typeof reading.gatewayLost !== 'boolean' || typeof reading.running !== 'boolean') {
            return failure('ENGINE_INVALID_REQUEST')
          }
          reply.quietFor = streams.pane(stream, { ready: reading.ready, gatewayLost: reading.gatewayLost, running: reading.running })
          break
        }
        default: await streams.release(stream)
      }
      // What the stream made before this op is the core's to take first, in order.
      return answer({ ...reply, frames: stream.frames(), turn: stream.turn() })
    },
    [STREAMS_WAIT]: (payload, asker, closed) => {
      if (!fromCore(payload, asker) || !record(payload.acks)) return failure('ENGINE_INVALID_REQUEST')
      const acks: Record<string, number> = {}
      for (const [token, serial] of Object.entries(payload.acks)) if (Number.isSafeInteger(serial)) acks[token] = serial as number
      const gone = streams.ack(acks)
      waiting?.done({ pages: [], lost: [] })
      waiting = null
      if (gone.length || streams.pending().length) {
        const now = pages()
        return parts.send({ version: STREAM_VERSION, answer: { ...now, lost: [...gone, ...(now.lost as string[])] } })
      }
      return new Promise((resolve) => {
        const done = (value: Record<string, unknown>): void => {
          clearTimeout(timer)
          closed?.removeEventListener('abort', aborted)
          resolve(parts.send({ version: STREAM_VERSION, answer: value }))
        }
        const self = { done }
        const aborted = (): void => { if (waiting === self) waiting = null; done({ pages: [], lost: [] }) }
        const timer = setTimeout(() => { if (waiting === self) waiting = null; done({ pages: [], lost: [] }) }, waitMs)
        timer.unref?.()
        closed?.addEventListener('abort', aborted, { once: true })
        waiting = self
      })
    },
  }
}
