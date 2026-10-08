import type { ServiceRequests } from '../../core/api.js'
import type { EngineRuntime } from '../facets/runtime.js'
import { type ReaderEngine } from './protocol.js'
import { runtimeContext, runtimeOperation, RUNTIME_CAPABILITIES, RUNTIME_IN_FLIGHT, RUNTIME_READ,
  RUNTIME_REPLY_BYTES, RUNTIME_REQUEST_BYTES, RUNTIME_VERSION, RUNTIME_WAIT_MS, type RuntimeAnswer } from './runtimeProtocol.js'

const loadRuntime = {
  claude: async () => (await import('../claude/runtimeProfile.js')).runtime,
  codex: async () => (await import('../codex/runtimeProfile.js')).runtime,
}

export interface RuntimeRequestDeps {
  load?: () => Promise<EngineRuntime>
  recycle?: () => void
}

/** Each operation starts from a supplied value, so reconnecting never loses an acknowledged profile. */
export function engineRuntimeRequests(engine: ReaderEngine, deps: RuntimeRequestDeps = {}): ServiceRequests {
  let loaded: Promise<EngineRuntime> | null = null
  let pending = 0
  const failure = (error: string) => ({ version: RUNTIME_VERSION, error,
    retryable: error !== 'ENGINE_INVALID_REQUEST' && error !== 'ENGINE_REPLY_TOO_LARGE' })
  const handler = (type: string): ServiceRequests[string] => async (payload, asker, closed) => {
    if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== RUNTIME_VERSION) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
    if (type === RUNTIME_CAPABILITIES) return { version: RUNTIME_VERSION, runtime: RUNTIME_VERSION, engine }
    const context = runtimeContext(payload.context, engine)
    const operation = runtimeOperation(payload.operation)
    if (!context || !operation || Buffer.byteLength(JSON.stringify(payload)) > RUNTIME_REQUEST_BYTES) return failure('ENGINE_INVALID_REQUEST')
    if (pending >= RUNTIME_IN_FLIGHT) return failure('ENGINE_BUSY')
    pending++
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<Record<string, unknown>>(resolve => {
      timer = setTimeout(() => { resolve(failure('ENGINE_UNAVAILABLE')); (deps.recycle ?? (() => process.exit(1)))() }, RUNTIME_WAIT_MS)
    })
    try {
      return await Promise.race([deadline, (async () => {
        const adapter = await (loaded ??= (deps.load ?? loadRuntime[engine])().catch(error => { loaded = null; throw error }))
        const { session, state, control } = context
        const extra: Partial<RuntimeAnswer> = {}
        if (operation.kind === 'records') for (const evidence of operation.records) adapter.reduce(context, evidence)
        else if (operation.kind === 'pane') adapter.pane(context, operation.text)
        else if (operation.kind === 'config' && adapter.configuredEffort) {
          state.effort = await adapter.configuredEffort(session)
          state.observedAt = Date.now()
        } else if (operation.kind === 'models') extra.models = await adapter.models(session, state)
        else if (operation.kind === 'catalog') extra.catalog = await adapter.catalog?.(session) ?? []
        else if (operation.kind === 'effort') extra.effortAllowed = adapter.effortAllowed?.(operation.model, operation.effort, operation.listed) ?? false
        if (closed?.aborted) return failure('ENGINE_UNAVAILABLE')
        const answer: RuntimeAnswer = { state, cliVersion: session.cliVersion, control: control ?? null,
          selectedModel: adapter.selectedModel(session, state), supportsControl: adapter.supportsControl(session), ...extra }
        const reply = { version: RUNTIME_VERSION, answer }
        return Buffer.byteLength(JSON.stringify(reply)) <= RUNTIME_REPLY_BYTES ? reply : failure('ENGINE_REPLY_TOO_LARGE')
      })()])
    } catch { return failure('ENGINE_UNAVAILABLE') }
    finally { clearTimeout(timer); pending-- }
  }
  return { [RUNTIME_CAPABILITIES]: handler(RUNTIME_CAPABILITIES), [RUNTIME_READ]: handler(RUNTIME_READ) }
}
