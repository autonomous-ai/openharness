/** Optional profile readers and their derived targets live with the other engines' worker. */
import type { RegisteredSession } from '../../lib/registry.js'
import type { RuntimeContext } from '../facets/runtime.js'
import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import { loadEngine } from '../inProcess.js'
import { blankRuntimeState, encodeRuntimeProfile, stripAnsi } from '../kit/runtime.js'
import type { RuntimeReader } from '../worker/runtimeRequests.js'
import type { OtherEngine } from '../otherEngines.js'

export const PROFILE_SESSIONS = 512
export function otherRuntimeReaders() {
  const readers = new Map<OtherEngine, InlineRuntimeReader>()
  const sessions = new Map<string, { engine: OtherEngine; sessionId: string }>()
  const retain = (engine: OtherEngine, sessionId: string): void => {
    const key = `${engine}\0${sessionId}`
    sessions.delete(key)
    sessions.set(key, { engine, sessionId })
    while (sessions.size > PROFILE_SESSIONS) {
      const [old, session] = sessions.entries().next().value!
      sessions.delete(old)
      readers.get(session.engine)?.forget?.(session.sessionId)
    }
  }
  return {
    clear(): void {
      for (const { engine, sessionId } of sessions.values()) readers.get(engine)?.forget?.(sessionId)
      sessions.clear()
    },
    async load(engine: OtherEngine): Promise<RuntimeReader> {
      const module = await loadEngine(engine)
      const reader = module?.createRuntimeProfileReader()
      if (!reader || reader.engine !== engine) throw Error('ENGINE_UNAVAILABLE')
      readers.set(engine, reader)
      const context = (value: RuntimeContext, refreshConfig: () => void): InlineRuntimeContext => {
        retain(engine, value.session.sessionId)
        return { ...value, session: value.session as RegisteredSession, refreshConfig }
      }
      return {
        async pane(value, text) {
          let refresh = false
          const captured = context(value, () => { refresh = true })
          if (reader.pane?.(captured, stripAnsi(text)) === false) return false
          if (refresh) return { refreshConfig: true }
        },
        async config(value) { if (!await reader.config?.(context(value, () => {}))) return false },
        selectedModel: (session, state) => state.model && state.effort
          ? encodeRuntimeProfile({ sessionId: session.agentId, engine, model: state.model, effort: state.effort }) : null,
        // Only OpenCode has a shipped driver in this worker. The remaining engines stay view-only.
        models: async (session, state) => engine === 'opencode'
          ? await reader.models?.(context({ session, state: state ?? blankRuntimeState() }, () => {})) ?? [] : [],
        catalog: async session => engine === 'opencode' ? await reader.modelCatalog?.(session as RegisteredSession) ?? [] : [],
        supportsControl: session => engine === 'opencode' && (reader.supportsControl?.(session as RegisteredSession) ?? false),
      }
    },
  }
}
