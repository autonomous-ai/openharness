import { describe, expect, it, vi } from 'vitest'
import { CABLE_MAX_PAYLOAD } from './cableFrame.js'
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
  it('bounds the pending set', () => {
    const inbox = new QuestionInbox()
    for (let i = 0; i < 65; i++) inbox.set(`agent-${i}`, 'q', question())
    expect(inbox.read('agent-0').ok).toBe(false)
    expect(inbox.read('agent-64').ok).toBe(true)
  })
  it('keeps the questions each agent asked last as they came, but none over a frame', () => {
    const inbox = new QuestionInbox(), source = question()
    inbox.set('a', 'qa', source)
    source[0].options[0] = 'changed'
    expect(inbox.asked('a', 'qa')).toEqual(question())
    expect(inbox.asked('a', 'old')).toBeUndefined()
    // The dial never read one over a frame, so no answer is in its words: 64 agents' worth were held for nothing.
    inbox.set('a', 'qb', [{ ...question()[0], options: ['x'.repeat(CABLE_MAX_PAYLOAD)] }])
    expect(inbox.asked('a', 'qb')).toBeUndefined()
    expect(() => inbox.set('a', 'qd', [{ ...question()[0], size: BigInt(1) }])).not.toThrow()
    expect(inbox.asked('a', 'qd')).toBeUndefined()
    inbox.set('a', 'qc', question())
    inbox.close('a', 'qc')
    expect(inbox.asked('a', 'qc')).toBeUndefined()
  })
  it('asks each question once until the dial loses it, and a drawer that carries one holds it as asked', () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'qa', question()); inbox.set('b', 'qb', question()); inbox.set('c', 'qc', question())
    expect(inbox.ask('a', 'qa')).toBe(true)
    expect(inbox.ask('a', 'qa')).toBe(false)
    expect(inbox.ask('a', 'old')).toBe(false)
    // A drawer naming b's question as a row puts it on the dial, asked or not; a's, which it does not name, is gone.
    inbox.forget(new Set(['b']))
    expect(inbox.ask('b', 'qb')).toBe(false)
    expect(inbox.ask('a', 'qa')).toBe(true)
    expect(inbox.ask('c', 'qc')).toBe(true)
    inbox.forget()
    expect(['a', 'b', 'c'].map((id) => inbox.ask(id, `q${id}`))).toEqual([true, true, true])
  })
  const notice = [{ key: 'notice', q: 'Tests pass.', options: ['In Terminal'] }]
  it('a held question is read, never asked, though the dial loses its questions', () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'shown:n1', notice, true)
    const state = read(inbox)
    expect(state.id).toBe('shown:n1')
    expect(state.questions[0].q).toBe('Tests pass.')
    expect(inbox.ask('a', 'shown:n1')).toBe(false)
    inbox.forget()
    inbox.forget(new Set())
    expect(inbox.ask('a', 'shown:n1')).toBe(false)
    inbox.set('a', 'shown:n1', notice)
    expect(inbox.ask('a', 'shown:n1')).toBe(false)
    expect(inbox.open()).toEqual([{ agentId: 'a', id: 'shown:n1',
      questions: [expect.objectContaining({ q: 'Tests pass.' })], held: true }])
  })
  it('a later question of the agent replaces a held one and is asked; a close under the held id removes it', () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'shown:n1', notice, true)
    inbox.set('a', 'q2', question())
    expect(inbox.ask('a', 'q2')).toBe(true)
    expect(inbox.open()[0]).not.toHaveProperty('held')
    const fresh = new QuestionInbox()
    fresh.set('a', 'shown:n1', notice, true)
    expect(fresh.close('a', 'shown:n1')).toBe(true)
    expect(fresh.read('a').ok).toBe(false)
  })
  it('remembers what the dial was told, by a ring or a drawer row, until the dial loses everything', () => {
    const inbox = new QuestionInbox()
    for (const agent of ['a', 'b', 'c']) inbox.set(agent, `q${agent}`, question())
    expect(inbox.told('a', 'qa')).toBe(false)
    expect(inbox.refile('a', 'qa')).toBe(false)   // never told: it is rung, not filed
    expect(inbox.ask('a', 'qa')).toBe(true)       // a ring tells it
    expect(inbox.told('a', 'qa')).toBe(true)
    expect(inbox.told('a', 'old')).toBe(false)    // not the open one
    expect(inbox.refile('a', 'qa')).toBe(false)   // the dial holds it
    inbox.forget(new Set(['b']))                  // a drawer that carries b's row and not a's
    expect(inbox.told('b', 'qb')).toBe(true)      // shown as a row: told, with no ring
    expect(inbox.refile('b', 'qb')).toBe(false)   // and the dial holds it
    expect(inbox.told('a', 'qa')).toBe(true)      // a replace never clears it
    expect(inbox.told('c', 'qc')).toBe(false)
    expect(inbox.refile('a', 'old')).toBe(false)
    expect(inbox.refile('a', 'qa')).toBe(true)    // back on the dial as a row
    expect(inbox.refile('a', 'qa')).toBe(false)
    expect(inbox.ask('a', 'qa')).toBe(false)
    inbox.forget()                                // a greeting: its RAM is gone
    expect(['a', 'b', 'c'].map((agent) => inbox.told(agent, `q${agent}`))).toEqual([false, false, false])
    expect(['a', 'b', 'c'].map((agent) => inbox.ask(agent, `q${agent}`))).toEqual([true, true, true])
    inbox.set('a', 'qa2', question())             // a new question id: a new entry, neither mark
    expect(inbox.told('a', 'qa2')).toBe(false)
    expect(inbox.ask('a', 'qa2')).toBe(true)
  })
  it('a held question was told, as it rang before: it goes back on the dial as a row, never as a ring', () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'shown:n1', notice, true)
    expect(inbox.told('a', 'shown:n1')).toBe(true)
    expect(inbox.ask('a', 'shown:n1')).toBe(false)
    expect(inbox.refile('a', 'shown:n1')).toBe(true)
  })
})

describe('a question the dial cannot answer', () => {
  const one = question()[0]
  const summaryOnly = (q: string) => [{ key: '', q, options: [], multi: false }]

  it('is kept as its summary, whatever made the inbox refuse it', () => {
    const refused: Array<[string, unknown, string]> = [
      ['five questions', Array.from({ length: 5 }, (_, i) => ({ ...one, key: `k${i}` })), 'Which scope?'],
      ['seven options', [{ ...one, options: ['1', '2', '3', '4', '5', '6', '7'] }], 'Which scope?'],
      ['no options', [{ ...one, options: [] }], 'Which scope?'],
      ['a duplicate key', [one, one], 'Which scope?'],
      ['over 6500 bytes', [{ ...one, q: `Approve  this\n\nplan? ${'x'.repeat(7000)}` }], `Approve this plan? ${'x'.repeat(220)}`],
      ['a BigInt beside its words', [{ ...one, options: [], size: BigInt(1) }], 'Which scope?'],
      ['a BigInt for text', [{ ...one, q: BigInt(7), options: [] }], 'Needs your answer'],
      ['no words', [{ ...one, q: ' \n ', options: [] }], 'Needs your answer'],
      ['no text', [{ key: 'k' }], 'Needs your answer'],
      ['a number for text', [{ ...one, q: 7, options: [] }], 'Needs your answer'],
      ['an empty list', [], 'Needs your answer'],
      ['not a list', 'approve?', 'Needs your answer'],
      ['a null question', [null], 'Needs your answer'],
    ]
    for (const [why, raw, words] of refused) {
      const inbox = new QuestionInbox()
      expect(inbox.set('a', 'q', raw), why).toBe(false)
      expect(read(inbox).questions, why).toEqual(summaryOnly(words))
      expect(inbox.open(), why).toEqual([{ agentId: 'a', id: 'q', questions: summaryOnly(words) }])
    }
  })

  it('is kept under the bound an answerable one has: an id past it keeps nothing, not even the summary', () => {
    // 8 kB of id; and 1400 control characters, 1.4 kB as they came but 8.4 kB as JSON writes them, past a frame.
    for (const id of ['x'.repeat(8000), '\u0001'.repeat(1400)]) {
      const inbox = new QuestionInbox()
      expect(inbox.set('a', 'q', question())).toBe(true)
      for (const raw of [[{ ...one, options: [] }], question()]) {
        expect(inbox.set('a', id, raw)).toBe(false)
        expect(inbox.read('a').ok).toBe(false)              // the earlier question is replaced, by nothing
        expect(inbox.open()).toEqual([])
      }
      expect(inbox.set('a', id, [{ ...one, options: [] }], true)).toBe(false)
      expect(inbox.open()).toEqual([])
      expect(inbox.close('a', id)).toBe(true)
    }
  })

  it('is readable and refuses every answer', async () => {
    const inbox = new QuestionInbox(), send = vi.fn(async () => ({ ok: true as const }))
    inbox.set('a', 'q', [{ ...one, options: [] }])
    const { token } = read(inbox), pin = { agentId: 'a', token, index: 0 }
    for (const [masks, drafts] of [[[1], undefined], [[0], undefined], [[0], ['draft']], [[], undefined]] as const)
      expect((await inbox.submit('a', token, masks, send, drafts)).ok).toBe(false)
    expect(inbox.canSpeak(pin)).toBe(false)
    expect(inbox.draft(pin, 'Yes').ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('is the same entry when delivered again or as its own summary, and is replaced or closed like any other', () => {
    const inbox = new QuestionInbox(), plan = [{ ...one, q: `Approve? ${'x'.repeat(7000)}` }]
    expect(inbox.set('a', 'q', plan)).toBe(false)
    const first = read(inbox)
    expect(inbox.ask('a', 'q')).toBe(true)
    expect(inbox.set('a', 'q', plan)).toBe(false)
    expect(inbox.set('a', 'q', first.questions)).toBe(false)   // the fleet hands a dial beside this one `open()`'s questions
    expect(read(inbox).token).toBe(first.token)
    expect(inbox.ask('a', 'q')).toBe(false)                    // the same entry, still asked
    expect(inbox.set('a', 'q', question())).toBe(true)         // the same id, answerable now: a new entry
    expect(read(inbox).token).not.toBe(first.token)
    expect(inbox.set('a', 'q', question())).toBe(true)         // unchanged: still as it came
    expect(inbox.set('a', 'q2', plan)).toBe(false)
    expect(inbox.close('a', 'q')).toBe(false)
    expect(inbox.close('a', 'q2')).toBe(true)
    expect(inbox.open()).toEqual([])
  })

  it('counts against the 64 entries, and an empty agent or id keeps, evicts and changes nothing', () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'q', question())
    const before = inbox.open()
    for (const [agent, id] of [['', 'q'], ['a', ''], ['', '']]) expect(inbox.set(agent, id, question())).toBe(false)
    expect(inbox.set('a', '', [])).toBe(false)
    expect(inbox.open()).toEqual(before)                       // a's open question is as it was
    expect(inbox.asked('a', 'q')).toEqual(question())          // and so are the words it was asked in
    expect(inbox.close('a', 'q')).toBe(true)
    for (let i = 0; i < 65; i++) inbox.set(`agent-${i}`, 'q', [])
    expect(inbox.read('agent-0').ok).toBe(false)
    expect(inbox.open()).toHaveLength(64)
    const full = new QuestionInbox()
    for (let i = 0; i < 64; i++) full.set(`agent-${i}`, 'q', question())
    expect(full.set('', 'q', question())).toBe(false)
    expect(full.read('agent-0').ok).toBe(true)                 // not evicted for a question nobody can close
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
