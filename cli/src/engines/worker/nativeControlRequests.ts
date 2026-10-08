import type { ServiceRequests } from '../../core/api.js'
import type { EngineNativeControl } from '../facets/nativeControl.js'
import { controlToken } from './controlWire.js'
import { createNativeStopHost, NATIVE_UNCONFIRMED } from './nativeControlHost.js'
import { boundConversation, nativeActivity, nativeConversation, nativeEnvelope, nativeMessage, NATIVE_ACTIVITY, NATIVE_ACTIVITY_IN_FLIGHT,
  NATIVE_ACTIVITY_WAIT_MS, NATIVE_CONTROL_CAPABILITIES, NATIVE_CONTROL_HOST, NATIVE_CONTROL_VERSION, NATIVE_QUERY_MS,
  NATIVE_RECOVER, NATIVE_RECOVER_WAIT_MS, NATIVE_REPLY_BYTES, NATIVE_STOP, NATIVE_STOP_IN_FLIGHT, NATIVE_STOP_WAIT_MS } from './nativeControlProtocol.js'
import { snapshotRequests } from './snapshotRequests.js'

const loadControl = { codex: async () => (await import('../codex/nativeControl.js')).nativeControl }
export interface NativeControlRequestDeps {
  query(query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  load?: () => Promise<EngineNativeControl>
  recycle?: () => void
}

/**
 * The engine's control connection, in its worker. An activity read is a snapshot like a screen's. A stop
 * runs under core's grant: it asks core before each effect, and ends when core stops answering, the
 * connection that sent it closes, or its deadline passes, which also recycles this worker.
 */
export function engineNativeControlRequests(engine: keyof typeof loadControl, deps: NativeControlRequestDeps): ServiceRequests {
  let loaded: Promise<EngineNativeControl> | null = null
  const load = () => loaded ??= (deps.load ?? loadControl[engine])().catch(error => { loaded = null; throw error })
  const recycle = () => (deps.recycle ?? (() => process.exit(1)))()
  const reads = snapshotRequests<EngineNativeControl>({
    engine, version: NATIVE_CONTROL_VERSION, capabilities: NATIVE_CONTROL_CAPABILITIES, capability: 'nativeControl',
    inFlight: NATIVE_ACTIVITY_IN_FLIGHT, waitMs: NATIVE_ACTIVITY_WAIT_MS, replyBytes: NATIVE_REPLY_BYTES, load, recycle,
    methods: {
      [NATIVE_ACTIVITY]: {
        fields: ['conversation'], accepts: payload => nativeConversation(payload.conversation),
        answer: (control, payload) => control.activity(payload.conversation as never),
        valid: answer => nativeActivity(answer),
      },
    },
  })
  // A recovery is one effect, rare, bounded: its own budget, so a slow one never starves activity reads.
  const recoveries = snapshotRequests<EngineNativeControl>({
    engine, version: NATIVE_CONTROL_VERSION, capabilities: NATIVE_CONTROL_CAPABILITIES, capability: 'nativeControl',
    inFlight: NATIVE_STOP_IN_FLIGHT, waitMs: NATIVE_RECOVER_WAIT_MS, replyBytes: NATIVE_REPLY_BYTES, load, recycle,
    methods: {
      [NATIVE_RECOVER]: {
        fields: ['conversation'], accepts: payload => boundConversation(payload.conversation),
        answer: async (control, payload) => { try { await control.recover(payload.conversation as never); return true } catch { return false } },
        valid: answer => typeof answer === 'boolean',
      },
    },
  })
  let pending = 0
  const failure = () => ({ version: NATIVE_CONTROL_VERSION, error: 'ENGINE_INVALID_REQUEST' })
  const stop: ServiceRequests[string] = async (payload, asker, closed) => {
    if (!asker.owner || !asker.local || asker.connection !== undefined || closed?.aborted) return failure()
    if (!nativeEnvelope(payload, ['token', 'conversation']) || !controlToken(payload.token) || !boundConversation(payload.conversation)) return failure()
    if (pending >= NATIVE_STOP_IN_FLIGHT) return { version: NATIVE_CONTROL_VERSION, error: 'ENGINE_BUSY' }
    const conversation = payload.conversation, token = payload.token
    pending++
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const refused = (message: string) => ({ version: NATIVE_CONTROL_VERSION, answer: { refused: message } })
    const ended = new Promise<Record<string, unknown>>(resolve => {
      abort = () => { active = false; resolve(refused(NATIVE_UNCONFIRMED)) }
      closed?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { abort!(); recycle() }, NATIVE_STOP_WAIT_MS)
    })
    const host = createNativeStopHost(async action => {
      if (!active) throw new Error(NATIVE_UNCONFIRMED)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const reply = await Promise.race([deps.query(NATIVE_CONTROL_HOST, { version: NATIVE_CONTROL_VERSION, token, action }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(NATIVE_UNCONFIRMED)), NATIVE_QUERY_MS) })])
        // Revoked while core answered: its answer authorizes nothing more.
        if (!active) throw new Error(NATIVE_UNCONFIRMED)
        return reply
      } catch (error) { active = false; throw error }
      finally { clearTimeout(timeout) }
    })
    try {
      return await Promise.race([ended, (async () => {
        const control = await load()
        if (!active) return refused(NATIVE_UNCONFIRMED)
        try { await control.stop(conversation, host) }
        catch (error) {
          const message = error instanceof Error ? error.message : ''
          return refused(nativeMessage(message) ? message : NATIVE_UNCONFIRMED)
        }
        return active ? { version: NATIVE_CONTROL_VERSION, answer: { stopped: true } } : refused(NATIVE_UNCONFIRMED)
      })()])
    } catch { return refused(NATIVE_UNCONFIRMED) }
    finally { active = false; clearTimeout(timer); closed?.removeEventListener('abort', abort!); pending-- }
  }
  return { ...reads, [NATIVE_RECOVER]: recoveries[NATIVE_RECOVER], [NATIVE_STOP]: stop }
}
