import type { ServiceRequests } from '../../core/api.js'
import type { EngineQuestionControl } from '../facets/questionControl.js'
import { controlToken } from './controlWire.js'
import { createQuestionControlHost } from './questionControlHost.js'
import { questionControlEnvelope, questionControlStep, QUESTION_CONTROL_APPLY, QUESTION_CONTROL_CAPABILITIES,
  QUESTION_CONTROL_HOST, QUESTION_CONTROL_IN_FLIGHT, QUESTION_CONTROL_QUERY_MS, QUESTION_CONTROL_VERSION, QUESTION_CONTROL_WAIT_MS } from './questionControlProtocol.js'
import type { ReaderEngine } from './protocol.js'

const loadControl = {
  claude: async () => (await import('../claude/questionControl.js')).questionControl,
  codex: async () => (await import('../codex/questionControl.js')).questionControl,
}
export interface QuestionControlRequestDeps {
  query(query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  load?: () => Promise<EngineQuestionControl>
  recycle?: () => void
}

export function engineQuestionControlRequests(engine: ReaderEngine, deps: QuestionControlRequestDeps): ServiceRequests {
  let loaded: Promise<EngineQuestionControl> | null = null
  let pending = 0
  const failure = () => ({ version: QUESTION_CONTROL_VERSION, error: 'ANSWER_FAILED' })
  const recycle = deps.recycle ?? (() => process.exit(1))
  const handler = (capability: boolean): ServiceRequests[string] => async (payload, asker, closed) => {
    if (!asker.owner || !asker.local || asker.connection !== undefined || closed?.aborted) return failure()
    if (!questionControlEnvelope(payload, capability ? [] : ['step', 'token'])) return failure()
    if (capability) return { version: QUESTION_CONTROL_VERSION, questionControl: QUESTION_CONTROL_VERSION, engine }
    if (!questionControlStep(payload.step) || !controlToken(payload.token) || pending >= QUESTION_CONTROL_IN_FLIGHT) return failure()
    const step = payload.step
    pending++
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const stopped = new Promise<Record<string, unknown>>(resolve => {
      abort = () => { active = false; resolve(failure()) }
      closed?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { abort!(); recycle() }, QUESTION_CONTROL_WAIT_MS)
    })
    const valid = () => { if (!active) throw new Error('question control revoked') }
    const host = createQuestionControlHost(async action => {
      valid()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const reply = await Promise.race([
          deps.query(QUESTION_CONTROL_HOST, { version: QUESTION_CONTROL_VERSION, token: payload.token, action }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => {
            active = false; reject(new Error('question host timeout')); recycle()
          }, QUESTION_CONTROL_QUERY_MS) }),
        ])
        valid()
        return reply
      } finally { clearTimeout(timeout) }
    })
    try {
      return await Promise.race([stopped, (async () => {
        const control = await (loaded ??= (deps.load ?? loadControl[engine])().catch(error => { loaded = null; throw error }))
        valid()
        const ok = await control.apply(step, host)
        valid()
        return ok ? { version: QUESTION_CONTROL_VERSION, ok: true } : failure()
      })()])
    } catch { return failure() }
    finally { active = false; clearTimeout(timer); closed?.removeEventListener('abort', abort!); pending-- }
  }
  return { [QUESTION_CONTROL_CAPABILITIES]: handler(true), [QUESTION_CONTROL_APPLY]: handler(false) }
}
