/**
 * The core's event loop held still for seconds at a time while agents work, for Claude Code and Codex.
 * A synchronous read of a huge file, a heap paged out under memory pressure, a laptop deep in swap: each
 * holds every timer, socket and child of the core at once. When the hold ends, Node runs the timers that
 * came due before it reads the answers that arrived meanwhile, so a probe in flight (`ps`, `tmux`) times
 * out with its answer sitting unread. That says nothing about any agent. A timeout is "could not tell",
 * and only "known gone" may unbind, retire, stop, relaunch or forget.
 *
 * The core is held 2-8 s at a time (core/stall.ts), each hold landing as it starts a child process, so
 * a probe is always in flight: at random, and on purpose while it binds new agents, takes turns,
 * restarts an agent, resumes one, adopts an engine typed into a terminal, reconciles, and restores and
 * attaches every agent after a daemon restart. Every agent must stay bound and active and take its next
 * turn, no engine may run twice, and the master must never take the held core for hung (every hold is
 * far inside its 40 s).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Engine = 'claude' | 'codex'
type Row = Record<string, any>

const STALLS = 'core.stall:2000-8000@12000/spawn'
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 60_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

/** Hold the core at the next child process it starts, as a test chooses the moment. */
function hold(d: IsolatedDaemon): void {
  const core = d.corePid()
  if (core) process.kill(core, 'SIGUSR2')
}

async function folder(d: IsolatedDaemon, name: string): Promise<string> {
  const cwd = join(d.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  return cwd
}

const bound = (client: LocalClient, agentId: string, sessionId?: string) =>
  until(`${agentId.slice(0, 8)} to be bound and active`, async () => {
    const now = await row(client, agentId)
    return now?.status === 'active' && now.sessionId && (!sessionId || now.sessionId === sessionId) ? now : null
  }, 120_000, 500)

/** A turn that starts with what was sent and ends once. */
async function turn(client: LocalClient, agentId: string, content: string, during?: () => void): Promise<void> {
  const from = client.frames.length
  const started = client.next(isTurn('turn_started', agentId), 90_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 120_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  during?.()
  expect((await started).payload?.userMessage).toBe(content)
  await ended
  // A turn the held core could not see end must not end again when it looks.
  await sleep(1_000)
  expect(client.frames.slice(from).filter(isTurn('turn_ended', agentId)), `${content}: ended once`).toHaveLength(1)
}

/** The engine processes in each tmux pane, by pid, from tmux's own pane list and the process table. The
 *  fake engines' process title is their engine's name, then their arguments, as a CLI's is. */
async function enginePids(d: IsolatedDaemon): Promise<Map<string, number[]>> {
  const panes = (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}')).trim().split('\n')
    .map((line) => line.split(' ')).map(([id, pid]) => ({ id, pid: Number(pid) }))
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).toString().trim().split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[]
  const children = new Map<number, number[]>()
  for (const [, pid, ppid] of table) children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)])
  const result = new Map<string, number[]>()
  for (const pane of panes) {
    const tree = new Set<number>([pane.pid])
    for (const pid of tree) for (const child of children.get(pid) ?? []) tree.add(child)
    result.set(pane.id, table.filter(([, pid, , command]) => tree.has(Number(pid)) && /^(claude|codex)(?:\s|$)/.test(command.trim()))
      .map(([, pid]) => Number(pid)))
  }
  return result
}
const enginesByPane = async (d: IsolatedDaemon): Promise<Map<string, number>> =>
  new Map([...(await enginePids(d))].map(([pane, pids]) => [pane, pids.length]))

/** Every agent in `expected` active, on the conversation it had, with one engine in its pane, and no
 *  engine anywhere else. */
async function intact(d: IsolatedDaemon, client: LocalClient, expected: Row[]): Promise<void> {
  const all = await rows(client)
  for (const agent of expected) {
    const now = all.find((one) => one.id === agent.id)
    expect(now?.status, `${agent.id.slice(0, 8)} (${agent.engine}) is active`).toBe('active')
    expect(now?.sessionId, `${agent.id.slice(0, 8)} (${agent.engine}) is on its conversation`).toBe(agent.sessionId)
  }
  // Nothing was minted beside them for a pane or an engine they already own.
  expect(all.filter((one) => one.status === 'active').map((one) => one.id).sort()).toEqual(expected.map((one) => one.id).sort())
  const engines = await until('one engine per agent', async () => {
    const counts = await enginesByPane(d)
    const ok = expected.every((agent) => counts.get(agent.tmuxPane) === 1)
      && [...counts.values()].reduce((sum, n) => sum + n, 0) === expected.length
    return ok ? counts : null
  }, 20_000, 500).catch(async () => enginesByPane(d))
  for (const agent of expected) expect(engines.get(agent.tmuxPane), `${agent.id.slice(0, 8)}: engines in its pane`).toBe(1)
  expect([...engines.values()].reduce((sum, n) => sum + n, 0), 'engines on the tmux server').toBe(expected.length)
}

/** The holds the core logged: there were some, and each was far inside the master's patience. */
function holds(d: IsolatedDaemon): number[] {
  return [...d.log().matchAll(/\[stall\] holding the event loop for (\d+) ms/g)].map((match) => Number(match[1]))
}

/** Nothing on the way was decided from a probe that could not answer. A core held as it is stopped
 *  outlives its grace and is killed, which is a stop doing its job; one killed for silence is not. */
function nothingRetired(d: IsolatedDaemon): void {
  const log = d.log()
  expect(log).not.toMatch(/\[harnessd\] core (sent no heartbeat|.*hung)/)
  expect(log).not.toMatch(/\[discovery\] \S+ (retained|dormant|removed|kept) · /)
  expect(log).not.toMatch(/ENGINE_DID_NOT_START|START_TIMEOUT|restored pane disappeared/)
}

describe('the core held still while agents work', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_TEST_FAULTS: STALLS } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-250).join('\n')}`) })
    await d.start()
    await until('the stalls to be armed', () => /\[stall\] armed/.test(d.log()) || null, 30_000, 100)
    return d
  }

  it('creating, turns, a restart, a resume and an engine typed into a terminal: nothing is lost or retired', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)

    // Two agents created at once, the core held while their engines start and bind.
    const asked = (['claude', 'codex'] as const).map(async (engine: Engine) =>
      client.request('agent_create', { engine, cwd: await folder(d, `held-${engine}`), bypassPermission: true }, 120_000))
    await sleep(300)
    hold(d)
    const created = await Promise.all(asked)
    for (const answer of created) expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    const agents = await Promise.all(created.map((answer) => bound(client, answer.agent.id)))
    const [claude, codex] = agents

    // Turns, held while they run.
    for (const agent of agents) await turn(client, agent.id, `held during a turn (${agent.engine})`, () => hold(d))
    await turn(client, claude.id, '!slow 6000', () => setTimeout(() => hold(d), 1_500))

    // A restart, held the moment its new engine is up, and a message sent right then by a client that
    // sees the agent still active. The restart may not have recorded the new engine yet: such a message
    // used to be dropped as "no longer running", and an attach then unbound the agent (e2e/races.e2e.ts,
    // a restart nobody waited for).
    for (const agent of agents) {
      const before = (await enginePids(d)).get(agent.tmuxPane) ?? []
      const restarting = client.request('agent_restart', { agentId: agent.id }, 120_000)
      await until('the new engine to start', async () =>
        ((await enginePids(d)).get(agent.tmuxPane) ?? []).some((pid) => !before.includes(pid)) || null, 60_000, 50)
      hold(d)
      await turn(client, agent.id, `while a held restart finishes (${agent.engine})`)
      const restarted = await restarting
      expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
      await bound(client, agent.id, agent.sessionId)
      await turn(client, agent.id, `after a held restart (${agent.engine})`)
    }

    // A stop and a resume, held while the resumed engine starts.
    expect((await client.request('agent_delete', { agentId: codex.id }, 120_000)).error).toBeUndefined()
    await until('codex to stop', async () => (await row(client, codex.id))?.status === 'stopped' || null, 90_000, 500)
    const resuming = client.request('agent_resume', { agentId: codex.id }, 120_000)
    await sleep(200)
    hold(d)
    const resumed = await resuming
    expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
    const back = await bound(client, codex.id, codex.sessionId)
    await turn(client, codex.id, 'after a held resume')

    // An engine somebody typed into a terminal, adopted while the core is held.
    const tile = await client.request('agent_create', { engine: 'terminal', cwd: await folder(d, 'held-terminal') }, 120_000)
    expect(tile.error, JSON.stringify(tile)).toBeUndefined()
    const shell = await until('the terminal to have its pane', async () => {
      const now = await row(client, tile.agent.id)
      return now?.tmuxPane && now.status === 'active' ? now : null
    }, 60_000, 500)
    await sleep(2_000)
    await d.tmux.run('send-keys', '-t', shell.tmuxPane, `${join(d.root, 'bin', 'claude')} --dangerously-skip-permissions`, 'Enter')
    await sleep(300)
    hold(d)
    const adopted = await until('the typed engine to be adopted and bound', async () => {
      const now = await row(client, tile.agent.id)
      return now?.engine === 'claude' && now.sessionId && now.status === 'active' ? now : null
    }, 120_000, 500)
    await turn(client, adopted.id, 'typed into a terminal, then held')

    // Reconciles go on under the random holds; nothing may be retired by one that could not answer.
    const everyone = [{ ...claude }, { ...back }, { ...adopted }]
    for (const agent of everyone) agent.tmuxPane = (await row(client, agent.id))!.tmuxPane
    await sleep(40_000)
    await intact(d, client, everyone)
    for (const agent of everyone) await turn(client, agent.id, `still here (${agent.engine})`)

    const held = holds(d)
    expect(held.length, 'the core was held, again and again').toBeGreaterThanOrEqual(8)
    for (const ms of held) expect(ms).toBeLessThanOrEqual(8_000)
    expect(d.coresStarted()).toBe(1)
    nothingRetired(d)
    client.close()
  }, 900_000)

  it('restarted while held: restore and attach find every agent, bound and active, and each takes a turn', async () => {
    const d = await fresh()
    let client = await LocalClient.connect(d)
    const created = await Promise.all((['claude', 'codex'] as const).map(async (engine: Engine) =>
      client.request('agent_create', { engine, cwd: await folder(d, `restart-${engine}`), bypassPermission: true }, 120_000)))
    for (const answer of created) expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    const agents = await Promise.all(created.map((answer) => bound(client, answer.agent.id)))
    for (const agent of agents) await turn(client, agent.id, `before the restarts (${agent.engine})`)

    for (let restart = 1; restart <= 3; restart++) {
      // A turn in flight as the daemon goes, every other time.
      if (restart % 2) client.send('message', { agentId: agents[restart % 2].id, content: '!slow 4000' })
      client.close()
      await d.stop()
      const from = d.log().length
      await d.start({ ready: 'none' })
      // Held as soon as the new core can be (before it listens for the signal, SIGUSR2 would end it), and
      // again while it restores and attaches.
      await until('the new core to arm its stalls', () => /\[stall\] armed/.test(d.log().slice(from)) || null, 60_000, 50)
      hold(d)
      await until('the daemon to be ready', () => /\[cli\] ready/.test(d.log().slice(from)) || null, 120_000, 100)
      hold(d)
      client = await LocalClient.connect(d)
      for (const agent of agents) await bound(client, agent.id, agent.sessionId)
      for (const agent of agents) await turn(client, agent.id, `after held restart ${restart} (${agent.engine})`, () => hold(d))
      await intact(d, client, agents)
    }

    const held = holds(d)
    expect(held.length).toBeGreaterThanOrEqual(6)
    for (const ms of held) expect(ms).toBeLessThanOrEqual(8_000)
    expect(d.coresStarted()).toBe(4)
    nothingRetired(d)
    client.close()
  }, 900_000)
})
