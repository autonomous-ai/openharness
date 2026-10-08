/**
 * Question answers whose keystrokes an engine worker chooses (`Engine.questionControl`), on a real private
 * daemon, tmux, supervised engine workers and RPC; deterministic CLIs, no model accounts.
 *
 * The worker is stopped between two keystrokes of one answer by the fake engine itself, the moment the
 * named keystroke reaches it (fakeEngine.mjs `question-keys-<engine>.signal`), so the stop lands inside
 * the step on every run rather than whenever a poll happens to notice. What reached the engine is read
 * back from its own key log, not from the screen.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { alive, harnessdProcesses } from './harness/endurance.js'

type Engine = 'claude' | 'codex'
type Agent = Record<string, any>
type Shaped = { key: string; q: string; options: string[]; multi: boolean }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

/**
 * One engine's question: the prompt that asks it, the answer the worker is stopped in (and the keys of it
 * that reach the engine first), and a different answer: the keys it takes on a fresh dialog, and after
 * the interrupted one.
 */
const QUESTIONS = {
  // Five toggles and a Tab in one step: stopped after the second toggle.
  claude: { prompt: '!askmany', first: ['Cheese', 'Ham', 'Basil', 'Olives', 'Onion'], stopAfter: 2, typed: ['1', '2'],
    second: ['Basil', 'Peppers'], freshKeys: ['3', '6', 'Tab', '1'],
    // The approved set is exact: the two rows the interrupted step left checked are unchecked again.
    secondKeys: ['1', '2', '3', '6', 'Tab', '1'], chose: 'you chose Basil, Peppers' },
  // The digit and its Enter in one step: stopped after the digit.
  codex: { prompt: '!ask', first: ['Coffee'], stopAfter: 1, typed: ['2'],
    second: ['Tea'], freshKeys: ['1', 'Enter'], secondKeys: ['1', 'Enter'], chose: 'you chose Tea' },
} as const

describe('engine question-control workers', () => {
  let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
  const frozen = new Set<number>()
  afterEach(async () => {
    for (const pid of frozen) { try { process.kill(pid, 'SIGCONT') } catch { /* gone */ } }
    frozen.clear()
    client?.close(); await daemon?.close(); client = undefined; daemon = undefined
  })
  async function fresh(env: Record<string, string> = {}) {
    const d = daemon = await IsolatedDaemon.create({ env })
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-250).join('\n')}\n---- keys\n${JSON.stringify({ claude: keys(d, 'claude'), codex: keys(d, 'codex') })}`))
    await d.start()
    const c = client = await LocalClient.connect(d)
    return { d, c }
  }
  const rows = async (c: LocalClient) => (await c.request<{ agents: Agent[] }>('agents_list', {}, 30_000)).agents
  async function create(d: IsolatedDaemon, c: LocalClient, engine: Engine, folder: string): Promise<Agent> {
    const cwd = join(d.projectsDir, folder); mkdirSync(cwd, { recursive: true })
    const created = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    return until(`${folder} to bind its conversation`, async () => {
      const row = (await rows(c)).find((agent) => agent.id === created.agent.id)
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 200)
  }
  async function turn(c: LocalClient, agent: Agent, content: string) {
    const ended = c.next(isTurn('turn_ended', agent.id), 45_000, `turn_ended: ${content}`)
    c.send('message', { agentId: agent.id, content })
    await ended
  }
  async function ask(c: LocalClient, agent: Agent, prompt: string): Promise<{ requestId: string; shaped: Shaped }> {
    const asked = c.next((frame) => frame.type === 'commander_question' && frame.agentId === agent.id, 30_000, `${prompt} question`)
    c.send('message', { agentId: agent.id, content: prompt })
    const payload = (await asked).payload!
    return { requestId: payload.requestId, shaped: payload.questions[0] }
  }
  /** The answer as a window sends one it reviewed: the exact question, and for a multi-select the exact set. */
  function answer(c: LocalClient, agent: Agent, requestId: string, shaped: Shaped, labels: readonly string[]): Promise<Record<string, any>> {
    const result = c.next((frame) => frame.type === 'question_response_result' && frame.payload?.requestId === requestId, 60_000, 'question_response_result')
    c.send('question_response', { requestId, agentId: agent.id, answers: { [shaped.key]: labels.join(', ') },
      expectedQuestions: [shaped], ...(shaped.multi ? { selectedLabels: { [shaped.key]: [...labels] } } : {}) })
    return result.then((frame) => frame.payload as Record<string, any>)
  }
  const keyLog = (d: IsolatedDaemon, engine: Engine) => join(d.engineConfig.root, `question-keys-${engine}`)
  const keys = (d: IsolatedDaemon, engine: Engine): string[] => existsSync(keyLog(d, engine)) ? readFileSync(keyLog(d, engine), 'utf8').split('\n').filter(Boolean) : []
  /** The fake engine signals `pid` once its key log holds `after` keys, before it acts on the last one. */
  const arm = (d: IsolatedDaemon, engine: Engine, pid: number, signal: NodeJS.Signals, after: number, delayMs = 0) =>
    writeFileSync(`${keyLog(d, engine)}.signal`, JSON.stringify({ pid, signal, after, delayMs }))
  /** What the engine noted once it sent the signal, or null before. */
  const fired = (d: IsolatedDaemon, engine: Engine) => {
    const note = existsSync(`${keyLog(d, engine)}.fired`) ? readFileSync(`${keyLog(d, engine)}.fired`, 'utf8') : ''
    return note.includes('"outcome"') ? note : null
  }
  const workerPid = (d: IsolatedDaemon, engine: Engine) => harnessdProcesses(d).get(`engine-${engine}`)
  const replaced = (d: IsolatedDaemon, engine: Engine, old: number) => until(`a replacement engine-${engine} worker`, () => {
    const pid = workerPid(d, engine)
    return pid && pid !== old && alive(pid) ? pid : null
  }, 30_000, 100)
  const panePid = async (d: IsolatedDaemon, agent: Agent) => (await d.tmux.run('display-message', '-p', '-t', agent.tmuxPane, '#{pane_pid}')).trim()

  it.each([
    ['claude', 'SIGKILL'], ['claude', 'SIGSTOP'], ['codex', 'SIGKILL'], ['codex', 'SIGSTOP'],
  ] as const)('%s: a worker stopped by %s inside one answer\'s step fails that answer, types nothing more, and a new answer succeeds once it is back', async (engine, signal) => {
    const spec = QUESTIONS[engine]
    const other: Engine = engine === 'claude' ? 'codex' : 'claude'
    // A frozen worker is declared hung after 4 s (and a third more grace) and killed; a replacement waits
    // 8 s more, so the other engine's turn below runs while this engine's worker is dead or frozen.
    const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '4000', HARNESSD_SERVICE_STOP_GRACE_MS: '100',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '8000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '8000' })
    const agent = await create(d, c, engine, `q-${engine}`)
    const bystander = await create(d, c, other, `q-${other}`)
    await turn(c, bystander, `${other} before the question`)
    const { requestId, shaped } = await ask(c, agent, spec.prompt)
    expect(shaped.multi).toBe(engine === 'claude')
    const core = d.corePid(), worker = workerPid(d, engine)!, otherWorker = workerPid(d, other)!
    expect(worker && otherWorker).toBeTruthy()
    const pane = await panePid(d, agent)
    const before = keys(d, engine).length
    arm(d, engine, worker, signal, before + spec.stopAfter)
    if (signal === 'SIGSTOP') frozen.add(worker)
    const started = Date.now()
    const interrupted = answer(c, agent, requestId, shaped, spec.first).then((result) => ({ result, ms: Date.now() - started }))
    await until('the worker stopped inside the step', () => fired(d, engine), 20_000, 20)
    expect(fired(d, engine)).toContain('"outcome":"sent"')

    // Meanwhile the other engine's agent takes a whole turn, and the core answers a request.
    await turn(c, bystander, `${other} while ${engine} has no worker`)
    expect((await rows(c)).map((row) => row.id).sort()).toEqual([agent.id, bystander.id].sort())
    expect(workerPid(d, engine)).toBe(worker) // no replacement yet: this all ran during the outage
    if (signal === 'SIGKILL') expect(alive(worker)).toBe(false)

    // Failed, visibly: at once for a dead worker, once the master kills a frozen one.
    const failed = await interrupted
    expect(failed.result.error, JSON.stringify(failed)).toBe('ANSWER_FAILED')
    expect(failed.ms).toBeLessThan(signal === 'SIGKILL' ? 5_000 : 15_000)
    // An answer while there is no worker fails at once (its screen is read in that worker too, so the question
    // cannot be read), and nothing is typed inline in its place.
    const outage = await answer(c, agent, requestId, shaped, spec.second)
    expect(outage.error, JSON.stringify(outage)).toBe('ANSWER_FAILED')
    expect(workerPid(d, engine)).toBe(worker)
    expect(keys(d, engine).slice(before)).toEqual(spec.typed)
    await until('the stopped worker gone', () => !alive(worker), 15_000, 100)
    frozen.delete(worker)
    await replaced(d, engine, worker)
    // Back, and given time: the interrupted step is not resumed, by the new worker or anyone.
    await sleep(2_500)
    expect(keys(d, engine).slice(before)).toEqual(spec.typed)
    const screen = await d.capture(agent.tmuxPane)
    expect(screen).toContain(shaped.q)
    expect(screen).not.toContain('Review your answers')
    expect(screen).not.toContain('you chose')
    if (engine === 'claude') expect(screen).toMatch(/\[✔\] Cheese[\s\S]*\[✔\] Ham[\s\S]*\[ \] Basil/)

    // A new answer is a new intent, and a different one: it succeeds, and nothing of the old one follows it.
    const ended = c.next(isTurn('turn_ended', agent.id), 45_000, 'the answered turn')
    const retried = await answer(c, agent, requestId, shaped, spec.second)
    expect(retried.error, JSON.stringify(retried)).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain(spec.chose)
    expect(keys(d, engine).slice(before)).toEqual([...spec.typed, ...spec.secondKeys])
    await turn(c, agent, `${engine} after recovery`)
    await turn(c, bystander, `${other} after recovery`)
    expect(await panePid(d, agent)).toBe(pane)
    expect(workerPid(d, other)).toBe(otherWorker)
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it('claude: a worker frozen inside a step and woken after core revoked it types nothing more', async () => {
    // Longer than the step's 30 s deadline: the default service heartbeat (30 s and its grace) is too.
    const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '60000', HARNESSD_SERVICE_STOP_GRACE_MS: '100', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200' })
    const spec = QUESTIONS.claude
    const agent = await create(d, c, 'claude', 'q-woken')
    const bystander = await create(d, c, 'codex', 'q-woken-codex')
    const { requestId, shaped } = await ask(c, agent, spec.prompt)
    const core = d.corePid(), worker = workerPid(d, 'claude')!
    const before = keys(d, 'claude').length
    // Frozen a moment after the second toggle, once the worker has heard it went in and is waiting out
    // the repaint before the third: the third is the first thing it does when woken.
    arm(d, 'claude', worker, 'SIGSTOP', before + spec.stopAfter, 120)
    frozen.add(worker)
    const started = Date.now()
    const interrupted = answer(c, agent, requestId, shaped, spec.first).then((result) => ({ result, ms: Date.now() - started }))
    await until('the worker frozen inside the step', () => fired(d, 'claude'), 20_000, 20)
    expect(fired(d, 'claude')).toContain('"outcome":"sent"')
    expect(keys(d, 'claude').slice(before)).toEqual(spec.typed)
    await turn(c, bystander, 'codex while claude is frozen')
    // Failed at the step's own deadline (30 s), not before: core held the step for its whole life.
    const failed = await interrupted
    expect(failed.result.error, JSON.stringify(failed)).toBe('ANSWER_FAILED')
    expect(failed.ms).toBeGreaterThan(25_000)
    expect(alive(worker)).toBe(true) // still frozen: core gave up on the step, not on the process
    // Woken now, its next toggle is already due. Core has revoked the step: nothing reaches the pane.
    process.kill(worker, 'SIGCONT')
    frozen.delete(worker)
    await sleep(3_000)
    expect(keys(d, 'claude').slice(before)).toEqual(spec.typed)
    expect(await d.capture(agent.tmuxPane)).not.toContain('Review your answers')
    // Whether the woken worker recycled itself at its own deadline or carries on, a new answer works.
    await until('a live claude worker', () => { const pid = workerPid(d, 'claude'); return pid && alive(pid) ? pid : null }, 30_000, 100)
    const ended = c.next(isTurn('turn_ended', agent.id), 45_000, 'the answered turn')
    const retried = await answer(c, agent, requestId, shaped, spec.second)
    expect(retried.error, JSON.stringify(retried)).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain(spec.chose)
    expect(keys(d, 'claude').slice(before)).toEqual([...spec.typed, ...spec.secondKeys])
    expect(d.corePid()).toBe(core)
    expect(d.coresStarted()).toBe(1)
  })

  it.each(['claude', 'codex'] as const)('%s: explicit inline mode answers a question end to end', async (engine) => {
    const { d, c } = await fresh({ HARNESSD_SERVICES: 'none' })
    const spec = QUESTIONS[engine]
    const agent = await create(d, c, engine, `q-inline-${engine}`)
    const { requestId, shaped } = await ask(c, agent, spec.prompt)
    const ended = c.next(isTurn('turn_ended', agent.id), 45_000, 'the answered turn')
    const result = await answer(c, agent, requestId, shaped, spec.second)
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain(spec.chose)
    // A fresh dialog: only the rows the answer checks, then on (Claude Code's review submits it).
    expect(keys(d, engine)).toEqual(spec.freshKeys)
    expect(workerPid(d, engine)).toBeUndefined()
    expect(d.coresStarted()).toBe(1)
  })

  it.each(['claude', 'codex'] as const)('%s: a window cannot drive question control, even while a worker holds a live grant mid-step', async (engine) => {
    // The worker is paused inside a real answer's step, so core holds a live grant for it, and woken well
    // within the step's deadline: a pause, not an interruption, so the step then finishes.
    const { d, c } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '60000' })
    const spec = QUESTIONS[engine]
    const agent = await create(d, c, engine, `q-private-${engine}`)
    const { requestId, shaped } = await ask(c, agent, spec.prompt)
    const worker = workerPid(d, engine)!
    arm(d, engine, worker, 'SIGSTOP', 1)
    frozen.add(worker)
    const ended = c.next(isTurn('turn_ended', agent.id), 60_000, 'the answered turn')
    const answered = answer(c, agent, requestId, shaped, spec.second)
    await until('the worker paused inside the step', () => fired(d, engine), 20_000, 20)
    const step = { kind: 'select', row: { number: '1', label: shaped.options[0], checked: false } }
    const token = 'a'.repeat(64)
    for (const [type, payload] of [
      ['engine_question_control_capabilities', { version: 1 }],
      ['engine_question_control_apply', { version: 1, step, token }],
      ['engine_question_control_apply', { version: 1, step, token, agentId: agent.id, sessionId: agent.sessionId }],
      ['engine.questionControl', { version: 1, query: 'engine.questionControl', token, action: { kind: 'key', key: 'Enter' } }],
      ['engine.questionControl', { version: 1, query: 'engine.questionControl', token, action: { kind: 'text', text: 'typed by a window' } }],
    ] as const) {
      const reply = await c.request(type, payload as Record<string, unknown>, 5_000)
      expect(reply.error, `${type}: ${JSON.stringify(reply)}`).toBe('UNSUPPORTED')
    }
    await sleep(500)
    expect(keys(d, engine)).toEqual(spec.freshKeys.slice(0, 1))
    expect(await d.capture(agent.tmuxPane)).not.toContain('typed by a window')
    process.kill(worker, 'SIGCONT')
    frozen.delete(worker)
    const result = await answered
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    await ended
    expect(await d.capture(agent.tmuxPane)).toContain(spec.chose)
    expect(keys(d, engine)).toEqual(spec.freshKeys)
    expect(workerPid(d, engine)).toBe(worker)
    expect(d.coresStarted()).toBe(1)
  })
})
