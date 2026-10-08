/**
 * Private, stateless readings in an engine worker: core sends text, the worker answers facts. Shared by the
 * screen and submission readers, each with its own version, bounds and validators. A worker gets no terminal
 * handle, no lease and no general core API: what it answers is all it can do.
 */
import type { ServiceRequests } from '../../core/api.js'

export interface SnapshotMethod<A> {
  /** The payload's own fields; `version` and the link's `requestId` are always allowed beside them. */
  fields: readonly string[]
  accepts(payload: Record<string, unknown>): boolean
  answer(adapter: A, payload: Record<string, unknown>): unknown | Promise<unknown>
  valid(answer: unknown, payload: Record<string, unknown>): boolean
}

export interface SnapshotSpec<A> {
  engine: string
  version: number
  capabilities: string
  /** The capability reply's field naming this reader's version. */
  capability: string
  inFlight: number
  waitMs: number
  replyBytes: number
  load(): Promise<A>
  /** A timed-out reading may still hold the worker; recycle it rather than accumulate abandoned work. */
  recycle(): void
  methods: Readonly<Record<string, SnapshotMethod<A>>>
}

export function snapshotRequests<A>(spec: SnapshotSpec<A>): ServiceRequests {
  let loaded: Promise<A> | null = null
  let pending = 0
  const failure = (error: string) => ({ version: spec.version, error })
  const handle = (method?: SnapshotMethod<A>): ServiceRequests[string] => async (payload, asker, closed) => {
    if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== spec.version) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
    if (!method) return { version: spec.version, [spec.capability]: spec.version, engine: spec.engine }
    // ServiceLinks adds its routing id inside the payload. It is transport
    // metadata, not a terminal capability or engine input.
    if (!method.accepts(payload) || Object.keys(payload).some(key => key !== 'version' && key !== 'requestId' && !method.fields.includes(key))
      || (payload.requestId !== undefined && (typeof payload.requestId !== 'string' || payload.requestId.length > 200))) return failure('ENGINE_INVALID_REQUEST')
    if (pending >= spec.inFlight) return failure('ENGINE_BUSY')
    pending++
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>(resolve => {
      timer = setTimeout(() => { resolve(failure('ENGINE_UNAVAILABLE')); spec.recycle() }, spec.waitMs)
    })
    try {
      return await Promise.race([deadline, (async () => {
        const adapter = await (loaded ??= spec.load().catch(error => { loaded = null; throw error }))
        if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
        const answer = await method.answer(adapter, payload)
        if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
        const reply = { version: spec.version, answer }
        if (Buffer.byteLength(JSON.stringify(reply)) > spec.replyBytes) return failure('ENGINE_REPLY_TOO_LARGE')
        return method.valid(answer, payload) ? reply : failure('ENGINE_INVALID_REPLY')
      })()])
    } catch { return failure('ENGINE_UNAVAILABLE') }
    finally { clearTimeout(timer); pending-- }
  }
  return Object.fromEntries([[spec.capabilities, handle()],
    ...Object.entries(spec.methods).map(([name, method]) => [name, handle(method)])])
}
