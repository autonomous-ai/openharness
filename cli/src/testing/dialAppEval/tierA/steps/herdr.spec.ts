// Tier A's herdr (herdr.ts) on a fake world: the processes its server, panes and clients run as, what its client tells
// the devices' herdr code (cable/hosts/herdrSource.ts, herdr.ts), how the world answers the client lookup's lsof and ps
// (cable/hosts/herdrOuter.ts), and the person's own moves. Every folder is a temp one.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HerdrEntry, HerdrSubscriber } from '../../../../cable/hosts/herdrClient.js'
import { createHerdrOuter } from '../../../../cable/hosts/herdrOuter.js'
import { appRoots, ptyMaker } from '../../../../cable/hosts/scannedApp.js'
import type { ObservedEvent, ObservedHookEvent } from '../../../../core/observedHook.js'
import { itermSession } from '../../catalog.js'
import { wrongSends } from '../../checks.js'
import { namedPanes } from '../../itermRecords.js'
import type { Delivery, Scenario, Seen, SessionKey, StepOf } from '../../types.js'
import { machine } from '../machine.js'
import type { TierAWorld } from '../world.js'
import { answerHerdr, herdrClient, herdrSteps } from './herdr.js'
import { itermSteps, tabShell } from './iterm.js'
import { agentPid, running, sessionsSteps } from './sessions.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const HERDR = '/opt/eval/bin/herdr'
/** Virtual time at the start of a case. */
const T0 = 1_763_337_600_000
/** What the herdr source subscribes to besides its panes' statuses (herdrSource.ts KINDS). */
const KINDS: HerdrEntry[] = [{ type: 'pane.agent_detected' }, { type: 'pane.closed' }, { type: 'pane.exited' }]

/** a in w1's plain tab 0; h and g in herdr, their client in tab 1, g's row with no session; k in herdr, its client in
 *  tab 2. */
const sessions = (): Scenario => ({
  id: 'H1', app: 'iterm', title: 'Eval herdr', dims: ['D1'], platforms: ['darwin'], tiers: ['a'], heldOut: false, steps: [],
  checks: [], probes: [], sessions: [itermSession('a'), itermSession('h', { place: 'herdr', tab: 1 }),
    itermSession('g', { place: 'herdr', tab: 1, split: 1, herdrSession: false }), itermSession('k', { place: 'herdr', tab: 2 })],
})

/** A world on darwin whose devices are told hooks, whose listener takes tab reports, and whose rules answer each command. */
function fakeWorld() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-herdr-'))
  roots.push(root)
  // The client lookup's walk finds iTerm2's server in the home, the world's.
  vi.stubEnv('HOME', root)
  machine.reset()
  machine.itermHome = root
  machine.installed.set('herdr', HERDR)
  const of = sessions()
  const told: ObservedEvent[] = []
  const deliveries: Delivery[] = []
  const gaps: string[] = []
  const rules: Array<(argv: readonly string[]) => { code: number; stdout?: string } | undefined> = []
  const world = {
    scenario: of, platform: 'darwin', machine, streams: [], panes: new Map<string, SessionKey>(),
    ports: { devices: { observed: (event: ObservedEvent) => { told.push(event); return true }, inboxPoll: () => new Promise(() => {}),
      inboxGone: () => {} } },
    folders: { claudeProjects: join(root, 'projects'), codexSessions: join(root, 'codex', 'sessions'),
      cursorProjects: join(root, 'cursor', 'projects'), codexHomes: join(root, 'codex-homes') },
    listener: { tab: { maxBytes: 128, perSecond: 8, handle: () => undefined } },
    session: (key: SessionKey) => of.sessions.find((s) => s.key === key)!,
    deliver: (d: Omit<Delivery, 'at'>) => { deliveries.push({ at: Date.now(), ...d }) },
    gap: (reason: string) => { gaps.push(reason) },
    answer: (rule: (typeof rules)[number]) => { rules.push(rule) },
  } as unknown as TierAWorld
  answerHerdr(world)
  const client = herdrClient(world)
  /** What the world answers a command with, as world.ts runs it: one no rule answers exits 0. */
  const run = (...argv: string[]) => {
    for (const rule of rules) {
      const said = rule(argv)
      if (said) return { stdout: '', ...said }
    }
    return { code: 0, stdout: '' }
  }
  const start = async (...keys: SessionKey[]) => {
    for (const session of keys) await sessionsSteps.hook(world, { kind: 'hook', session, event: 'start' })
  }
  const hook = (session: SessionKey, event: StepOf<'hook'>['event']) => sessionsSteps.hook(world, { kind: 'hook', session, event })
  const step = <K extends keyof typeof herdrSteps>(kind: K, more: Omit<StepOf<K>, 'kind'>) =>
    (herdrSteps[kind] as (w: TierAWorld, s: StepOf<K>) => Promise<void>)(world, { kind, ...more } as StepOf<K>)
  const at = (pid: number) => machine.processes.get(pid)!
  /** The herdr clients running: a herdr process on a tty. */
  const clients = () => [...machine.processes.values()].filter((p) => p.executable === HERDR && p.tty !== undefined)
  /** The pid of the herdr server the session's pane runs under. */
  const serverOf = (key: SessionKey) => at(at(agentPid(world, key)!).ppid).ppid
  /** The pane the session's last hook named. */
  const paneOf = (key: SessionKey) => (told.filter((e): e is ObservedHookEvent => e.sessionId === of.sessions.find((s) => s.key === key)!.id)
    .at(-1)!.hostHints.HERDR_PANE_ID)
  /** herdr's agents, as agent.list answers them. */
  const list = async () => {
    const answer = await client.request('agent.list', {})
    if (!answer.ok) throw new Error(`agent.list: ${answer.fault}`)
    return answer.result.agents as Array<Record<string, unknown>>
  }
  /** The devices' own lookup of the herdr client a pane is seen in, on the model: its lsof and ps answered by the world,
   *  a tty's access time the model's. */
  const outer = () => createHerdrOuter({
    run: async (file, args) => run(file, ...args), processes: async () => [...machine.processes.values()],
    tty: async (pid) => machine.processes.get(pid)?.tty, log: () => {}, now: () => Date.now(), platform: 'darwin',
    roots: appRoots(root), bundleId: async (bundle) => machine.bundleIds.get(bundle),
    atime: async (tty) => machine.atimes.get(tty.slice('/dev/'.length)), onPath: () => null, sockets: async () => undefined,
  })
  return { root, of, world, told, deliveries, gaps, client, run, start, hook, step, at, clients, serverOf, paneOf, list, outer }
}

/** A subscriber that keeps what it is told, in order. */
function hearing() {
  const heard: unknown[] = []
  const to: HerdrSubscriber = {
    started: () => { heard.push('started') },
    event: (name, data) => { heard.push({ name, data }) },
    closed: (reason) => { heard.push({ closed: reason }) },
  }
  return { heard, to }
}

/** What herdr says on a connection comes on a turn of its own. */
const landed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
const status = (pane: string, agentStatus: string) =>
  ({ name: 'pane.agent_status_changed', data: { agent: 'claude', agent_status: agentStatus, pane_id: pane, workspace_id: 'w1' } })

describe("tier A's herdr", () => {
  it("the server is its first client's child on no tty, each pane's shell its child on a tty of its own, each client under "
    + "its tab's shell", async () => {
    const w = fakeWorld()
    await w.start('h', 'g', 'k')
    const agents = ['h', 'g', 'k'].map((key) => w.at(agentPid(w.world, key)!))
    const shells = agents.map((agent) => w.at(agent.ppid))
    const server = w.at(shells[0]!.ppid)
    const [one, two] = w.clients()
    expect([server.executable, server.tty, server.ppid]).toEqual([HERDR, undefined, one!.pid])
    // One server for the world: every pane's shell is its child, on the agent's tty, each pane's its own.
    for (const [i, shell] of shells.entries()) {
      expect([shell.ppid, shell.tty, shell.executable]).toEqual([server.pid, agents[i]!.tty, '/bin/zsh'])
    }
    expect(new Set(shells.map((s) => s.tty)).size).toBe(3)
    // The devices' own maker check names herdr.
    expect(ptyMaker(agents[0]!.pid, [...machine.processes.values()])).toEqual({ pid: server.pid, host: 'herdr' })
    // A client in each tab that holds a herdr session, each under its tab's shell on its tty.
    const tabs = [1, 2].map((tab) => tabShell(w.world, { window: 'w1', tab }))
    expect([one, two].map((c) => ({ ppid: c!.ppid, tty: c!.tty }))).toEqual(tabs.map(({ pid, tty }) => ({ ppid: pid, tty })))
    // Panes are numbered in the order they opened, and each hook names its own.
    expect(['h', 'g', 'k'].map(w.paneOf)).toEqual(['w1:p1', 'w1:p2', 'w1:p3'])
  })

  it("agent.list answers each live herdr session's pane, status, folder and session, with no session for herdrSession false "
    + 'and no name', async () => {
    const w = fakeWorld()
    // No server, no socket.
    expect(w.client.socketStamp()).toBeUndefined()
    expect(await w.client.request('agent.list', {})).toEqual({ ok: false, fault: 'no_socket' })
    // A watch on herdr's socket hears of it once, as the server starts.
    const stamps: Array<string | undefined> = []
    machine.socketWatches.add(() => { stamps.push(w.client.socketStamp()) })
    await w.start('a', 'h', 'g')
    await landed()
    expect(stamps).toEqual([w.client.socketStamp()])
    expect(stamps[0]).toBeDefined()
    await w.hook('h', 'turn-start')
    const [, h] = w.of.sessions
    // A new pane takes herdr's focus.
    expect(await w.list()).toEqual([
      { pane_id: 'w1:p1', agent: 'claude', agent_status: 'working', focused: false, cwd: '/work/eval-h',
        agent_session: { agent: 'claude', kind: 'id', value: h!.id } },
      { pane_id: 'w1:p2', agent: 'claude', agent_status: 'idle', focused: true, cwd: '/work/eval-g' },
    ])
    await w.hook('g', 'end')
    expect((await w.list()).map((agent) => agent.pane_id)).toEqual(['w1:p1'])
    // A request the devices never send is not modelled: a gap.
    expect(w.gaps).toEqual([])
    expect((await w.client.request('agent.get', { target: 'w1:p1' })).ok).toBe(false)
    expect(w.gaps).toEqual(["tier A does not model herdr's agent.get"])
  })

  it('a subscription hears each status change of a pane it names, and closes when the server ends', async () => {
    const w = fakeWorld()
    await w.start('h', 'g')
    const { heard, to } = hearing()
    w.client.subscribe([...KINDS, { type: 'pane.agent_status_changed', pane_id: 'w1:p1' }], to)
    await landed()
    await w.hook('h', 'turn-start')
    // g's pane is not named: its status is not told.
    await w.hook('g', 'turn-start')
    await w.hook('h', 'needs-input')
    await w.hook('h', 'turn-stop')
    // A new agent, and one that left, are told to every subscription.
    await w.start('k')
    await w.hook('g', 'end')
    await landed()
    expect(heard).toEqual(['started', status('w1:p1', 'working'), status('w1:p1', 'blocked'), status('w1:p1', 'done'),
      { name: 'pane_agent_detected', data: { agent: 'claude', pane_id: 'w1:p3', type: 'pane_agent_detected', workspace_id: 'w1' } },
      { name: 'pane_agent_detected', data: { agent: 'claude', pane_id: 'w1:p2', type: 'pane_agent_detected', workspace_id: 'w1',
        final_status: 'working', released: true } }])
    await w.step('herdr.restart', {})
    await landed()
    expect(heard.slice(6)).toEqual([{ closed: 'ended' }])
    // One its caller closes is told nothing, not even its start.
    const none = hearing()
    w.client.subscribe(KINDS, none.to).close()
    await landed()
    expect(none.heard).toEqual([])
  })

  it("a prompt goes as herdr's client sends it: typed into the pane's idle or done agent of its kind, control characters as "
    + 'spaces; busy while it works or waits; refused for another kind, a pane with no agent, or a pane or text the client '
    + 'would not send', async () => {
    const w = fakeWorld()
    // No server, no socket.
    expect(await w.client.prompt('w1:p1', 'claude', 'Eval words for H.')).toEqual({ outcome: 'failed', fault: 'no_socket' })
    await w.start('h', 'g')
    expect(await w.client.prompt('w1:p1', 'claude', 'Eval words\nfor H.')).toEqual({ outcome: 'sent' })
    await w.hook('g', 'turn-start')
    expect(await w.client.prompt('w1:p2', 'claude', 'Eval words for G at work.')).toEqual({ outcome: 'busy' })
    await w.hook('g', 'needs-input')
    expect(await w.client.prompt('w1:p2', 'claude', 'Eval words for G waiting.')).toEqual({ outcome: 'busy' })
    await w.hook('g', 'turn-stop')
    expect(await w.client.prompt('w1:p2', 'claude', 'Eval words for G.')).toEqual({ outcome: 'sent' })
    expect(await w.client.prompt('w1:p1', 'codex', 'Eval words for a Codex.')).toEqual({ outcome: 'failed', fault: 'not_that_agent' })
    // herdr answers agent_not_found for a pane with no agent: one it never had, and one whose agent left.
    const notFound = { outcome: 'failed', fault: 'rejected', code: 'agent_not_found' }
    expect(await w.client.prompt('w1:p9', 'claude', 'Eval words for no pane.')).toEqual(notFound)
    await w.hook('g', 'end')
    expect(await w.client.prompt('w1:p2', 'claude', 'Eval words for G gone.')).toEqual(notFound)
    // The client sends no pane id of another form, and no text that is blank once its control characters are spaces.
    expect(await w.client.prompt('%1', 'claude', 'Eval words for H.')).toEqual({ outcome: 'failed', fault: 'bad_request' })
    expect(await w.client.prompt('w1:p1', 'claude', '\n\n')).toEqual({ outcome: 'failed', fault: 'bad_request' })
    expect(w.deliveries.map(({ path, target, text }) => ({ path, target, text }))).toEqual([
      { path: 'typed', target: 'h', text: 'Eval words for H.' },
      { path: 'typed', target: 'g', text: 'Eval words for G.' },
    ])
  })

  it('the gate counts a prompt herdr types into the other session\'s pane as a wrong-session send, and none herdr refuses', async () => {
    const w = fakeWorld()
    await w.start('h', 'g')
    const spoken: Scenario = { ...w.of, steps: [{ label: 'voice', kind: 'voice', transcript: 'Eval words for H.', target: 'h' }] }
    for (const pane of ['w1:p1', 'w1:p2', 'w1:p9']) await w.client.prompt(pane, 'claude', 'Eval words for H.')
    const seen: Seen = { frames: [], faces: [], commands: [], deliveries: w.deliveries, steps: [{ at: T0, index: 0, kind: 'voice' }] }
    expect(wrongSends(spoken, seen).map(({ target, got, path }) => ({ target, got, path }))).toEqual([
      { target: 'h', got: 'g', path: 'typed' },
    ])
  })

  it("lsof names each client connected to the server's client socket and ps their ttys", async () => {
    const w = fakeWorld()
    await w.start('h')
    vi.setSystemTime(T0 + 1_000)
    await w.start('k')
    const [one, two] = w.clients()
    const h = agentPid(w.world, 'h')!
    // The devices' lookup finds both clients and takes the one typed into last: tab 2's, started after tab 1's.
    expect(await w.outer()({ HERDR_PANE_ID: 'w1:p1' }, h)).toEqual({ app: 'iterm', tty: `/dev/${two!.tty!}`, pid: two!.pid })
    // A turn of h with no tab selected moves no client.
    vi.setSystemTime(T0 + 2_000)
    await w.hook('h', 'turn-start')
    expect([machine.atimes.get(one!.tty!), machine.atimes.get(two!.tty!)]).toEqual([T0, T0 + 1_000])
    // Typed through tab 1's client, its tty was used last.
    await itermSteps['iterm.select'](w.world, { kind: 'iterm.select', window: 'w1', tab: 1 })
    vi.setSystemTime(T0 + 3_000)
    await w.hook('h', 'turn-start')
    expect(machine.atimes.get(one!.tty!)).toBe(T0 + 3_000)
    expect(await w.outer()({ HERDR_PANE_ID: 'w1:p1' }, h)).toEqual({ app: 'iterm', tty: `/dev/${one!.tty!}`, pid: one!.pid })
    expect(w.gaps).toEqual([])
  })

  it('herdr agent focus answers 0 and is recorded with its pane as pane:<key>', async () => {
    const w = fakeWorld()
    await w.start('h', 'g')
    const focus = [HERDR, 'agent', 'focus', 'w1:p1']
    expect(w.run(...focus)).toEqual({ code: 0, stdout: '' })
    expect((await w.list()).map((agent) => [agent.pane_id, agent.focused])).toEqual([['w1:p1', true], ['w1:p2', false]])
    expect(namedPanes(focus, (pane) => w.world.panes.get(pane))).toEqual([HERDR, 'agent', 'focus', 'pane:h'])
    // A pane herdr does not have is herdr's error.
    expect(w.run(HERDR, 'agent', 'focus', 'w1:p9').code).toBe(1)
    expect(w.gaps).toEqual([])
    w.run(HERDR, 'pane', 'list')
    expect(w.gaps).toEqual(['tier A does not model herdr pane list'])
    // Another program's command is not herdr's to answer.
    expect(w.run('/usr/bin/open', '-b', 'com.googlecode.iterm2')).toEqual({ code: 0, stdout: '' })
  })

  it('herdr.focus records no command', async () => {
    const w = fakeWorld()
    await w.start('h', 'g')
    // The person's own move inside herdr: herdr's focus moves, and nothing reaches the devices.
    await w.step('herdr.focus', { session: 'h' })
    expect((await w.list()).map((agent) => [agent.pane_id, agent.focused])).toEqual([['w1:p1', true], ['w1:p2', false]])
    expect([w.told.length, w.deliveries]).toEqual([2, []])
  })

  it('herdr.restart ends the server, its clients and agents with no hook, then starts each session again on a new pane with '
    + 'its start hook and fires every socket watch', async () => {
    const w = fakeWorld()
    await w.start('a', 'h', 'g')
    const before = new Set(machine.processes.keys())
    const old = [w.serverOf('h'), ...w.clients().map((c) => c.pid), agentPid(w.world, 'h')!, agentPid(w.world, 'g')!]
    const stamp = w.client.socketStamp()
    const a = agentPid(w.world, 'a')
    // A watch on herdr's socket hears of the new one: the server runs again as it is told.
    const stamps: Array<string | undefined> = []
    machine.socketWatches.add(() => { stamps.push(w.client.socketStamp()) })
    const told = w.told.length
    await w.step('herdr.restart', {})
    await landed()
    expect(old.filter((pid) => machine.processes.has(pid))).toEqual([])
    expect(w.told.slice(told).map((e) => [e.event, e.sessionId])).toEqual([['session-start', w.of.sessions[1]!.id],
      ['session-start', w.of.sessions[2]!.id]])
    expect(['h', 'g'].map(w.paneOf)).toEqual(['w1:p3', 'w1:p4'])
    expect((await w.list()).map((agent) => agent.pane_id)).toEqual(['w1:p3', 'w1:p4'])
    // A new client in the same tab, and a new server its child.
    const [client] = w.clients()
    expect([before.has(client!.pid), client!.ppid, w.at(w.serverOf('h')).ppid])
      .toEqual([false, tabShell(w.world, { window: 'w1', tab: 1 }).pid, client!.pid])
    expect([running(w.world, 'h'), running(w.world, 'g'), agentPid(w.world, 'a')]).toEqual([true, true, a])
    expect(stamps).toHaveLength(1)
    expect([stamps[0], stamps[0] === stamp]).toEqual([w.client.socketStamp(), false])
    // Old panes are no session's now.
    expect(namedPanes([HERDR, 'agent', 'focus', 'w1:p1'], (pane) => w.world.panes.get(pane))).toEqual([HERDR, 'agent', 'focus', 'pane:other'])
  })
})
