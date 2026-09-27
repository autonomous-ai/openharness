/**
 * The owning machine's floor (pair/owner.ts): a REAL PairSensor and journal, and — for answers — the
 * real AskQuestionController over a fake pane, so "a stale answer types nothing" is proved against the
 * same code that keys a person's answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairJournal } from './journal.js'
import { PairSensor } from './sensor.js'
import { PairOwner, type OwnerDeps, type OwnerSubject } from './owner.js'
import { answerFloor, matchOption } from './floor.js'
import type { Autonomy } from './floor.js'
import { AskQuestionController, parseEngineQuestionPane, questionRequestId, type QuestionView } from '../lib/askQuestion.js'
import type { RegisteredSession } from '../lib/registry.js'

const SUBJECTS: Record<string, OwnerSubject> = {
  api: { agentId: 'api', name: 'api', engine: 'claude', status: 'live', untouchable: null, cwd: '/w/api' },
  sh: { agentId: 'sh', name: 'shell', engine: 'terminal', status: 'live', untouchable: 'terminal' },
  pair: { agentId: 'pair', name: 'tim', engine: 'claude', status: 'live', untouchable: 'pair' },
  old: { agentId: 'old', name: 'old', engine: 'codex', status: 'stopped', untouchable: null },
}
const ask = (q: string, options = ['1. Yes', '2. No']) => [{ key: q, q, options, multi: false }]
/** A permission prompt, painted as one line (read with certainty: pair/classify.ts). */
const perm = (cmd: string) => ({ permission: true, dialog: `Bash command\n\n  ${cmd}\n\nDo you want to proceed?\n1. Yes\n2. No` })

let dirs: string[] = []
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs = [] })

function world(opts: { autonomy?: Autonomy; keyAnswer?: OwnerDeps['keyAnswer'] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pair-owner-'))
  dirs.push(dir)
  const journal = new PairJournal({ dir })
  const sensor = new PairSensor({
    machineId: () => 'machine-a', journal,
    describe: (id) => SUBJECTS[id] ? { name: SUBJECTS[id].name, engine: SUBJECTS[id].engine, excluded: SUBJECTS[id].untouchable } : null,
  })
  sensor.setPair('tim')
  let autonomy: Autonomy = opts.autonomy ?? 'suggest'
  const calls = {
    message: vi.fn(), cancel: vi.fn(),
    create: vi.fn<OwnerDeps['create']>(async () => ({ ok: true, agentId: 'new-1' })),
    stop: vi.fn<OwnerDeps['stop']>(async () => {}),
    resume: vi.fn<OwnerDeps['resume']>(async () => ({ ok: true })),
    keyAnswer: vi.fn<OwnerDeps['keyAnswer']>(opts.keyAnswer ?? (async () => ({ ok: true }))),
  }
  const owner = new PairOwner({
    sensor, autonomy: () => autonomy,
    subject: (id) => SUBJECTS[id] ?? null,
    subjects: () => Object.values(SUBJECTS),
    recent: () => ({ recaps: ['fixed the login test'], asks: ['fix the login test'] }),
    ...calls,
    newId: () => 'delivery-1',
  })
  const acts = () => journal.since().entries.filter((e) => e.kind === 'act')
  return { owner, sensor, journal, calls, acts, setAutonomy: (level: Autonomy) => { autonomy = level } }
}

describe('the floor', () => {
  it('answers only with the dialog\'s own options, and a deny-class prompt only with its decline', () => {
    const q = { options: ['1. Yes', '2. Yes, and don\'t ask again', '3. No, and tell Claude what to do'], deny: false, allow: true, permission: true }
    expect(matchOption(q.options, 'yes')).toBe('1. Yes')
    expect(matchOption(q.options, '3. no, and tell claude what to do')).toBe('3. No, and tell Claude what to do')
    expect(answerFloor(q, 'rm -rf /')).toMatchObject({ ok: false, error: 'NOT_OFFERED' })
    expect(answerFloor({ ...q, deny: true }, 'Yes')).toMatchObject({ ok: false, error: 'DENY_CLASS' })
    expect(answerFloor({ ...q, deny: true }, "Yes, and don't ask again")).toMatchObject({ ok: false })
    expect(answerFloor({ ...q, deny: true }, 'No, and tell Claude what to do')).toEqual({ ok: true, option: '3. No, and tell Claude what to do' })
    // "Don't ask again" is never keyed, by anyone, on any prompt.
    expect(answerFloor(q, "Yes, and don't ask again")).toMatchObject({ ok: false, error: 'PERSISTENT' })
    expect(answerFloor({ options: ['1. Yes', '2. Yes, allow all edits during this session (shift+tab)', '3. No'], deny: false }, '2')).toMatchObject({ error: 'NOT_OFFERED' })
    expect(answerFloor({ options: ['1. Yes', '2. Yes, allow all edits during this session (shift+tab)', '3. No'], deny: false }, 'Yes, allow all edits during this session (shift+tab)')).toMatchObject({ error: 'PERSISTENT' })
  })

  it('re-checks allow-class for every answer, whoever asked: only a permission prompt, only its no or a one-time yes to an allow-class one', () => {
    const q = { options: ['1. Yes', '2. No'], deny: false, allow: false, permission: true }
    // A permission prompt that is not allow-class (a curl, a multi-line command): its no, never its yes.
    expect(answerFloor(q, 'Yes')).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
    expect(answerFloor(q, 'No')).toEqual({ ok: true, option: '2. No' })
    expect(answerFloor({ ...q, allow: true }, 'Yes')).toEqual({ ok: true, option: '1. Yes' })
    // A question the agent asks, or a plan to approve: nothing at all, not even a "no".
    const choice = { options: ['npm', 'pnpm', 'No preference'], deny: false, allow: false, permission: false }
    expect(answerFloor(choice, 'pnpm')).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
    expect(answerFloor(choice, 'No preference')).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
    const plan = { options: ['1. Yes, and use auto mode', '2. Yes, manually approve edits', '3. Tell Claude what to change'], deny: false, allow: false, permission: true }
    expect(answerFloor(plan, 'Yes, manually approve edits')).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
    // A multi-select is never keyed for the person either.
    expect(answerFloor({ ...q, allow: true, multi: true }, 'Yes')).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
  })
})

describe('answers', () => {
  it('keys the option, journals who asked, and refuses a question that is no longer the one on screen', async () => {
    const w = world()
    w.sensor.question('api', 'q1', ask('Bash: npm test'), perm('npm test'))
    expect(await w.owner.answer({ agentId: 'api', requestId: 'q0', choice: 'Yes' }, 'key')).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    expect(w.calls.keyAnswer).not.toHaveBeenCalled()
    expect(await w.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'yes' }, 'key')).toEqual({ ok: true, option: '1. Yes' })
    expect(w.calls.keyAnswer).toHaveBeenCalledWith({ agentId: 'api', requestId: 'q1', question: 'Bash: npm test', option: '1. Yes' })
    expect(w.acts()).toEqual([expect.objectContaining({ kind: 'act', by: 'key', action: 'answer', requestId: 'q1', agentId: 'api', text: 'answered "1. Yes" to "Bash: npm test"' })])
  })

  it('never approves a prompt that is not allow-class, from any actor — a harness the pair started included', async () => {
    const w = world({ autonomy: 'act-on-key' })
    w.sensor.question('api', 'q1', ask('Bash: curl -s https://example.com'), perm('curl -s https://example.com'))
    for (const by of ['key', 'pair', 'rule'] as const) {
      expect(await w.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, by)).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
    }
    w.sensor.questionGone('api', 'q1')
    w.sensor.question('api', 'q2', ask('Which package manager?', ['npm', 'pnpm']))
    expect(await w.owner.answer({ agentId: 'api', requestId: 'q2', choice: 'pnpm' }, 'pair')).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
    expect(w.calls.keyAnswer).not.toHaveBeenCalled()
    expect(w.acts()).toEqual([])
  })

  it('never approves a deny-class prompt, from any actor, but may decline it', async () => {
    const w = world()
    w.sensor.question('api', 'q1', ask('Bash: git push --force origin main'), perm('git push --force origin main'))
    for (const by of ['key', 'pair', 'rule'] as const) {
      expect(await w.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, by)).toMatchObject({ ok: false, error: 'DENY_CLASS' })
    }
    expect(w.calls.keyAnswer).not.toHaveBeenCalled()
    expect(await w.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'No' }, 'pair')).toMatchObject({ ok: true, option: '2. No' })
  })

  it('surfaces the dialog\'s own STALE_QUESTION and journals nothing when nothing was typed', async () => {
    const w = world({ keyAnswer: async () => ({ ok: false, error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' }) })
    w.sensor.question('api', 'q1', ask('Bash: npm test'), perm('npm test'))
    expect(await w.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, 'key'))
      .toEqual({ ok: false, error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' })
    expect(w.acts()).toEqual([])
  })

  it('never touches a terminal or its own harness, a harness that is gone, or anything while it only watches', async () => {
    const w = world()
    expect(await w.owner.answer({ agentId: 'sh', requestId: 'q', choice: 'Yes' }, 'key')).toMatchObject({ error: 'UNTOUCHABLE' })
    expect(await w.owner.answer({ agentId: 'pair', requestId: 'q', choice: 'Yes' }, 'key')).toMatchObject({ error: 'UNTOUCHABLE' })
    expect(await w.owner.answer({ agentId: 'nope', requestId: 'q', choice: 'Yes' }, 'key')).toMatchObject({ error: 'GONE' })
    expect(await w.owner.answer({ agentId: 'old', requestId: 'q', choice: 'Yes' }, 'key')).toMatchObject({ error: 'GONE' })
    w.setAutonomy('watch')
    w.sensor.question('api', 'q1', ask('Bash: npm test'), perm('npm test'))
    expect(await w.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, 'key')).toMatchObject({ error: 'AUTONOMY_WATCH' })
    expect(w.owner.send({ agentId: 'api', text: 'hi' }, 'pair')).toMatchObject({ error: 'AUTONOMY_WATCH' })
    expect(await w.owner.start({ engine: 'codex', cwd: '/w' }, 'pair')).toMatchObject({ error: 'AUTONOMY_WATCH' })
    expect(w.calls.keyAnswer).not.toHaveBeenCalled()
  })

  describe('through the real AskQuestionController', () => {
    const permission = (): string => readFileSync(join(__dirname, '../lib/__fixtures__/permission-claude.txt'), 'utf8')
    const changed = (): string => permission().replaceAll('curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin', 'npm run build')
    const idOf = (capture: string): string => questionRequestId('s1', parseEngineQuestionPane('claude', capture) as QuestionView)

    function paneWorld(captures: string[]) {
      const keys: string[] = []
      let i = 0
      const controller = new AskQuestionController({
        getSession: () => ({ agentId: 'api', sessionId: 's1', engine: 'claude', tmuxPane: '%1' } as RegisteredSession),
        capture: async () => captures[Math.min(i++, captures.length - 1)],
        sendText: async () => true,
        sendKey: async (_pane, key) => { keys.push(key); return true },
        wait: async () => {},
      })
      const w = world({
        keyAnswer: ({ agentId, requestId, question, option }) => controller.answer({ agentId, requestId, answers: { [question]: option } })
          .then((r) => r.ok ? { ok: true as const } : { ok: false as const, error: r.error, detail: r.detail }),
      })
      const view = parseEngineQuestionPane('claude', permission()) as QuestionView
      w.sensor.question('api', idOf(permission()), [{ key: view.question, q: view.question, options: view.rows.map((r) => r.label), multi: false }], { permission: true, dialog: view.dialog ?? '' })
      return { ...w, keys }
    }

    it('keys the answer when the dialog on screen is still the one it was for', async () => {
      const w = paneWorld([permission(), '❯ '])
      // A curl is not allow-class: its decline is what a key may type.
      expect(await w.owner.answer({ agentId: 'api', requestId: idOf(permission()), choice: 'Yes' }, 'key')).toMatchObject({ ok: false, error: 'NOT_ALLOW_CLASS' })
      expect(await w.owner.answer({ agentId: 'api', requestId: idOf(permission()), choice: 'No' }, 'key')).toMatchObject({ ok: true })
      expect(w.keys).toEqual(['3'])
    })

    it('types nothing when the dialog changed under the answer, and says STALE_QUESTION', async () => {
      const w = paneWorld([changed(), '❯ '])
      expect(await w.owner.answer({ agentId: 'api', requestId: idOf(permission()), choice: 'No' }, 'key'))
        .toEqual({ ok: false, error: 'STALE_QUESTION', detail: 'That question changed before your answer arrived.' })
      expect(w.keys).toEqual([])
      expect(w.acts()).toEqual([])
    })
  })
})

describe('the other writes', () => {
  it('sends a prompt with a delivery id, but never into a dialog, a terminal or its own harness', () => {
    const w = world()
    expect(w.owner.send({ agentId: 'api', text: '  run the tests  ' }, 'pair')).toEqual({ ok: true, deliveryId: 'delivery-1' })
    expect(w.calls.message).toHaveBeenCalledWith('api', 'run the tests', 'delivery-1')
    expect(w.owner.send({ agentId: 'sh', text: 'ls' }, 'pair')).toMatchObject({ error: 'UNTOUCHABLE' })
    expect(w.owner.send({ agentId: 'pair', text: 'hi me' }, 'pair')).toMatchObject({ error: 'UNTOUCHABLE' })
    expect(w.owner.send({ agentId: 'api', text: '   ' }, 'pair')).toMatchObject({ error: 'EMPTY' })
    w.sensor.question('api', 'q1', ask('Bash: npm test'), perm('npm test'))
    expect(w.owner.send({ agentId: 'api', text: 'yes' }, 'pair')).toMatchObject({ error: 'QUESTION_OPEN' })
    expect(w.calls.message).toHaveBeenCalledTimes(1)
  })

  it('stops a turn, pauses through the guarded stop (never delete), and resumes', async () => {
    const w = world()
    expect(w.owner.stop({ agentId: 'api' }, 'key')).toEqual({ ok: true })
    expect(w.calls.cancel).toHaveBeenCalledWith('api')
    expect(await w.owner.pause({ agentId: 'api' }, 'pair')).toEqual({ ok: true })
    expect(w.calls.stop).toHaveBeenCalledWith('api')
    expect(await w.owner.pause({ agentId: 'pair' }, 'pair')).toMatchObject({ error: 'UNTOUCHABLE' })
    w.calls.stop.mockRejectedValueOnce(Object.assign(new Error('Harness changed while saving its conversation.'), { code: 'STOP_UNCONFIRMED' }))
    expect(await w.owner.pause({ agentId: 'api' }, 'pair')).toMatchObject({ ok: false, error: 'STOP_UNCONFIRMED' })
    expect(await w.owner.resume({ agentId: 'old' }, 'pair')).toEqual({ ok: true })
    expect(await w.owner.resume({ agentId: 'api' }, 'pair')).toEqual({ ok: true, already: true })
    expect(w.calls.resume).toHaveBeenCalledTimes(1)
  })

  it('starts an agent in a real folder, never a terminal', async () => {
    const w = world()
    expect(await w.owner.start({ engine: 'codex', cwd: '/w/api', prompt: 'add a test', name: 'tests' }, 'pair')).toEqual({ ok: true, agentId: 'new-1' })
    expect(w.calls.create).toHaveBeenCalledWith({ engine: 'codex', cwd: '/w/api', prompt: 'add a test', name: 'tests' })
    expect(await w.owner.start({ engine: 'terminal', cwd: '/w' }, 'pair')).toMatchObject({ error: 'INVALID_ENGINE' })
    expect(await w.owner.start({ engine: 'codex', cwd: 'relative' }, 'pair')).toMatchObject({ error: 'INVALID_CWD' })
  })

  it('journals every action it takes, with who asked', async () => {
    const w = world()
    w.sensor.question('api', 'q1', ask('Bash: npm test'), perm('npm test'))
    await w.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, 'rule')
    w.sensor.questionGone('api', 'q1')
    w.owner.send({ agentId: 'api', text: 'next' }, 'pair')
    w.owner.stop({ agentId: 'api' }, 'key')
    await w.owner.start({ engine: 'codex', cwd: '/w' }, 'pair')
    await w.owner.pause({ agentId: 'api' }, 'pair')
    await w.owner.resume({ agentId: 'old' }, 'key')
    expect(w.acts().map((e) => [e.action, e.by])).toEqual([
      ['answer', 'rule'], ['send', 'pair'], ['stop', 'key'], ['start', 'pair'], ['pause', 'pair'], ['resume', 'key'],
    ])
  })
})

describe('another machine\'s brain', () => {
  it('answers only an allow-class prompt for another machine, a few a minute per connection', async () => {
    const w = world()
    const from = { connId: 'relay-conn-2' }
    w.sensor.question('api', 'q1', ask('Bash: curl -s https://x'), perm('curl -s https://x'))
    // Not allow-class: not even its decline, from another machine.
    expect(await w.owner.handle('pair_answer', { expectRequestId: 'q1', agentId: 'api', choice: 'No' }, from)).toMatchObject({ error: 'REMOTE_ANSWERS_ONLY' })
    w.sensor.questionGone('api', 'q1')
    // The refused attempt counted too: five more this minute.
    for (let i = 0; i < 5; i++) {
      w.sensor.question('api', `q${i + 2}`, ask('Bash: npm test'), perm('npm test'))
      expect(await w.owner.handle('pair_answer', { expectRequestId: `q${i + 2}`, agentId: 'api', choice: 'No' }, from)).toEqual({ ok: true, option: '2. No' })
      w.sensor.questionGone('api', `q${i + 2}`)
    }
    w.sensor.question('api', 'q9', ask('Bash: npm test'), perm('npm test'))
    expect(await w.owner.handle('pair_answer', { expectRequestId: 'q9', agentId: 'api', choice: 'Yes' }, from)).toMatchObject({ error: 'RATE_LIMITED' })
    // Another connection has its own minute.
    expect(await w.owner.handle('pair_answer', { expectRequestId: 'q9', agentId: 'api', choice: 'Yes' }, { connId: 'relay-conn-3' })).toEqual({ ok: true, option: '1. Yes' })
    expect(w.calls.keyAnswer).toHaveBeenCalledTimes(6)
  })

  it('answers sealed pair_* through the same floor, reading the question id from expectRequestId', async () => {
    const w = world()
    w.sensor.question('api', 'q1', ask('Bash: npm test'), perm('npm test'))
    const from = { connId: 'relay-conn-1', label: 'laptop' }
    // The `by` a request carries is the sender's claim: here it is `remote`, and where it came from is journaled.
    expect(await w.owner.handle('pair_answer', { requestId: 'rpc-1', expectRequestId: 'q1', agentId: 'api', choice: 'Yes', by: 'key' }, from)).toEqual({ ok: true, option: '1. Yes' })
    expect(w.acts()[0]).toMatchObject({ by: 'remote', action: 'answer', origin: 'laptop (relay-conn-1)', text: 'answered "1. Yes" to "Bash: npm test" (from laptop (relay-conn-1))' })
    // Nothing but an answer, from another machine.
    for (const type of ['pair_send', 'pair_stop', 'pair_start', 'pair_pause', 'pair_resume']) {
      expect(await w.owner.handle(type, { agentId: 'api', text: 'ls', engine: 'codex', cwd: '/w', by: 'key' }, from)).toMatchObject({ error: 'REMOTE_ANSWERS_ONLY' })
    }
    expect(w.calls.message).not.toHaveBeenCalled()
    expect(w.calls.stop).not.toHaveBeenCalled()
    expect(w.acts()).toHaveLength(1)
    expect(await w.owner.handle('pair_list', {})).toMatchObject({ harnesses: expect.arrayContaining([expect.objectContaining({ agentId: 'old', status: 'stopped' })]) })
    expect(await w.owner.handle('pair_read', { agentId: 'api' })).toMatchObject({ ok: true, recaps: ['fixed the login test'], asks: ['fix the login test'] })
    expect(await w.owner.handle('pair_read', { agentId: 'sh' })).not.toHaveProperty('recaps')
    expect(await w.owner.handle('pair_bogus', {})).toEqual({ error: 'UNSUPPORTED' })
    w.sensor.setPair(null)
    expect(await w.owner.handle('pair_list', {})).toEqual({ error: 'PAIR_OFF' })
    expect(await w.owner.handle('pair_answer', { expectRequestId: 'q1', agentId: 'api', choice: 'Yes' })).toEqual({ error: 'PAIR_OFF' })
  })
})
