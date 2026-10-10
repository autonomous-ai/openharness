// Where a typed task goes: Jev alone, asked once (sure at 0.6, or a clear lead → its session, or new work; else new work; not
// asked at all → nothing decided), how a new harness is set up, what Jev is asked, and what is logged when it
// fails. Jev is a fake here: the question it is put and the answer it gives are the contract.
import { describe, expect, it, vi } from 'vitest'

import type { JevChoice, JevChoiceAnswer } from './jev/jevClient.js'
import { JevUnavailable } from './jev/jevClient.js'
import { decideRoute, JEV_LEAD_OPTIONS, JEV_LEAD_P, JEV_LEAD_RATIO, JEV_SURE_P, jevPick, type RouteDeps, type RouteInput, type RouteOption, type RouteSession } from './routeDecide.js'

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
        instructions: 'A person typed this message to continue their work. Which of their ongoing sessions is it for?',
        criteria: {
          s0: 'billing retries — asked: why was the card charged twice',
          s1: 'Prometheus alerts — lately: raised the alert threshold to 90%',
          new: 'None of them: it starts new, unrelated work',
        },
      },
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
    const long = session('a1', `  ${'n'.repeat(250)}\n`, [`${'y'.repeat(200)}`, 'older'], 'z'.repeat(500))
    const tidy = session('a2', 'auth\n\n  api', ['rotate   the\ttokens'])
    await decideRoute(input({
      sessions: [long, tidy, session('a3', 'bare'), session('a4', 'quiet', [], 'only   turns')],
      projects: [{ id: 'p', name: 'x'.repeat(700) }, { id: 'q', name: ' q\n' }],
      agents: [{ id: 'claude', name: 'Claude\nCode' }, { id: 'codex', name: 'Codex' }],
    }), { jev: remote })
    const [, questions] = remote.mock.calls[0]!
    const criteria = questions.target!.criteria
    // The name, then the first 120 of its last ask and the first 420 of its last turns: cut at 600 with an ellipsis.
    expect(criteria.s0).toBe(`${`${'n'.repeat(250)} — asked: ${'y'.repeat(120)} — lately: ${'z'.repeat(420)}`.slice(0, 599)}…`)
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
    expect(Object.keys(remote.mock.calls[0]![1])).toEqual(['target'])
    await decideRoute(input(), { jev: remote })
    expect(Object.keys(remote.mock.calls[1]![1])).toEqual(['target'])
    // Two projects and one agent: the project is asked, the agent is not.
    await decideRoute(input({ projects: PROJECTS, agents: [AGENTS[0]!] }), { jev: remote })
    expect(Object.keys(remote.mock.calls[2]![1])).toEqual(['target', 'project'])
  })

  it('asks Jev about the sessions with "new" alone when the desk is empty', async () => {
    const remote = jev({ target: said('new', 1, ['new']) })
    const verdict = await decideRoute(input({ sessions: [] }), { jev: remote })
    expect(remote.mock.calls[0]![1].target!.criteria).toEqual({ new: 'None of them: it starts new, unrelated work' })
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
    const stopped = (id: string, name: string, stoppedAgoMs: number): RouteSession => ({ ...session(id, name), stoppedAgoMs })
    await decideRoute(input({ sessions: [stopped('a1', 'lamp v1', 3 * 86_400_000), stopped('a2', 'lamp v2', 5 * 3_600_000), stopped('a3', 'notes', 60_000)] }), { jev: remote })
    expect(remote.mock.calls[0][1].target.criteria).toMatchObject({
      s0: 'lamp v1 — stopped, last active 3 days ago',
      s1: 'lamp v2 — stopped, last active 5 hours ago',
      s2: 'notes — stopped, last active 1 minute ago',
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
