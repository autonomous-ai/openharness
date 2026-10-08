import { randomBytes } from 'node:crypto'
import type { EngineModelControl } from '../../engines/facets/modelControl.js'
import { RuntimeProfileControlError, type RuntimeProfileErrorCode } from '../../engines/facets/modelControl.js'
import type { RuntimeCatalogModel, RuntimeProfile } from '../../engines/facets/runtime.js'
import { readerEngine, READER_SERVICES } from '../../engines/worker/protocol.js'
import { createModelControlHost } from '../../engines/worker/modelControlHost.js'
import { modelControlAction, modelControlAnswer, modelControlCheck, modelControlEnvelope, modelControlInput, modelControlSize,
  MODEL_CONTROL_APPLY, MODEL_CONTROL_CAPABILITIES, MODEL_CONTROL_CHECK_MS, MODEL_CONTROL_ERRORS, MODEL_CONTROL_HOST,
  MODEL_CONTROL_IN_FLIGHT, MODEL_CONTROL_QUERIES, MODEL_CONTROL_QUERY_MS, MODEL_CONTROL_VALIDATE,
  MODEL_CONTROL_VERSION, MODEL_CONTROL_WAIT_MS, MODEL_CONTROL_WRITES } from '../../engines/worker/modelControlProtocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { ModelControlFor } from '../../lib/modelControl.js'
import { sessionBinding } from './sessionBinding.js'

export interface ModelControlsDeps {
  handles(engine: string): boolean
  inline(engine: string): EngineModelControl | undefined
  resolve(id: string): RegisteredSession | undefined
  call(service: string, method: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  catalog(session: RegisteredSession): Promise<RuntimeCatalogModel[]>
  capture(target: string, lines: number): Promise<string | null>
  text(target: string, text: string, allowed: () => boolean): Promise<boolean>
  key(target: string, key: string, allowed: () => boolean): Promise<boolean>
  waitForModel(sessionId: string, ms: number): Promise<boolean>
  waitForProfile(sessionId: string, ms: number): Promise<boolean>
  confirmEffort(sessionId: string, effort: string): void
}
function fail(): never { throw new RuntimeProfileControlError('BUSY') }
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RuntimeProfileControlError('BUSY')), ms) })]) }
  finally { clearTimeout(timer) }
}
interface Grant {
  service: string
  session: RegisteredSession
  target: RuntimeProfile
  allowed(): boolean
  pending: boolean
  queries: number
  writes: number
}

/** Core holds identity, input authority and confirmation state. Workers receive none of those handles. */
export function createModelControls(deps: ModelControlsDeps) {
  const states = new Map(Object.values(READER_SERVICES).map(service => [service as string, { generation: 0, connected: false, capable: false, pending: 0 }]))
  const grants = new Map<string, Grant>()
  const answer = (service: string, query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> | null => {
    if (query !== MODEL_CONTROL_HOST) return null
    return (async () => {
      const denied = { version: MODEL_CONTROL_VERSION, error: 'BUSY' }
      // query/requestId are supplied by the authenticated link, not terminal authority.
      if (!modelControlEnvelope(payload, ['query', 'token', 'action']) || typeof payload.token !== 'string' || !modelControlAction(payload.action)) return denied
      const grant = grants.get(payload.token), action = payload.action
      if (!grant || grant.service !== service) return denied
      if (!grant.allowed() || grant.pending || ++grant.queries > MODEL_CONTROL_QUERIES
        || ((action.kind === 'text' || action.kind === 'key') && ++grant.writes > MODEL_CONTROL_WRITES)
        || (action.kind === 'confirmEffort' && action.effort !== grant.target.effort)) { grants.delete(payload.token); return denied }
      grant.pending = true
      try {
        const { session, allowed } = grant
        const value = await bounded((async () => {
          if (action.kind === 'catalog') return deps.catalog(session)
          if (action.kind === 'capture') return deps.capture(session.agentId, action.lines)
          if (action.kind === 'text') return deps.text(session.agentId, action.text, allowed)
          if (action.kind === 'key') return deps.key(session.agentId, action.key, allowed)
          if (action.kind === 'waitForModel') return deps.waitForModel(session.sessionId, action.ms)
          if (action.kind === 'waitForProfile') return deps.waitForProfile(session.sessionId, action.ms)
          deps.confirmEffort(session.sessionId, action.effort)
          return true
        })(), MODEL_CONTROL_QUERY_MS)
        const reply = { version: MODEL_CONTROL_VERSION, value }
        if (!allowed() || !modelControlAnswer(action, value) || !modelControlSize(reply)) { grants.delete(payload.token); return denied }
        return reply
      } catch { grants.delete(payload.token); return denied }
      finally { grant.pending = false }
    })()
  }
  const forSession: ModelControlFor = registered => {
    const engine = registered.engine
    if (!readerEngine(engine)) return undefined
    // Snapshot before the controller's first await: in-place registry edits cannot retarget this request.
    const session = structuredClone(registered), binding = sessionBinding(registered), service = READER_SERVICES[engine]
    const isolated = deps.handles(engine), state = states.get(service)!
    const generation = state.generation + (state.connected ? 0 : 1)
    const sameSession = () => sessionBinding(deps.resolve(session.agentId)) === binding
    const current = () => sameSession() && (!isolated || (state.connected && state.generation === generation))
    let catalog: RuntimeCatalogModel[] = []
    const run = async (ms: number, work: (allowed: () => boolean, call: (method: string, payload: Record<string, unknown>) => Promise<void>) => Promise<void>) => {
      if (!sameSession() || state.pending >= MODEL_CONTROL_IN_FLIGHT) fail()
      state.pending++
      let active = true
      const deadline = performance.now() + ms
      const allowed = () => active && performance.now() < deadline && current()
      const call = async (method: string, payload: Record<string, unknown>) => {
        const reply = await deps.call(service, method, { version: MODEL_CONTROL_VERSION, ...payload }, Math.max(1, Math.ceil(deadline - performance.now())))
        if (!allowed() || !modelControlEnvelope(reply, ['ok', 'error'])) fail()
        if (reply.error !== undefined) throw new RuntimeProfileControlError(MODEL_CONTROL_ERRORS.includes(reply.error as RuntimeProfileErrorCode) ? reply.error as RuntimeProfileErrorCode : 'BUSY')
        if (reply.ok !== true) fail()
      }
      try {
        await bounded((async () => {
          if (isolated && !state.capable) {
            // Allow only the first startup connection. A replacement cannot resume an old UI intent.
            if (state.generation !== generation && (state.connected || state.generation !== generation - 1)) fail()
            const reply = await deps.call(service, MODEL_CONTROL_CAPABILITIES, { version: MODEL_CONTROL_VERSION }, ms)
            if (!allowed() || !modelControlEnvelope(reply, ['modelControl', 'engine']) || reply.modelControl !== MODEL_CONTROL_VERSION || reply.engine !== engine) fail()
            state.capable = true
          }
          if (!allowed()) fail()
          await work(allowed, call)
          if (!allowed()) fail()
        })(), ms)
      } catch (error) { throw error instanceof RuntimeProfileControlError ? error : new RuntimeProfileControlError('BUSY') }
      finally { active = false; state.pending-- }
    }
    return {
      validate: check => run(MODEL_CONTROL_CHECK_MS, async (allowed, call) => {
        if (check.stage === 'target') catalog = await deps.catalog(session)
        const value = modelControlCheck({ ...check, session, catalog }, engine)
        if (!allowed() || !value) fail()
        if (isolated) await call(MODEL_CONTROL_VALIDATE, { check: value })
        else { const control = deps.inline(engine); if (!control) fail(); await control.validate(value!) }
      }),
      apply: async input => {
        const token = randomBytes(32).toString('hex')
        try { await run(MODEL_CONTROL_WAIT_MS, async (allowed, call) => {
          const value = modelControlInput({ ...input, session, catalog }, engine)
          if (!value) fail()
          grants.set(token, { service, session, target: value!.target, allowed: () => allowed() && grants.has(token), pending: false, queries: 0, writes: 0 })
          if (isolated) await call(MODEL_CONTROL_APPLY, { input: value, token })
          else {
            const control = deps.inline(engine); if (!control) fail()
            await control.apply(value!, createModelControlHost(action => answer(service, MODEL_CONTROL_HOST, { version: MODEL_CONTROL_VERSION, token, action })!))
          }
          const grant = grants.get(token)
          if (!grant || grant.pending) fail()
        }) } finally { grants.delete(token) }
      },
    }
  }
  const connection = (service: string, connected: boolean) => {
    const state = states.get(service)
    if (state) { state.generation++; state.connected = connected; state.capable = false }
    for (const [token, grant] of grants) if (grant.service === service) grants.delete(token)
  }
  return { forSession, answer, connected: (service: string) => connection(service, true), disconnected: (service: string) => connection(service, false) }
}
