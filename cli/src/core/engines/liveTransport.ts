/** Only protocol code belongs here. Parsers, transcript walks and their recovery execute in workers. */
import { createHash } from 'node:crypto'
import {
  liveCursor, livePage, LIVE_CAPABILITIES, LIVE_CLOSE, LIVE_FORGET, LIVE_PART, LIVE_PART_BYTES,
  LIVE_PREPARE, LIVE_READ, LIVE_RESULT_BYTES, LIVE_VERSION, LIVE_WAIT_MS, LIVE_IN_FLIGHT, type LiveCursor, type LivePage, type LivePull,
} from '../../engines/worker/liveProtocol.js'
import { readerEngine, record, READER_SERVICES, type ReaderEngine } from '../../engines/worker/protocol.js'

export class EngineLiveError extends Error {
  constructor(readonly code: string) { super(code) }
}
export interface LiveTransportDeps {
  call(service: string, type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
}

export function createLiveTransport(deps: LiveTransportDeps) {
  const states = new Map(Object.values(READER_SERVICES).map(service => [service as string, { generation: 0, connected: false, capable: false, pending: 0 }]))
  async function perform(engine: ReaderEngine, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const service = READER_SERVICES[engine]
    const state = states.get(service)!
    const generation = state.generation + (state.connected ? 0 : 1)
    const deadline = performance.now() + LIVE_WAIT_MS
    const one = async (method: string, data: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0) throw new EngineLiveError('ENGINE_UNAVAILABLE')
      let reply: Record<string, unknown>
      try { reply = await deps.call(service, method, { ...data, version: LIVE_VERSION }, remaining) }
      catch { throw new EngineLiveError('ENGINE_UNAVAILABLE') }
      if (state.generation !== generation) throw new EngineLiveError('ENGINE_STALE_REPLY')
      if (reply.error !== undefined) throw new EngineLiveError(typeof reply.error === 'string' && reply.error.startsWith('ENGINE_') ? reply.error : 'ENGINE_UNAVAILABLE')
      if (reply.version !== LIVE_VERSION) throw new EngineLiveError('ENGINE_INVALID_REPLY')
      return reply
    }
    if (!state.capable) {
      const capabilities = await one(LIVE_CAPABILITIES, {})
      if (capabilities.live !== LIVE_VERSION || capabilities.engine !== engine) throw new EngineLiveError('ENGINE_INVALID_REPLY')
      state.capable = true
    }
    let reply = await one(type, payload)
    if (reply.part === undefined) return reply
    const id = reply.part, size = reply.bytes, hash = reply.hash
    if (typeof id !== 'string' || !id || id.length > 200 || typeof size !== 'number' || !Number.isSafeInteger(size)
      || size < 1 || size > LIVE_RESULT_BYTES || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new EngineLiveError('ENGINE_INVALID_REPLY')
    // Allocate once, after the bound is checked. One session awaits one page, so unread backlog stays
    // on disk rather than queuing raw transcript records in core's heap.
    const body = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      if (reply.part !== id || reply.bytes !== size || reply.hash !== hash || reply.offset !== offset || typeof reply.data !== 'string'
        || reply.data.length > Math.ceil(LIVE_PART_BYTES / 3) * 4) throw new EngineLiveError('ENGINE_INVALID_REPLY')
      const part = Buffer.from(reply.data, 'base64')
      if (!part.length || part.length > size - offset || part.toString('base64') !== reply.data) throw new EngineLiveError('ENGINE_INVALID_REPLY')
      part.copy(body, offset); offset += part.length
      if (offset < size) reply = await one(LIVE_PART, { part: id, offset })
    }
    if (createHash('sha256').update(body).digest('hex') !== hash) throw new EngineLiveError('ENGINE_INVALID_REPLY')
    let result: unknown
    try { result = JSON.parse(body.toString('utf8')) } catch { throw new EngineLiveError('ENGINE_INVALID_REPLY') }
    if (!record(result) || result.version !== LIVE_VERSION) throw new EngineLiveError('ENGINE_INVALID_REPLY')
    return result
  }
  async function request(engine: ReaderEngine, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = states.get(READER_SERVICES[engine])!
    if (state.pending >= LIVE_IN_FLIGHT) throw new EngineLiveError('ENGINE_BUSY')
    state.pending++
    try { return await perform(engine, type, payload) } finally { state.pending-- }
  }
  return {
    async pull(ask: LivePull): Promise<LivePage> {
      if (!readerEngine(ask.session.engine)) throw new EngineLiveError('ENGINE_INVALID_REQUEST')
      const reply = await request(ask.session.engine, ask.cursor ? LIVE_READ : LIVE_PREPARE, { ...ask })
      if (!livePage(reply.answer) || reply.answer.cursor.serial !== (ask.cursor?.serial ?? 0) + 1
        || (ask.cursor && (reply.answer.cursor.offset < ask.cursor.offset || reply.answer.cursor.origin !== ask.cursor.origin))
        || !reply.answer.cursor.turn.identity.startsWith(`${ask.token}:`)
        || reply.answer.frames.some(frame => !frame.turn.identity.startsWith(`${ask.token}:`))) throw new EngineLiveError('ENGINE_INVALID_REPLY')
      return reply.answer
    },
    async close(ask: LivePull, identity: string, reason: Exclude<LiveCursor['closed'], false>): Promise<{ closed: boolean; cursor: LiveCursor }> {
      if (!readerEngine(ask.session.engine)) throw new EngineLiveError('ENGINE_INVALID_REQUEST')
      const reply = await request(ask.session.engine, LIVE_CLOSE, { ...ask, identity, reason })
      if (!record(reply.answer) || typeof reply.answer.closed !== 'boolean' || !liveCursor(reply.answer.cursor)) throw new EngineLiveError('ENGINE_INVALID_REPLY')
      return { closed: reply.answer.closed, cursor: reply.answer.cursor }
    },
    async forget(engine: string, token: string): Promise<void> {
      if (readerEngine(engine)) await request(engine, LIVE_FORGET, { token })
    },
    connected(service: string): void {
      const state = states.get(service)
      if (state) { state.connected = true; state.generation++; state.capable = false }
    },
    disconnected(service: string): void {
      const state = states.get(service)
      if (state) { state.connected = false; state.generation++; state.capable = false }
    },
  }
}

export type LiveTransport = ReturnType<typeof createLiveTransport>
