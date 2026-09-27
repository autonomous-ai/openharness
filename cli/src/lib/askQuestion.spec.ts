import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  AskQuestionController,
  matchRow,
  parseEngineQuestionPane,
  parseQuestionPane,
  QuestionWatcher,
  questionRequestId,
  shapeQuestions,
  type QuestionView,
  type ReviewView,
} from './askQuestion.js'
import type { RegisteredSession } from './registry.js'

// Real `tmux capture-pane` output from Claude Code 2.1.220 dialogs (the single-select one still carries
// its SGR codes, exactly as captureTmuxPane returns it).
const fixture = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', `question-${name}.txt`), 'utf8')

const asQuestion = (view: ReturnType<typeof parseQuestionPane>): QuestionView => {
  expect(view?.kind).toBe('question')
  return view as QuestionView
}

describe('shapeQuestions', () => {
  it('keys each question the way the CLI matches answers, and flattens option labels', () => {
    const shaped = shapeQuestions([
      { question: 'Which color?', header: 'Color', multiSelect: true, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }] },
    ])
    expect(shaped).toEqual([{ key: 'Which color?', q: 'Which color?', options: ['Red', 'Blue'], multi: true }])
  })

  it('falls back to id/header for the key and defaults multi to false', () => {
    expect(shapeQuestions([{ id: 'q1', options: [] }])).toEqual([{ key: 'q1', q: '', options: [], multi: false }])
    expect(shapeQuestions(undefined)).toEqual([])
  })
})

describe('the Hermes clarify dialog', () => {
  // Real capture from hermes on a live pane: the SAME dialog Claude paints (`❯ 1. Xanh` rows, a footer
  // reading "Enter to confirm") wrapped in a box-drawing frame. Peeling the frame is the whole adaptation
  // — a second parser would have drifted from the one it duplicates.
  it('reads through the box frame that wraps it', () => {
    const view = asQuestion(parseEngineQuestionPane('hermes', fixture('hermes')))
    expect(view.question).toBe('Bạn muốn chọn size nào?')
    expect(view.rows.map((r) => [r.number, r.label])).toEqual([['1', 'S'], ['2', 'M']])
    expect(view.multi).toBe(false)
  })

  it('offers the free-text row as free text, not as an option', () => {
    // Hermes writes "Other (type your answer)" where Claude writes "Type something." — it must not be
    // announced to the device as a choosable label.
    const view = asQuestion(parseEngineQuestionPane('hermes', fixture('hermes')))
    expect(view.rows.map((r) => r.label)).not.toContain('Other (type your answer)')
  })

  it('is invisible to the unframed parser — which is why the engine branch exists', () => {
    expect(parseQuestionPane(fixture('hermes'))).toBeNull()
  })
})

describe('the OpenCode question dialog', () => {
  // Real capture from opencode on a live pane. Same bones as Claude's — `1. Size S` rows, a free-text row
  // last — but framed in `┃` and with its own footer wording ("enter submit"), which is why the shared
  // footer anchor had to learn a second phrasing rather than each CLI getting a parser.
  it('reads through the frame and the different footer wording', () => {
    const view = asQuestion(parseEngineQuestionPane('opencode', fixture('opencode')))
    expect(view.question).toBe('Bạn muốn chọn size nào?')
    expect(view.rows.map((r) => r.label)).toEqual(['Size S', 'Size M'])
  })

  it('treats "Type your own answer" as the free-text row, not an option', () => {
    // Each CLI words this row differently; offering it as a label would send the device an answer that
    // selects nothing.
    const view = asQuestion(parseEngineQuestionPane('opencode', fixture('opencode')))
    expect(view.typeRow?.label).toBe('Type your own answer')
    expect(view.rows.map((r) => r.label)).not.toContain('Type your own answer')
  })

  it('ignores the description line under each option', () => {
    const view = asQuestion(parseEngineQuestionPane('opencode', fixture('opencode')))
    expect(view.rows).toHaveLength(2)
  })
})

describe('the OpenCode review screen', () => {
  // Real capture of the last step of a multi-question dialog: a "Review" heading over `label: answer`
  // lines, NO numbered rows, submitted with Enter. Before this was recognised the driver read it as "no
  // dialog", stopped, and left a fully-answered form sitting there unsubmitted.
  it('is a review, not a question, and submits with Enter', () => {
    const view = parseEngineQuestionPane('opencode', fixture('opencode-review')) as ReviewView
    expect(view?.kind).toBe('review')
    expect(view.submitRow).toBe('Enter')
  })

  it('does not mistake a live question for the review', () => {
    expect(parseEngineQuestionPane('opencode', fixture('opencode'))?.kind).toBe('question')
  })
})

describe('parseQuestionPane', () => {
  it('reads a single-select dialog through its ANSI styling', () => {
    const view = asQuestion(parseQuestionPane(fixture('single')))
    expect(view.question).toBe('Which drink would you like?')
    expect(view.rows.map((r) => r.label)).toEqual(['Tea', 'Coffee'])
    expect(view.multi).toBe(false)
    expect(view.typeRow?.number).toBe('3')
  })

  it('reads a multi-select dialog: checkbox rows, and excludes the type/chat rows', () => {
    const view = asQuestion(parseQuestionPane(fixture('multi')))
    expect(view.question).toBe('Which toppings do you want?')
    expect(view.rows.map((r) => r.label)).toEqual(['Cheese', 'Ham', 'Basil'])
    expect(view.multi).toBe(true)
    expect(view.typeRow?.number).toBe('4')
  })

  it('skips the question tab bar when several questions share one dialog', () => {
    const view = asQuestion(parseQuestionPane(fixture('tabs')))
    expect(view.question).toBe('Which colors do you like?')
    expect(view.rows.map((r) => r.label)).toEqual(['Red', 'Blue', 'Green'])
  })

  it('recognises the review screen (no footer, rows below the prompt)', () => {
    const view = parseQuestionPane(fixture('review'))
    expect(view?.kind).toBe('review')
    expect((view as ReviewView).submitRow).toBe('1')
  })

  it('returns null when no dialog is open', () => {
    expect(parseQuestionPane('❯ \n  ⏸ plan mode on (shift+tab to cycle)')).toBeNull()
  })
})

describe('matchRow', () => {
  const rows = [
    { number: '1', label: 'Tách socket riêng cho voice', checked: false },
    { number: '2', label: 'Giữ nguyên', checked: false },
  ]

  it('matches exactly and case/space-insensitively', () => {
    expect(matchRow(rows, 'giữ  NGUYÊN')?.number).toBe('2')
  })

  it('matches a label the device truncated to its 80-byte buffer', () => {
    expect(matchRow(rows, 'Tách socket riêng')?.number).toBe('1')
  })

  it('returns null for a free-text answer', () => {
    expect(matchRow(rows, 'cho tao cai khac di')).toBeNull()
  })
})

// --- driving the pane -------------------------------------------------------------------------

interface Machine {
  keys: string[]
  texts: string[]
  controller: AskQuestionController
}

function machine(captures: string[], engine?: string): Machine {
  const keys: string[] = []
  const texts: string[] = []
  let i = 0
  const controller = new AskQuestionController({
    getSession: () => ({ sessionId: 's1', tmuxPane: '%1', ...(engine ? { engine } : {}) } as RegisteredSession),
    capture: async () => captures[Math.min(i++, captures.length - 1)],
    sendText: async (_pane, text) => { texts.push(text); return true },
    sendKey: async (_pane, key) => { keys.push(key); return true },
    wait: async () => {},
  })
  return { keys, texts, controller }
}

const CLOSED = '❯ \n  ⏸ plan mode on (shift+tab to cycle)'

/** The requestId the watcher announces this capture under — what a client echoes back with its answer. */
const idOf = (capture: string, engine: Parameters<typeof parseEngineQuestionPane>[0] = 'claude'): string =>
  questionRequestId('s1', asQuestion(parseEngineQuestionPane(engine, capture)))

describe('AskQuestionController.answer', () => {
  it('presses the option digit for a single-select answer', async () => {
    const h = machine([fixture('single'), CLOSED])
    const r = await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: { 'Which drink would you like?': 'Coffee' } })
    expect(r).toEqual({ ok: true })
    expect(h.keys).toEqual(['2'])
  })

  it('types a voice/free-text answer into the "Type something." row and submits it', async () => {
    const h = machine([fixture('single'), CLOSED])
    const r = await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: { 'Which drink would you like?': 'nuoc mia' } })
    expect(r.ok).toBe(true)
    expect(h.keys).toEqual(['3', 'Enter'])
    expect(h.texts).toEqual(['nuoc mia'])
  })

  it('toggles each selected checkbox then Tabs on, and submits from the review screen', async () => {
    const h = machine([fixture('multi'), fixture('review')])
    const r = await h.controller.answer({ requestId: idOf(fixture('multi')), sessionId: 's1', answers: { 'Which toppings do you want?': 'Cheese, Basil' } })
    expect(r.ok).toBe(true)
    expect(h.keys).toEqual(['1', '3', 'Tab', '1'])
  })

  it('fills a multi-question form in order when the answers name each question', async () => {
    const h = machine([fixture('tabs'), fixture('single'), CLOSED])
    const r = await h.controller.answer({
      requestId: idOf(fixture('tabs')),
      sessionId: 's1',
      answers: { 'Which colors do you like?': 'Blue', 'Which drink would you like?': 'Tea' },
    })
    expect(r.ok).toBe(true)
    expect(h.keys).toEqual(['2', 'Tab', '1'])
  })

  it('never types into a later question of the form that the answers do not name', async () => {
    // Used to be answered POSITIONALLY: the second entry went into whatever question came next, named or
    // not. The form's next screen is a question this answer was never written for — it stays open for the
    // watcher to announce, and whoever sees it answers it.
    const h = machine([fixture('tabs'), fixture('single'), CLOSED])
    const r = await h.controller.answer({
      requestId: idOf(fixture('tabs')),
      sessionId: 's1',
      answers: { 'Which colors do you like?': 'Blue', 'Which size do you want?': 'Tea' },
    })
    expect(r.ok).toBe(true)
    expect(h.keys).toEqual(['2', 'Tab'])
  })

  it('leaves a multi-question dialog open on the question the device has not been shown yet', async () => {
    // The device answers ONE question at a time (the watcher pushes them as the pane advances), so the
    // drive loop must stop at the next question instead of guessing an answer for it.
    const h = machine([fixture('tabs'), fixture('single'), CLOSED])
    const r = await h.controller.answer({ requestId: idOf(fixture('tabs')), sessionId: 's1', answers: { 'Which colors do you like?': 'Blue' } })
    expect(r.ok).toBe(true)
    expect(h.keys).toEqual(['2', 'Tab'])
  })

  it('does nothing when the dialog is already gone', async () => {
    const h = machine([CLOSED])
    expect(await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: { q: 'a' } }))
      .toEqual({ ok: false, error: 'STALE_QUESTION', detail: 'That question is no longer open.' })
    expect(h.keys).toEqual([])
  })

  it('gives up instead of hammering keys when the dialog never advances', async () => {
    const h = machine([fixture('single')])
    const r = await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: { 'Which drink would you like?': 'Tea' } })
    expect(r).toMatchObject({ ok: false, error: 'ANSWER_FAILED' })
    expect(h.keys.length).toBeLessThanOrEqual(3)
  })

  it('falls back to the remembered session when the device sends no sessionId', async () => {
    const h = machine([fixture('single'), CLOSED])
    h.controller.remember(idOf(fixture('single')), 's1')
    expect((await h.controller.answer({ requestId: idOf(fixture('single')), answers: { 'Which drink would you like?': 'Tea' } })).ok).toBe(true)
    expect(h.keys).toEqual(['1'])
  })

  it('drops an answer with no answers map', async () => {
    const h = machine([fixture('single')])
    expect((await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: {} })).ok).toBe(false)
    expect(h.keys).toEqual([])
  })
})

describe('an answer that arrives after its question changed', () => {
  // The person saw one approval; by the time their "Yes" arrived the agent had moved on to ANOTHER. The
  // old positional fallback typed that "Yes" into the new prompt — approving a command nobody was shown.
  const promptA = (): string => permission('claude')
  const promptB = (): string => permission('claude').replaceAll('curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin', 'rm -rf ~/projects')
  const yesToA = { 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin': 'Yes' }

  it('the two prompts are different dialogs with different ids', () => {
    expect(asQuestion(parseQuestionPane(promptB())).question).toBe('Approve Bash command: rm -rf ~/projects')
    expect(idOf(promptB())).not.toBe(idOf(promptA()))
  })

  it('types nothing into the new dialog and says the question changed', async () => {
    const h = machine([promptB(), CLOSED])
    const r = await h.controller.answer({ requestId: idOf(promptA()), sessionId: 's1', answers: yesToA })
    expect(r).toEqual({ ok: false, error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' })
    expect(h.keys).toEqual([])
    expect(h.texts).toEqual([])
  })

  it('still answers when the dialog on screen is the one it was for', async () => {
    const h = machine([promptA(), CLOSED])
    const r = await h.controller.answer({ requestId: idOf(promptA()), sessionId: 's1', answers: yesToA })
    expect(r).toEqual({ ok: true })
    expect(h.keys).toEqual(['1'])
  })

  it('refuses one with no requestId whose text names a different question', async () => {
    const h = machine([promptB(), CLOSED])
    const r = await h.controller.answer({ sessionId: 's1', answers: yesToA })
    expect(r).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(h.keys).toEqual([])
  })

  it('accepts one with no requestId whose text names the question on screen', async () => {
    const h = machine([fixture('single'), CLOSED])
    expect((await h.controller.answer({ sessionId: 's1', answers: { 'Which drink would you like?': 'Tea' } })).ok).toBe(true)
    expect(h.keys).toEqual(['1'])
  })

  it('looks again when a repaint blanks the question, instead of calling it stale', async () => {
    // Mid-repaint the question line can read empty for one capture; its id then matches nothing.
    const blank = fixture('single').replace('Which drink would you like?', '')
    const h = machine([blank, fixture('single'), CLOSED])
    expect(await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: { Drink: 'Tea' } })).toEqual({ ok: true })
    expect(h.keys).toEqual(['1'])
  })

  it('types nothing into a dialog whose question never becomes readable', async () => {
    const h = machine([fixture('single').replace('Which drink would you like?', '')])
    expect(await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: { Drink: 'Tea' } })).toMatchObject({ ok: false })
    expect(h.keys).toEqual([])
  })

  it('never submits a form it finds already on its review screen', async () => {
    // Every question was answered elsewhere first: pressing Submit would send answers nobody here gave.
    const h = machine([fixture('review')])
    const r = await h.controller.answer({ requestId: idOf(fixture('multi')), sessionId: 's1', answers: { 'Which toppings do you want?': 'Cheese' } })
    expect(r).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(h.keys).toEqual([])
  })
})

describe('positional answers', () => {
  // An answer keyed by something other than the question's text (a header, an id) is matched by POSITION
  // — but only to the dialog its requestId names. Anywhere else, position means "whatever is showing".
  const byHeader = { Drink: 'Tea' }

  it('fill the question their requestId names', async () => {
    const h = machine([fixture('single'), CLOSED])
    expect(await h.controller.answer({ requestId: idOf(fixture('single')), sessionId: 's1', answers: byHeader })).toEqual({ ok: true })
    expect(h.keys).toEqual(['1'])
  })

  it('are refused for a dialog announced under another requestId', async () => {
    const h = machine([fixture('single'), CLOSED])
    const r = await h.controller.answer({ requestId: idOf(fixture('multi')), sessionId: 's1', answers: byHeader })
    expect(r).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(h.keys).toEqual([])
  })

  it('are refused with no requestId at all', async () => {
    const h = machine([fixture('single'), CLOSED])
    expect(await h.controller.answer({ sessionId: 's1', answers: byHeader })).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(h.keys).toEqual([])
  })

  it('stop at the next question of the form — a new question is a new request', async () => {
    const h = machine([fixture('tabs'), fixture('single'), CLOSED])
    const r = await h.controller.answer({ requestId: idOf(fixture('tabs')), sessionId: 's1', answers: { Colors: 'Blue', Drink: 'Tea' } })
    expect(r.ok).toBe(true)
    expect(h.keys).toEqual(['2', 'Tab'])
  })

  it('match the id the watcher announced the dialog under', async () => {
    // The two sides must compute the SAME id, or every answer would be refused as stale.
    const announced: string[] = []
    const w = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as RegisteredSession),
      capture: async () => fixture('single'),
      hasDevice: () => true,
      onQuestion: (_s, requestId) => { announced.push(requestId) },
    })
    await (w as unknown as { tick(id: string): Promise<void> }).tick('s1')
    expect(announced).toEqual([idOf(fixture('single'))])
  })
})

describe('QuestionWatcher', () => {
  const session = { sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as RegisteredSession

  function watcher(captures: string[], opts: { hasDevice?: boolean } = {}): {
    seen: Array<{ requestId: string; questions: ReturnType<typeof shapeQuestions> }>
    gone: string[]
    tick: () => Promise<void>
    instance: QuestionWatcher
  } {
    let i = 0
    const seen: Array<{ requestId: string; questions: ReturnType<typeof shapeQuestions> }> = []
    const gone: string[] = []
    const instance = new QuestionWatcher({
      getSession: () => session,
      capture: async () => captures[Math.min(i++, captures.length - 1)],
      hasDevice: () => opts.hasDevice !== false,
      onQuestion: (_s, requestId, questions) => { seen.push({ requestId, questions }) },
      onQuestionGone: (_s, requestId) => { gone.push(requestId) },
    })
    // tick() is private — exercised the way the interval does.
    const tick = (): Promise<void> => (instance as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    return { seen, gone, tick, instance }
  }

  it('announces a close once the dialog has really left the pane', async () => {
    // The whole point of the feature: answered in the app, so every other client has to stop waiting.
    const w = watcher([fixture('single'), '', ''])
    await w.tick()
    expect(w.seen).toHaveLength(1)
    await w.tick()
    expect(w.gone).toEqual([])          // one empty capture is not yet evidence
    await w.tick()
    expect(w.gone).toEqual([w.seen[0].requestId])
  })

  it('does NOT close on a single unparseable capture', async () => {
    // A capture taken mid-repaint reads as no-dialog. Closing on that would pull a LIVE question off the
    // dial — the bug this feature exists to prevent, inverted, and far harder to notice.
    const w = watcher([fixture('single'), '', fixture('single'), ''])
    await w.tick()
    await w.tick()   // the flicker
    await w.tick()   // dialog is back
    await w.tick()   // first real miss
    expect(w.gone).toEqual([])
  })

  it('closes an outstanding question when the watcher stops', async () => {
    // The case that made the whole mechanism look broken on hardware: the turn ends BECAUSE the question
    // was answered, so stop() lands a second or two after the dialog left — well inside the two-tick
    // confirmation, which would otherwise swallow the close entirely.
    const w = watcher([fixture('single')])
    await w.tick()
    expect(w.seen).toHaveLength(1)
    w.instance.stop('s1')
    expect(w.gone).toEqual([w.seen[0].requestId])
  })

  it('does not close twice when the dialog was already confirmed gone', async () => {
    const w = watcher([fixture('single'), '', ''])
    await w.tick(); await w.tick(); await w.tick()
    expect(w.gone).toHaveLength(1)
    w.instance.stop('s1')
    expect(w.gone).toHaveLength(1)
  })

  it('says nothing about a question it never announced', async () => {

    const w = watcher(['', '', ''])
    await w.tick(); await w.tick(); await w.tick()
    expect(w.gone).toEqual([])
  })


  it('announces an open dialog in the device question shape', async () => {
    const w = watcher([fixture('single')])
    await w.tick()
    expect(w.seen).toHaveLength(1)
    expect(w.seen[0].questions).toEqual([
      { key: 'Which drink would you like?', q: 'Which drink would you like?', options: ['Tea', 'Coffee'], multi: false },
    ])
  })

  it('does not announce a dialog that was already on the pane when the turn began', async () => {
    // The daemon attaches to a running engine whose LAST prompt was answered a
    // moment ago in another client. Its pixels are still there, and a pane that
    // was just answered looks exactly like one still waiting.
    const w = watcher([fixture('single'), fixture('single'), fixture('single')]);
    w.instance.noteTurnStart('s1');
    await Promise.resolve();
    await Promise.resolve();
    await w.tick();
    expect(w.seen).toHaveLength(0);
  });

  it('...but announces the next one, once the dialog actually changes', async () => {
    const w = watcher([fixture('single'), fixture('multi'), fixture('multi')]);
    w.instance.noteTurnStart('s1');
    await Promise.resolve();
    await Promise.resolve();
    await w.tick();   // the NEW dialog — nothing like the one that predated the turn
    expect(w.seen).toHaveLength(1);
  });

  it('announces a question ONCE while it stays on screen', async () => {
    const w = watcher([fixture('single')])
    await w.tick(); await w.tick(); await w.tick()
    expect(w.seen).toHaveLength(1)
  })

  it('announces the next question of the same dialog once the pane advances', async () => {
    const w = watcher([fixture('tabs'), fixture('single')])
    await w.tick(); await w.tick()
    expect(w.seen.map((s) => s.questions[0].q)).toEqual(['Which colors do you like?', 'Which drink would you like?'])
    expect(w.seen[0].requestId).not.toBe(w.seen[1].requestId)
  })

  it('re-announces an open question after a device (re)join', async () => {
    const w = watcher([fixture('single')])
    await w.tick()
    w.instance.reset()
    await w.tick()
    expect(w.seen).toHaveLength(2)
    expect(w.seen[0].requestId).toBe(w.seen[1].requestId) // stable id → the device dedups if it still has it
  })

  it('says nothing when the pane has no dialog, or when no device is listening', async () => {
    expect((await (async () => { const w = watcher([CLOSED]); await w.tick(); return w.seen })()).length).toBe(0)
    expect((await (async () => { const w = watcher([fixture('single')], { hasDevice: false }); await w.tick(); return w.seen })()).length).toBe(0)
  })

  it('carries the multi-select flag so the device renders checkboxes', async () => {
    const w = watcher([fixture('multi')])
    await w.tick()
    expect(w.seen[0].questions[0]).toMatchObject({ options: ['Cheese', 'Ham', 'Basil'], multi: true })
  })
})

describe('parseQuestionPane — frame boundary', () => {
  // A capture taken mid-repaint: the live frame's question line is not painted yet, and the PREVIOUS
  // question is still in scrollback above. Pairing that stale title with the live options is what made
  // the device re-show "Chọn màu?" over question 2's options.
  const midRepaint = [
    'Chọn màu?',
    '',
    '  1. Đỏ',
    '  2. Vàng',
    '────────────────────────────',
    '←  ☒ Màu  ☐ Size  ✔ Submit  →',
    '',
    '',
    '❯ 1. S',
    '     Nhỏ.',
    '  2. M',
    '  3. Type something.',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n')

  it('never takes a question from an older frame in scrollback', () => {
    const view = parseQuestionPane(midRepaint) as QuestionView
    expect(view.kind).toBe('question')
    expect(view.rows.map((r) => r.label)).toEqual(['S', 'M'])
    expect(view.question).toBe('')   // → the watcher skips this tick instead of announcing a stale title
  })

  it('so the watcher announces nothing until the question paints', async () => {
    let capture = midRepaint
    const seen: string[] = []
    const w = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as RegisteredSession),
      capture: async () => capture,
      hasDevice: () => true,
      onQuestion: (_s, _r, qs) => { seen.push(qs[0].q) },
    })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    await tick()
    expect(seen).toEqual([])
    capture = midRepaint.replace('←  ☒ Màu  ☐ Size  ✔ Submit  →\n\n', '←  ☒ Màu  ☐ Size  ✔ Submit  →\n\nChọn size?\n')
    await tick()
    expect(seen).toEqual(['Chọn size?'])
  })
})

/**
 * Command Code paints the same dialog as Claude but with NO footer — the pane just ends at the last
 * option — so the footer anchor found nothing and the device showed no question at all while the terminal
 * sat waiting for an answer. Fixture captured from a live pane.
 */
describe('the Command Code question dialog', () => {
  const capture = fixture('commandcode')

  it('reads it through the tab bar instead of a footer', () => {
    const view = parseQuestionPane(capture)
    expect(view?.kind).toBe('question')
    if (view?.kind !== 'question') return
    expect(view.question).toBe('"Cầu vụ" bạn muốn game gì?')
    expect(view.rows.map((row) => row.label)).toEqual([
      'Cờ vua (Chess) (Recommended)',
      'Cầu vồng',
      'Cầu vượt',
    ])
  })

  it('keeps the free-text row out of the options', () => {
    // Claude writes "Type something.", Command Code "Type something..." — treated as an option it would
    // both pollute the device's list and leave a voice answer nowhere to go.
    const view = parseQuestionPane(capture)
    if (view?.kind !== 'question') throw new Error('not a question')
    expect(view.typeRow?.number).toBe('4')
    expect(view.rows.some((row) => /type something/i.test(row.label))).toBe(false)
  })
})

/**
 * Command Code's review screen has neither Claude's "Ready to submit your answers" line nor a footer —
 * just a Submit/Cancel pair under a numbered summary. Unrecognised, the drive loop hit its "nothing on
 * screen" exit and reported success while the terminal sat on the review screen, unanswered. Fixture
 * captured from a live pane in exactly that state.
 */
describe('the Command Code review screen', () => {
  const capture = fixture('commandcode-review')

  it('is recognised by its Submit/Cancel pair', () => {
    expect(parseQuestionPane(capture)).toEqual({ kind: 'review', submitRow: '1' })
  })

  it('does not read the numbered SUMMARY as options', () => {
    // "1. Quân cờ mày muốn hình dạng kiểu nào?" and friends are recap lines, not choices — reading them
    // as a question is how a review screen turns into a phantom question on the device.
    const view = parseQuestionPane(capture)
    expect(view?.kind).not.toBe('question')
  })
})

/**
 * Permission prompts — the reason this whole bridge matters on a remote machine.
 *
 * The CLI attaches to an agent the USER started, under the user's own config and with no permission flag
 * of ours, so a blocking approval is the pane's normal state rather than an edge case. Every fixture below
 * is a real `tmux capture-pane -e` of a live prompt, triggered by asking the engine to run a curl (or, for
 * opencode, to read outside its workspace) — never hand-written, per `engines/README.md`'s one rule.
 *
 * Four engines needed nothing: codex and hermes already fall out of the shared parser (their footers are
 * its anchor), opencode's is kilo's horizontal prompt, and amp/kilo shipped theirs earlier. Muse and pi
 * are absent because they have no such prompt at all — both sandbox the shell and refuse outright rather
 * than ask (measured: muse answers "the shell is sandboxed to the workspace", pi reports the denial and
 * offers alternatives). Cursor is absent because its free-request limit blocked a capture, and a parser
 * written without one would be exactly the silent failure the one rule exists to prevent.
 */
const permission = (name: string): string =>
  readFileSync(join(__dirname, '__fixtures__', `permission-${name}.txt`), 'utf8')

describe('permission prompts, per engine', () => {
  const cases: Array<{ engine: string; fixture: string; question: string; rows: string[] }> = [
    {
      engine: 'claude', fixture: 'claude',
      question: 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      // Note the TYPOGRAPHIC apostrophe: Claude writes "don’t", not "don't".
      rows: ['Yes', 'Yes, and don’t ask again for: curl *', 'No'],
    },
    {
      engine: 'claude', fixture: 'claude-edit',
      question: 'Approve Edit file: README.md',
      rows: ['Yes', 'Yes, allow all edits during this session (shift+tab)', 'No'],
    },
    {
      engine: 'claude', fixture: 'claude-plan',
      question: 'Approve Claude has written up a plan and is ready to execute. Would you like to proceed?',
      rows: ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'],
    },
    {
      engine: 'commandcode', fixture: 'commandcode',
      question: 'Approve Execute Shell Command: Command Code needs to execute curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin.',
      rows: ['Yes', "Yes, don't ask again for this exact command in this project", 'No, tell Command Code what to do differently'],
    },
    {
      engine: 'codex', fixture: 'codex',
      question: "$ printf 'hi\\n' > /private/etc/harness-probe.txt",
      rows: [
        'Yes, proceed (y)',
        "Yes, and don't ask again for commands that start with `printf 'hi\\n' > /private/etc/harness-probe.txt` (p)",
        'No, and tell Codex what to do differently (esc)',
      ],
    },
    {
      engine: 'devin', fixture: 'devin',
      question: 'Approve curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      rows: ['Yes (Approve once)', 'Yes, allow `curl` commands', 'Yes, always allow `curl` commands in `work-devin`', 'Yes, always allow `curl` commands in all projects', 'No'],
    },
    {
      engine: 'grok', fixture: 'grok',
      question: 'curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      rows: ["Yes, and don't ask again for anything (always-approve mode)", 'Yes, proceed', 'No, reject (type to add feedback)'],
    },
    {
      // Muse gates the NETWORK, not the command: its prompt names the host, and it only appears at all
      // because `--approval-mode` defaults to `on-request`. A first sweep that only tried a sandboxed
      // file write concluded muse never asks — it does.
      engine: 'muse', fixture: 'muse',
      question: '$ curl -s https://example.com',
      rows: ['Yes, proceed (y)', "Yes, don't ask again this session (p)  example.com:443 (https)", 'No, and tell Muse Code what to do differently (esc)'],
    },
    {
      engine: 'hermes', fixture: 'hermes',
      question: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      rows: ['Allow once', 'Allow for this session', 'Deny'],
    },
    {
      // Cursor is the third selection mechanism: it numbers nothing and walks nothing — each row states
      // its own key, so `number` carries `y` / `Tab` / `BTab` / `n` instead of a digit or an index.
      engine: 'cursor', fixture: 'cursor',
      question: 'Approve curl -s https://example.com',
      rows: ['Run (once)', 'Add Shell(curl) to allowlist?', 'Run Everything', 'Skip & tell the agent what to do instead'],
    },
    {
      engine: 'opencode', fixture: 'opencode',
      question: 'Access external directory /private/etc',
      rows: ['Allow once', 'Allow always', 'Reject'],
    },
  ]

  for (const c of cases) {
    describe(`${c.engine} (${c.fixture})`, () => {
      const view = (): QuestionView => asQuestion(parseEngineQuestionPane(c.engine as never, permission(c.fixture)))

      it('reads the prompt and every option off the pane', () => {
        expect(view().question).toBe(c.question)
        expect(view().rows.map((row) => row.label)).toEqual(c.rows)
      })

      it('keeps a way to say no', () => {
        // Amp's rule, and the reason its "Reject with feedback" row survives: a device user offered three
        // ways to approve and none to decline cannot answer the prompt at all. The word varies more than
        // it looks — cursor says "Skip", hermes says "Deny" — which is why the shared REJECT_RE lists all
        // of them rather than assuming "no".
        expect(view().rows.some((row) => /^(no|reject|deny|skip|cancel)\b|^tell\b.*\bwhat to change\b/i.test(row.label))).toBe(true)
      })

      it('is single-select with nothing to type into', () => {
        // The device answers a question by TAPPING (ui_screens.c) and an approval has no free-text row,
        // so a typeRow here would offer a choice the device can never make.
        expect(view().multi).toBe(false)
        expect(view().typeRow).toBeNull()
      })

      it('fits the device screen', () => {
        // Firmware caps: Q_MAX 4 questions, OPT_MAX 6 options. Overflow is dropped SILENTLY, and the row
        // that would fall off the end is the last one — which on devin is "No".
        expect(view().rows.length).toBeLessThanOrEqual(6)
      })
    })
  }
})

describe('permission prompts vs the ask dialog', () => {
  // Both anchors can be on one capture, because a pane keeps its scrollback. Whichever sits LOWER is the
  // live dialog; getting this backwards shows the user a prompt they already answered, or answers the
  // wrong dialog with the digit meant for the other.
  it('takes the permission prompt when it is below an answered question', () => {
    const view = asQuestion(parseQuestionPane(fixture('single') + permission('claude')))
    expect(view.rows.map((r) => r.label)).toEqual(['Yes', 'Yes, and don’t ask again for: curl *', 'No'])
  })

  it('takes the question when IT is the lower of the two', () => {
    const view = asQuestion(parseQuestionPane(permission('claude') + fixture('single')))
    expect(view.question).toBe('Which drink would you like?')
    expect(view.rows.map((r) => r.label)).toEqual(['Tea', 'Coffee'])
  })

  it('does not read an ordinary numbered list as an approval', () => {
    // The rows are what identify a permission prompt — a list that offers no way to decline is prose.
    const prose = [
      'Here is the plan:',
      '  1. Yes we should refactor the parser',
      '  2. Then update the fixtures',
      '',
      'Esc to cancel',
    ].join('\n')
    expect(parseQuestionPane(prose)).toBeNull()
  })

  it('does not read a numbered block with no key hints under it as an approval', () => {
    const orphan = ['  1. Yes', '  2. No', '', '', '', '', '', ''].join('\n')
    expect(parseQuestionPane(orphan)).toBeNull()
  })
})

describe('answering a permission prompt from the device', () => {
  it('presses the digit that declines, on an engine whose rows are numbered', () => {
    // Verified on a live claude pane: one digit selects AND submits, so no Enter follows it.
    const h = machine([permission('claude'), CLOSED])
    const answers = { 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin': 'No' }
    return h.controller.answer({ requestId: idOf(permission('claude')), sessionId: 's1', answers }).then((r) => {
      expect(r.ok).toBe(true)
      expect(h.keys).toEqual(['3'])
    })
  })

  it('presses devin\'s real row number, not its position in the shortened list', () => {
    // Devin's "No" is row 7 of 7; two unanswerable editor rows are dropped from what the device shows, so
    // the label→digit mapping must survive that filter.
    const h = machine([permission('devin'), CLOSED], 'devin')
    return h.controller.answer({ requestId: idOf(permission('devin'), 'devin'), sessionId: 's1', answers: { 'Approve curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin': 'No' } }).then((r) => {
      expect(r.ok).toBe(true)
      expect(h.keys).toEqual(['7'])
    })
  })

  it('walks to the row on opencode, whose permission prompt numbers nothing', () => {
    // opencode draws BOTH a numbered ask dialog and kilo's horizontal prompt, so the direction travels on
    // the ROW. Keying "2" here would select nothing at all.
    const h = machine([permission('opencode'), CLOSED], 'opencode')
    return h.controller.answer({ requestId: idOf(permission('opencode'), 'opencode'), sessionId: 's1', answers: { 'Access external directory /private/etc': 'Reject' } }).then((r) => {
      expect(r.ok).toBe(true)
      expect(h.keys).toEqual(['Right', 'Right', 'Enter'])
    })
  })

  it('matches an option the device truncated to its 80-byte buffer', () => {
    const h = machine([permission('codex'), CLOSED], 'codex')
    const truncated = "Yes, and don't ask again for commands that start with `printf 'hi\\n' > /priva"
    return h.controller.answer({ requestId: idOf(permission('codex'), 'codex'), sessionId: 's1', answers: { "$ printf 'hi\\n' > /private/etc/harness-probe.txt": truncated } }).then((r) => {
      expect(r.ok).toBe(true)
      expect(h.keys).toEqual(['2'])
    })
  })
})

describe('QuestionWatcher on a permission prompt', () => {
  it('announces it exactly like a question, so the firmware renders it unchanged', async () => {
    const seen: Array<{ requestId: string; questions: Array<{ key: string; q: string; options: string[]; multi: boolean }> }> = []
    const w = new QuestionWatcher({
      getSession: () => ({ sessionId: 's1', tmuxPane: '%1', engine: 'claude' } as RegisteredSession),
      capture: async () => permission('claude'),
      hasDevice: () => true,
      onQuestion: (_s, requestId, questions) => { seen.push({ requestId, questions }) },
    })
    const tick = (): Promise<void> => (w as unknown as { tick: (s: string) => Promise<void> }).tick('s1')
    await tick()
    expect(seen).toHaveLength(1)
    expect(seen[0].questions[0]).toMatchObject({
      q: 'Approve Bash command: curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      options: ['Yes', 'Yes, and don’t ask again for: curl *', 'No'],
      multi: false,
    })
    // Same prompt still on screen ⇒ announced once, not every 1.5s tick.
    await tick()
    expect(seen).toHaveLength(1)
  })
})

// ── the requestId of a dialog that is waiting ────────────────────────────────────────────────────────
//
// The id is recomputed on every 1.5s poll (a new id = a new question: the needs-you alert, the sound, the
// dial push) and again at the moment an answer is typed (a new id = STALE_QUESTION, nothing typed). So it
// may only change when the QUESTION does — never because a timer ticked, the cursor moved or a box was
// ticked. Hashing the raw `dialog` broke both halves for every engine that keeps one.

const FIXTURES = join(__dirname, '__fixtures__')
// SGR and cursor codes, and OSC 8 hyperlinks (grok) — what a person sees is what is left.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const paneOf = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8').replace(ANSI_RE, '')
const engineOf = (file: string): Parameters<typeof parseEngineQuestionPane>[0] => {
  const name = /^(?:permission|question)-([a-z]+)/.exec(file)![1]
  return (['single', 'multi', 'tabs', 'review'].includes(name) ? 'claude' : name) as Parameters<typeof parseEngineQuestionPane>[0]
}
const viewIn = (file: string, pane: string): QuestionView => asQuestion(parseEngineQuestionPane(engineOf(file), pane))
const idIn = (file: string, pane: string): string => questionRequestId('s1', viewIn(file, pane))
/** main's fingerprint — the words, the options, the arity — which never saw the dialog below its first line. */
const wordsOf = (view: QuestionView): string => `${view.question}|${view.rows.map((r) => r.label).join('|')}|${view.multi}`

/** Every captured dialog that is an open question (review screens have no id). */
const OPEN = readdirSync(FIXTURES)
  .filter((file) => /^(permission|question)-.*\.txt$/.test(file))
  .filter((file) => {
    const view = parseEngineQuestionPane(engineOf(file), paneOf(file))
    return view?.kind === 'question' && !view.partial && !!view.question && view.rows.length > 0
  })
  .sort()

/** Advance every live timer on the pane by `by`: `(01m30s · ↓ 82 tok)`, `(21s · esc to interrupt)`,
 *  `( 30.5s · ↓ 63 tok)`, `(1s • esc to interrupt)`, grok's bare `1m33s`, a footer's `(89s)`. */
const tickTimers = (pane: string, by: number): string =>
  pane
    .replace(/\([^()\n]*?(?:\d(?:ms|s|m|h)\b|\dm\d|\d\s*tok|esc to interrupt)[^()\n]*\)|\b\d+m\d+s\b|\b\d+(?:\.\d+)?s\b|\b\d+ tok(?:en)?s?\b/g,
      (live) => live.replace(/\d+/g, (n) => String(Number(n) + by).padStart(n.length, '0')))

interface CursorStyle { at: RegExp; row: RegExp; off: (line: string) => string; on: (line: string, glyph: string) => string }
const CURSOR_STYLES: CursorStyle[] = [
  { // `❯ 1. Yes` over `  2. No`: Claude, Command Code, Codex and Muse (`›`), agy (`>`), Copilot, Hermes.
    // The last "row" a cursor can sit on in Claude's multi-select is the unnumbered Submit/Next.
    at: /^(\s*(?:[│┃|]\s*)?)([❯›>])(\s*)(\d+\.\s.*)$/,
    row: /^(\s*(?:[│┃|]\s*)?)(\s\s)((?:\d+\.\s|(?:Submit|Next)\s*$).*)$/,
    off: (line) => line.replace(/^(\s*(?:[│┃|]\s*)?)([❯›>])(\s*)(\d+\.\s.*)$/, (_m, a: string, _g, sp: string, rest: string) => `${a} ${sp}${rest}`),
    on: (line, glyph) => line.replace(/^(\s*(?:[│┃|]\s*)?)(\s\s)(.*)$/, (_m, a: string, _s, rest: string) => `${a}${glyph} ${rest}`),
  },
  { // devin: `❭ 1 Xanh` over `· 2 Đỏ` and `·   Other (type your own)`.
    at: /^(\s*)❭(\s.*)$/,
    row: /^(\s*)·(\s.*)$/,
    off: (line) => line.replace(/^(\s*)❭/, '$1·'),
    on: (line) => line.replace(/^(\s*)·/, '$1❭'),
  },
  { // grok's permission radio: `1 (●) Yes, and don't ask again…` over `2 (○) Yes, proceed`.
    at: /^.*\b\d+ \(●\)/,
    row: /^.*\b\d+ \(○\)/,
    off: (line) => line.replace('(●)', '(○)'),
    on: (line) => line.replace('(○)', '(●)'),
  },
]

/** The pane with the cursor moved to each other row of the live dialog, one pane per row. */
function cursorMoves(pane: string): string[] {
  const lines = pane.split('\n')
  for (const style of CURSOR_STYLES) {
    const cur = lines.findLastIndex((line) => style.at.test(line))
    if (cur < 0) continue
    const glyph = /[❯›>❭●]/.exec(lines[cur].replace(/^\s*[│┃|]/, ''))![0]
    const targets: number[] = []
    // The rows around the cursor, allowing a description line or a rule between two of them.
    for (const step of [-1, 1]) {
      for (let i = cur + step, gap = 0; i >= 0 && i < lines.length && gap <= 2; i += step) {
        if (style.row.test(lines[i])) { targets.push(i); gap = 0 } else gap++
      }
    }
    return targets.map((t) => {
      const moved = [...lines]
      moved[cur] = style.off(lines[cur])
      moved[t] = style.on(lines[t], glyph)
      return moved.join('\n')
    })
  }
  return []
}

/** The live multi-select with each box ticked in turn, then all of them. */
function boxToggles(pane: string): string[] {
  const lines = pane.split('\n')
  const first = lines.findLastIndex((line) => /\b1\.\s+\[ \]|^\s*[□■]\s+1\s/.test(line))
  if (first < 0) return []
  // Every option's box; not the free-text row's, which opens an editor rather than ticking a choice.
  const boxes = lines.map((line, i) => i >= first && /\d\.\s+\[ \]|^\s*□\s/.test(line) && !/type something|type your own/i.test(line) ? i : -1)
    .filter((i) => i >= 0)
  const tick = (line: string): string => line.replace('[ ]', '[✔]').replace(/^(\s*)□/, '$1■')
  const one = boxes.map((b) => lines.map((line, i) => i === b ? tick(line) : line).join('\n'))
  return [...one, lines.map((line, i) => boxes.includes(i) ? tick(line) : line).join('\n')]
}

// TUIs that mark the highlighted row by colour alone (the SGR is gone once captured) or lay the rows out
// side by side: no glyph in the text to move, so nothing a cursor does can reach the id.
const CURSOR_BY_COLOUR = ['permission-cursor.txt', 'permission-opencode.txt', 'question-grok.txt', 'question-kilo.txt', 'question-opencode.txt', 'question-devin-multi.txt']
// The captures that paint a live timer — inside the dialog (Hermes, Muse) or around it.
const TICKING = ['permission-grok.txt', 'permission-hermes.txt', 'permission-muse.txt', 'question-codex.txt', 'question-grok.txt', 'question-hermes.txt', 'question-muse.txt']

describe('a waiting dialog keeps one requestId', () => {
  it('covers every captured dialog', () => {
    // A new fixture joins every case below by being in the folder; this only guards the sweep itself.
    expect(OPEN.length).toBeGreaterThanOrEqual(25)
    for (const file of TICKING) expect(OPEN).toContain(file)
  })

  it.each(OPEN)('%s: while its timers tick', (file) => {
    const pane = paneOf(file)
    const id = idIn(file, pane)
    for (const by of [1, 7, 61, 997]) expect(idIn(file, tickTimers(pane, by))).toBe(id)
  })

  it.each(TICKING)('%s: the timer really is on the pane (the tick test is not vacuous)', (file) => {
    expect(tickTimers(paneOf(file), 1)).not.toBe(paneOf(file))
  })

  it.each(['permission-hermes.txt', 'permission-muse.txt', 'question-hermes.txt'])('%s: even though the timer is inside the dialog itself', (file) => {
    const pane = paneOf(file)
    expect(viewIn(file, tickTimers(pane, 1)).dialog).not.toBe(viewIn(file, pane).dialog)
    expect(idIn(file, tickTimers(pane, 1))).toBe(idIn(file, pane))
  })

  it.each(OPEN)('%s: with the cursor on each row', (file) => {
    const pane = paneOf(file)
    const moves = cursorMoves(pane)
    if (moves.length === 0) { expect(CURSOR_BY_COLOUR).toContain(file); return }
    const view = viewIn(file, pane)
    for (const moved of moves) {
      expect(moved).not.toBe(pane)
      // The move is a real one: the same dialog, still read as the same question with the same options.
      expect(wordsOf(viewIn(file, moved))).toBe(wordsOf(view))
      expect(idIn(file, moved)).toBe(idIn(file, pane))
      // …and with its timers ticking at the same time.
      expect(idIn(file, tickTimers(moved, 3))).toBe(idIn(file, pane))
    }
  })

  it('moves the cursor through every row of the dialogs whose rows it can see', () => {
    // Guards the sweep above against quietly moving nothing: each of these is `❯ 1.` over N more rows.
    expect(cursorMoves(paneOf('permission-claude.txt'))).toHaveLength(2)
    expect(cursorMoves(paneOf('question-single.txt'))).toHaveLength(3)           // Coffee, Type something, Chat
    expect(cursorMoves(paneOf('question-multi.txt'))).toHaveLength(5)            // + Submit
    expect(cursorMoves(paneOf('permission-devin.txt'))).toHaveLength(6)
    expect(cursorMoves(paneOf('permission-grok.txt'))).toHaveLength(2)
  })

  it.each(['question-multi.txt', 'question-tabs.txt', 'question-devin-multi.txt'])('%s: with its boxes ticked', (file) => {
    const pane = paneOf(file)
    const toggles = boxToggles(pane)
    expect(toggles.length).toBeGreaterThanOrEqual(4)
    for (const toggled of toggles) {
      expect(viewIn(file, toggled).rows.some((row) => row.checked)).toBe(true)
      expect(idIn(file, toggled)).toBe(idIn(file, pane))
      for (const moved of cursorMoves(toggled)) expect(idIn(file, moved)).toBe(idIn(file, pane))
    }
  })

  it('keeps the raw dialog — timer, cursor and all — for the pair floor, which reads it exactly', () => {
    const view = viewIn('permission-hermes.txt', paneOf('permission-hermes.txt'))
    expect(view.dialog).toContain('❯ 1. Allow once')
    expect(view.dialog).toContain('(01m30s · ↓ 82 tok)')
  })
})

describe('two different commands are still two requestIds', () => {
  // The reason the dialog is in the id at all: a command that wraps is only whole there. What was taken
  // out of it above must never be enough to make two commands look alike.
  function variants(file: string, from: string, to: [string, string]): [string, string] {
    const pane = paneOf(file)
    expect(pane).toContain(from)
    return [pane.replace(from, to[0]), pane.replace(from, to[1])]
  }

  const cases: Array<{ file: string; from: string; to: [string, string] }> = [
    // Claude titles the prompt by the command's FIRST line; the second is only in the dialog.
    { file: 'permission-claude.txt', from: '   curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin',
      to: ['   npm test &&\n   git push', '   npm test &&\n   rm -rf ~/work'] },
    // Codex titles it by the line just above the rows — the LAST line — so the middle one differs.
    { file: 'permission-codex.txt', from: "  $ printf 'hi\\n' > /private/etc/harness-probe.txt",
      to: ['  $ npm test &&\n    git status &&\n    git push', '  $ npm test &&\n    rm -rf ~/work &&\n    git push'] },
    // Hermes titles it by the URL on the second line; the first (`curl -s`) is only in the dialog.
    { file: 'permission-hermes.txt', from: '│ curl -s ', to: ['│ curl -s ', '│ rm -rf  '] },
    // Muse: what is being reached, in the body above the command.
    { file: 'permission-muse.txt', from: 'network: example.com:443 https', to: ['network: example.com:443 https', 'network: evil.example:443 https'] },
  ]

  it.each(cases)('$file: a different command below its first line', ({ file, from, to }) => {
    const [a, b] = variants(file, from, to)
    // main's fingerprint cannot see the difference…
    expect(wordsOf(viewIn(file, a))).toBe(wordsOf(viewIn(file, b)))
    // …the id can, with the timers ticking and the cursor anywhere.
    expect(idIn(file, a)).not.toBe(idIn(file, b))
    expect(idIn(file, tickTimers(a, 5))).toBe(idIn(file, a))
    expect(idIn(file, tickTimers(b, 5))).toBe(idIn(file, b))
    for (const moved of cursorMoves(b)) expect(idIn(file, moved)).not.toBe(idIn(file, a))
  })
})

describe('the review\'s simulation: a real QuestionWatcher and AskQuestionController over one pane', () => {
  // What the dial saw: the question re-announced on every poll, then its answer refused as STALE_QUESTION.
  function world(engine: string, first: string) {
    let screen = first
    const session = { agentId: 'a1', sessionId: 's1', engine, active: true, tmuxPane: '%1' } as unknown as RegisteredSession
    const announced: string[] = []
    const watcher = new QuestionWatcher({
      getSession: () => session,
      capture: async () => screen,
      hasDevice: () => true,
      onQuestion: (_s, requestId) => { announced.push(requestId) },
      onQuestionGone: (_s, requestId) => { announced.push(`gone:${requestId}`) },
    })
    const keys: string[] = []
    const controller = new AskQuestionController({
      getSession: () => session,
      capture: async () => screen,
      sendText: async () => true,
      // The keystroke answers the dialog: it leaves the pane.
      sendKey: async (_t, key) => { keys.push(key); screen = '❯ '; return true },
      wait: async () => {},
    })
    return {
      announced,
      keys,
      show: (pane: string) => { screen = pane },
      poll: () => (watcher as unknown as { tick: (s: string) => Promise<void> }).tick('s1'),
      controller,
    }
  }

  it('Claude: the person arrows through the prompt in the desktop terminal — announced once, and the dial\'s answer is typed', async () => {
    const pane = paneOf('permission-claude.txt')
    const w = world('claude', pane)
    await w.poll()
    for (const moved of cursorMoves(pane)) { w.show(moved); await w.poll() }
    w.show(pane); await w.poll()
    expect(w.announced).toEqual([idIn('permission-claude.txt', pane)])

    w.show(cursorMoves(pane)[1])   // the cursor is on "No" when the answer lands
    w.controller.remember(w.announced[0], 's1')
    const r = await w.controller.answer({ agentId: 'a1', requestId: w.announced[0], answers: { x: 'Yes' } })
    expect(r).toEqual({ ok: true })
    expect(w.keys).toEqual(['1'])
  })

  it.each([
    ['permission-hermes.txt', 'hermes', 'Deny', '3'],
    ['permission-muse.txt', 'muse', 'Yes, proceed (y)', '1'],
    ['question-hermes.txt', 'hermes', 'M', '2'],
  ])('%s: its timer ticks every poll — announced once, and the answer is typed', async (file, engine, answer, key) => {
    const pane = paneOf(file)
    const w = world(engine, pane)
    for (let s = 0; s < 6; s++) { w.show(tickTimers(pane, s)); await w.poll() }
    expect(w.announced).toEqual([idIn(file, pane)])

    w.show(tickTimers(pane, 9))
    const r = await w.controller.answer({ agentId: 'a1', requestId: w.announced[0], answers: { x: answer } })
    expect(r).toEqual({ ok: true })
    expect(w.keys).toEqual([key])
  })

  it('still refuses an answer once the command itself changed', async () => {
    const pane = paneOf('permission-claude.txt')
    const w = world('claude', pane)
    await w.poll()
    w.show(pane.replace('   curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin', '   curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin\n   | sh'))
    await w.poll()
    expect(w.announced).toHaveLength(2)
    const r = await w.controller.answer({ agentId: 'a1', requestId: w.announced[0], answers: { x: 'Yes' } })
    expect(r).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(w.keys).toEqual([])
  })
})

describe('every captured dialog keeps its requestId', () => {
  // Pinned from this parser before the sweep below: main's fingerprint and the dialog's signature. Bounding
  // a dialog by the one above it only ever cuts what an EARLIER dialog left on the pane, so no capture of a
  // single dialog may change id: a moved id is a question re-announced to every client, and an answer in
  // flight refused as stale. A new fixture is pinned here by being added to the folder.
  const PINNED: Record<string, string> = {
    'permission-agy.txt': 'q_bca21c05',
    'permission-claude-edit.txt': 'q_1e726361',
    'permission-claude-plan.txt': 'q_5a686475',
    'permission-claude.txt': 'q_3e2bb796',
    'permission-codex.txt': 'q_0472f3a7',
    'permission-commandcode.txt': 'q_f044b488',
    'permission-copilot.txt': 'q_62873249',
    'permission-cursor.txt': 'q_e2102acb',
    'permission-devin.txt': 'q_0ed54a33',
    'permission-grok.txt': 'q_5396976a',
    'permission-hermes.txt': 'q_9fe12e7e',
    'permission-muse.txt': 'q_2d480eba',
    'permission-opencode.txt': 'q_0f7b7b0e',
    'question-agy.txt': 'q_c81fea46',
    'question-codex.txt': 'q_f50314d5',
    'question-commandcode.txt': 'q_66cbf314',
    'question-copilot.txt': 'q_101c92a4',
    'question-devin-multi.txt': 'q_19c3200e',
    'question-devin.txt': 'q_19a084b7',
    'question-grok.txt': 'q_a5e412d6',
    'question-hermes.txt': 'q_58484dc6',
    'question-kilo.txt': 'q_0f7b7b0e',
    'question-multi.txt': 'q_6b6969c5',
    'question-muse.txt': 'q_42c9e375',
    'question-opencode.txt': 'q_a71204f9',
    'question-single.txt': 'q_321279c1',
    'question-tabs.txt': 'q_76723591',
  }
  const answered = ['─'.repeat(60), ' Bash command', '', '   npm test', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend', '',
    '⏺ Bash(npm test)', '  ⎿  ok', '']

  it('pins every open fixture', () => {
    expect(Object.keys(PINNED).sort()).toEqual(OPEN)
  })

  it.each(OPEN)('%s: alone, and under an answered prompt in scrollback', (file) => {
    expect(idIn(file, paneOf(file))).toBe(PINNED[file])
    expect(idIn(file, [...answered, paneOf(file)].join('\n'))).toBe(PINNED[file])
  })

  it('reads muse\'s approval, not the answered question above it (regression)', () => {
    const pane = [paneOf('question-muse.txt'), paneOf('permission-muse.txt')].join('\n')
    expect(viewIn('permission-muse.txt', pane)).toMatchObject({ question: '$ curl -s https://example.com', rows: [{ label: 'Yes, proceed (y)' }, { label: expect.stringMatching(/^Yes, don't ask again/) }, { label: expect.stringMatching(/^No/) }] })
    expect(idIn('permission-muse.txt', pane)).toBe(PINNED['permission-muse.txt'])
  })

  it('reads Command Code\'s footer-less question, not the answered question above it (regression)', () => {
    const pane = [paneOf('question-single.txt'), paneOf('question-commandcode.txt')].join('\n')
    expect(viewIn('question-commandcode.txt', pane).question).toBe('"Cầu vụ" bạn muốn game gì?')
    expect(idIn('question-commandcode.txt', pane)).toBe(PINNED['question-commandcode.txt'])
  })
})

describe('the dialog read is the LAST one on the pane (regression: an answered dialog above was read instead)', () => {
  // A pane keeps an answered dialog in its scrollback and paints the live one under it. Every reader must
  // read the live one, and nothing of it from above the answered one's end: found with the live dialog
  // under an answered one, muse's approval read as the muse question above it, and Command Code's
  // footer-less question as the footered question above it — under THAT question's requestId.
  const ALL = readdirSync(FIXTURES).filter((file) => /^(permission|question)-.*\.txt$/.test(file)).sort()
  /** What a client is shown, and the id its answer comes back under. */
  const readIn = (file: string, pane: string) => {
    const view = parseEngineQuestionPane(engineOf(file), pane)
    return view?.kind === 'question' && view.question ? { ...view, id: questionRequestId('s1', view) } : view
  }
  /**
   * The capture cut to its own dialog: the fewest last lines that read as the whole capture does, alone and
   * under unrelated output. The second half keeps the dialog's own top (a rule, a bullet) in the cut: the
   * dialog a footer dialog carries reads up to it, and without it would read the output above instead.
   */
  const ownDialog = (file: string): string => {
    const lines = paneOf(file).split('\n')
    const whole = JSON.stringify(readIn(file, paneOf(file)))
    const output = `${Array(14).fill('  some earlier output').join('\n')}\n`
    const same = (top: number) => JSON.stringify(readIn(file, lines.slice(top).join('\n'))) === whole
      && JSON.stringify(readIn(file, output + lines.slice(top).join('\n'))) === whole
    let top = 0
    while (top + 1 < lines.length && same(top + 1)) top++
    return lines.slice(top).join('\n')
  }

  it('sweeps every captured dialog', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(29)
    expect(ALL).toEqual(expect.arrayContaining([...OPEN, 'question-review.txt', 'question-commandcode-review.txt', 'question-opencode-review.txt']))
  })

  it.each(ALL)('%s: under every other captured dialog, answered, reads as it does alone', (file) => {
    const alone = readIn(file, paneOf(file))
    expect(alone).not.toBeNull()
    const own = ownDialog(file)
    for (const other of ALL.filter((name) => name !== file)) {
      // The whole capture under the other's whole capture, and this dialog alone right under the other's.
      expect({ other, read: readIn(file, [paneOf(other), paneOf(file)].join('\n')) }).toEqual({ other, read: alone })
      expect({ other, read: readIn(file, [paneOf(other).trimEnd(), own].join('\n')) }).toEqual({ other, read: alone })
    }
  })
})

describe('a bare timer line in the dialog keeps the requestId (regression: `waiting 3s` moved it every tick)', () => {
  // Found end to end: a status line with no parentheses and no ` · ` sat inside the dialog the id hashes,
  // so every second was a new question: re-announced, and every answer to it refused as stale.
  const FILE = 'permission-codex.txt'
  const ASKED = '  Would you like to run the following command?'
  const withLine = (line: string): string => {
    expect(paneOf(FILE)).toContain(ASKED)
    return paneOf(FILE).replace(ASKED, `  ${line}\n${ASKED}`)
  }

  it.each([
    'waiting 3s', 'Waiting… 12s', 'thinking 4s', 'Churned for 4s', '✻ Working... 1m30s', '⠼ Fetch Bitcoin price… 1m33s',
    'Waiting on answers for the command?          4.2s',
  ])('%s', (status) => {
    const pane = withLine(status)
    expect(viewIn(FILE, pane).dialog).toContain(status)
    expect(tickTimers(pane, 1)).not.toBe(pane)
    for (const by of [1, 7, 61, 997]) expect(idIn(FILE, tickTimers(pane, by))).toBe(idIn(FILE, pane))
  })

  it.each([
    ['sleep 30s', 'sleep 99s'],
    ['$ timeout 30s npm test', '$ timeout 99s npm test'],
    ['Reason: retry after 30s', 'Reason: retry after 99s'],
    ['npm test && sleep 5s', 'npm test && sleep 500s'],
    ['Waiting on answers for the command?          4.2s', 'Waiting on answers for another command?          4.2s'],
  ])('keeps the prompt\'s own words and numbers: %s', (a, b) => {
    expect(idIn(FILE, withLine(a))).not.toBe(idIn(FILE, withLine(b)))
  })
})
