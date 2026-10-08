import type { ServiceRequests } from '../../core/api.js'
import { RuntimeProfileControlError, type EngineModelControl } from '../facets/modelControl.js'
import type { ReaderEngine } from './protocol.js'
import { createModelControlHost } from './modelControlHost.js'
import { modelControlCheck, modelControlEnvelope, modelControlInput, modelControlToken,
  MODEL_CONTROL_APPLY, MODEL_CONTROL_CAPABILITIES, MODEL_CONTROL_CHECK_MS, MODEL_CONTROL_HOST, MODEL_CONTROL_IN_FLIGHT,
  MODEL_CONTROL_QUERY_MS, MODEL_CONTROL_VALIDATE, MODEL_CONTROL_VERSION, MODEL_CONTROL_WAIT_MS } from './modelControlProtocol.js'

const loadControl = {
  claude: async () => (await import('../claude/modelControl.js')).modelControl,
  codex: async () => (await import('../codex/modelControl.js')).modelControl,
}
export interface ModelControlRequestDeps {
  query(query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  load?: () => Promise<EngineModelControl>
  recycle?: () => void
}

export function engineModelControlRequests(engine: ReaderEngine, deps: ModelControlRequestDeps): ServiceRequests {
  let loaded: Promise<EngineModelControl> | null = null
  let pending = 0
  const failure = (error: string) => ({ version: MODEL_CONTROL_VERSION, error })
  const recycle = deps.recycle ?? (() => process.exit(1))
  const handler = (method: string): ServiceRequests[string] => async (payload, asker, closed) => {
    if (!asker.owner || !asker.local || asker.connection !== undefined) return failure('BUSY')
    const names = method === MODEL_CONTROL_CAPABILITIES ? [] : method === MODEL_CONTROL_VALIDATE ? ['check'] : ['input', 'token']
    if (!modelControlEnvelope(payload, names)) return failure('INVALID_RUNTIME_PROFILE')
    if (closed?.aborted) return failure('BUSY')
    if (method === MODEL_CONTROL_CAPABILITIES) return { version: MODEL_CONTROL_VERSION, modelControl: MODEL_CONTROL_VERSION, engine }
    const check = method === MODEL_CONTROL_VALIDATE ? modelControlCheck(payload.check, engine) : null
    const input = method === MODEL_CONTROL_APPLY ? modelControlInput(payload.input, engine) : null
    if (!(check || (input && modelControlToken(payload.token)))) return failure('INVALID_RUNTIME_PROFILE')
    if (pending >= MODEL_CONTROL_IN_FLIGHT) return failure('BUSY')
    pending++
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const stopped = new Promise<Record<string, unknown>>(resolve => {
      abort = () => { active = false; resolve(failure('BUSY')) }
      closed?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { abort!(); recycle() }, input ? MODEL_CONTROL_WAIT_MS : MODEL_CONTROL_CHECK_MS)
    })
    const valid = () => { if (!active) throw new RuntimeProfileControlError('BUSY') }
    const host = createModelControlHost(async action => {
      valid()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const reply = await Promise.race([
          deps.query(MODEL_CONTROL_HOST, { version: MODEL_CONTROL_VERSION, token: payload.token, action }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => {
            active = false; reject(new RuntimeProfileControlError('BUSY')); recycle()
          }, MODEL_CONTROL_QUERY_MS) }),
        ])
        valid()
        return reply
      } finally { clearTimeout(timeout) }
    })
    try {
      return await Promise.race([stopped, (async () => {
        const control = await (loaded ??= (deps.load ?? loadControl[engine])().catch(error => { loaded = null; throw error }))
        valid()
        if (check) await control.validate(check)
        else await control.apply(input!, host)
        valid()
        return { version: MODEL_CONTROL_VERSION, ok: true }
      })()])
    } catch (error) { return failure(error instanceof RuntimeProfileControlError ? error.code : 'BUSY') }
    finally { active = false; clearTimeout(timer); closed?.removeEventListener('abort', abort!); pending-- }
  }
  return { [MODEL_CONTROL_CAPABILITIES]: handler(MODEL_CONTROL_CAPABILITIES),
    [MODEL_CONTROL_VALIDATE]: handler(MODEL_CONTROL_VALIDATE), [MODEL_CONTROL_APPLY]: handler(MODEL_CONTROL_APPLY) }
}
