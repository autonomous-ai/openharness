import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ServiceRequests } from '../../core/api.js'
import type { RuntimeField } from '../facets/runtime.js'
import type { EngineLive } from '../facets/live.js'
import { transcriptFields } from '../kit/runtime.js'
import { transcriptCloses } from '../../lib/transcriptControls.js'
import { record, READER_REPLY_BYTES, type ReaderEngine } from './protocol.js'
import { LiveStreams } from './liveStreams.js'
import {
  liveCursor, LIVE_CACHE_BYTES, LIVE_CACHE_SESSIONS, LIVE_CAPABILITIES, LIVE_CLOSE, LIVE_FORGET,
  LIVE_IN_FLIGHT, LIVE_PART, LIVE_PART_BYTES, LIVE_PREPARE, LIVE_READ, LIVE_RESULT_BYTES, LIVE_VERSION, LIVE_WAIT_MS,
  type LiveSession, type LivePull,
} from './liveProtocol.js'

const loadLive = {
  claude: async () => (await import('../claude/live.js')).live,
  codex: async () => (await import('../codex/live.js')).live,
}
const loadRuntime = {
  claude: async () => (await import('../claude/runtimeProfile.js')).runtime,
  codex: async () => (await import('../codex/runtimeProfile.js')).runtime,
}
const path = (value: unknown): value is string => typeof value === 'string' && value.length <= 32_768
  && !value.includes('\0') && isAbsolute(value)
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200
const nullableText = (value: unknown): value is string | null => value === null || (typeof value === 'string' && value.length <= 2_000)
const position = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function sessionOf(value: unknown, engine: ReaderEngine): LiveSession | null {
  if (!record(value) || !label(value.agentId) || !label(value.sessionId) || value.engine !== engine
    || (value.transcriptPath !== null && !path(value.transcriptPath))
    || (value.codexHome != null && !path(value.codexHome)) || (value.cwd !== null && !path(value.cwd))
    || !nullableText(value.model) || !nullableText(value.cliVersion)) return null
  return { agentId: value.agentId, sessionId: value.sessionId, engine, transcriptPath: value.transcriptPath,
    codexHome: value.codexHome as string | null | undefined, cwd: value.cwd, model: value.model, cliVersion: value.cliVersion }
}

function pullOf(payload: Record<string, unknown>, engine: ReaderEngine): LivePull | null {
  const session = sessionOf(payload.session, engine)
  if (!session || !label(payload.token) || (payload.cursor !== null && !liveCursor(payload.cursor))
    || typeof payload.fromStart !== 'boolean' || typeof payload.replay !== 'boolean'
    || (payload.end !== undefined && !position(payload.end)) || (payload.liveStart !== undefined && typeof payload.liveStart !== 'boolean')
    || (payload.rewritten !== undefined && typeof payload.rewritten !== 'boolean')
    || (payload.closes !== undefined && !transcriptCloses(payload.closes))
    || (payload.rewrittenFrom !== undefined && !label(payload.rewrittenFrom))) return null
  return { token: payload.token, session, cursor: payload.cursor, fromStart: payload.fromStart,
    replay: payload.replay, ...(payload.liveStart === undefined ? {} : { liveStart: payload.liveStart }),
    ...(payload.rewritten === undefined ? {} : { rewritten: payload.rewritten }),
    ...(payload.rewrittenFrom === undefined ? {} : { rewrittenFrom: payload.rewrittenFrom }),
    ...(payload.closes === undefined ? {} : { closes: payload.closes }),
    ...(payload.end === undefined ? {} : { end: payload.end }) }
}

interface Reply {
  input: string
  id: string
  bytes: Buffer
  hash: string
}

export interface LiveRequestDeps {
  load?: () => Promise<EngineLive>
  fields?: (session: LiveSession, raw: string) => readonly RuntimeField[]
  recycle?: () => void
  /** Small budgets let tests exercise real eviction/fragmentation without allocating giant fixtures. */
  limits?: { reply?: number; cache?: number; sessions?: number; inline?: number; part?: number }
}

/** Private methods, available only on core's authenticated owner link. One active read per worker,
 * one cached response per token, and bounded LRU storage. Retrying an unacknowledged cursor is exact. */
export function engineLiveRequests(engine: ReaderEngine, deps: LiveRequestDeps = {}): ServiceRequests {
  const replies = new Map<string, Reply>()
  const parts = new Map<string, Reply>()
  const replyLimit = deps.limits?.reply ?? LIVE_RESULT_BYTES
  const cacheLimit = deps.limits?.cache ?? LIVE_CACHE_BYTES
  const sessionLimit = deps.limits?.sessions ?? LIVE_CACHE_SESSIONS
  const inlineLimit = deps.limits?.inline ?? READER_REPLY_BYTES
  const partSize = deps.limits?.part ?? LIVE_PART_BYTES
  let bytes = 0, pending = 0
  let streams: Promise<LiveStreams> | null = null
  const get = (): Promise<LiveStreams> => streams ??= (async () => {
    const adapter = await (deps.load ?? loadLive[engine])()
    const runtime = deps.fields ? undefined : await loadRuntime[engine]()
    const fields = deps.fields ?? ((session: LiveSession, raw: string) => transcriptFields(runtime, session, raw))
    return new LiveStreams(adapter, fields, runtime ? (line) => {
      let value: unknown
      try { value = JSON.parse(line) } catch { return null }
      return record(value) ? runtime.decode(value) : null
    } : undefined)
  })().catch((error) => { streams = null; throw error })
  // `release` only when core forgets the token: a failed read or an evicted reply drops the stream's
  // state, which a cursor rebuilds, but not where that stream found its file rewritten.
  const forget = async (token: string, release = false): Promise<void> => {
    const old = replies.get(token)
    if (old) { bytes -= old.bytes.length; replies.delete(token); parts.delete(old.id) }
    if (streams) (await streams).forget(token, release)
  }
  const failure = (error: string) => ({ version: LIVE_VERSION, error,
    retryable: error !== 'ENGINE_INVALID_REQUEST' && error !== 'ENGINE_REPLY_TOO_LARGE' })
  const fragment = (reply: Reply, offset: number): Record<string, unknown> => ({ version: LIVE_VERSION,
    part: reply.id, offset, bytes: reply.bytes.length, hash: reply.hash,
    data: reply.bytes.subarray(offset, offset + partSize).toString('base64') })
  const answer = (reply: Reply): Record<string, unknown> => reply.bytes.length <= inlineLimit
    ? JSON.parse(reply.bytes.toString('utf8')) as Record<string, unknown> : fragment(reply, 0)

  const handler = (type: string): ServiceRequests[string] => async (payload, asker, closed) => {
    if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== LIVE_VERSION) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
    if (type === LIVE_CAPABILITIES) return { version: LIVE_VERSION, live: LIVE_VERSION, engine }
    if (type === LIVE_PART) {
      if (!label(payload.part) || !position(payload.offset)) return failure('ENGINE_INVALID_REQUEST')
      const reply = parts.get(payload.part)
      return reply && payload.offset < reply.bytes.length ? fragment(reply, payload.offset) : failure('ENGINE_STALE_REPLY')
    }
    if (!label(payload.token)) return failure('ENGINE_INVALID_REQUEST')
    if (pending >= LIVE_IN_FLIGHT) return failure('ENGINE_BUSY')
    if (type === LIVE_FORGET) { await forget(payload.token, true); return { version: LIVE_VERSION, forgotten: true } }
    const ask = pullOf(payload, engine)
    if (!ask || (type === LIVE_PREPARE && ask.cursor !== null) || (type === LIVE_READ && ask.cursor === null)
      || (type === LIVE_CLOSE && (!ask.cursor || typeof payload.identity !== 'string'
        || !['cancel', 'abandoned', 'hook'].includes(payload.reason as string)))) return failure('ENGINE_INVALID_REQUEST')
    const input = JSON.stringify([type, ask, payload.identity, payload.reason])
    const previous = replies.get(ask.token)
    if (previous?.input === input) {
      replies.delete(ask.token); replies.set(ask.token, previous)
      return answer(previous)
    }
    pending++
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>((resolve) => {
      timer = setTimeout(() => { resolve(failure('ENGINE_UNAVAILABLE')); (deps.recycle ?? (() => process.exit(1)))() }, LIVE_WAIT_MS)
    })
    try {
      return await Promise.race([deadline, (async () => {
        const worker = await get()
        const value = type === LIVE_CLOSE
          ? await worker.close(ask, payload.identity as string, payload.reason as 'cancel' | 'abandoned' | 'hook')
          : await worker.pull(ask)
        if (closed?.aborted) { await forget(ask.token); return failure('ENGINE_UNAVAILABLE') }
        const result = Buffer.from(JSON.stringify({ version: LIVE_VERSION, answer: value }))
        if (result.length > replyLimit || result.length > cacheLimit) {
          await forget(ask.token)
          return failure('ENGINE_REPLY_TOO_LARGE')
        }
        if (previous) { bytes -= previous.bytes.length; replies.delete(ask.token); parts.delete(previous.id) }
        while (bytes + result.length > cacheLimit || replies.size >= sessionLimit) await forget(replies.keys().next().value!)
        const reply: Reply = { input, id: randomUUID(), bytes: result, hash: createHash('sha256').update(result).digest('hex') }
        replies.set(ask.token, reply); parts.set(reply.id, reply); bytes += result.length
        return answer(reply)
      })()])
    } catch (error) {
      await forget(ask.token)
      return failure(error instanceof Error && ['ENGINE_TRANSCRIPT_CHANGED', 'ENGINE_CONTROL_BOUNDARY_CHANGED'].includes(error.message)
        ? error.message : 'ENGINE_UNAVAILABLE')
    } finally { clearTimeout(timer); pending-- }
  }
  return Object.fromEntries([LIVE_CAPABILITIES, LIVE_PREPARE, LIVE_READ, LIVE_PART, LIVE_CLOSE, LIVE_FORGET].map(type => [type, handler(type)]))
}
