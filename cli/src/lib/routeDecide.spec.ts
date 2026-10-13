// Where a typed task goes: Jev alone, asked once (sure at 0.6, or a clear lead → its session, or new work; else new work; not
// asked at all → nothing decided), how a new harness is set up, what Jev is asked, and what is logged when it
// fails. Jev is a fake here: the question it is put and the answer it gives are the contract.
import { describe, expect, it, vi } from 'vitest'

import type { JevChoice, JevChoiceAnswer } from './jev/jevClient.js'
import { JevUnavailable } from './jev/jevClient.js'
import { decideRoute, JEV_LEAD_OPTIONS, JEV_LEAD_P, JEV_LEAD_RATIO, JEV_LIVE_RATIO, JEV_OVER_STOPPED, JEV_SURE_P, jevPick, offered, type RouteDeps, type RouteInput, type RouteOption, type RouteSession } from './routeDecide.js'

/** A choice of [choice] at [p] over [options], the rest shared evenly among the others. */
function said(choice: string, p: number, options: string[]): JevChoiceAnswer {
  const rest = (1 - p) / Math.max(1, options.length - 1)
  return { choice, probabilities: Object.fromEntries(options.map((id) => [id, id === choice ? p : rest])) }
}

/** A Jev that gives [answers] and records what it was asked. */
function jev(answers: Record<string, JevChoiceAnswer> = {}) {
  return vi.fn(async (_state: unknown, _questions: Record<string, JevChoice>, _signal?: AbortSignal) => answers)
}

const session = (id: string, name: string, asks: string[] = [], about?: string): RouteSession => ({ id, name, asks, ...(about ? { about } : {}) })

const DESK: RouteSession[] = [
  session('a1', 'billing retries', ['why was the card charged twice']),
  session('a2', 'Prometheus alerts', [], 'raised the alert threshold to 90%'),
]
const TARGETS = ['s0', 's1', 'new']
const PROJECTS: RouteOption[] = [{ id: '/code/billing', name: 'billing' }, { id: '/code/infra', name: 'infra monitoring' }]
const AGENTS: RouteOption[] = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }]

const input = (over: Partial<RouteInput> = {}): RouteInput => ({ text: 'the prometheus alert fired again', sessions: DESK, projects: [], agents: [], ...over })
const steps = (trace: string) => trace.split(' · ')

const TARGET_QUESTION = 'A person typed this message into a box that either sends it to one of their ongoing sessions or starts a new one. ' +
  "Choose a session only when the message is clearly about that session's own work: it continues that work, or it is the same " +
  'kind of work on the same subject. Sharing a few words with a session is not enough. If the message names nothing to go on ' +
  '(like "merge it" or "continue"), asks for a new session, or is about another subject, choose none. Prefer a session that is ' +
  'still running over a stopped one, unless the message clearly continues the stopped one.'
const FOLLOW_UP = ' Their previous message went to the session given as previous_message_went_to: a follow-up that names nothing new goes there too; a message about something else does not.'
const TOPIC_QUESTION = {
  type: 'choice',
  instructions: 'Does this message name anything of its own to work on or ask about? A single word is enough: "retention", "the daemon", "the round unit", "the tui".',
  criteria: {
    yes: 'Yes: it names a subject or task, even briefly and even when it starts with "also" or "and"',
    no: 'No: it is only words like "merge it", "do it", "ok merge", "what does that do", "post it as is", "continue", "take care of them all"',
  },
}
/** Jev says the message names nothing of its own, at [p]. */
const topicless = (p = 0.8): JevChoiceAnswer => ({ choice: 'no', probabilities: { yes: 1 - p, no: p } })

describe('Jev\'s pick', () => {
  it('is its choice when it gives it 0.6 or more over exactly the options asked', () => {
    expect(JEV_SURE_P).toBe(0.6)
    expect(jevPick(said('s0', 0.6, ['s0', 'new']), ['s0', 'new'])).toBe('s0')
    expect(jevPick(said('new', 0.95, TARGETS), TARGETS)).toBe('new')
    expect(jevPick(said('s0', 0.59, ['s0', 'new']), ['s0', 'new'])).toBeUndefined()
  })

  it('is a session below 0.6 when it leads clearly over six options or more: 0.4 or more, and twice the next, new work included', () => {
    expect([JEV_LEAD_P, JEV_LEAD_RATIO, JEV_LEAD_OPTIONS]).toEqual([0.4, 2, 6])
    const options = ['s0', 's1', 's2', 's3', 's4', 'new']
    const lead = (p: number[]) => jevPick({ choice: 's0', probabilities: Object.fromEntries(options.map((id, i) => [id, p[i]])) }, options, true)
    // The owner's desk, 2026-10-10: the right session at 0.45, the rest spread thin.
    expect(lead([0.45, 0.15, 0.1, 0.05, 0.05, 0.2])).toBe('s0')
    expect(lead([0.4, 0.2, 0.1, 0.05, 0.05, 0.2])).toBe('s0')
    // Torn with new work, or with a session like it: new work.
    expect(lead([0.45, 0.1, 0.05, 0.05, 0, 0.35])).toBeUndefined()
    expect(lead([0.5, 0.3, 0.05, 0.05, 0, 0.1])).toBeUndefined()
    // Never below 0.4, however thin the rest.
    expect(lead([0.39, 0.01, 0.01, 0.01, 0.01, 0.01])).toBeUndefined()
    // A "choice" that is not Jev's likeliest is not a lead.
    expect(lead([0.45, 0.5, 0.05, 0, 0, 0])).toBeUndefined()
  })

  it('takes no lead over fewer than six options, or where it was not asked for', () => {
    // 0.4 of four options is 0.6 somewhere else: no spread to excuse it.
    const four = ['s0', 's1', 's2', 'new']
    expect(jevPick({ choice: 's0', probabilities: { s0: 0.45, s1: 0.2, s2: 0.15, new: 0.2 } }, four, true)).toBeUndefined()
    // The project and the agent fall back to the pane the person is in: the bar stands for them.
    const six = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
    expect(jevPick({ choice: 'p0', probabilities: { p0: 0.45, p1: 0.15, p2: 0.1, p3: 0.1, p4: 0.1, p5: 0.1 } }, six)).toBeUndefined()
  })

  it('is nothing for an answer that is not a whole one over those options', () => {
    expect(jevPick(undefined, ['s0'])).toBeUndefined()
    expect(jevPick({ choice: 's0' } as unknown as JevChoiceAnswer, ['s0'])).toBeUndefined()
    // A choice it was never offered.
    expect(jevPick({ choice: 's9', probabilities: { s9: 0.9, s0: 0.1 } }, ['s0', 'new'])).toBeUndefined()
    // An option it gave no probability, or one that is not a number.
    expect(jevPick({ choice: 's0', probabilities: { s0: 0.9 } }, ['s0', 'new'])).toBeUndefined()
    expect(jevPick({ choice: 's0', probabilities: { s0: 0.9, new: Number.NaN } }, ['s0', 'new'])).toBeUndefined()
    expect(jevPick({ choice: 's0', probabilities: { s0: Number.POSITIVE_INFINITY, new: 0 } }, ['s0', 'new'])).toBeUndefined()
    expect(jevPick({ choice: 's0', probabilities: { s0: 0.9, new: '0.1' } as unknown as Record<string, number> }, ['s0', 'new'])).toBeUndefined()
  })
})

describe('where a task goes', () => {
  it('goes to the session Jev is sure of, asked once about the session, the project and the agent', async () => {
    const remote = jev({ target: said('s1', 0.8, TARGETS), project: said('p1', 0.9, ['p0', 'p1']), agent: said('a1', 0.9, ['a0', 'a1']) })
    const verdict = await decideRoute(input({ projects: PROJECTS, agents: AGENTS }), { jev: remote })
    // A session needs no project or agent: Jev's picks of them are not part of the verdict.
    expect(verdict).toEqual({ kind: 'session', id: 'a2', p: 0.8, trace: '2 sessions · jev: "Prometheus alerts" 0.80, then "billing retries" 0.10' })
    expect(remote).toHaveBeenCalledOnce()
    const [state, questions] = remote.mock.calls[0]!
    expect(state).toEqual({ message: 'the prometheus alert fired again' })
    expect(questions).toEqual({
      target: {
        type: 'choice',
        instructions: TARGET_QUESTION,
        criteria: {
          s0: 'billing retries — asked: why was the card charged twice',
          s1: 'Prometheus alerts — lately: raised the alert threshold to 90%',
          new: 'None of them: no session does this kind of work',
        },
      },
      topic: TOPIC_QUESTION,
      project: {
        type: 'choice',
        instructions: 'If this becomes new work, which project folder does it belong in?',
        criteria: { p0: 'billing', p1: 'infra monitoring' },
      },
      agent: {
        type: 'choice',
        instructions: 'Which agent is best suited to do this work?',
        criteria: { a0: 'Claude Code', a1: 'Codex' },
      },
    })
  })

  it('describes a session to Jev by its name, its last ask and its last turns, in one line cut short', async () => {
    const remote = jev()
    const long = session('a1', `  ${'n'.repeat(250)}\n`, [`deploy the ${'y'.repeat(200)}`, 'older'], 'z'.repeat(500))
    const tidy = session('a2', 'auth\n\n  api', ['rotate   the\ttokens'])
    await decideRoute(input({
      sessions: [long, tidy, session('a3', 'bare'), session('a4', 'quiet', [], 'only   turns')],
      projects: [{ id: 'p', name: 'x'.repeat(700) }, { id: 'q', name: ' q\n' }],
      agents: [{ id: 'claude', name: 'Claude\nCode' }, { id: 'codex', name: 'Codex' }],
    }), { jev: remote })
    const [, questions] = remote.mock.calls[0]!
    const criteria = questions.target!.criteria
    // The name, then the first 120 of its last ask and the first 420 of its last turns: cut at 600 with an ellipsis.
    expect(criteria.s0).toBe(`${`${'n'.repeat(250)} — asked: deploy the ${'y'.repeat(109)} — lately: ${'z'.repeat(420)}`.slice(0, 599)}…`)
    expect(criteria.s0).toHaveLength(600)
    expect(criteria.s1).toBe('auth api — asked: rotate the tokens')
    expect(criteria.s2).toBe('bare')
    expect(criteria.s3).toBe('quiet — lately: only turns')
    // A project's or an agent's name is tidied and cut the same way.
    expect(questions.project!.criteria).toEqual({ p0: `${'x'.repeat(599)}…`, p1: 'q' })
    expect(questions.agent!.criteria).toEqual({ a0: 'Claude Code', a1: 'Codex' })
  })

  it('asks no project or agent question when there is one or none to choose from', async () => {
    const remote = jev()
    await decideRoute(input({ projects: [PROJECTS[0]!], agents: [AGENTS[0]!] }), { jev: remote })
    expect(Object.keys(remote.mock.calls[0]![1])).toEqual(['target', 'topic'])
    await decideRoute(input(), { jev: remote })
    expect(Object.keys(remote.mock.calls[1]![1])).toEqual(['target', 'topic'])
    // Two projects and one agent: the project is asked, the agent is not.
    await decideRoute(input({ projects: PROJECTS, agents: [AGENTS[0]!] }), { jev: remote })
    expect(Object.keys(remote.mock.calls[2]![1])).toEqual(['target', 'topic', 'project'])
  })

  it('asks Jev about the sessions with "new" alone when the desk is empty', async () => {
    const remote = jev({ target: said('new', 1, ['new']) })
    const verdict = await decideRoute(input({ sessions: [] }), { jev: remote })
    expect(remote.mock.calls[0]![1].target!.criteria).toEqual({ new: 'None of them: no session does this kind of work' })
    expect(verdict).toEqual({ kind: 'new', via: 'jev', why: 'Jev: new work', trace: '0 sessions · jev: "new" 1.00' })
  })

  it('cuts a long rail to its first forty sessions, projects and agents for Jev, as the client ordered them', async () => {
    const remote = jev()
    const many = <T>(make: (i: number) => T) => Array.from({ length: 45 }, (_, i) => make(i))
    const verdict = await decideRoute(input({
      sessions: many((i) => session(`a${i}`, `topic ${i}`)),
      projects: many((i) => ({ id: `/code/${i}`, name: `project ${i}` })),
      agents: many((i) => ({ id: `agent-${i}`, name: `agent ${i}` })),
    }), { jev: remote })
    const [, questions] = remote.mock.calls[0]!
    expect(Object.keys(questions.target!.criteria)).toEqual([...Array.from({ length: 40 }, (_, i) => `s${i}`), 'new'])
    expect(questions.target!.criteria.s39).toBe('topic 39')
    expect(Object.keys(questions.project!.criteria)).toEqual(Array.from({ length: 40 }, (_, i) => `p${i}`))
    expect(Object.keys(questions.agent!.criteria)).toEqual(Array.from({ length: 40 }, (_, i) => `a${i}`))
    // The trace counts the sessions Jev weighed.
    expect(steps(verdict.trace)[0]).toBe('40 sessions')
  })

  it('tells Jev where the person\'s last task went when that was ten minutes ago or less, and that session is among those asked', async () => {
    const remote = jev()
    const stateFor = async (last: RouteInput['last'], sessions = DESK) => {
      await decideRoute(input({ text: 'and check it again tomorrow', sessions, ...(last ? { last } : {}) }), { jev: remote })
      return remote.mock.calls.at(-1)![0]
    }
    expect(await stateFor({ id: 'a2', agoMs: 600_000 })).toEqual({ message: 'and check it again tomorrow', previous_message_went_to: 'Prometheus alerts' })
    expect(await stateFor({ id: 'a1', agoMs: 0 })).toEqual({ message: 'and check it again tomorrow', previous_message_went_to: 'billing retries' })
    expect(await stateFor({ id: 'a2', agoMs: 600_001 })).toEqual({ message: 'and check it again tomorrow' })
    expect(await stateFor({ id: 'gone', agoMs: 1_000 })).toEqual({ message: 'and check it again tomorrow' })
    expect(await stateFor(undefined)).toEqual({ message: 'and check it again tomorrow' })
    // A session past the first forty is not one Jev was asked about, so it is not named either.
    const rail = Array.from({ length: 41 }, (_, i) => session(`a${i}`, `topic ${i}`))
    expect(await stateFor({ id: 'a40', agoMs: 1_000 }, rail)).toEqual({ message: 'and check it again tomorrow' })
    expect(await stateFor({ id: 'a39', agoMs: 1_000 }, rail)).toEqual({ message: 'and check it again tomorrow', previous_message_went_to: 'topic 39' })
  })

  it('is new work, set up as Jev says, when Jev is sure it is new', async () => {
    const remote = jev({
      target: said('new', 0.9, TARGETS),
      project: said('p1', 0.7, ['p0', 'p1']),
      agent: said('a0', 0.65, ['a0', 'a1']),
    })
    const verdict = await decideRoute(input({ text: 'rename my photos by date', projects: PROJECTS, agents: AGENTS }), { jev: remote })
    expect(verdict).toEqual({ kind: 'new', project: '/code/infra', agent: 'claude', via: 'jev', why: 'Jev: new work', trace: '2 sessions · jev: "new" 0.90, then "billing retries" 0.05' })
  })

  it('leaves the project and the agent to the caller when Jev is not sure of them, or did not answer them', async () => {
    const remote = jev({
      target: said('new', 0.9, TARGETS),
      project: said('p0', 0.5, ['p0', 'p1']),
      agent: said('a1', 0.4, ['a0', 'a1']),
    })
    const verdict = await decideRoute(input({ projects: PROJECTS, agents: AGENTS }), { jev: remote })
    expect(verdict).toEqual({ kind: 'new', via: 'jev', why: 'Jev: new work', trace: '2 sessions · jev: "new" 0.90, then "billing retries" 0.05' })
    const silent = await decideRoute(input({ projects: PROJECTS, agents: AGENTS }), { jev: jev({ target: said('new', 0.9, TARGETS) }) })
    expect(silent).not.toHaveProperty('project')
    expect(silent).not.toHaveProperty('agent')
  })

  it('is new work when Jev is not sure where it goes, still in the project and with the agent Jev is sure of', async () => {
    const remote = jev({
      target: { choice: 's0', probabilities: { s0: 0.5, s1: 0.3, new: 0.2 } },
      project: said('p0', 0.9, ['p0', 'p1']),
      agent: said('a1', 0.8, ['a0', 'a1']),
    })
    const verdict = await decideRoute(input({ projects: PROJECTS, agents: AGENTS }), { jev: remote })
    expect(verdict).toEqual({ kind: 'new', project: '/code/billing', agent: 'codex', via: 'unsure', why: 'Jev was not sure', trace: '2 sessions · jev: "billing retries" 0.50, then "Prometheus alerts" 0.30' })
  })

  it('is new work Jev was not sure of when Jev leans to new work below the bar', async () => {
    const verdict = await decideRoute(input(), { jev: jev({ target: { choice: 'new', probabilities: { s0: 0.35, s1: 0.1, new: 0.55 } } }) })
    expect(verdict).toEqual({ kind: 'new', via: 'unsure', why: 'Jev was not sure', trace: '2 sessions · jev: "new" 0.55, then "billing retries" 0.35' })
  })

  it('goes to a session Jev leads with clearly below 0.6, and traces how far ahead it was', async () => {
    const desk = [...DESK, session('a3', 'lamp GTM'), session('a4', 'Memories'), session('a5', 'onboarding')]
    const answer = (s1: number, other: number) => ({ target: { choice: 's1', probabilities: { s0: 0.05, s1, s2: 0.05, s3: 0.05, s4: 0.05, new: other } } })
    expect((await decideRoute(input({ sessions: desk }), { jev: jev(answer(0.45, 0.35)) })).kind).toBe('new')
    const led = await decideRoute(input({ sessions: desk }), { jev: jev(answer(0.57, 0.23)) })
    expect(led).toEqual({ kind: 'session', id: 'a2', p: 0.57, trace: '5 sessions · jev: "Prometheus alerts" 0.57, then "new" 0.23' })
    // Two sessions and new work are three options: the bar stands.
    expect((await decideRoute(input(), { jev: jev({ target: { choice: 's1', probabilities: { s0: 0.2, s1: 0.57, new: 0.23 } } }) })).kind).toBe('new')
  })

  it('tells Jev which sessions are stopped, and how long ago they were last active', async () => {
    const remote = jev({ target: said('new', 0.9, ['s0', 's1', 's2', 'new']) })
    const stopped = (id: string, name: string, stoppedAgoMs: number): RouteSession => ({ ...session(id, name, [], 'built the rig'), stoppedAgoMs })
    await decideRoute(input({ sessions: [stopped('a1', 'lamp v1', 3 * 86_400_000), stopped('a2', 'lamp v2', 5 * 3_600_000), stopped('a3', 'notes', 60_000)] }), { jev: remote })
    expect(remote.mock.calls[0][1].target.criteria).toMatchObject({
      s0: 'lamp v1 — stopped, last active 3 days ago — lately: built the rig',
      s1: 'lamp v2 — stopped, last active 5 hours ago — lately: built the rig',
      s2: 'notes — stopped, last active 1 minute ago — lately: built the rig',
    })
  })

  it('traces what Jev said even when it is no session on the desk, or nothing', async () => {
    const strange = await decideRoute(input(), { jev: jev({ target: { choice: 's7', probabilities: { s0: 0.5, s1: 0.5 } } }) })
    expect(strange).toEqual({ kind: 'new', via: 'unsure', why: 'Jev was not sure', trace: '2 sessions · jev: "s7" 0.00, then "billing retries" 0.50' })
    const silent = await decideRoute(input(), { jev: jev({}) })
    expect(silent).toEqual({ kind: 'new', via: 'unsure', why: 'Jev was not sure', trace: '2 sessions · jev: no answer' })
  })

  it('decides nothing when Jev is not set up', async () => {
    const lines: string[] = []
    expect(await decideRoute(input({ projects: PROJECTS, agents: AGENTS }), { log: (line) => lines.push(line) }))
      .toEqual({ kind: 'unavailable', why: 'Jev is not set up', trace: '2 sessions · jev: not set up' })
    expect(await decideRoute(input({ sessions: [] }), {})).toEqual({ kind: 'unavailable', why: 'Jev is not set up', trace: '0 sessions · jev: not set up' })
    // Nothing failed: there is nothing to log.
    expect(lines).toEqual([])
  })

  it('logs Jev failing, with what caused it, and decides nothing', async () => {
    const lines: string[] = []
    const failing = vi.fn(async () => { throw Object.assign(new JevUnavailable('BUSY', 'OpenRouter is busy'), { cause: { code: 'UND_ERR_SOCKET' } }) })
    const verdict = await decideRoute(input({ projects: PROJECTS, agents: AGENTS }), { jev: failing, log: (line) => lines.push(line) })
    // The verdict says the error alone, for the person; the log says its cause too, for whoever debugs it.
    expect(verdict).toEqual({ kind: 'unavailable', why: 'OpenRouter is busy', trace: '2 sessions · jev: failed' })
    expect(lines).toEqual(['jev could not answer: OpenRouter is busy (UND_ERR_SOCKET)'])
    // A cause with no code says its message; no cause, the error alone.
    const logged = async (error: Error) => {
      const said: string[] = []
      const answer = await decideRoute(input(), { jev: async () => { throw error }, log: (line) => said.push(line) })
      return { answer, said }
    }
    expect(await logged(new Error('fetch failed', { cause: { message: 'socket hang up' } }))).toEqual({
      answer: { kind: 'unavailable', why: 'fetch failed', trace: '2 sessions · jev: failed' },
      said: ['jev could not answer: fetch failed (socket hang up)'],
    })
    expect(await logged(new JevUnavailable('NO_KEY', 'no OpenRouter key on this computer'))).toEqual({
      answer: { kind: 'unavailable', why: 'no OpenRouter key on this computer', trace: '2 sessions · jev: failed' },
      said: ['jev could not answer: no OpenRouter key on this computer'],
    })
    // Without a log it goes the same way.
    await expect(decideRoute(input(), { jev: failing })).resolves.toEqual({ kind: 'unavailable', why: 'OpenRouter is busy', trace: '2 sessions · jev: failed' })
  })
})

// The deps a router hands decideRoute are the same shape: a check that this file's fakes stay assignable.
const _deps: RouteDeps = { jev: jev(), log: () => {} }
void _deps

describe('the sessions Jev is shown', () => {
  const live = (id: string, name: string, over: Partial<RouteSession> = {}): RouteSession => ({ ...session(id, name, ['look at the alerts']), ...over })
  const stopped = (id: string, name: string, over: Partial<RouteSession> = {}): RouteSession => ({ ...live(id, name), stoppedAgoMs: 3_600_000, ...over })

  it('are the live ones first, then stopped ones, each in the order the client sent them', () => {
    const shown = offered([stopped('s1', 'old work'), live('l1', 'alerts'), stopped('s2', 'older work'), live('l2', 'billing')])
    expect(shown.map((s) => s.id)).toEqual(['l1', 'l2', 's1', 's2'])
  })

  it('show a conversation listed twice once, the live one before a stopped one', () => {
    const shown = offered([stopped('s1', 'User activation', { conversation: 'c1' }), live('l1', 'renamed', { conversation: 'c1' }), stopped('s2', 'shell path', { conversation: 'c1' })])
    expect(shown.map((s) => s.id)).toEqual(['l1'])
  })

  it('drop a stopped session a live one has the name of, a stopped twin by name, and one with nothing to read', () => {
    const shown = offered([
      live('l1', 'X Posts'),
      stopped('s1', 'x posts'),
      stopped('s2', 'lamp GTM'),
      stopped('s3', 'Lamp GTM'),
      stopped('s4', 'hi', { asks: ['ok', 'continue'], about: '  ' }),
      stopped('s5', 'agent note', { asks: ['Another Claude session sent a message: <agent-message from="x">'] }),
    ])
    expect(shown.map((s) => s.id)).toEqual(['l1', 's2'])
  })

  it('are forty at most', () => {
    expect(offered(Array.from({ length: 50 }, (_, i) => live(`l${i}`, `s${i}`)))).toHaveLength(40)
  })

  it('are described with their machine, and the last prompt of the person\'s own that names something', async () => {
    const remote = jev()
    await decideRoute(input({ sessions: [
      { ...session('a1', 'X Posts', ['ok merge it', 'Another Claude session sent a message: hi', '<pasted_content id="1">Spending my Saturday with   the kids</pasted_content>']), machine: 'M2' },
      { ...session('a2', 'hub', ['cont', 'allow']), machine: 'office' },
    ] }), { jev: remote })
    expect(remote.mock.calls[0]![1].target!.criteria).toMatchObject({
      s0: 'X Posts — on M2 — asked: Spending my Saturday with the kids',
      s1: 'hub — on office',
    })
  })
})

describe('a message that names nothing of its own', () => {
  it('goes where the last task went, minutes ago, whatever the sessions\' words', async () => {
    const remote = jev({ target: said('s0', 0.5, TARGETS), topic: topicless() })
    const verdict = await decideRoute(input({ text: 'merge it', last: { id: 'a2', agoMs: 60_000 } }), { jev: remote })
    expect(verdict).toMatchObject({ kind: 'session', id: 'a2', p: 0.8 })
    expect(steps(verdict.trace)).toContain('names nothing: to "Prometheus alerts", where the last went')
    // The previous session is told to Jev, and how to read it.
    expect(remote.mock.calls[0]![0]).toEqual({ message: 'merge it', previous_message_went_to: 'Prometheus alerts' })
    expect(remote.mock.calls[0]![1].target!.instructions).toBe(TARGET_QUESTION + FOLLOW_UP)
  })

  it('is new work when nothing went anywhere just now, even with a session Jev is sure of', async () => {
    const verdict = await decideRoute(input({ text: 'merge it' }), { jev: jev({ target: said('s0', 0.95, TARGETS), topic: topicless() }) })
    expect(verdict).toMatchObject({ kind: 'new', via: 'jev', why: 'names nothing, and no task went anywhere just now' })
    expect(steps(verdict.trace)).toContain('names nothing: nowhere to go')
  })

  it('is new work when Jev is sure of another session than the last: the two disagree', async () => {
    const verdict = await decideRoute(input({ text: 'merge it', last: { id: 'a2', agoMs: 60_000 } }), { jev: jev({ target: said('s0', 0.9, TARGETS), topic: topicless() }) })
    expect(verdict).toMatchObject({ kind: 'new', why: 'names nothing, and Jev pointed elsewhere' })
    // Sure of the last itself: it goes there.
    const agreed = await decideRoute(input({ text: 'merge it', last: { id: 'a2', agoMs: 60_000 } }), { jev: jev({ target: said('s1', 0.9, TARGETS), topic: topicless() }) })
    expect(agreed).toMatchObject({ kind: 'session', id: 'a2' })
  })

  it('finds the last session by its conversation when it is shown as its live self', async () => {
    const sessions: RouteSession[] = [
      { ...session('a1', 'billing retries', ['why was the card charged twice']), conversation: 'c1' },
      { ...session('old', 'billing (before the rename)', ['refund the order']), conversation: 'c1', stoppedAgoMs: 60_000 },
    ]
    const verdict = await decideRoute(input({ text: 'merge it', sessions, last: { id: 'old', agoMs: 60_000 } }), { jev: jev({ target: said('new', 0.5, ['s0', 'new']), topic: topicless() }) })
    expect(verdict).toMatchObject({ kind: 'session', id: 'a1' })
    // A last that is not there at all is nowhere to go.
    const gone = await decideRoute(input({ text: 'merge it', last: { id: 'nowhere', agoMs: 60_000 } }), { jev: jev({ target: said('new', 0.5, TARGETS), topic: topicless() }) })
    expect(gone).toMatchObject({ kind: 'new', why: 'names nothing, and no task went anywhere just now' })
  })

  it('is decided by the sessions when Jev is not sure it names nothing', async () => {
    for (const topic of [topicless(0.55), topicless(0.5), { choice: 'no', probabilities: { yes: 0.2 } }, { choice: 'no', probabilities: { yes: 0.1, no: Number.NaN } }]) {
      const verdict = await decideRoute(input({ text: 'also check retention' }), { jev: jev({ target: said('s0', 0.9, TARGETS), topic }) })
      expect(verdict, JSON.stringify(topic)).toMatchObject({ kind: 'session', id: 'a1' })
    }
  })
})

describe('a message that asks for a new session', () => {
  it('is new work, whatever Jev picks', async () => {
    for (const text of ['start a new session and write an x post about lamp', 'in a fresh session, look at the usage data', 'Open a new harness for the parser', 'spin up another session to check retention']) {
      const verdict = await decideRoute(input({ text }), { jev: jev({ target: said('s0', 0.95, TARGETS) }) })
      expect(verdict, text).toMatchObject({ kind: 'new', why: 'asked for a new session' })
    }
  })

  it('is not one that only talks about a new pane, a thread or a session', async () => {
    for (const text of ['the new pane is broken', 'race on a different thread', 'rewrite the parser from scratch', 'new session restore drops the cwd']) {
      const verdict = await decideRoute(input({ text }), { jev: jev({ target: said('s0', 0.95, TARGETS) }) })
      expect(verdict, text).toMatchObject({ kind: 'session', id: 'a1' })
    }
  })
})

describe('a running session\'s lead', () => {
  const desk: RouteSession[] = [
    session('live', 'X Posts', ['write a post about the lamp']),
    { ...session('copy', 'write an x post about the', ['write an x post about the device']), stoppedAgoMs: 3_600_000 },
    session('twin', 'X Posts', ['draft another post']),
    session('other', 'usage data', ['retention today']),
    session('more', 'firmware', ['flash the round unit']),
  ]
  // Jev's answer over the desk as it is shown: live ones first, so the stopped copy is s4.
  const answer = (p: Record<string, number>, choice = 's0') => ({ target: { choice, probabilities: p } })

  it('is not held back by a stopped copy of its work, by 1.25 times it or more', async () => {
    expect([JEV_LIVE_RATIO, JEV_OVER_STOPPED]).toEqual([1.75, 1.25])
    const verdict = await decideRoute(input({ text: 'post this on x', sessions: desk }), { jev: jev(answer({ s0: 0.44, s1: 0.1, s2: 0.06, s3: 0.04, s4: 0.32, new: 0.04 })) })
    expect(verdict).toMatchObject({ kind: 'session', id: 'live' })
  })

  it('is held back by another running session, a twin of its name too, or new work within 1.75 times it, or a stopped one within 1.25', async () => {
    for (const p of [
      { s0: 0.44, s1: 0.05, s2: 0.3, s3: 0.08, s4: 0.05, new: 0.08 },
      { s0: 0.44, s1: 0.05, s2: 0.08, s3: 0.08, s4: 0.05, new: 0.3 },
      // Two "X Posts" running: a coin flip, not a lead.
      { s0: 0.42, s1: 0.4, s2: 0.05, s3: 0.05, s4: 0.04, new: 0.04 },
      { s0: 0.41, s1: 0.05, s2: 0.05, s3: 0.05, s4: 0.4, new: 0.04 },
    ]) {
      const verdict = await decideRoute(input({ text: 'post this on x', sessions: desk }), { jev: jev(answer(p)) })
      expect(verdict.kind, JSON.stringify(p)).toBe('new')
    }
  })

  it('is no lead for a stopped pick, a pick below 0.4, one that is not the likeliest, a broken answer, or fewer than six options', async () => {
    const cases: [string, Record<string, JevChoiceAnswer>, RouteSession[]][] = [
      ['stopped', answer({ s0: 0.3, s1: 0.05, s2: 0.05, s3: 0.05, s4: 0.45, new: 0.1 }, 's4'), desk],
      ['low', answer({ s0: 0.39, s1: 0.1, s2: 0.1, s3: 0.06, s4: 0.3, new: 0.05 }), desk],
      ['not top', answer({ s0: 0.42, s1: 0.03, s2: 0.03, s3: 0.03, s4: 0.45, new: 0.04 }), desk],
      ['broken', answer({ s0: 0.45, s4: 0.3 }), desk],
      // Would lead (0.5 against 0.2) over six; over five there is no spread to excuse it.
      ['five', answer({ s0: 0.5, s1: 0.05, s2: 0.2, s3: 0.2, new: 0.05 }), desk.filter((s) => s.id !== 'copy')],
    ]
    for (const [name, answers, sessions] of cases) {
      const verdict = await decideRoute(input({ text: 'post this on x', sessions }), { jev: jev(answers) })
      expect(verdict.kind, name).toBe('new')
    }
  })
})
