/**
 * lib/askQuestion.ts, the paths askQuestion.spec.ts leaves alone: every engine's route through
 * parseEngineQuestionPane, the dialog shapes at the edges (a review with no submit row, a partial Codex
 * dialog, a frame with no header), what counts as an approval, and the controller and watcher when
 * something fails — a key that does not land, a busy terminal, a session that went away, a drive that
 * never settles (it must stop, not spin).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AskQuestionController,
  codexRowKeys,
  isApprovalDialog,
  matchRow,
  parseEngineQuestionPane,
  parseQuestionPane,
  pickAnswer,
  pollsQuestions,
  QuestionWatcher,
  questionRequestId,
  shapeQuestions,
  type AskQuestionDeps,
  type QuestionView,
} from './askQuestion.js'
import type { RegisteredSession } from './registry.js'
import type { AgentEngine } from '../engines/types.js'

const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', `question-${name}.txt`), 'utf8')
const permission = (name: string): string => readFileSync(join(__dirname, '__fixtures__', `permission-${name}.txt`), 'utf8')

const asQuestion = (view: ReturnType<typeof parseQuestionPane>): QuestionView => {
  expect(view?.kind).toBe('question')
  return view as QuestionView
}
const idOf = (capture: string, engine: AgentEngine = 'claude'): string =>
  questionRequestId('s1', asQuestion(parseEngineQuestionPane(engine, capture)))

const CLOSED = '❯ \n  ⏸ plan mode on (shift+tab to cycle)'
const FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel'

/** A plain Claude-shaped dialog: question, blank, numbered rows, footer. */
const dialog = (question: string, rows: string[], footer = FOOTER): string =>
  ['', question, '', ...rows.map((row, i) => `  ${i + 1}. ${row}`), '', footer].join('\n')

// Amp's approval prompt, live capture (engines/amp/askQuestion.spec.ts): unnumbered rows, walked with Down.
const AMP = `
                    ╭─ Approval Required ──────────────────────────────────────────────────────────╮
                    │                                                                              │
                    │ shell_command:                                                             █ │
                    │   {                                                                        █ │
                    │     "command": "echo probe123",                                            █ │
                    │   }                                                                        █ │
                    │                                                                              │
                    │ ‣ Allow Once                                                                 │
                    │   Reject with feedback                                                       │
                    │   Allow All for This Session                                                 │
                    │                                                                              │
                    ╰──────────── ↑/↓/j/k move · Enter select · Ctrl+E/Ctrl+Y scroll · Esc cancel ─╯
`

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('shapeQuestions — the edges', () => {
  it('prefers prompt over question, and falls back to header, then to the position', () => {
    expect(shapeQuestions([
      { prompt: 'P?', question: 'Q?', options: [] },
      { header: 'H', options: [] },
      {},
      null,
    ]).map((q) => [q.key, q.q])).toEqual([['P?', 'P?'], ['H', ''], ['question_2', ''], ['question_3', '']])
  })

  it('keeps only options with a label, whatever shape they come in', () => {
    const [q] = shapeQuestions([{ question: 'Q', options: ['A', { label: 'B' }, { description: 'no label' }, null, '', { label: '' }, 7] }])
    expect(q.options).toEqual(['A', 'B'])
    expect(shapeQuestions([{ question: 'Q', options: 'A,B' }])[0].options).toEqual([])
  })

  it('reads all three spellings of multi-select', () => {
    expect(shapeQuestions([
      { question: 'a', allow_multiple: true }, { question: 'b', multiSelect: true }, { question: 'c', multi_select: true }, { question: 'd' },
    ]).map((q) => q.multi)).toEqual([true, true, true, false])
  })
})

describe('parseEngineQuestionPane — every engine\'s route', () => {
  it('amp: its unnumbered approval, as a permission prompt walked with Down', () => {
    const view = asQuestion(parseEngineQuestionPane('amp', AMP))
    expect(view.permission).toBe(true)
    expect(view.rows.map((r) => [r.label, r.walk])).toEqual([['Allow Once', 'down'], ['Reject with feedback', 'down'], ['Allow All for This Session', 'down']])
  })

  it('kilo: its horizontal prompt, as a permission prompt walked with Right', () => {
    const view = asQuestion(parseEngineQuestionPane('kilo', fixture('kilo')))
    expect(view.permission).toBe(true)
    expect(view.rows.map((r) => r.walk)).toEqual(['right', 'right', 'right'])
  })

  it('grok: a permission prompt only under the approval footer; its questionnaire is a question', () => {
    expect(asQuestion(parseEngineQuestionPane('grok', fixture('grok'))).permission).toBeUndefined()
    expect(asQuestion(parseEngineQuestionPane('grok', permission('grok'))).permission).toBe(true)
  })

  it('agy: its own question parser, and the shared one for its numbered permission prompt', () => {
    const question = asQuestion(parseEngineQuestionPane('agy', fixture('agy')))
    expect(question.question).toBe('Which colour do you prefer?')
    const prompt = asQuestion(parseEngineQuestionPane('agy', permission('agy')))
    expect(prompt.permission).toBe(true)
    expect(prompt.rows.map((r) => r.label)).toContain('No')
  })

  it('copilot: peels the box, keeps the free-text row out, and names the subject of a permission prompt', () => {
    const question = asQuestion(parseEngineQuestionPane('copilot', fixture('copilot')))
    expect(question.rows.map((r) => r.label)).toEqual(['Red', 'Green', 'Blue'])
    expect(question.typeRow?.label).toBe('Other (type your answer)')
    expect(asQuestion(parseEngineQuestionPane('copilot', permission('copilot'))).question).toBe('Do you want to allow this access? — https://example.com')
  })

  it('codex: the label before the description column, Enter submits; nothing on screen is nothing', () => {
    const view = asQuestion(parseEngineQuestionPane('codex', fixture('codex')))
    expect(view.rows.map((r) => r.label)).toEqual(['Red', 'Green'])
    expect(view.enterSubmits).toBe(true)
    expect(parseEngineQuestionPane('codex', CLOSED)).toBeNull()
  })

  it('opencode: an `enter submit` footer with neither rows nor a Review heading is nothing', () => {
    expect(parseEngineQuestionPane('opencode', 'some output\nmore output\n  enter submit  esc dismiss')).toBeNull()
  })
})

describe('parseQuestionPane — the edges', () => {
  it('a review screen with no "Submit answers" row under it is not something to submit', () => {
    expect(parseQuestionPane('Review your answers\n\nReady to submit your answers?\n\n  (nothing here yet)\n')).toBeNull()
  })

  it('a lone Submit row on the last line is not Command Code\'s review pair', () => {
    expect(parseQuestionPane('  1. Summary item\n❯ 1. Submit')).toBeNull()
  })

  it('reads a footer-less tab-bar dialog with checkboxes as multi-select, with no free-text row', () => {
    const view = asQuestion(parseQuestionPane(['● Toppings | ◯ Review', '', 'Which toppings?', '', '❯ 1. [ ] Cheese', '  2. [✔] Ham'].join('\n')))
    expect(view).toMatchObject({ question: 'Which toppings?', multi: true, typeRow: null })
    expect(view.rows.map((r) => [r.label, r.checked])).toEqual([['Cheese', false], ['Ham', true]])
  })

  it('a Codex dialog scrolled so its first row is gone is PARTIAL: still open, nothing to announce', () => {
    const capture = ['  3. Blue    Creates a calm accent.', '  4. None of the above', '  option 3/4 | tab to add notes', '  enter to submit answer | esc to interrupt'].join('\n')
    const view = asQuestion(parseEngineQuestionPane('codex', capture))
    expect(view).toMatchObject({ partial: true, enterSubmits: true, question: '', multi: false })
    expect(view.rows.map((r) => r.number)).toEqual(['3', '4'])
  })

  it('an unframed approval with nothing above it is titled "Approval required"', () => {
    const view = asQuestion(parseQuestionPane(['', '', '', '', '', '  1. Yes', '  2. No', '', '  Esc to cancel'].join('\n')))
    expect(view).toMatchObject({ permission: true, question: 'Approval required' })
  })

  it('a framed approval skips its own prose for the title, and has no header only when the frame is empty', () => {
    const rule = '─'.repeat(40)
    const prose = asQuestion(parseQuestionPane([rule, ' Bash command', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')))
    expect(prose.question).toBe('Approve Bash command')
    const empty = asQuestion(parseQuestionPane([rule, '', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')))
    expect(empty.question).toBe('Approval required')
    expect(empty.dialog).toBe('❯ 1. Yes\n   2. No')
  })
})

describe('isApprovalDialog', () => {
  const view = (over: Partial<QuestionView>): QuestionView =>
    ({ kind: 'question', question: 'Q', rows: [{ number: '1', label: 'Yes', checked: false }, { number: '2', label: 'No', checked: false }], multi: false, typeRow: null, ...over })

  it('is any framed permission prompt', () => {
    expect(isApprovalDialog(view({ permission: true, rows: [] }))).toBe(true)
  })

  it('is a yes/no dialog that names a command or asks to run or change something', () => {
    expect(isApprovalDialog(view({ dialog: 'Reason: x\n  $ rm -rf build\n1. Yes\n2. No' }))).toBe(true)
    expect(isApprovalDialog(view({ question: 'Would you like to make the following edits?' }))).toBe(true)
    expect(isApprovalDialog(view({ question: 'Would you like to EXECUTE this?' }))).toBe(true)
  })

  it('is not a question the agent asks, nor anything without an approve row first and a reject row', () => {
    expect(isApprovalDialog(view({ question: 'Which colour?' }))).toBe(false)
    expect(isApprovalDialog(view({ rows: [] }))).toBe(false)
    expect(isApprovalDialog(view({ dialog: '$ ls', rows: [{ number: '1', label: 'Red', checked: false }, { number: '2', label: 'No', checked: false }] }))).toBe(false)
    expect(isApprovalDialog(view({ dialog: '$ ls', rows: [{ number: '1', label: 'Yes', checked: false }, { number: '2', label: 'Maybe', checked: false }] }))).toBe(false)
  })
})

describe('an answer whose key names no question (regression: a short or empty key matched every question)', () => {
  // pickAnswer's prefix rule let a key that is a prefix of the question on screen name it. A key that
  // normalises to nothing — '' or '...' — is a prefix of EVERY question, and a one-word key ("Which",
  // "Run") of every question that starts with that word: an answer that names no question on screen was
  // typed into whatever was showing, a permission prompt included. The shorter side must be as long as
  // the question floor (6) for a prefix to count.
  it('pickAnswer: an empty, dotted or one-word key is not a prefix match', () => {
    for (const key of ['', '...', 'W', 'Which', 'Run']) {
      expect(pickAnswer({ [key]: 'Yes' }, 'Which drink would you like?', new Set())).toBeNull()
      expect(pickAnswer({ [key]: 'Yes' }, 'Run npm test?', new Set())).toBeNull()
    }
  })

  it('types nothing into a permission prompt for an answer keyed by nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const key of ['', '...']) {
      const r = rig([permission('claude'), CLOSED])
      expect(await r.controller.answer({ sessionId: 's1', answers: { [key]: 'Yes' } })).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
      expect(r.keys).toEqual([])
    }
  })
})

describe('a stale `Approve …` header (regression: a header from an earlier dialog named the current one)', () => {
  // An approval is titled `Approve <header>: <argument>`, and the header is shared by every prompt of its
  // kind. Two ways an earlier prompt's header reached the current one:
  //  - pickAnswer's prefix rule: a key left from an earlier prompt — `Approve Bash command` (its argument
  //    unread) — was a prefix of `Approve Bash command: rm -rf ~/projects`, so a no-requestId "Yes" to the
  //    old prompt approved the new one; the other way round, an old full title named a header-only one.
  //  - the parser: an unframed prompt under an answered one still in scrollback walked up past that one's
  //    rows to its frame, and was titled — and its dialog read by the pair's classifier — by the OLD header
  //    and command. A [y] on `npm test` would have approved whatever the new prompt runs.
  const rule = '─'.repeat(60)
  const earlier = [rule, ' Bash command', '', '   npm test', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend', '']
  const output = ['⏺ Bash(npm test)', '  ⎿  ok', '']
  const unframed = [' Do you want to proceed?', '   python3 scripts/wipe.py --all', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel', '']
  const headerOnly = [rule, ' Bash command', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')
  const rmRf = permission('claude').replaceAll('curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin', 'rm -rf ~/projects')

  it('pickAnswer: an approval is named by its own text only, never a prefix either way', () => {
    expect(pickAnswer({ 'Approve Bash command': 'Yes' }, 'Approve Bash command: rm -rf ~/projects', new Set())).toBeNull()
    expect(pickAnswer({ 'Approve Bash command: npm test': 'Yes' }, 'Approve Bash command', new Set())).toBeNull()
    expect(pickAnswer({ 'Approve Bash command: rm -rf ~/pro': 'Yes' }, 'Approve Bash command: rm -rf ~/projects', new Set())).toBeNull()
    expect(pickAnswer({ 'approve bash command:  rm -rf ~/projects…': 'No' }, 'Approve Bash command: rm -rf ~/projects', new Set()))
      .toEqual({ key: 'approve bash command:  rm -rf ~/projects…', value: 'No' })
    // A truncated device label needs requestId-backed positional matching too.
    expect(pickAnswer({ 'Which drink would': 'Tea' }, 'Which drink would you like?', new Set())).toBeNull()
  })

  it('types nothing into a permission prompt for a no-requestId answer keyed by an earlier prompt\'s header', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const stale = rig([rmRf, CLOSED])
    expect(await stale.controller.answer({ sessionId: 's1', answers: { 'Approve Bash command': 'Yes' } })).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(stale.keys).toEqual([])
    // …nor into a header-only prompt for an earlier prompt's full title.
    const bare = rig([headerOnly, CLOSED])
    expect(await bare.controller.answer({ sessionId: 's1', answers: { 'Approve Bash command: npm test': 'Yes' } })).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(bare.keys).toEqual([])
    // The prompt's own title still answers it, and its requestId still answers it by position.
    const own = rig([rmRf, CLOSED])
    expect(await own.controller.answer({ sessionId: 's1', answers: { 'Approve Bash command: rm -rf ~/projects': 'No' } })).toEqual({ ok: true })
    expect(own.keys).toEqual(['3'])
    const byId = rig([rmRf, CLOSED])
    expect(await byId.controller.answer({ requestId: idOf(rmRf), sessionId: 's1', answers: { 'Approve Bash command': 'No' } })).toEqual({ ok: true })
    expect(byId.keys).toEqual(['3'])
  })

  it('an unframed prompt under an answered one is not titled, or read, by the answered one', () => {
    const view = asQuestion(parseQuestionPane([...earlier, ...output, ...unframed].join('\n')))
    expect(view.question).toBe('python3 scripts/wipe.py --all')
    expect(view.dialog).not.toMatch(/Bash command|^\s*npm test$|Tab to amend/m)
    expect(view.dialog).toContain('python3 scripts/wipe.py --all')
  })

  it('an earlier question dialog ends the walk the same way; right under one, the title is "Approval required"', () => {
    const question = [rule, ' ☐ Drink', '', ' Which drink would you like?', '', ' ❯ 1. Tea', '   2. Coffee', '', ' Enter to select · ↑/↓ to navigate · Esc to cancel', '']
    const view = asQuestion(parseQuestionPane([...question, ...output, ...unframed].join('\n')))
    expect(view.question).toBe('python3 scripts/wipe.py --all')
    expect(view.dialog).not.toMatch(/Drink|Tea|Coffee/)
    const underIt = asQuestion(parseQuestionPane([...earlier, ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n')))
    expect(underIt).toMatchObject({ permission: true, question: 'Approval required', dialog: '❯ 1. Yes\n   2. No' })
  })

  it('a framed prompt under an answered one still reads its own frame, header and command, under its own id', () => {
    const current = [rule, ' Bash command', '', '   ls -la', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel']
    const view = asQuestion(parseQuestionPane([...earlier, ...output, ...current].join('\n')))
    expect(view.question).toBe('Approve Bash command: ls -la')
    expect(view.dialog).toBe('Bash command\n\n   ls -la\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No')
    expect(idOf([...earlier, ...output, ...current].join('\n'))).toBe(idOf(current.join('\n')))
  })

  it('numbered text inside the frame, and prose that mentions a key, are not an earlier dialog', () => {
    const edit = [rule, ' Edit file', ' notes.md', '', ' 1. Add the tests', ' 2. Make Esc close the modal', '    press esc to see it', '',
      ' Do you want to make this edit to notes.md?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel']
    const view = asQuestion(parseQuestionPane(edit.join('\n')))
    expect(view.question).toBe('Approve Edit file: notes.md')
    expect(view.dialog).toContain('Make Esc close the modal')
  })
})

describe('keys and matching', () => {
  const row = { number: '2', label: 'Green', checked: false }

  it('codex: a digit then Enter only where Enter submits', () => {
    expect(codexRowKeys(row, { kind: 'question', question: 'q', rows: [row], multi: false, typeRow: null, enterSubmits: true })).toEqual(['2', 'Enter'])
    expect(codexRowKeys(row)).toEqual(['2'])
  })

  it('matchRow: nothing for an empty answer; a longer answer matches a label of 3+ characters it starts with', () => {
    const rows = [{ number: '1', label: 'No', checked: false }, { number: '2', label: 'Tea', checked: false }]
    expect(matchRow(rows, '   ')).toBeNull()
    expect(matchRow(rows, 'Tea, please')?.number).toBe('2')
    expect(matchRow(rows, 'Nope')).toBeNull()        // "No" is too short to be a prefix match
    expect(matchRow(rows, 'no')?.number).toBe('1')   // …but matches exactly
  })

  it('pickAnswer: only the complete question matches; a used answer is not taken twice', () => {
    const answers = { 'Which drink would you like? (pick one)': 'Tea' }
    expect(pickAnswer(answers, 'Which drink would you like?', new Set())).toBeNull()
    expect(pickAnswer({ 'Which drink would': 'Tea' }, 'Which drink would you like?', new Set())).toBeNull()
    expect(pickAnswer(answers, 'Which drink would you like? (pick one)', new Set())).toEqual({ key: 'Which drink would you like? (pick one)', value: 'Tea' })
    expect(pickAnswer(answers, 'Which drink would you like? (pick one)', new Set(['Which drink would you like? (pick one)']))).toBeNull()
    expect(pickAnswer({ a: '1' }, 'Other?', new Set(['a']), { positional: true })).toBeNull()
    expect(pickAnswer({ 'Size? (S or M)': 'M' }, 'Size?', new Set())).toBeNull()
    expect(pickAnswer({ 'size?': 'M' }, 'Size?', new Set())).toEqual({ key: 'size?', value: 'M' })
  })
})

// ── the controller ──────────────────────────────────────────────────────────────────────────────────

interface Rig {
  keys: string[]
  texts: string[]
  controller: AskQuestionController
}

function rig(captures: Array<string | null>, opts: {
  engine?: AgentEngine
  sendKey?: (key: string, n: number) => boolean
  sendText?: (text: string) => boolean
  deps?: Partial<AskQuestionDeps>
} = {}): Rig {
  const keys: string[] = []
  const texts: string[] = []
  let i = 0
  const controller = new AskQuestionController({
    getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: opts.engine ?? 'claude' } as unknown as RegisteredSession),
    capture: async () => captures[Math.min(i++, captures.length - 1)],
    sendText: async (_pane, text) => { texts.push(text); return opts.sendText?.(text) ?? true },
    sendKey: async (_pane, key) => { keys.push(key); return opts.sendKey?.(key, keys.length) ?? true },
    wait: async () => {},
    ...opts.deps,
  })
  return { keys, texts, controller }
}

const DRINK = dialog('Which drink?', ['Tea', 'Coffee', 'Type something.'])
const drink = (answer: string) => ({ requestId: idOf(DRINK), sessionId: 's1', answers: { 'Which drink?': answer } })

describe('AskQuestionController — refusing before anything is typed', () => {
  it('ignores remember() without a requestId, and forgets the oldest past 64', async () => {
    const r = rig([DRINK, CLOSED])
    r.controller.remember('', 's1')
    for (let i = 0; i < 66; i++) r.controller.remember(`req-${i}`, 's1')
    // req-0 was forgotten: an answer that names only it names no agent.
    expect(await r.controller.answer({ requestId: 'req-0', answers: { q: 'a' } })).toMatchObject({ ok: false, error: 'ANSWER_FAILED' })
    expect(await r.controller.answer({ requestId: '', answers: { q: 'a' } })).toMatchObject({ ok: false, error: 'ANSWER_FAILED' })
    expect(r.keys).toEqual([])
  })

  it('refuses answers that are not a map', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = rig([DRINK])
    expect(await r.controller.answer({ sessionId: 's1', answers: 'Tea' as never })).toMatchObject({ ok: false, error: 'ANSWER_FAILED' })
  })

  it('says AGENT_NOT_FOUND for a session that is gone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = rig([DRINK], { deps: { getSession: () => undefined } })
    expect(await r.controller.answer(drink('Tea'))).toEqual({ ok: false, error: 'AGENT_NOT_FOUND', detail: 'That harness is no longer running.' })
    expect(r.keys).toEqual([])
  })

  it('says ANSWER_BUSY when the terminal cannot be pinned, and releases what it pinned after a drive', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const busy = rig([DRINK], { deps: { acquireControl: () => null } })
    expect(await busy.controller.answer(drink('Tea'))).toMatchObject({ ok: false, error: 'ANSWER_BUSY', detail: 'The agent\'s terminal is busy. Try again.' })
    expect(busy.keys).toEqual([])

    const release = vi.fn()
    const acquire = vi.fn(() => release)
    const pinned = rig([DRINK, CLOSED], { deps: { acquireControl: acquire } })
    expect(await pinned.controller.answer(drink('Tea'))).toEqual({ ok: true })
    expect(acquire).toHaveBeenCalledWith('s1', { forAnswer: true })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('drives one answer at a time per agent: a second one while the first is keyed is ANSWER_BUSY', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    let n = 0
    const keys: string[] = []
    const controller = new AskQuestionController({
      getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as unknown as RegisteredSession),
      capture: async () => { if (n++ === 0) { await gate; return DRINK } return CLOSED },
      sendText: async () => true,
      sendKey: async (_p, key) => { keys.push(key); return true },
      wait: async () => {},
    })
    const first = controller.answer(drink('Tea'))
    expect(controller.isDriving('s1')).toBe(true)
    expect(await controller.answer(drink('Coffee'))).toMatchObject({ ok: false, error: 'ANSWER_BUSY' })
    open()
    expect(await first).toEqual({ ok: true })
    expect(controller.isDriving('s1')).toBe(false)
    expect(keys).toEqual(['1'])
  })

  it('refuses a permission prompt when the client may not answer one', async () => {
    const r = rig([permission('claude')])
    const answers = { 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin': 'Yes' }
    expect(await r.controller.answer({ requestId: idOf(permission('claude')), sessionId: 's1', answers, allowPermissions: false }))
      .toEqual({ ok: false, error: 'ANSWER_FAILED', detail: 'Permission prompts cannot be answered from here.' })
    expect(r.keys).toEqual([])
  })

  it('a capture that fails reads as nothing on screen', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([null])
    expect(await r.controller.answer(drink('Tea'))).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
  })
})

describe('AskQuestionController — keys that do not land', () => {
  it('fails when the row\'s key does not land', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([DRINK], { sendKey: () => false })
    expect(await r.controller.answer(drink('Tea'))).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: 'The answer could not be typed into the agent\'s terminal.' })
  })

  it('fails at each step of a free-text answer that does not land: the row, the text, the Enter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const row = rig([DRINK], { sendKey: () => false })
    expect(await row.controller.answer(drink('lemonade'))).toMatchObject({ error: 'ANSWER_FAILED' })
    expect(row.texts).toEqual([])
    const text = rig([DRINK], { sendText: () => false })
    expect(await text.controller.answer(drink('lemonade'))).toMatchObject({ error: 'ANSWER_FAILED' })
    expect(text.keys).toEqual(['3'])
    const enter = rig([DRINK], { sendKey: (key) => key !== 'Enter' })
    expect(await enter.controller.answer(drink('lemonade'))).toMatchObject({ error: 'ANSWER_FAILED' })
    expect(enter.texts).toEqual(['lemonade'])
  })

  it('refuses an answer that matches no option on a dialog with no free-text row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const noText = dialog('Which size?', ['S', 'M'])
    const r = rig([noText])
    expect(await r.controller.answer({ requestId: idOf(noText), sessionId: 's1', answers: { 'Which size?': 'XL' } }))
      .toEqual({ ok: false, error: 'ANSWER_FAILED', detail: 'That answer matches no option.' })
    expect(r.keys).toEqual([])
  })

  it('fails when the review\'s submit key does not land', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([fixture('multi'), fixture('review')], { sendKey: (key) => key !== '1' || r.keys.length < 3 })
    const result = await r.controller.answer({ requestId: idOf(fixture('multi')), sessionId: 's1', answers: { 'Which toppings do you want?': 'Ham' } })
    expect(r.keys).toEqual(['2', 'Tab', '1'])
    expect(result).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: 'The answers could not be submitted.' })
  })
})

describe('AskQuestionController — multi-select', () => {
  const TOPPINGS = ['', 'Which toppings?', '', '❯ 1. [✔] Cheese', '  2. [ ] Ham', '  3. [ ] Type something', '', FOOTER].join('\n')
  const toppings = (answer: string) => ({ requestId: idOf(TOPPINGS), sessionId: 's1', answers: { 'Which toppings?': answer } })

  it('never toggles a box that is already ticked (that would untick it)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([TOPPINGS, CLOSED])
    expect(await r.controller.answer(toppings('Cheese, Ham'))).toEqual({ ok: true })
    expect(r.keys).toEqual(['2', 'Tab'])
  })

  it('types an answer that ticks nothing into the free-text row', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([TOPPINGS, CLOSED])
    expect(await r.controller.answer(toppings('Pineapple'))).toEqual({ ok: true })
    expect(r.keys).toEqual(['3', 'Enter', 'Tab'])
    expect(r.texts).toEqual(['Pineapple'])
  })

  it('fails when a toggle, the free text, or the advance key does not land', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await rig([TOPPINGS], { sendKey: () => false }).controller.answer(toppings('Ham'))).toMatchObject({ error: 'ANSWER_FAILED' })
    expect(await rig([TOPPINGS], { sendText: () => false }).controller.answer(toppings('Pineapple'))).toMatchObject({ error: 'ANSWER_FAILED' })
    const tab = rig([TOPPINGS], { sendKey: (key) => key !== 'Tab' })
    expect(await tab.controller.answer(toppings('Ham'))).toMatchObject({ error: 'ANSWER_FAILED' })
    expect(tab.keys).toEqual(['2', 'Tab'])
  })

  it('submits devin\'s multi-select with Enter, not Tab', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([fixture('devin-multi'), CLOSED], { engine: 'devin' })
    const answers = { 'Bạn thích màu nào? (có thể chọn nhiều màu)': 'Xanh, Vàng' }
    expect(await r.controller.answer({ requestId: idOf(fixture('devin-multi'), 'devin'), sessionId: 's1', answers })).toEqual({ ok: true })
    expect(r.keys).toEqual(['1', '3', 'Enter'])
  })
})

describe('AskQuestionController — engines whose rows are walked, not numbered', () => {
  it('amp: Down to the row, then Enter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([AMP, CLOSED], { engine: 'amp' })
    const question = asQuestion(parseEngineQuestionPane('amp', AMP)).question
    expect(await r.controller.answer({ requestId: idOf(AMP, 'amp'), sessionId: 's1', answers: { [question]: 'Reject with feedback' } })).toEqual({ ok: true })
    expect(r.keys).toEqual(['Down', 'Enter'])
  })

  it('kilo: Right to the row, then Enter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([fixture('kilo'), CLOSED], { engine: 'kilo' })
    expect(await r.controller.answer({ requestId: idOf(fixture('kilo'), 'kilo'), sessionId: 's1', answers: { 'Access external directory /private/etc': 'Reject' } })).toEqual({ ok: true })
    expect(r.keys).toEqual(['Right', 'Right', 'Enter'])
  })

  it('codex request_user_input: the digit, then Enter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([fixture('codex'), CLOSED], { engine: 'codex' })
    expect(await r.controller.answer({ requestId: idOf(fixture('codex'), 'codex'), sessionId: 's1', answers: { 'Which colour should the demo use?': 'Green' } })).toEqual({ ok: true })
    expect(r.keys).toEqual(['2', 'Enter'])
  })
})

describe('AskQuestionController — a dialog that will not settle', () => {
  const PARTIAL = ['  3. Blue    Creates a calm accent.', '  4. None of the above', '  enter to submit answer | esc to interrupt'].join('\n')

  it('cannot answer a dialog whose top is scrolled out of view', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = rig([PARTIAL], { engine: 'codex' })
    expect(await r.controller.answer({ sessionId: 's1', answers: { q: 'Blue' } })).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: 'The question is scrolled out of view.' })
    expect(r.keys).toEqual([])
  })

  it('after keying, waits out a scrolled dialog once — then calls it stuck, or done when it closes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const answer = { requestId: idOf(fixture('codex'), 'codex'), sessionId: 's1', answers: { 'Which colour should the demo use?': 'Red' } }
    const settles = rig([fixture('codex'), PARTIAL, CLOSED], { engine: 'codex' })
    expect(await settles.controller.answer(answer)).toEqual({ ok: true })
    const stuck = rig([fixture('codex'), PARTIAL, PARTIAL], { engine: 'codex' })
    expect(await stuck.controller.answer(answer)).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: 'The question did not take the answer.' })
    expect(stuck.keys).toEqual(['1', 'Enter'])
  })

  it('an answered dialog whose question stays blank is taken as submitted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const blank = ['─'.repeat(20), '', '  1. Tea', '  2. Coffee', '', FOOTER].join('\n')
    const r = rig([DRINK, blank, blank, blank])
    expect(await r.controller.answer(drink('Tea'))).toEqual({ ok: true })
    expect(r.keys).toEqual(['1'])
  })

  it('stops after a bounded number of steps rather than spin on a pane that keeps changing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const blank = ['─'.repeat(20), '', '  1. Tea', '  2. Coffee', '', FOOTER].join('\n')
    const q = (n: number) => dialog(`Question ${n}?`, ['Tea', 'Coffee'])
    const captures = [q(1), blank, blank, q(2), blank, blank, q(3), blank, blank, q(4), blank, blank, q(5), blank, blank, q(6)]
    const answers = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`Question ${n}?`, 'Tea']))
    const r = rig(captures)
    expect(await r.controller.answer({ requestId: idOf(q(1)), sessionId: 's1', answers })).toEqual({ ok: false, error: 'ANSWER_FAILED', detail: 'The question did not take the answer.' })
    expect(r.keys).toEqual(['1', '1', '1', '1', '1'])   // five questions in 14 steps, then it stops
  })

  it('waits between keystrokes on real timers when no wait is injected', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const keys: string[] = []
    let i = 0
    const captures = [DRINK, CLOSED]
    const controller = new AskQuestionController({
      getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as unknown as RegisteredSession),
      capture: async () => captures[Math.min(i++, 1)],
      sendText: async () => true,
      sendKey: async (_p, key) => { keys.push(key); return true },
    })
    let settled = false
    const pending = controller.answer(drink('Tea')).then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(100)
    expect(keys).toEqual(['1'])
    expect(settled).toBe(false)          // still letting the TUI repaint
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual({ ok: true })
  })
})

// ── the watcher ─────────────────────────────────────────────────────────────────────────────────────

describe('QuestionWatcher — polling', () => {
  const session = (over: Partial<RegisteredSession> = {}) => ({ sessionId: 's1', agentId: 'a1', tmuxPane: '%1', engine: 'claude', active: true, ...over } as unknown as RegisteredSession)

  it('knows which engines paint a dialog', () => {
    for (const engine of ['claude', 'codex', 'amp', 'kilo', 'copilot'] as AgentEngine[]) expect(pollsQuestions(engine)).toBe(true)
    expect(pollsQuestions('pi' as AgentEngine)).toBe(false)
  })

  it('polls only a live session of an engine that paints dialogs, once, until stopped', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const seen: string[] = []
    const gone: string[] = []
    let current: RegisteredSession | undefined = session()
    const capture = vi.fn(async () => DRINK)
    const w = new QuestionWatcher({
      getSession: () => current, capture, hasDevice: () => true,
      onQuestion: (_s, requestId) => { seen.push(requestId) }, onQuestionGone: (_s, requestId) => { gone.push(requestId) },
    })
    for (const skip of [undefined, session({ active: false }), session({ engine: 'pi' as AgentEngine }), session({ agentId: '', sessionId: '' })]) {
      current = skip
      w.start('s1')
      await vi.advanceTimersByTimeAsync(3_000)
    }
    expect(capture).not.toHaveBeenCalled()

    current = session()
    w.start('s1')
    w.start('s1')                                   // a second start is not a second poll
    await vi.advanceTimersByTimeAsync(1_500)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([idOf(DRINK)])
    w.stop('s1')
    expect(gone).toEqual([idOf(DRINK)])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('stopAll stops every poll', async () => {
    vi.useFakeTimers()
    const capture = vi.fn(async () => CLOSED)
    const w = new QuestionWatcher({ getSession: () => session(), capture, hasDevice: () => true, onQuestion: () => {} })
    w.start('s1'); w.start('s2')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(capture).toHaveBeenCalledTimes(2)
    w.stopAll()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('stops itself — and takes back what it announced — when the session is gone', async () => {
    let current: RegisteredSession | undefined = session()
    const gone: string[] = []
    const w = new QuestionWatcher({ getSession: () => current, capture: async () => DRINK, hasDevice: () => true, onQuestion: () => {}, onQuestionGone: (_s, id) => { gone.push(id) } })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    await tick()
    current = undefined
    await tick()
    expect(gone).toEqual([idOf(DRINK)])
  })

  it('says once per change when it pauses (no device, an answer being keyed) and when it polls again', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let device = true
    let driving = false
    const capture = vi.fn(async () => CLOSED)
    const w = new QuestionWatcher({ getSession: () => session(), capture, hasDevice: () => device, isDriving: () => driving, onQuestion: () => {} })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    device = false; await tick(); await tick()
    device = true; driving = true; await tick(); await tick()
    driving = false; await tick(); await tick()
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      '[question] s1 watcher paused · no device',
      '[question] s1 watcher paused · driving an answer',
      '[question] s1 watcher polling',
    ])
    expect(capture).toHaveBeenCalledTimes(2)   // only the two unpaused ticks read the pane
  })

  it('keeps a question open while it is scrolled (partial), and a miss after it starts the count again', async () => {
    const PARTIAL = ['  3. Blue    Creates a calm accent.', '  4. None of the above', '  enter to submit answer | esc to interrupt'].join('\n')
    const captures = [fixture('codex'), '', PARTIAL, '', '']
    let i = 0
    const gone: string[] = []
    const w = new QuestionWatcher({
      getSession: () => session({ engine: 'codex' as AgentEngine }), capture: async () => captures[i++], hasDevice: () => true,
      onQuestion: () => {}, onQuestionGone: (_s, id) => { gone.push(id) },
    })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    await tick()   // announced
    await tick()   // one miss
    await tick()   // partial: still open, the misses start over
    await tick()   // one miss
    expect(gone).toEqual([])
    await tick()   // two in a row: gone
    expect(gone).toHaveLength(1)
  })
})

describe('QuestionWatcher — what it announces', () => {
  it('reads a session with no engine as Claude, ignores a failed capture, and uses a dialog with no body as its question', async () => {
    const captures: Array<string | null> = [null, fixture('grok')]
    let i = 0
    const seen: Array<{ id: string; detail?: { permission: boolean; dialog: string } }> = []
    const engineless = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1' } as unknown as RegisteredSession),
      capture: async () => DRINK, hasDevice: () => true,
      onQuestion: (_s, id, _q, detail) => { seen.push({ id, detail }) },
    })
    await (engineless as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    expect(seen[0].id).toBe(idOf(DRINK))
    const grok = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1', engine: 'grok' } as unknown as RegisteredSession),
      capture: async () => captures[i++] ?? null, hasDevice: () => true,
      onQuestion: (_s, id, _q, detail) => { seen.push({ id, detail }) },
    })
    const tick = (): Promise<void> => (grok as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    await tick()                 // null capture: nothing
    expect(seen).toHaveLength(1)
    await tick()
    expect(seen[1].detail).toEqual({ permission: false, dialog: 'Which color should I report?' })
  })
})

describe('QuestionWatcher.noteTurnStart — the edges', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  it('does nothing for a session with no terminal, or a pane with no dialog on it', async () => {
    const capture = vi.fn(async () => CLOSED)
    let current: RegisteredSession | undefined
    const seen: string[] = []
    const w = new QuestionWatcher({ getSession: () => current, capture, hasDevice: () => true, onQuestion: (_s, id) => { seen.push(id) } })
    w.noteTurnStart('s1')
    await settle()
    expect(capture).not.toHaveBeenCalled()
    current = { sessionId: 's1' } as unknown as RegisteredSession   // no engine: read as Claude
    w.noteTurnStart('s1')
    await settle()
    expect(capture).toHaveBeenCalledTimes(1)
    capture.mockImplementationOnce(async () => null as unknown as string)   // a capture that fails
    w.noteTurnStart('s1')
    await settle()
    expect(capture).toHaveBeenCalledTimes(2)
    // Nothing was recorded as pre-turn, so the next dialog announces.
    capture.mockImplementation(async () => DRINK)
    await (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    expect(seen).toEqual([idOf(DRINK)])
  })

  it('does not suppress a dialog that was already announced before its turn-start capture landed', async () => {
    let release!: () => void
    const late = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const seen: string[] = []
    const w = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1', engine: 'claude' } as unknown as RegisteredSession),
      capture: async () => { if (calls++ === 0) await late; return DRINK },
      hasDevice: () => true,
      onQuestion: (_s, id) => { seen.push(id) },
    })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    w.noteTurnStart('s1')      // its capture is slow…
    await tick()               // …and the poll announces the dialog first: it is this turn's
    release()
    await settle()
    w.reset()                  // a device rejoins: the open question must be pushed again
    await tick()
    expect(seen).toEqual([idOf(DRINK), idOf(DRINK)])
  })
})

describe('QuestionWatcher.notePrompt — the pane before a prompt the daemon typed', () => {
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  afterEach(() => { vi.useRealTimers() })
  const watcher = (session: Partial<RegisteredSession> | undefined, capture: () => string | null) => {
    const seen: string[] = []
    const read = vi.fn(async () => capture())
    const w = new QuestionWatcher({
      getSession: () => session as RegisteredSession | undefined,
      capture: read, hasDevice: () => true,
      onQuestion: (_s, id) => { seen.push(id) },
    })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    return { w, seen, read, tick }
  }

  it('announces the question an engine drew before its turn was seen to start, which the start\'s own read took for the turn before\'s', async () => {
    // The pane, as the turn is seen to start: the turn's own question is already up (the start was late).
    const late = watcher({ sessionId: 's1', engine: 'claude' }, () => DRINK)
    late.w.noteTurnStart('s1')
    await settle()
    await late.tick()
    expect(late.seen).toEqual([])
    // The same, with the pane as the daemon read it right before typing the prompt: no dialog then.
    const typed = watcher({ sessionId: 's1', engine: 'claude' }, () => DRINK)
    typed.w.notePrompt('s1', CLOSED)
    typed.w.noteTurnStart('s1')
    await settle()
    expect(typed.read).not.toHaveBeenCalled()
    await typed.tick()
    expect(typed.seen).toEqual([idOf(DRINK)])
  })

  it('still keeps a dialog that was on the pane as the prompt was typed from being announced as the new turn\'s', async () => {
    const { w, seen, tick } = watcher({ sessionId: 's1', engine: 'claude' }, () => DRINK)
    w.notePrompt('s1', DRINK)
    w.noteTurnStart('s1')
    await tick()
    expect(seen).toEqual([])
  })

  it('reads the pane at the turn\'s start as before, for a prompt it did not type, one whose read failed, an engine it does not watch, or one typed long ago', async () => {
    vi.useFakeTimers()
    const drawn = watcher({ sessionId: 's1', engine: 'claude' }, () => DRINK)
    drawn.w.notePrompt('s1', null)
    drawn.w.noteTurnStart('s1')
    await settle()
    expect(drawn.read).toHaveBeenCalledTimes(1)
    const stale = watcher({ sessionId: 's1', engine: 'claude' }, () => DRINK)
    stale.w.notePrompt('s1', CLOSED)
    vi.advanceTimersByTime(120_001)
    stale.w.noteTurnStart('s1')
    await settle()
    expect(stale.read).toHaveBeenCalledTimes(1)
    // Used once: the turn after reads its own start.
    const once = watcher({ sessionId: 's1', engine: 'claude' }, () => DRINK)
    once.w.notePrompt('s1', CLOSED)
    once.w.noteTurnStart('s1')
    once.w.noteTurnStart('s1')
    await settle()
    expect(once.read).toHaveBeenCalledTimes(1)
    for (const session of [undefined, { sessionId: 's1', engine: 'gemini' }] as const) {
      const ignored = watcher(session as Partial<RegisteredSession> | undefined, () => DRINK)
      ignored.w.notePrompt('s1', CLOSED)
      expect((ignored.w as unknown as { beforePrompt: Map<string, unknown> }).beforePrompt.size).toBe(0)
    }
    // An engine with no name is read as Claude; everything is forgotten when the watcher stops.
    const nameless = watcher({ sessionId: 's1' }, () => DRINK)
    nameless.w.notePrompt('s1', DRINK)
    expect((nameless.w as unknown as { beforePrompt: Map<string, unknown> }).beforePrompt.size).toBe(1)
    nameless.w.stopAll()
    expect((nameless.w as unknown as { beforePrompt: Map<string, unknown> }).beforePrompt.size).toBe(0)
  })
})
