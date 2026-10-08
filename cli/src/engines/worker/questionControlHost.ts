import type { QuestionControlHost } from '../facets/questionControl.js'
import { questionControlEnvelope, type QuestionControlAction } from './questionControlProtocol.js'

export function createQuestionControlHost(ask: (action: QuestionControlAction) => Promise<Record<string, unknown>>): QuestionControlHost {
  const call = async (action: QuestionControlAction) => {
    const reply = await ask(action)
    if (!questionControlEnvelope(reply, ['value', 'error']) || reply.error !== undefined || typeof reply.value !== 'boolean') throw new Error('question control unavailable')
    return reply.value
  }
  return { key: key => call({ kind: 'key', key }), text: text => call({ kind: 'text', text }) }
}
