/** Cloud owns the wording, choices and notification policy; core only admits the prepared frames. */
import type { CloudQuestionClose, CloudQuestionPresentation } from '../core/api.js'

export function cloudQuestionClose(agentId: string, requestId: string): CloudQuestionClose {
  return { type: 'commander_question_close', agentId, dbSessionId: agentId, payload: { requestId } }
}
export function prepareCloudQuestion(agentId: string, requestId: string, question: { text: string; choices: string[] }): CloudQuestionPresentation {
  const choices = (Array.isArray(question.choices) ? question.choices : [])
    .filter((choice): choice is string => typeof choice === 'string' && !!choice).slice(0, 6).map(choice => choice.slice(0, 500))
  return { frame: { type: 'commander_question', agentId, dbSessionId: agentId,
    payload: { requestId, questions: [{ key: 'answer', q: question.text.slice(0, 500), options: choices, multi: false, canText: true }],
      notification: { id: requestId, kind: 'needsYou' } } }, close: cloudQuestionClose(agentId, requestId), dial: choices.length > 0 }
}
