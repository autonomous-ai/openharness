import { describe, expect, it } from 'vitest'
import type { ApprovalDecision, ApprovalRequest } from '../../core/deviceHookCalls.js'
import type { ReviewQuestion } from '../questionInbox.js'
import { Approvals, approvalQuestion, type ApprovalsDeps } from './approvals.js'

type Shown = { agentId: string; requestId: string; questions: ReviewQuestion[] }

/** A fake clock and a recording dial: the agent for session `s` is `agent-s`. */
function setup(over: Partial<ApprovalsDeps> = {}) {
  let clock = 0
  const timers: Array<{ at: number; run: () => void; on: boolean }> = []
  const shown: Shown[] = []
  const closed: Array<[string, string]> = []
  const marks: Array<[string, string | undefined, string]> = []
  const counts: Array<[string, number]> = []
  const owned: string[] = []
  const deps: ApprovalsDeps = {
    now: () => clock,
    after: (ms, run) => {
      const timer = { at: clock + ms, run, on: true }
      timers.push(timer)
      return () => { timer.on = false }
    },
    canShow: () => true,
    owned: async (sessionId) => { owned.push(sessionId); return false },
    mark: (sessionId, cwd, state) => { marks.push([sessionId, cwd, state]); return { id: `agent-${sessionId}` } },
    show: (agentId, requestId, questions) => { shown.push({ agentId, requestId, questions }) },
    close: (agentId, requestId) => { closed.push([agentId, requestId]) },
    count: (outcome, ms) => { counts.push([outcome, ms]) },
    ...over,
  }
  const advance = (ms: number): void => {
    clock += ms
    for (const timer of timers) if (timer.on && timer.at <= clock) { timer.on = false; timer.run() }
  }
  return { approvals: new Approvals(deps), shown, closed, marks, counts, owned, advance }
}

const req = (id: string, sessionId = 's1', extra: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({ id, sessionId, tool: 'Bash', summary: 'npm test', cwd: '/work', ...extra })

/** The request's answer, read after the work it started has run. */
function track(answer: Promise<ApprovalDecision>) {
  const state: { value?: ApprovalDecision } = {}
  void answer.then((value) => { state.value = value })
  return state
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('Approvals', () => {
  it('no dial or a window\'s tab view is none at once, with no card', async () => {
    const t = setup({ canShow: () => false })
    expect(await t.approvals.request(req('r1'))).toBe('none')
    expect(t.owned).toEqual([])
    expect(t.shown).toEqual([])
    expect(t.marks).toEqual([])
  })

  it('a Harness-owned session is none', async () => {
    const t = setup({ owned: async () => true })
    expect(await t.approvals.request(req('r1'))).toBe('none')
    expect(t.shown).toEqual([])
    expect(t.marks).toEqual([])
  })

  it('a session check that fails is none, with no card', async () => {
    const t = setup({ owned: async () => { throw new Error('core gone') } })
    await expect(t.approvals.request(req('r1'))).resolves.toBe('none')
    expect(t.shown).toEqual([])
    expect(t.marks).toEqual([])
  })

  it('asks whether Harness owns the request\'s session', async () => {
    const t = setup()
    track(t.approvals.request(req('r1', 'sess-9')))
    await settle()
    expect(t.owned).toEqual(['sess-9'])
  })

  it('no room for the agent is none', async () => {
    const t = setup({ mark: () => undefined })
    expect(await t.approvals.request(req('r1'))).toBe('none')
    expect(t.shown).toEqual([])
  })

  it('shows the card: Allow <tool>?, the summary, Allow and Deny, no canText, id approval:<id>', async () => {
    const t = setup()
    const answer = track(t.approvals.request(req('r1')))
    await settle()
    expect(t.marks).toEqual([['s1', '/work', 'open']])
    expect(t.shown).toStrictEqual([{
      agentId: 'agent-s1',
      requestId: 'approval:r1',
      questions: [{ key: 'approval', q: 'Allow Bash?\nnpm test', options: ['Allow', 'Deny'], multi: false }],
    }])
    expect(answer.value).toBeUndefined()
  })

  it('a terminalOnly request is none at once with no card: the agent waits for the terminal, counted terminal-only', async () => {
    const t = setup()
    expect(await t.approvals.request(req('r1', 's1', { summary: 'npm test', terminalOnly: true }))).toBe('none')
    expect(t.owned).toEqual(['s1'])
    expect(t.shown).toEqual([])
    expect(t.closed).toEqual([])
    expect(t.marks).toEqual([['s1', '/work', 'terminal']])
    expect(t.counts).toEqual([['terminal-only', 0]])
    // Nothing is held for it: no answer the dial sends reaches it.
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Allow')).toEqual({ ok: false, error: 'This request is closed.' })
  })

  it('a terminalOnly request beside a shown card leaves that card the dial\'s, and is held nowhere', async () => {
    const t = setup()
    const first = track(t.approvals.request(req('r1')))
    await settle()
    expect(await t.approvals.request(req('r2', 's1', { terminalOnly: true }))).toBe('none')
    expect(t.shown.map((s) => s.requestId)).toEqual(['approval:r1'])
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Allow')).toEqual({ ok: true })
    await settle()
    expect(first.value).toBe('allow')
    expect(t.shown.map((s) => s.requestId)).toEqual(['approval:r1'])
  })

  it('a terminalOnly request with no dial, for a Harness-owned session, or with no room marks and counts nothing', async () => {
    for (const over of [{ canShow: () => false }, { owned: async () => true }] as Partial<ApprovalsDeps>[]) {
      const t = setup(over)
      expect(await t.approvals.request(req('r1', 's1', { terminalOnly: true }))).toBe('none')
      expect(t.marks).toEqual([])
      expect(t.counts).toEqual([])
    }
    const full = setup({ mark: () => undefined })
    expect(await full.approvals.request(req('r1', 's1', { terminalOnly: true }))).toBe('none')
    expect(full.counts).toEqual([])
  })

  it('Allow answers allow and closes the card; Deny answers deny', async () => {
    const t = setup()
    const first = track(t.approvals.request(req('r1')))
    const second = track(t.approvals.request(req('r2', 's2')))
    await settle()
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Allow')).toEqual({ ok: true })
    expect(t.approvals.answer('agent-s2', 'approval:r2', 'Deny')).toEqual({ ok: true })
    await settle()
    expect(first.value).toBe('allow')
    expect(second.value).toBe('deny')
    expect(t.closed).toEqual([['agent-s1', 'approval:r1'], ['agent-s2', 'approval:r2']])
  })

  it('a spoken or any other answer is refused with Tap Allow or Deny. and the card stays', async () => {
    const t = setup()
    const answer = track(t.approvals.request(req('r1')))
    await settle()
    expect(t.approvals.answer('agent-s1', 'approval:r1', undefined)).toEqual({ ok: false, error: 'Tap Allow or Deny.' })
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'yes, go ahead')).toEqual({ ok: false, error: 'Tap Allow or Deny.' })
    await settle()
    expect(answer.value).toBeUndefined()
    expect(t.closed).toEqual([])
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Allow')).toEqual({ ok: true })
  })

  it('a second approval for the agent waits and shows after the first closes; another agent\'s shows at once', async () => {
    const t = setup()
    track(t.approvals.request(req('r1')))
    const second = track(t.approvals.request(req('r2')))
    track(t.approvals.request(req('r3', 's2')))
    await settle()
    expect(t.shown.map((s) => s.requestId)).toEqual(['approval:r1', 'approval:r3'])
    t.approvals.answer('agent-s1', 'approval:r1', 'Allow')
    expect(t.closed).toEqual([['agent-s1', 'approval:r1']])
    expect(t.shown.map((s) => s.requestId)).toEqual(['approval:r1', 'approval:r3', 'approval:r2'])
    expect(t.shown[2].agentId).toBe('agent-s1')
    await settle()
    expect(second.value).toBeUndefined()
  })

  it('an answer for a closed id never resolves the next card', async () => {
    const t = setup()
    track(t.approvals.request(req('r1')))
    const second = track(t.approvals.request(req('r2')))
    const third = track(t.approvals.request(req('r3')))
    await settle()
    t.approvals.answer('agent-s1', 'approval:r1', 'Deny')
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Allow')).toEqual({ ok: false, error: 'This request is closed.' })
    t.approvals.gone('r2')
    expect(t.approvals.answer('agent-s1', 'approval:r2', 'Allow')).toEqual({ ok: false, error: 'This request is closed.' })
    await settle()
    expect(second.value).toBe('none')
    expect(third.value).toBeUndefined()
    expect(t.shown.at(-1)?.requestId).toBe('approval:r3')
  })

  it('another agent\'s id is refused with This request is closed.', async () => {
    const t = setup()
    const first = track(t.approvals.request(req('r1')))
    const second = track(t.approvals.request(req('r2', 's2')))
    const waiting = track(t.approvals.request(req('r3')))
    await settle()
    expect(t.approvals.answer('agent-s1', 'approval:r2', 'Allow')).toEqual({ ok: false, error: 'This request is closed.' })
    // Shown nowhere yet: a waiting card is not the agent's to answer.
    expect(t.approvals.answer('agent-s1', 'approval:r3', 'Allow')).toEqual({ ok: false, error: 'This request is closed.' })
    expect(t.approvals.answer('agent-s1', 'r1', 'Allow')).toEqual({ ok: false, error: 'This request is closed.' })
    await settle()
    expect([first.value, second.value, waiting.value]).toEqual([undefined, undefined, undefined])
    expect(t.closed).toEqual([])
  })

  it('two answers to one card resolve it once', async () => {
    const t = setup()
    const answer = track(t.approvals.request(req('r1')))
    await settle()
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Deny')).toEqual({ ok: true })
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Allow')).toEqual({ ok: false, error: 'This request is closed.' })
    t.approvals.gone('r1')
    t.advance(300_000)
    await settle()
    expect(answer.value).toBe('deny')
    expect(t.closed).toEqual([['agent-s1', 'approval:r1']])
    expect(t.counts.filter(([outcome]) => outcome !== 'shown')).toEqual([['denied', 0]])
  })

  it('gone closes a shown card and drops a waiting one unseen', async () => {
    const t = setup()
    const first = track(t.approvals.request(req('r1')))
    const second = track(t.approvals.request(req('r2')))
    track(t.approvals.request(req('r3')))
    await settle()
    t.approvals.gone('r2')
    expect(t.closed).toEqual([])
    t.approvals.gone('r1')
    expect(t.closed).toEqual([['agent-s1', 'approval:r1']])
    expect(t.shown.map((s) => s.requestId)).toEqual(['approval:r1', 'approval:r3'])
    t.approvals.gone('unknown')
    await settle()
    expect([first.value, second.value]).toEqual(['none', 'none'])
    expect(t.counts.filter(([outcome]) => outcome === 'terminal')).toHaveLength(2)
  })

  it('after 300 s the answer is none and the card closes; the agent is marked left', async () => {
    const t = setup()
    const answer = track(t.approvals.request(req('r1')))
    await settle()
    t.advance(299_999)
    await settle()
    expect(answer.value).toBeUndefined()
    t.advance(1)
    await settle()
    expect(answer.value).toBe('none')
    expect(t.closed).toEqual([['agent-s1', 'approval:r1']])
    expect(t.marks).toEqual([['s1', '/work', 'open'], ['s1', '/work', 'left']])
  })

  it('a waiting request expires 300 s after it arrived, not after it was shown', async () => {
    const t = setup()
    track(t.approvals.request(req('r1')))
    t.advance(1000)
    const second = track(t.approvals.request(req('r2')))
    await settle()
    t.advance(299_000)
    expect(t.shown.at(-1)?.requestId).toBe('approval:r2')
    t.advance(999)
    await settle()
    expect(second.value).toBeUndefined()
    t.advance(1)
    await settle()
    expect(second.value).toBe('none')
  })

  it('closeAll answers every one none and closes the shown cards', async () => {
    const t = setup()
    const answers = [
      track(t.approvals.request(req('r1'))),
      track(t.approvals.request(req('r2'))),
      track(t.approvals.request(req('r3', 's2'))),
    ]
    await settle()
    t.approvals.closeAll()
    await settle()
    expect(answers.map((a) => a.value)).toEqual(['none', 'none', 'none'])
    expect(t.closed).toEqual([['agent-s1', 'approval:r1'], ['agent-s2', 'approval:r3']])
    expect(t.shown.map((s) => s.requestId)).toEqual(['approval:r1', 'approval:r3'])
    expect(t.marks.filter(([, , state]) => state !== 'open')).toEqual([['s1', '/work', 'left'], ['s2', '/work', 'left']])
    expect(t.counts.filter(([outcome]) => outcome === 'closed')).toHaveLength(3)
  })

  it('a request closeAll overtakes while its session is checked is none', async () => {
    let owner!: (owned: boolean) => void
    const t = setup({ owned: () => new Promise((resolve) => { owner = resolve }) })
    const answer = track(t.approvals.request(req('r1')))
    await settle()
    t.approvals.closeAll()
    owner(false)
    await settle()
    expect(answer.value).toBe('none')
    expect(t.shown).toEqual([])
    expect(t.marks).toEqual([])
  })

  it('a request the terminal answers while its session is checked shows no card', async () => {
    let owner!: (owned: boolean) => void
    const t = setup({ owned: () => new Promise((resolve) => { owner = resolve }) })
    const answer = track(t.approvals.request(req('r1')))
    await settle()
    t.approvals.gone('r1')
    owner(false)
    await settle()
    expect(answer.value).toBe('none')
    expect(t.shown).toEqual([])
    expect(t.marks).toEqual([])
  })

  it('a dial that goes while the session is checked shows no card', async () => {
    let owner!: (owned: boolean) => void
    let dial = true
    const t = setup({ canShow: () => dial, owned: () => new Promise((resolve) => { owner = resolve }) })
    const answer = track(t.approvals.request(req('r1')))
    await settle()
    dial = false
    owner(false)
    await settle()
    expect(answer.value).toBe('none')
    expect(t.shown).toEqual([])
  })

  it('marks answered only when the agent\'s last request ends', async () => {
    const t = setup()
    track(t.approvals.request(req('r1')))
    track(t.approvals.request(req('r2')))
    await settle()
    t.approvals.answer('agent-s1', 'approval:r1', 'Allow')
    t.advance(1000)
    track(t.approvals.request(req('r3')))
    await settle()
    // r2 expires while r3 still waits: the agent's prompt is still open, so it is neither answered nor left.
    t.advance(299_000)
    expect(t.marks.filter(([, , state]) => state !== 'open')).toEqual([])
    t.approvals.answer('agent-s1', 'approval:r3', 'Deny')
    expect(t.marks.filter(([, , state]) => state !== 'open')).toEqual([['s1', '/work', 'answered']])
  })

  it('the 17th held request is none', async () => {
    const t = setup()
    const held = Array.from({ length: 16 }, (_, i) => track(t.approvals.request(req(`r${i}`, `s${i % 5}`))))
    await settle()
    expect(await t.approvals.request(req('r16', 's9'))).toBe('none')
    expect(held.every((a) => a.value === undefined)).toBe(true)
    expect(t.marks.filter(([sessionId]) => sessionId === 's9')).toEqual([])
    t.approvals.gone('r0')
    track(t.approvals.request(req('r17', 's9')))
    await settle()
    expect(t.marks.at(-1)).toEqual(['s9', '/work', 'open'])
  })

  it('a request id already held is none, and the first stays', async () => {
    const t = setup()
    const first = track(t.approvals.request(req('r1')))
    await settle()
    expect(await t.approvals.request(req('r1'))).toBe('none')
    expect(t.approvals.answer('agent-s1', 'approval:r1', 'Allow')).toEqual({ ok: true })
    await settle()
    expect(first.value).toBe('allow')
  })

  it('a 64-character tool and a 200-byte multi-byte summary give a q of at most 255 bytes, cut on a character', async () => {
    const tool = 'T'.repeat(64)
    const summary = `a${'ệ'.repeat(66)}b`
    expect(Buffer.byteLength(summary)).toBe(200)
    const { q } = approvalQuestion(tool, summary)
    expect(q).toBe(`Allow ${tool}?\na${'ệ'.repeat(60)}`)
    expect(Buffer.byteLength(q)).toBeLessThanOrEqual(255)
    const t = setup()
    track(t.approvals.request(req('r1', 's1', { tool, summary })))
    await settle()
    expect(t.shown[0].questions[0].q).toBe(q)
  })

  it('counts shown, allowed with the time to the answer, denied, expired, terminal', async () => {
    const t = setup()
    track(t.approvals.request(req('r1')))
    track(t.approvals.request(req('r2')))
    await settle()
    t.advance(1500)
    t.approvals.answer('agent-s1', 'approval:r1', 'Allow')
    t.advance(500)
    t.approvals.answer('agent-s1', 'approval:r2', 'Deny')
    track(t.approvals.request(req('r3')))
    await settle()
    t.advance(300_000)
    track(t.approvals.request(req('r4')))
    await settle()
    t.advance(42)
    t.approvals.gone('r4')
    expect(t.counts).toEqual([
      ['shown', 0], ['allowed', 1500], ['shown', 1500], ['denied', 2000],
      ['shown', 0], ['expired', 300_000],
      ['shown', 0], ['terminal', 42],
    ])
  })

  it('a summary with CJK and an emoji shows its card with ? in their place', async () => {
    expect(approvalQuestion('Bash', 'echo 你好 🙂').q).toBe('Allow Bash?\necho ?? ?')
    const t = setup()
    track(t.approvals.request(req('r1', 's1', { summary: 'echo 你好 🙂' })))
    await settle()
    expect(t.shown[0].questions[0].q).toBe('Allow Bash?\necho ?? ?')
  })

  it('a tool name the dial cannot draw is replaced the same way', () => {
    expect(approvalQuestion('mcp__工具🙂', 'x').q).toBe('Allow mcp__????\nx')
  })

  it('a long CJK summary is replaced before the cut', () => {
    const tool = 'T'.repeat(64)
    const summary = '你'.repeat(66)
    expect(Buffer.byteLength(summary)).toBe(198)
    expect(approvalQuestion(tool, summary).q).toBe(`Allow ${tool}?\n${'?'.repeat(66)}`)
  })
})
