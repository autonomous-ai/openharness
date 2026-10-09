import { randomBytes } from 'node:crypto'
import type { EngineQuestionControl } from '../../engines/facets/questionControl.js'
import { createQuestionControlHost } from '../../engines/worker/questionControlHost.js'
import { questionControlAction, questionControlEnvelope, questionControlStep, questionStepText,
  QUESTION_CONTROL_APPLY, QUESTION_CONTROL_CAPABILITIES, QUESTION_CONTROL_HOST, QUESTION_CONTROL_IN_FLIGHT,
  QUESTION_CONTROL_QUERY_MS, QUESTION_CONTROL_VERSION, QUESTION_CONTROL_WAIT_MS, QUESTION_CONTROL_WRITES } from '../../engines/worker/questionControlProtocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { QuestionControlFor, QuestionStepFailure } from '../../lib/questionControl.js'
import { boundedControl, createControlTransport, type ControlTransportDeps } from './controlTransport.js'

export interface QuestionControlsDeps extends ControlTransportDeps {
  inline(engine: string): EngineQuestionControl | undefined
  text(target: string, text: string, allowed: () => boolean): Promise<boolean>
  key(target: string, key: string, allowed: () => boolean): Promise<boolean>
}
const unavailable = () => new Error('question control unavailable')
interface Grant {
  service: string
  session: RegisteredSession
  text: string | undefined
  allowed(): boolean
  pending: boolean
  writes: number
  /** Writes handed to the terminal: any one of them may have gone in, whatever the step's outcome. */
  dispatched: number
}

/** The worker navigates one approved step; it never receives the pending answer map or a pane locator. */
export function createQuestionControls(deps: QuestionControlsDeps) {
  const grants = new Map<string, Grant>()
  const transport = createControlTransport(deps, {
    version: QUESTION_CONTROL_VERSION, capabilities: QUESTION_CONTROL_CAPABILITIES, inFlight: QUESTION_CONTROL_IN_FLIGHT,
    capable: (reply, engine) => questionControlEnvelope(reply, ['questionControl', 'engine']) && reply.questionControl === QUESTION_CONTROL_VERSION && reply.engine === engine,
    result: reply => { if (!questionControlEnvelope(reply, ['ok', 'error']) || reply.error !== undefined || reply.ok !== true) throw unavailable() },
    unavailable, error: unavailable,
    connectionChanged: service => { for (const [token, grant] of grants) if (grant.service === service) grants.delete(token) },
  })
  const answer = (service: string, query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> | null => {
    if (query !== QUESTION_CONTROL_HOST) return null
    return (async () => {
      const denied = { version: QUESTION_CONTROL_VERSION, error: 'ANSWER_FAILED' }
      if (!questionControlEnvelope(payload, ['query', 'token', 'action']) || typeof payload.token !== 'string' || !questionControlAction(payload.action)) return denied
      const grant = grants.get(payload.token), action = payload.action
      if (!grant || grant.service !== service) return denied
      if (!grant.allowed() || grant.pending || ++grant.writes > QUESTION_CONTROL_WRITES
        || (action.kind === 'text' && action.text !== grant.text)) { grants.delete(payload.token); return denied }
      // The approved text goes in once: typed a second time it would be a different answer from the one approved.
      if (action.kind === 'text') grant.text = undefined
      grant.pending = true
      grant.dispatched++
      try {
        const value = await boundedControl(action.kind === 'text'
          ? deps.text(grant.session.agentId, action.text, grant.allowed)
          : deps.key(grant.session.agentId, action.key, grant.allowed), QUESTION_CONTROL_QUERY_MS, unavailable)
        if (!grant.allowed() || typeof value !== 'boolean') { grants.delete(payload.token); return denied }
        if (!value) grants.delete(payload.token) // A failed or uncertain write never authorizes another key.
        return { version: QUESTION_CONTROL_VERSION, value }
      } catch { grants.delete(payload.token); return denied }
      finally { grant.pending = false }
    })()
  }
  const forSession: QuestionControlFor = registered => {
    const bound = transport.bind(registered)
    if (!bound) return undefined
    const { session, engine, service, isolated, run } = bound
    let failure: QuestionStepFailure | undefined
    return { failure: () => failure, apply: async step => {
      const token = randomBytes(32).toString('hex')
      let admitted: Grant | undefined
      failure = undefined
      try {
        return await run(QUESTION_CONTROL_WAIT_MS, async (allowed, call) => {
          if (!questionControlStep(step)) throw unavailable()
          const value = structuredClone(step)
          admitted = { service, session, text: questionStepText(value), allowed: () => allowed() && grants.has(token), pending: false, writes: 0, dispatched: 0 }
          grants.set(token, admitted)
          if (isolated) await call(QUESTION_CONTROL_APPLY, { step: value, token })
          else {
            const control = deps.inline(engine)
            if (!control || !await control.apply(value, createQuestionControlHost(action => answer(service, QUESTION_CONTROL_HOST, { version: QUESTION_CONTROL_VERSION, token, action })!))) throw unavailable()
          }
          const grant = grants.get(token)
          if (!grant || grant.pending) throw unavailable()
          return true
        })
      } catch {
        // A step that dispatched nothing typed nothing; one that dispatched a write may have answered (found by
        // the chaos run: the worker killed after the last key, the dialog closed, and the answer was reported failed).
        failure = admitted && admitted.dispatched > 0 ? 'uncertain' : 'refused'
        return false
      } finally { grants.delete(token) }
    } }
  }
  return { forSession, answer, connected: transport.connected, disconnected: transport.disconnected }
}
