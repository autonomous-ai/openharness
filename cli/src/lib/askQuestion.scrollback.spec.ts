import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AskQuestionController, parseEngineQuestionPane, questionRequestId, type QuestionView } from './askQuestion.js'
import { messageHold } from './messageHold.js'
import { CLAUDE_PROMPT, CODEX_PROMPT } from './__fixtures__/rewindPickers.js'
import type { RegisteredSession } from './registry.js'

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}.txt`, import.meta.url), 'utf8')

it('keeps a partial current Codex dialog open below an old composer', () => {
  const partial = `${CODEX_PROMPT}\n\n  3. None of the above\n  enter to submit answer | esc to interrupt`
  expect(parseEngineQuestionPane('codex', partial)).toMatchObject({ kind: 'question', partial: true })
  expect(messageHold('codex', partial)).toBe('question_open')
})

// A capture includes scrollback. Compose the recorded dialog and the engine's composer to reproduce
// the long chaos run: the answer was accepted, but the old dialog kept every later prompt on hold.
describe.each([
  ['claude', 'question-single', CLAUDE_PROMPT],
  ['codex', 'question-codex', CODEX_PROMPT],
] as const)('%s with an answered dialog in scrollback', (engine, name, composer) => {
  const dialog = fixture(name)
  const answered = `${dialog}\n\n${composer}`

  it('does not treat the old question or permission as open below a live composer', () => {
    for (const old of [dialog, fixture(`permission-${engine}`)]) {
      expect(parseEngineQuestionPane(engine, `${old}\n\n${composer}`)).toBeNull()
      expect(messageHold(engine, `${old}\n\n${composer}`)).toBeNull()
    }
  })

  it('still holds messages when the current dialog is below an old composer', () => {
    expect(messageHold(engine, `${composer}\n\n${dialog}`)).toBe('question_open')
    expect(messageHold(engine, `${composer}\n\n${fixture(`permission-${engine}`)}`)).toBe('permission_open')
  })

  it('finishes an answer once the composer returns, and refuses a late answer without keys', async () => {
    const session = { agentId: 'a1', sessionId: 's1', engine } as RegisteredSession
    const capture = vi.fn().mockResolvedValueOnce(dialog).mockResolvedValue(answered)
    const sendKey = vi.fn().mockResolvedValue(true)
    const sendText = vi.fn().mockResolvedValue(true)
    const controller = new AskQuestionController({ getSession: () => session, capture, sendKey, sendText, wait: async () => {} })
    const view = parseEngineQuestionPane(engine, dialog) as QuestionView
    const payload = { agentId: 'a1', requestId: questionRequestId('s1', view), answers: { [view.question]: view.rows[0].label } }
    expect(await controller.answer(payload)).toEqual({ ok: true })
    const count = sendKey.mock.calls.length
    expect(count).toBeGreaterThan(0)
    expect(await controller.answer(payload)).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(sendKey).toHaveBeenCalledTimes(count)
    expect(sendText).not.toHaveBeenCalled()
  })
})
