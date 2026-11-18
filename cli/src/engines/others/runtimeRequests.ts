/** Route captured reads and approved question steps to the fourteen engines in their one worker. */
import type { ServiceRequests } from '../../core/api.js'
import { isOtherEngine, OTHER_ENGINES, type OtherEngine } from '../otherEngines.js'
import { engineRuntimeRequests } from '../worker/runtimeRequests.js'
import { engineScreenRequests } from '../worker/screenRequests.js'
import { engineModelControlRequests } from '../worker/modelControlRequests.js'
import { MODEL_CONTROL_APPLY, MODEL_CONTROL_CAPABILITIES, MODEL_CONTROL_VALIDATE, MODEL_CONTROL_IN_FLIGHT, MODEL_CONTROL_VERSION } from '../worker/modelControlProtocol.js'
import { engineQuestionControlRequests } from '../worker/questionControlRequests.js'
import { RUNTIME_CAPABILITIES, RUNTIME_IN_FLIGHT, RUNTIME_READ, RUNTIME_VERSION } from '../worker/runtimeProtocol.js'
import { SCREEN_CAPABILITIES, SCREEN_IN_FLIGHT, SCREEN_READ, SCREEN_VERSION } from '../worker/screenProtocol.js'
import { QUESTION_CONTROL_APPLY, QUESTION_CONTROL_CAPABILITIES, QUESTION_CONTROL_IN_FLIGHT, QUESTION_CONTROL_VERSION } from '../worker/questionControlProtocol.js'
import { otherRuntimeReaders } from './runtime.js'
import { otherQuestionControl } from './questionControl.js'

export function otherRuntimeRequests(deps: {
  query(query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  recycle?: () => void
}) {
  const runtime = otherRuntimeReaders()
  const routes = new Map<OtherEngine | 'terminal', ServiceRequests>(OTHER_ENGINES.map(engine => [engine, {
    ...(engine === 'opencode' ? engineModelControlRequests(engine, deps) : {}),
    ...engineRuntimeRequests(engine, { load: () => runtime.load(engine), recycle: deps.recycle }),
    ...engineScreenRequests(engine, { load: async () => {
      const screen = await import('../../lib/legacyScreen.js')
      return { inspect: capture => screen.legacyScreen(engine, capture) }
    }, recycle: deps.recycle }),
    ...engineQuestionControlRequests(engine, { ...deps, load: async () => otherQuestionControl(engine) }),
  }]))
  routes.set('terminal', engineScreenRequests('terminal', { recycle: deps.recycle }))
  const groups = [
    { methods: [MODEL_CONTROL_CAPABILITIES, MODEL_CONTROL_VALIDATE, MODEL_CONTROL_APPLY], limit: MODEL_CONTROL_IN_FLIGHT, version: MODEL_CONTROL_VERSION, busy: 'BUSY' },
    { methods: [RUNTIME_CAPABILITIES, RUNTIME_READ], limit: RUNTIME_IN_FLIGHT, version: RUNTIME_VERSION, busy: 'ENGINE_BUSY' },
    { methods: [SCREEN_CAPABILITIES, SCREEN_READ], limit: SCREEN_IN_FLIGHT, version: SCREEN_VERSION, busy: 'ENGINE_BUSY' },
    { methods: [QUESTION_CONTROL_CAPABILITIES, QUESTION_CONTROL_APPLY], limit: QUESTION_CONTROL_IN_FLIGHT, version: QUESTION_CONTROL_VERSION, busy: 'ANSWER_FAILED' },
  ]
  const requests: Record<string, ServiceRequests[string]> = {}
  for (const group of groups) {
    let pending = 0
    for (const method of group.methods) requests[method] = async (payload, asker, closed) => {
      const { engine, ...snapshot } = payload
      if (!asker.owner || !asker.local || asker.connection !== undefined || typeof engine !== 'string' || !(isOtherEngine(engine) || engine === 'terminal')) {
        return { version: group.version, error: 'ENGINE_INVALID_REQUEST' }
      }
      const route = routes.get(engine)![method]
      if (!route) return { version: group.version, error: 'ENGINE_INVALID_REQUEST' }
      if (pending >= group.limit) return { version: group.version, error: group.busy }
      pending++
      try {
        return await route(snapshot, asker, closed)
      } finally { pending-- }
    }
  }
  return { requests, clear: runtime.clear }
}
