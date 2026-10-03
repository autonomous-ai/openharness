import { describe, expect, it, vi } from 'vitest'
import { QuestionInbox, type ReviewedAnswer } from './questionInbox.js'

const question = () => [{ key: 'scope', q: 'Which scope?', options: ['This file', 'Whole project'], multi: false }]
function read(inbox: QuestionInbox, id = 'a') {
  const state = inbox.read(id)
  expect(state.ok).toBe(true)
  if (!state.ok) throw new Error(state.error)
  return state
}
describe('QuestionInbox', () => {
  it('retains separate agents and immutable contents without resetting on reannounce', () => {
    const inbox = new QuestionInbox(), source = question()
    inbox.set('a', 'qa', source)
    const a = read(inbox)
    source[0].options[0] = 'changed'
    inbox.set('b', 'qb', question())
    inbox.set('a', 'qa', question())
    expect(read(inbox).token).toBe(a.token)
    expect(read(inbox).questions[0].options[0]).toBe('This file')
    expect(read(inbox, 'b').token).not.toBe(a.token)
    inbox.close('a', 'old')
    expect(read(inbox).token).toBe(a.token)
    inbox.close('a', 'qa')
    expect(inbox.read('a').ok).toBe(false)
  })
  it('refuses replaced tokens, invalid masks and missing choices without input', async () => {
    const inbox = new QuestionInbox(), send = vi.fn(async () => ({ ok: true as const }))
    inbox.set('a', 'q', question()); const old = read(inbox)
    const changed = question(); changed[0].options[1] = 'Everything'
    inbox.set('a', 'q', changed); const current = read(inbox)
    expect(current.token).not.toBe(old.token)
    for (const [token, masks] of [[old.token, [1]], [current.token, []], [current.token, [0]],
      [current.token, [3]], [current.token, [4]], [current.token, [1.2]]] as const) {
      expect((await inbox.submit('a', token, masks, send)).ok).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })
  it('delivers the exact reviewed labels once, including commas, and retains the receipt', async () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'q', [{ key: 'pick', q: 'Pick formats', options: ['CSV, UTF-8', 'JSON', 'XML'], multi: true }])
    const send = vi.fn(async (_answer: ReviewedAnswer) => ({ ok: true as const })), token = read(inbox).token
    const one = inbox.submit('a', token, [3], send), duplicate = inbox.submit('a', token, [4], send)
    expect(duplicate).toBe(one)
    expect(await one).toEqual({ ok: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ requestId: 'q', selections: { pick: ['CSV, UTF-8', 'JSON'] } })
    expect(read(inbox).submitted).toBe(true)
    await inbox.submit('a', token, [1], send)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('does not retry uncertain input or send after a question closes while queued', async () => {
    const inbox = new QuestionInbox(), send = vi.fn(async () => { throw new Error('lost receipt') })
    inbox.set('a', 'q', question()); let token = read(inbox).token
    const first = await inbox.submit('a', token, [1], send)
    expect(first.ok).toBe(false)
    expect(await inbox.submit('a', token, [1], send)).toEqual(first)
    expect(send).toHaveBeenCalledTimes(1)
    inbox.set('a', 'q2', question()); token = read(inbox).token
    const queued = inbox.submit('a', token, [1], send)
    inbox.close('a', 'q2')
    expect((await queued).ok).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('refuses oversized or ambiguous catalogs and bounds the pending set', () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'q', [...question(), ...question()])
    expect(inbox.read('a').ok).toBe(false)
    inbox.set('a', 'q', [{ ...question()[0], q: 'x'.repeat(7000) }])
    expect(inbox.read('a').ok).toBe(false)
    for (let i = 0; i < 65; i++) inbox.set(`agent-${i}`, 'q', question())
    expect(inbox.read('agent-0').ok).toBe(false)
    expect(inbox.read('agent-64').ok).toBe(true)
  })
})

describe('spoken answer drafts', () => {
  const spoken = () => [{ ...question()[0], canText: true }]
  it('keeps a full draft inert until its exact id is explicitly submitted', async () => {
    const inbox = new QuestionInbox(), send = vi.fn(async (_a: ReviewedAnswer) => ({ ok: true as const }))
    inbox.set('a', 'q', spoken()); const token = read(inbox).token
    const pin = { agentId: 'a', token, index: 0 }
    expect(inbox.canSpeak(pin)).toBe(true)
    const draft = inbox.draft(pin, 'This file, but leave the tests alone.')
    if (!draft.ok) throw new Error(draft.error)
    expect(send).not.toHaveBeenCalled()
    for (const [masks, drafts] of [[[1], [draft.draftId]], [[0], ['wrong']], [[0], []]] as const)
      expect((await inbox.submit('a', token, masks, send, drafts)).ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(await inbox.submit('a', token, [0], send, [draft.draftId])).toEqual({ ok: true })
    expect(send.mock.calls[0][0]).toMatchObject({ answers: { scope: draft.text }, freeTextKeys: ['scope'] })
    await inbox.submit('a', token, [0], send, [draft.draftId])
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('rejects superseded drafts, closed questions, unsupported speech and incomplete text', async () => {
    const inbox = new QuestionInbox(), send = vi.fn(async () => ({ ok: true as const }))
    inbox.set('a', 'q', spoken()); const token = read(inbox).token, pin = { agentId: 'a', token, index: 0 }
    for (const text of ['', 'x'.repeat(1201), 'x\u001b[31m', 'x\tEnter']) expect(inbox.draft(pin, text).ok).toBe(false)
    const first = inbox.draft(pin, 'First'), second = inbox.draft(pin, 'Second')
    if (!first.ok || !second.ok) throw new Error('draft')
    expect((await inbox.submit('a', token, [0], send, [first.draftId])).ok).toBe(false)
    inbox.close('a', 'q')
    expect(inbox.draft(pin, 'Late').ok).toBe(false)
    expect((await inbox.submit('a', token, [0], send, [second.draftId])).ok).toBe(false)
    for (const q of [question()[0], { ...spoken()[0], multi: true }]) {
      inbox.set('a', 'q2', [q])
      expect(inbox.canSpeak({ ...pin, token: read(inbox).token })).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })
})
