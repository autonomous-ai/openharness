// Tier A's tmux (tmux.ts) on a fake world: the processes its server, panes and clients run as, how it answers the
// commands the devices' tmux code sends (cable/hosts/tmux.ts), and the person's own moves. Every folder is a temp one.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ptyMaker } from '../../../../cable/hosts/scannedApp.js'
import type { ObservedEvent } from '../../../../core/observedHook.js'
import { HARNESS_OWNER_OPTION, paneOwnerFormat } from '../../../../lib/harnessSessionLabel.js'
import { itermSession, orcaSession } from '../../catalog.js'
import { namedPanes } from '../../itermRecords.js'
import type { Scenario, SessionKey, StepOf } from '../../types.js'
import { machine } from '../machine.js'
import type { TierAWorld } from '../world.js'
import { itermSteps, tabShell } from './iterm.js'
import { agentPid, running, sessionsSteps, shellOf } from './sessions.js'
import { answerTmux, tmuxShown, tmuxSteps } from './tmux.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

const TMUX = '/opt/eval/bin/tmux'
// The formats the devices send (cable/hosts/tmux.ts), spelled from the same parts.
const FACTS = `#{pane_pid}|#{session_name}|#{${HARNESS_OWNER_OPTION}}${paneOwnerFormat(false)}`
const CLIENTS = `#{client_activity}|#{client_pid}|#{client_name}|#{${HARNESS_OWNER_OPTION}}|#{session_name}`
const CLIENT_PLACES = '#{client_activity}|#{client_pid}|#{client_tty}'
const PANES = `#{pane_id}|#{pane_tty}|${FACTS}`
/** Virtual time at the start of a case: whole seconds, as tmux gives a client's activity. */
const T0 = 1_763_337_600_000

/** a in w1's plain tab 0; t and u in tmux in tab 1, its panes 0 and 1; v in tmux in tab 2. Pane ids by index: %1, %2, %3. */
const sessions = (): Scenario => ({
  id: 'T3', app: 'iterm', title: 'Eval tmux', dims: ['D1'], platforms: ['darwin'], tiers: ['a'], heldOut: false, steps: [],
  checks: [], probes: [], sessions: [itermSession('a'), itermSession('t', { place: 'tmux', tab: 1 }),
    itermSession('u', { place: 'tmux', tab: 1, split: 1 }), itermSession('v', { place: 'tmux', tab: 2 })],
})

/** a in w1's Orca tab 0; c and d under tmux in tab 1, its splits 0 and 1, d a Codex; e under tmux in tab 2. Pane ids by
 *  index: %1, %2, %3. */
const orcaTabs = (): Scenario => ({ ...sessions(), id: 'T4', app: 'orca', sessions: [orcaSession('a'), orcaSession('c', { tmux: true, tab: 1 }),
  orcaSession('d', { tmux: true, tab: 1, split: 1, engine: 'codex' }), orcaSession('e', { tmux: true, tab: 2 })] })

/** A world on darwin whose devices are told hooks, whose listener takes tab reports, and whose rules answer each command. */
function fakeWorld(of: Scenario = sessions()) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-tmux-'))
  roots.push(root)
  machine.reset()
  machine.itermHome = root
  machine.installed.set('tmux', TMUX)
  const told: ObservedEvent[] = []
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
    deliver: () => {},
    gap: (reason: string) => { gaps.push(reason) },
    answer: (rule: (typeof rules)[number]) => { rules.push(rule) },
  } as unknown as TierAWorld
  answerTmux(world)
  /** What the world answers a run of tmux with. */
  const run = (...args: string[]) => {
    for (const rule of rules) {
      const said = rule([TMUX, ...args])
      if (said) return { stdout: '', ...said }
    }
    return undefined
  }
  const start = async (...keys: SessionKey[]) => {
    for (const session of keys) await sessionsSteps.hook(world, { kind: 'hook', session, event: 'start' })
  }
  const step = <K extends keyof typeof tmuxSteps>(kind: K, more: Omit<StepOf<K>, 'kind'>) =>
    (tmuxSteps[kind] as (w: TierAWorld, s: StepOf<K>) => Promise<void>)(world, { kind, ...more } as StepOf<K>)
  const at = (pid: number) => machine.processes.get(pid)!
  /** The tmux clients running: a tmux process on a tty. */
  const clients = () => [...machine.processes.values()].filter((p) => p.executable === TMUX && p.tty !== undefined)
  /** Each pane's id and whether it is its window's active one, as tmux lists them. */
  const active = () => run('list-panes', '-a', '-F', '#{pane_id}|#{pane_active}')!.stdout
  return { root, world, told, gaps, rules, run, start, step, at, clients, active }
}

describe("tier A's tmux", () => {
  it("the server is launchd's child on no tty; each pane's shell is its child on a tty of its own; each client runs under its "
    + "tab's shell on that tab's tty", async () => {
    const w = fakeWorld()
    await w.start('t', 'u', 'v')
    const [t, u, v] = ['t', 'u', 'v'].map((key) => w.at(agentPid(w.world, key)!))
    const shells = [t, u, v].map((agent) => w.at(agent.ppid))
    const server = w.at(shells[0]!.ppid)
    expect([server.executable, server.tty, server.ppid]).toEqual([TMUX, undefined, 1])
    // One server for the world: every pane's shell is its child, on the agent's tty, each pane's its own.
    for (const [i, shell] of shells.entries()) {
      expect([shell.ppid, shell.tty, shell.executable]).toEqual([server.pid, [t, u, v][i]!.tty, '/bin/zsh'])
    }
    expect(new Set(shells.map((s) => s.tty)).size).toBe(3)
    // The devices' own maker check names tmux.
    expect(ptyMaker(t.pid, [...machine.processes.values()])).toEqual({ pid: server.pid, host: 'tmux' })
    // A client for each tmux session, the first in tab 1 and the other in tab 2, each under its tab's shell on its tty.
    const tabs = [1, 2].map((tab) => tabShell(w.world, { window: 'w1', tab }))
    expect(w.clients().map((c) => ({ ppid: c.ppid, tty: c.tty }))).toEqual(tabs.map(({ pid, tty }) => ({ ppid: pid, tty })))
  })

  it('display-message, list-clients in both formats and list-panes answer from the model; a format name the model does not '
    + 'know is a gap', async () => {
    const w = fakeWorld()
    await w.start('t', 'u', 'v')
    const shell = (key: SessionKey) => w.at(agentPid(w.world, key)!).ppid
    const tty = (key: SessionKey) => `/dev/${w.at(agentPid(w.world, key)!).tty!}`
    const [one, two] = w.clients()
    const seconds = T0 / 1000
    expect(w.run('display-message', '-p', '-t', '%2', FACTS)).toEqual({ code: 0, stdout: `${shell('u')}|eval-w1-1|\n` })
    expect(w.run('list-clients', '-F', CLIENTS)).toEqual({ code: 0,
      stdout: `${seconds}|${one!.pid}|/dev/${one!.tty!}||eval-w1-1\n${seconds}|${two!.pid}|/dev/${two!.tty!}||eval-w1-2\n` })
    expect(w.run('list-clients', '-t', '%3', '-F', CLIENT_PLACES)).toEqual({ code: 0, stdout: `${seconds}|${two!.pid}|/dev/${two!.tty!}\n` })
    expect(w.run('list-panes', '-a', '-F', PANES)).toEqual({ code: 0, stdout: [
      `%1|${tty('t')}|${shell('t')}|eval-w1-1|`, `%2|${tty('u')}|${shell('u')}|eval-w1-1|`, `%3|${tty('v')}|${shell('v')}|eval-w1-2|`,
    ].map((line) => `${line}\n`).join('') })
    // A pane the server does not have is tmux's error.
    expect(w.run('display-message', '-p', '-t', '%9', FACTS)?.code).toBe(1)
    expect(w.gaps).toEqual([])
    w.run('display-message', '-p', '-t', '%1', '#{pane_nope}')
    expect(w.gaps).toEqual(['tier A does not model tmux format #{pane_nope}'])
    // Another program's command is not tmux's to answer.
    expect(w.rules.map((rule) => rule(['/usr/bin/open', '-b', 'com.googlecode.iterm2']))).toEqual([undefined])
  })

  it("select-window ; select-pane makes the pane its window's active one, and is recorded with the pane as pane:<key>", async () => {
    const w = fakeWorld()
    await w.start('t', 'u', 'v')
    expect(w.active()).toBe('%1|1\n%2|0\n%3|1\n')
    const argv = ['select-window', '-t', '%2', ';', 'select-pane', '-t', '%2']
    expect(w.run(...argv)).toEqual({ code: 0, stdout: '' })
    expect(w.active()).toBe('%1|0\n%2|1\n%3|1\n')
    expect(namedPanes([TMUX, ...argv], (pane) => w.world.panes.get(pane)))
      .toEqual([TMUX, 'select-window', '-t', 'pane:u', ';', 'select-pane', '-t', 'pane:u'])
    expect(w.run('select-window', '-t', '%9', ';', 'select-pane', '-t', '%9')?.code).toBe(1)
  })

  it('switch-client moves that client', async () => {
    const w = fakeWorld()
    await w.start('t', 'u', 'v')
    const two = w.clients()[1]!
    expect(w.run('switch-client', '-c', `/dev/${two.tty!}`, '-t', '%2')).toEqual({ code: 0, stdout: '' })
    expect(w.run('list-clients', '-F', '#{client_pid}|#{session_name}')!.stdout)
      .toBe(`${w.clients()[0]!.pid}|eval-w1-1\n${two.pid}|eval-w1-1\n`)
    expect(w.active()).toBe('%1|0\n%2|1\n%3|1\n')
    expect(w.run('switch-client', '-c', '/dev/ttys999', '-t', '%2')?.code).toBe(1)
  })

  it("tmux.detach ends the session's clients; tmux.attach adds one in its tab, used now", async () => {
    const w = fakeWorld()
    await w.start('t', 'u', 'v')
    const [one, two] = w.clients()
    await w.step('tmux.detach', { session: 'u' })
    expect(w.clients()).toEqual([two])
    expect([machine.processes.has(one!.pid), running(w.world, 't'), running(w.world, 'u')]).toEqual([false, true, true])
    expect(w.run('list-clients', '-t', '%1', '-F', CLIENT_PLACES)).toEqual({ code: 0, stdout: '' })
    vi.setSystemTime(T0 + 5_000)
    await w.step('tmux.attach', { session: 't', window: 'w1', tab: 3 })
    const tab = tabShell(w.world, { window: 'w1', tab: 3 })
    const added = w.clients().find((c) => c.tty === tab.tty)!
    expect(added.ppid).toBe(tab.pid)
    expect(w.run('list-clients', '-t', '%2', '-F', CLIENT_PLACES)).toEqual({ code: 0, stdout: `${(T0 + 5_000) / 1000}|${added.pid}|/dev/${tab.tty}\n` })
    expect(machine.atimes.get(tab.tty)).toBe(T0 + 5_000)
  })

  it("tmux.selectPane makes the session's pane its window's active one", async () => {
    const w = fakeWorld()
    await w.start('t', 'u')
    await w.step('tmux.selectPane', { session: 'u' })
    expect(w.active()).toBe('%1|0\n%2|1\n')
  })

  it('tmux.selectPane on the pane already active fails its step: a move that changes nothing is the scenario\'s mistake', async () => {
    const w = fakeWorld()
    await w.start('t', 'u')
    await expect(w.step('tmux.selectPane', { session: 't' }))
      .rejects.toThrow("scenario T3: t's tmux pane is already its window's active one")
    expect(w.active()).toBe('%1|1\n%2|0\n')
  })

  it("a turn-start while the selected tab holds a client of the session moves that client's activity and its tty's atime, and "
    + 'with none selected moves nothing', async () => {
    const w = fakeWorld()
    await w.start('a', 't')
    const client = w.clients()[0]!
    const places = () => w.run('list-clients', '-t', '%1', '-F', CLIENT_PLACES)!.stdout
    const before = { places: places(), atime: machine.atimes.get(client.tty!) }
    const turn = () => sessionsSteps.hook(w.world, { kind: 'hook', session: 't', event: 'turn-start' })
    vi.setSystemTime(T0 + 3_000)
    await turn()
    expect({ places: places(), atime: machine.atimes.get(client.tty!) }).toEqual(before)
    // a's tab holds no client of t's session.
    await itermSteps['iterm.select'](w.world, { kind: 'iterm.select', window: 'w1', tab: 0 })
    await turn()
    expect({ places: places(), atime: machine.atimes.get(client.tty!) }).toEqual(before)
    await itermSteps['iterm.select'](w.world, { kind: 'iterm.select', window: 'w1', tab: 1 })
    vi.setSystemTime(T0 + 7_000)
    await turn()
    expect(places()).toBe(`${(T0 + 7_000) / 1000}|${client.pid}|/dev/${client.tty!}\n`)
    expect(machine.atimes.get(client.tty!)).toBe(T0 + 7_000)
    expect(w.told.filter((e) => e.event === 'turn-start')).toHaveLength(3)
  })

  it("Orca sessions under tmux in one worktree and tab are panes of one tmux session eval-orca-<worktree>-<tab>, in split "
    + "order, the first started selected, with one client under that tab's Orca shell; another tab's is a session of its own", async () => {
    const w = fakeWorld(orcaTabs())
    await w.start('d', 'c', 'e')
    expect(w.run('list-panes', '-a', '-F', '#{pane_id}|#{session_name}|#{pane_active}')!.stdout)
      .toBe('%1|eval-orca-w1-1|0\n%2|eval-orca-w1-1|1\n%3|eval-orca-w1-2|1\n')
    // A client a tmux session, under its tab's one Orca shell on that shell's tty: c's and d's is the same.
    const shells = ['c', 'e'].map((key) => w.at(shellOf(w.world, key)!))
    expect(w.clients().map((c) => ({ ppid: c.ppid, tty: c.tty }))).toEqual(shells.map(({ pid, tty }) => ({ ppid: pid, tty })))
    expect(shellOf(w.world, 'd')).toBe(shells[0]!.pid)
    // tmux shows the pane first started, d's, until the person selects another.
    expect(['c', 'd', 'e', 'a'].map((key) => tmuxShown(w.world, key))).toEqual(['d', 'd', 'e', undefined])
    await w.step('tmux.selectPane', { session: 'c' })
    expect(['c', 'd', 'e'].map((key) => tmuxShown(w.world, key))).toEqual(['c', 'c', 'e'])
  })
})
