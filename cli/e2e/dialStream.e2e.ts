/**
 * The `dial` stream (docs/specs/2026-11-16-orca-device-plugin.md), on the real daemon: fake dials on the desk turn to
 * Claude Code sessions outside Harness (harness/inOrca.ts), and the stream says whether a dial is attached and which
 * agent it shows. The stream is found as Orca's Harness Device plugin finds it: the real `harness device orca link`,
 * under the throwaway daemon's environment only, prints the devices' socket, and the test opens it there.
 *
 * A dial plugged in before any agent lands on the first one listed (cableSession.ts, the landing), and that is the stream's
 * first move. A turn that falls in the repaint of a switch the daemon drives is dropped: each move is a
 * `FakeDial.turnUntil`, sent again every 2 s until its line is read.
 *
 * Orca's plugin's own loop (plugins/harness-device-orca/src/dial.ts, with Node's inputs) runs too, in a process whose
 * whole environment is the throwaway home and a bare PATH (harness/pluginDial.ts): it finds this daemon through a
 * launcher shim in that home, and nothing on this Mac's PATH. Handed the worktree on Orca's screen, as Orca hands its
 * terminals to the plugin, it tells the devices, and while Orca is in front a dial that says appFilter lists only that
 * worktree's agents (docs/plans/2026-11-18-dial-orca-tab-scope-design.md).
 *
 * Orca's chats run on no terminal, so the loop is handed Orca's id of the worktree beside its terminals, and the fake
 * `orca` lists the chats and worktrees in Orca's own answers (docs/plans/2026-11-23-dial-orca-chats-design.md): the ring
 * is that worktree's terminal agents, then its chats in Orca's order; a tap on a chat brings its worktree up; a chat's
 * prompt moves the dial; a resting chat takes no words; and an Orca that lists no chats gives the ring as before.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { request, type ClientRequest } from 'node:http'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { heardClip } from '../src/cable/__fixtures__/heardClip.js'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { RECORDED_ORCA_AGENTS } from '../src/testing/recordedOrca.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { InOrca } from './harness/inOrca.js'
import { startPluginLoop, type PluginLoop } from './harness/pluginLoop.js'
import type { DialState } from '../../plugins/harness-device-orca/src/protocol.ts'

const run = promisify(execFile)

const ORCA = 'com.stablyai.orca'
/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** The everyday daemon's port: a `link` under test that reached it would hand the test this Mac's devices' socket. */
const EVERYDAY_PORT = '18473'
/** What Orca's plugin sends to open the stream: 30 bytes. */
const OPEN = '{"type":"dial","standby":true}'
const DETACHED = '{"attached":false}'
const NO_AGENT = '{"attached":true,"agent":null}'
/** O's name, from its title as Claude Code's SessionStart says it; the mark is what a log holding the name would show. */
const TITLE = 'Plan 5c2e9b'
const TITLE_MARK = '5c2e9b'

// How the CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

interface Link { daemon: boolean; devicesSocket?: string; devicesReady: boolean }

interface Stream {
  status: number | undefined
  /** Its lines so far, in the order they came. */
  lines: string[]
  /** Whether the listener or the test has closed it. */
  closed(): boolean
  close(): void
}

describe('the dial stream, for Orca\'s Harness Device plugin', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  const requests: ClientRequest[] = []
  afterEach(async () => {
    for (const sent of requests.splice(0)) sent.destroy()
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /**
   * A daemon of its own, with a desk it finds its dials on, and a fake `orca` first on its PATH (harness/fakeOrca.ts): a
   * swipe to an agent in an Orca terminal runs `orca terminal switch`, and with none on PATH a Mac's daemon runs the Orca
   * app's own. [agentList] false: an Orca whose `agent` has no `list`.
   */
  const fresh = async ({ agentList }: { agentList?: boolean } = {}) => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    const orca = FakeOrca.install(d, { agentList })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    return { d, desk: theDesk, orca }
  }

  /** A dial with no appFilter, so one ring holds every agent, shown its first list. */
  const plugged = async (on: Desk, serial: string, mac: string): Promise<FakeDial> => {
    const dial = await on.plug(serial, mac)
    await dial.next((m) => m.t === 'agents.end', 45_000, `${serial}'s first list`)
    return dial
  }

  /** O in an Orca terminal, named TITLE, and W in WezTerm, each started and listed on every dial. */
  const sessions = async (d: IsolatedDaemon, ...dials: FakeDial[]) => {
    const o = new InOrca(d, 'o', children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
    const w = new InOrca(d, 'w', children, { WEZTERM_PANE: '7' })
    await o.hook('SessionStart', { source: 'startup', session_title: TITLE })
    for (const dial of dials) await dial.next((m) => m.t === 'agent' && m.id === o.id && m.name === TITLE, 45_000, 'O listed by its title')
    await w.hook('SessionStart', { source: 'startup' })
    for (const dial of dials) await dial.next((m) => m.t === 'agent' && m.id === w.id, 45_000, 'W listed')
    return { o, w }
  }

  /** The daemon's environment names its own data folder, port and devices' socket, never this Mac's. */
  const isolated = (d: IsolatedDaemon): void => {
    expect(d.env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
    expect(d.env.PORT).not.toBe(EVERYDAY_PORT)
    expect(devicesListenerPath(d.dataDir, process.platform, d.env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
  }

  /** `harness device orca link`, the real CLI, under the daemon's environment only: what it prints is this daemon's. */
  const link = async (d: IsolatedDaemon): Promise<Link> => {
    isolated(d)
    const { stdout } = await run(process.execPath, [...CLI_ENTRY, 'device', 'orca', 'link'], { cwd: CLI_ROOT, env: d.env, timeout: 30_000 })
    return JSON.parse(stdout) as Link
  }

  /** The devices' socket, once `link` says it is ready. */
  const ready = async (d: IsolatedDaemon): Promise<string> => {
    const said = await until('the devices ready', async () => { const it = await link(d); return it.devicesReady && it }, 30_000, 200)
    expect(said.devicesSocket).toBe(join(d.dataDir, 'devices.sock'))
    return said.devicesSocket!
  }

  /** The stream opened as the plugin opens it, on the socket `link` printed. */
  const stream = (socketPath: string): Promise<Stream> => new Promise((resolve, reject) => {
    const sent = request({ socketPath, agent: false, method: 'POST', path: '/' }, (res) => {
      const lines: string[] = []
      let closed = false
      let rest = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop()!
        lines.push(...parts)
      })
      // The listener ends a stream by closing its connection, which its client reads as an error.
      res.on('error', () => {})
      res.once('close', () => { closed = true })
      resolve({ status: res.statusCode, lines, closed: () => closed, close: () => sent.destroy() })
    })
    requests.push(sent)
    sent.on('error', reject)
    sent.end(OPEN)
  })

  /** The name the dial draws for [agent]: the last `agent` frame it got for that id. */
  const nameOn = (dial: FakeDial, agent: InOrca): string | undefined =>
    dial.messages.filter((m) => m.t === 'agent' && m.id === agent.id).at(-1)?.name as string | undefined

  const shown = (dial: FakeDial, agent: InOrca, app: string): string =>
    JSON.stringify({ attached: true, agent: { name: nameOn(dial, agent), app } })

  /** [dial] turns to [agent] until the stream's line [count] is there; that line. */
  const moved = (dial: FakeDial, agent: InOrca, open: Stream, count: number): Promise<string> =>
    dial.turnUntil(agent.id, `line ${count}`, () => (open.lines.length >= count ? open.lines[count - 1] : undefined))

  /** The plugin's loop on [d] (harness/pluginLoop.ts), once [d]'s environment is its own. */
  const loop = (d: IsolatedDaemon): PluginLoop => {
    isolated(d)
    return startPluginLoop(d, children)
  }

  /** The daemon's dial stream lines, each from its `[devices]` on. */
  const streamLines = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('dial stream')).map((line) => line.slice(line.indexOf('[devices]')))

  /** How many streams the daemon has said ended, each by its client going. */
  const endedGone = (d: IsolatedDaemon): number =>
    streamLines(d).filter((line) => line === '[devices] dial stream · ended · gone').length

  it('before a dial, link says the daemon takes a connect and the devices are not ready; a dial plugged in makes them ready', async () => {
    const { d, desk } = await fresh()
    expect(await link(d)).toEqual({ daemon: true, devicesSocket: join(d.dataDir, 'devices.sock'), devicesReady: false })
    await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    await ready(d)
  })

  it('the stream opens on the state as it is, and each move of the dial is one line', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const open = await stream(await ready(d))
    expect(open.status).toBe(200)
    await until('the first line', () => open.lines.length >= 1)
    expect(open.lines).toEqual([NO_AGENT])
    // O, the first agent listed, is where the dial lands: its line is the next.
    const { o, w } = await sessions(d, dial)
    const onO = shown(dial, o, 'Orca')
    const onW = shown(dial, w, 'WezTerm')
    expect(await until('the landing', () => open.lines[1])).toBe(onO)
    expect(await moved(dial, w, open, 3)).toBe(onW)
    // A second focus on W says nothing: the next line is O's.
    dial.send({ t: 'focus', agentId: w.id })
    expect(await moved(dial, o, open, 4)).toBe(onO)
    expect(open.lines).toEqual([NO_AGENT, onO, onW, onO])
  })

  it('a second stream is 409 while the first is open, and a stream once it closed', async () => {
    const { d, desk } = await fresh()
    await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const socket = await ready(d)
    const first = await stream(socket)
    expect(first.status).toBe(200)
    await until('the first line', () => first.lines.length >= 1)
    const second = await stream(socket)
    expect(second.status).toBe(409)
    second.close()
    expect(first.closed()).toBe(false)
    first.close()
    // Once the listener has heard the first go: each try a connection of its own, at most one a second.
    const next = await until('a stream again', async () => {
      const tried = await stream(socket)
      if (tried.status === 200) return tried
      tried.close()
      return undefined
    }, 30_000, 1_000)
    await until('its first line', () => next.lines.length >= 1)
    expect(next.lines).toEqual([NO_AGENT])
  })

  it('two dials: the one that did not move last going changes nothing, and the last one going says attached false', async () => {
    const { d, desk } = await fresh()
    const a = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const b = await plugged(desk, 'E2E-B', 'e2:e0:00:00:00:0b')
    const open = await stream(await ready(d))
    await until('the first line', () => open.lines.length >= 1)
    // Both dials land on O, the first agent listed: one line, as the stream writes only a change.
    const { o, w } = await sessions(d, a, b)
    expect(await until('the landing', () => open.lines[1])).toBe(shown(a, o, 'Orca'))
    expect(await moved(b, w, open, 3)).toBe(shown(b, w, 'WezTerm'))
    await desk.unplug('E2E-A')
    // A's port closed before B moves: a none from A that reached the stream would come before B's line.
    // Any reason: a read in the unplug window can say `daemon stopping`, and Linux can say `EIO`.
    await until("A's port closed", () => /cable: closed \([^)]*\) \[usb E2E-A\]/.test(d.log()), 30_000, 50)
    expect(await moved(b, o, open, 4)).toBe(shown(b, o, 'Orca'))
    expect(open.lines).toEqual([NO_AGENT, shown(a, o, 'Orca'), shown(b, w, 'WezTerm'), shown(b, o, 'Orca')])
    await desk.unplug('E2E-B')
    await until('the last line detached', () => open.lines.at(-1) === DETACHED)
    // B's agent may be cleared in a line of its own before the dial is gone, or only the latest written.
    expect(open.lines.slice(4).every((line) => line === NO_AGENT || line === DETACHED)).toBe(true)
  })

  it('two dials: the one that moved last going says agent null, and the other\'s next move is its line', async () => {
    const { d, desk } = await fresh()
    const a = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const b = await plugged(desk, 'E2E-B', 'e2:e0:00:00:00:0b')
    const open = await stream(await ready(d))
    await until('the first line', () => open.lines.length >= 1)
    // Both dials land on O, the first agent listed; then B moves, last.
    const { o, w } = await sessions(d, a, b)
    expect(await until('the landing', () => open.lines[1])).toBe(shown(a, o, 'Orca'))
    await moved(b, w, open, 3)
    await desk.unplug('E2E-B')
    await until('agent null', () => open.lines.length >= 4)
    expect(open.lines[3]).toBe(NO_AGENT)
    expect(await moved(a, w, open, 5)).toBe(shown(a, w, 'WezTerm'))
  })

  it('the plugin\'s loop, through the launcher in the throwaway home, follows the dial', async () => {
    const { d, desk } = await fresh()
    const plugin = loop(d)
    const last = (): DialState | undefined => plugin.states.at(-1)
    onTestFailed(() => { console.log(`---- the loop's states\n${plugin.states.map((s) => JSON.stringify(s)).join('\n')}\n---- its log\n${plugin.logs.join('\n')}`) })
    await until('unplugged', () => last()?.state === 'unplugged', 60_000)
    const dial = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const attached: DialState = { state: 'attached' }
    await until('attached', () => last()?.state === 'attached', 60_000)
    expect(last()).toEqual(attached)
    // Started once the dial is there: a session known only by its hooks has no process for the attach scan to find, and
    // a SessionStart sent before the devices process exists is dropped.
    const { o } = await sessions(d, dial)
    const onO: DialState = { state: 'attached', agent: { name: TITLE, app: 'Orca' } }
    await dial.turnUntil(o.id, 'O shown', () => (last()?.agent?.name === TITLE || undefined))
    expect(last()).toEqual(onO)
    await desk.unplug('E2E-A')
    await until('unplugged again', () => last()?.state === 'unplugged', 60_000)
    // O cleared as the dial's session closes may come in a state of its own before the dial is gone, or only the
    // latest be told; nothing else is: no notRunning, noHarness or elsewhere.
    expect(plugin.states.slice(0, 3)).toEqual([{ state: 'unplugged' }, attached, onO])
    expect(plugin.states.slice(3, -1).every((state) => JSON.stringify(state) === JSON.stringify(attached))).toBe(true)
    expect(last()).toEqual({ state: 'unplugged' })
    // Streams the loop held while the dial came and went have ended too: the one it closes on stop is one more.
    const ended = endedGone(d)
    const stopped = plugin.stop()
    await until('the stream ended', () => endedGone(d) > ended)
    expect(await stopped).toBe(0)
    expect(plugin.logs).toContain('dial: unplugged')
    expect(plugin.logs).toContain('dial: attached')
    expect(plugin.logs.filter((line) => line.includes(TITLE_MARK) || line.includes('Orca') || line.includes(d.root))).toEqual([])
    expect(d.log()).not.toContain(TITLE_MARK)
  })

  it('the daemon\'s log says each open and end of the stream, and nothing of an agent', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk, 'E2E-A', 'e2:e0:00:00:00:0a')
    const { o, w } = await sessions(d, dial)
    const open = await stream(await ready(d))
    await until('the first line', () => open.lines.length >= 1)
    // The dial landed on O, the first agent listed: the stream opened on it.
    await moved(dial, w, open, 2)
    await moved(dial, o, open, 3)
    open.close()
    await until('the stream ended', () => endedGone(d) >= 1)
    const lines = streamLines(d)
    expect(lines).toContain('[devices] dial stream · open')
    // Each line whole: no name or app could sit in one.
    expect(lines.every((line) => /^\[devices\] dial stream · (open|ended · (gone|stalled|closed)|lines in the last minute: \d+)$/.test(line))).toBe(true)
    expect(d.log()).not.toContain(TITLE_MARK)
  })

  /** A session in the Orca terminal [handle], with Orca's bundle id as an app's terminal inherits it. */
  const inOrca = (d: IsolatedDaemon, folder: string, handle: string): InOrca =>
    new InOrca(d, folder, children, { ORCA_TERMINAL_HANDLE: handle, __CFBundleIdentifier: ORCA })

  /** The app in front, as the Harness Device app tells it: a line on the stdin of the real `harness hardware watch --json`,
   *  which it holds open until it quits. One watch, each call a line. */
  const frontWatch = (d: IsolatedDaemon): ((bundle: string) => void) => {
    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(watch)
    return (bundle) => { watch.stdin!.write(`${JSON.stringify({ front: bundle })}\n`) }
  }

  /** The dial's latest list: the `agent` frames between its last `agents.begin` and `agents.end`, that end, and where. */
  const latestList = (dial: FakeDial): { agents: DialMessage[]; end: DialMessage; at: number } | undefined => {
    const at = dial.messages.findLastIndex((m) => m.t === 'agents.end')
    if (at < 0) return undefined
    const begin = dial.messages.findLastIndex((m, i) => i < at && m.t === 'agents.begin')
    return { agents: dial.messages.slice(begin + 1, at).filter((m) => m.t === 'agent'), end: dial.messages[at], at }
  }

  /** The dial's latest list, once one sent after [since] is [agents], in that order. */
  const lists = (dial: FakeDial, agents: ReadonlyArray<{ readonly id: string }>, since: number, what: string) => until(what, () => {
    const latest = latestList(dial)
    return latest && latest.at >= since && latest.agents.map((m) => m.id).join() === agents.map((a) => a.id).join() ? latest : undefined
  }, 45_000, 50)

  /** The daemon's lines that hold [prefix], each from its `[device]` on. */
  const deviceLines = (d: IsolatedDaemon, prefix: string): string[] =>
    d.log().split('\n').filter((line) => line.includes(prefix)).map((line) => line.slice(line.indexOf('[device]')))
  const said = (d: IsolatedDaemon, line: string): Promise<true> =>
    until(`"${line}" in the daemon's log`, () => d.log().includes(line), 30_000, 50)

  /** [claude]'s typed prompt, and the line the devices said for it. */
  const prompted = async (d: IsolatedDaemon, claude: InOrca): Promise<string> => {
    const told = deviceLines(d, '[device] prompt · ').length
    await claude.hook('UserPromptSubmit', { prompt: 'run the tests' })
    return until("the prompt's line", () => deviceLines(d, '[device] prompt · ')[told], 30_000, 50)
  }

  it('the plugin\'s loop tells the worktree on screen, and Orca\'s ring on the dial is that worktree\'s agents', async () => {
    const { d, desk, orca } = await fresh()
    const [a1, a2, b1, e] = [0, 1, 2, 3].map(() => `term_${randomUUID()}`)
    // Three worktrees: A's two tabs, B's one, and a third whose terminal has no agent.
    orca.layout([[[a2], [a1]], [[b1]], [[e]]])
    const plugin = loop(d)
    onTestFailed(() => { console.log(`---- the loop's states\n${plugin.states.map((s) => JSON.stringify(s)).join('\n')}\n---- its log\n${plugin.logs.join('\n')}`) })

    // 1. Handed a worktree before any dial: it goes as the stream opens.
    plugin.front([a2, a1])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    await until('attached', () => plugin.states.at(-1)?.state === 'attached', 60_000)
    await said(d, '[device] orca front · set · 2 terminals')

    // 2. Every Orca agent, in Orca's tab order across worktrees, while no app is settled in front.
    const sessions = { a1: inOrca(d, 'a1', a1), a2: inOrca(d, 'a2', a2), b1: inOrca(d, 'b1', b1) }
    for (const claude of Object.values(sessions)) {
      await claude.hook('SessionStart', { source: 'startup' })
      await dial.next((m) => m.t === 'agent' && m.id === claude.id, 45_000, 'the agent listed')
    }
    const all = [sessions.a2, sessions.a1, sessions.b1]
    const onA = [sessions.a2, sessions.a1]
    await lists(dial, all, 0, 'every Orca agent')

    // 3. Orca in front: the worktree on screen, and the APPS page still counts every Orca agent.
    const front = frontWatch(d)
    let since = dial.messages.length
    front(ORCA)
    const scoped = await lists(dial, onA, since, "A's agents")
    expect(scoped.end.total).toBe(2)
    const apps = dial.messages.filter((m) => m.t === 'apps').at(-1)?.apps as { id: string; count: number }[]
    expect(apps.find((app) => app.id === 'orca')?.count).toBe(3)

    // 4. The other worktree, then the one with no agent: an empty list.
    since = dial.messages.length
    plugin.front([b1])
    await lists(dial, [sessions.b1], since, "B's agent")
    since = dial.messages.length
    plugin.front([e])
    expect((await lists(dial, [], since, 'an empty list')).end.total).toBe(0)

    // 5. Back on A, the dial turned to A2 by hand: A1's prompt moves the dial, B1's in the other worktree does not.
    since = dial.messages.length
    plugin.front([a2, a1])
    await lists(dial, onA, since, "A's agents again")
    await dial.turnUntil(sessions.a2.id, 'the swipe', () => (d.log().includes('[device] swipe · ok') || undefined))
    since = dial.messages.length
    expect(await prompted(d, sessions.a1)).toBe('[device] prompt · moved')
    await dial.next((m) => m.t === 'focus' && m.agentId === sessions.a1.id, 30_000, "A1's focus", since)
    expect(await prompted(d, sessions.b1)).toBe('[device] prompt · skipped · no tile')
    expect(dial.messages.filter((m) => m.t === 'focus' && m.agentId === sessions.b1.id)).toEqual([])

    // 6. Another app in front: every Orca agent. Orca again: the worktree on screen.
    since = dial.messages.length
    front('com.apple.Safari')
    await lists(dial, all, since, 'every Orca agent with Safari in front')
    since = dial.messages.length
    front(ORCA)
    await lists(dial, onA, since, "A's agents with Orca in front again")

    // 7. The plugin stopped: its stream ends, and with it the worktree on screen.
    since = dial.messages.length
    expect(await plugin.stop()).toBe(0)
    await said(d, '[device] orca front · cleared')
    await lists(dial, all, since, 'every Orca agent once the plugin stopped')

    // 8. Counts only: no handle in the daemon's log or the loop's, and every send was taken.
    for (const line of deviceLines(d, '[device] orca front')) expect(line).toMatch(/^\[device\] orca front · (set · \d+ terminals|cleared)$/)
    const loopLog = plugin.logs.join('\n')
    for (const handle of [a1, a2, b1, e]) {
      expect(d.log()).not.toContain(handle)
      expect(loopLog).not.toContain(handle)
    }
    expect(plugin.logs).not.toContain('dial: front not sent')
  })

  // ── Orca's chats (docs/plans/2026-11-23-dial-orca-chats-design.md) ─────────────────────────────────────────────────

  /** Every line the chat source says: fixed words and counts, never a title, folder, id or workspace. */
  const CHAT_LINE = /^\[orca-chat\] (listed · \d+ chats · \d+ heard|read · failed · (exit|no answer|unreadable)|read · (<0\.5s|<2s|>2s))$/
  const chatLines = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[orca-chat]')).map((line) => line.slice(line.indexOf('[orca-chat]')))

  /** A chat of Orca's: its Orca session id, the id of its row while no hook has named it, its worktree and its title. */
  interface OrcaChat { readonly orcaId: string; readonly id: string; readonly worktreeId: string; readonly title: string }
  const orcaChat = (worktreeId: string): OrcaChat => {
    const orcaId = randomUUID()
    return { orcaId, id: observedAgentId('orca', orcaId), worktreeId, title: `Chat ${orcaId.slice(0, 8)}` }
  }
  /** Its row of `orca agent list --json`: the recording's first chat's, with this chat's values. */
  const chatRow = (chat: OrcaChat, agent: string, updatedAt: number) => ({
    ...RECORDED_ORCA_AGENTS.result.agents[0], orcaSessionId: chat.orcaId, agent, state: 'done', worktreeId: chat.worktreeId,
    workspace: chat.worktreeId.slice(chat.worktreeId.lastIndexOf('/') + 1), repo: 'e2e', paneKey: randomUUID(),
    title: chat.title, lastAssistantMessage: `${chat.title} answered.`, updatedAt,
  })
  /** The fake Orca's runs with exactly these words, after the name it was run by. */
  const ran = (orca: FakeOrca, words: string) => orca.log().filter(({ argv }) => argv.slice(1).join(' ') === words)
  /** The count the dial's latest APPS page gives Orca. */
  const orcaCount = (dial: FakeDial): number | undefined =>
    (dial.messages.filter((m) => m.t === 'apps').at(-1)?.apps as { id: string; count: number }[] | undefined)?.find((app) => app.id === 'orca')?.count

  /**
   * Orca with two worktrees, in the shapes its CLI lists them (testing/recordedOrca.ts): A, which has an identity, holds
   * terminal T, where Claude Code runs, a Claude chat and a Codex chat; B, which has none, a Claude chat, and no terminal.
   * Orca lists A's Claude chat, B's, then A's Codex chat, the newest last, so a ring in time's order would differ. The
   * plugin's loop is handed A before any dial, by Orca's `identity:` id; a dial that says appFilter is plugged in, and T's
   * agent starts. [agentList] false: an Orca whose `agent` has no `list`.
   */
  const twoWorktrees = async ({ agentList = true }: { agentList?: boolean } = {}) => {
    const { d, desk, orca } = await fresh({ agentList })
    const repo = randomUUID()
    const worktreeA = `${repo}::/e2e/orca-chats/wt-a`
    const worktreeB = `${repo}::/e2e/orca-chats/wt-b`
    const identityA = `wt2:local:${randomUUID()}`
    const onA = `identity:${identityA}`
    const chats = { a1: orcaChat(worktreeA), b1: orcaChat(worktreeB), a2: orcaChat(worktreeA) }
    const t = `term_${randomUUID()}`
    orca.layout([[[t]]])
    const at = Date.now()
    orca.agents([chatRow(chats.a1, 'claude', at - 3_000), chatRow(chats.b1, 'claude', at - 2_000), chatRow(chats.a2, 'codex', at - 1_000)])
    orca.worktrees([{ id: worktreeA, identity: { key: identityA } }, { id: worktreeB }])
    const plugin = loop(d)
    onTestFailed(() => { console.log(`---- the loop's states\n${plugin.states.map((s) => JSON.stringify(s)).join('\n')}\n---- its log\n${plugin.logs.join('\n')}`) })
    plugin.front([t], onA)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    await until('attached', () => plugin.states.at(-1)?.state === 'attached', 60_000)
    await said(d, '[device] orca front · set · 1 terminals')
    const inT = inOrca(d, 'in-t', t)
    await inT.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'agent' && m.id === inT.id, 45_000, "T's agent listed")
    /** No title, Orca id, worktree id, folder, identity or handle of the case's in the daemon's log or the loop's. */
    const unlogged = (): void => {
      const loopLog = plugin.logs.join('\n')
      for (const secret of [...Object.values(chats).flatMap((c) => [c.orcaId, c.title, c.worktreeId]), '/e2e/orca-chats', identityA, t]) {
        expect(d.log()).not.toContain(secret)
        expect(loopLog).not.toContain(secret)
      }
      for (const line of chatLines(d)) expect(line).toMatch(CHAT_LINE)
      expect(plugin.logs).not.toContain('dial: front not sent')
    }
    return { d, dial, orca, plugin, chats, inT, t, onA, worktreeA, worktreeB, front: frontWatch(d), unlogged }
  }

  it("two worktrees with chats and a terminal: Orca in front with one on screen lists its terminal then its chats, and the plugin's other worktree switches the ring, named by its identity or by its own id", async () => {
    const { d, dial, plugin, chats, inT, t, onA, worktreeB, front, unlogged } = await twoWorktrees()
    const onScreenA = [inT, chats.a1, chats.a2]

    // 1. No app settled in front: every Orca agent, T's at its tab's place, then every chat in Orca's order.
    await lists(dial, [inT, chats.a1, chats.b1, chats.a2], 0, 'every Orca agent, its chats after its terminal')

    // 2. Orca in front, A on screen by its identity, which Orca's worktree list maps to A's id: T's agent, then A's chats,
    // each named as Orca names it. The APPS page counts every Orca agent, chats included.
    let since = dial.messages.length
    front(ORCA)
    const scoped = await lists(dial, onScreenA, since, "A's terminal agent, then its chats")
    expect(scoped.end.total).toBe(3)
    expect(scoped.agents.slice(1).map((m) => m.name)).toEqual([chats.a1.title, chats.a2.title])
    await until('APPS counting every Orca agent', () => orcaCount(dial) === 4 || undefined, 30_000, 50)

    // 3. B on screen, which has no identity, by its own id as Orca names it: its chat alone, as it has no terminal.
    since = dial.messages.length
    plugin.front([], worktreeB)
    await lists(dial, [chats.b1], since, "B's chat")

    // 4. A again, by its identity.
    since = dial.messages.length
    plugin.front([t], onA)
    await lists(dial, onScreenA, since, "A's agents again")

    // 5. Counts and fixed words only, and every send was taken.
    expect(chatLines(d)).toContain('[orca-chat] listed · 3 chats · 0 heard')
    unlogged()
  })

  it('a tap on a chat runs worktree activate with its worktree id, and words to a resting chat get Type in Orca for chats.', async () => {
    const { d, dial, orca, plugin, chats, inT, worktreeA, worktreeB, front, unlogged } = await twoWorktrees()
    let since = dial.messages.length
    front(ORCA)
    await lists(dial, [inT, chats.a1, chats.a2], since, "A's agents")
    /** Each `worktree activate` Orca ran, by the worktree it named and whether it exited 0. */
    const activated = () => orca.log().filter(({ argv }) => argv[1] === 'worktree' && argv[2] === 'activate')
      .map(({ argv, ok }) => ({ args: argv.slice(1), ok }))
    const activates = (worktreeId: string) => ({ args: ['worktree', 'activate', '--worktree', `id:${worktreeId}`, '--json'], ok: true })

    // 1. A tap on A's Codex chat: A's worktree comes up by its id, one argument, then Orca comes forward.
    const opened = d.opens().length
    dial.send({ t: 'agent.open', agentId: chats.a2.id })
    await until("A's worktree activated", () => activated().some((run) => JSON.stringify(run) === JSON.stringify(activates(worktreeA))) || undefined, 30_000, 50)
    // macOS brings an app forward by its bundle id; Linux raises its window, which no e2e desktop has.
    if (process.platform === 'darwin') {
      await until('Orca forward', () => d.opens().slice(opened).some((args) => args.join(' ') === `-b ${ORCA}`) || undefined, 30_000, 50)
    }

    // 2. On B, which Orca names by its own id, holding its folder: a tap on its chat brings B up, the id still one argument.
    since = dial.messages.length
    plugin.front([], worktreeB)
    await lists(dial, [chats.b1], since, "B's chat")
    dial.send({ t: 'agent.open', agentId: chats.b1.id })
    await until("B's worktree activated", () => activated().some((run) => JSON.stringify(run) === JSON.stringify(activates(worktreeB))) || undefined, 30_000, 50)

    // 3. Words to B's chat, which has no process: refused on the dial before any audio is kept, and typed nowhere.
    since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: chats.b1.id, uploadId: 'spoken-chat', sr: 16_000, lang: 'en' })
    for (const frame of heardClip()) dial.audio(frame)
    dial.send({ t: 'voice.end', uploadId: 'spoken-chat' })
    expect(await dial.next((m) => (m.t === 'voice.transcript' || m.t === 'voice.error') && m.uploadId === 'spoken-chat', 45_000, 'the answer to its words', since))
      .toMatchObject({ t: 'voice.error', message: 'Type in Orca for chats.' })
    expect(orca.log().filter(({ argv }) => argv[1] === 'terminal' && argv[2] === 'send')).toEqual([])
    unlogged()
  })

  it('a prompt hook carrying ORCA_AGENT_SESSION_ID, with no terminal handle, moves the dial to that chat', async () => {
    const { d, dial, chats, inT, front, unlogged } = await twoWorktrees()
    let since = dial.messages.length
    front(ORCA)
    await lists(dial, [inT, chats.a1, chats.a2], since, "A's agents")

    // 1. A's Claude chat's process, which Orca runs on no terminal: its hook names its Orca session and no handle. Its row is
    // the hooked copy now, in the resting row's place and named as Orca names the chat: one card.
    const a1 = new InOrca(d, 'chat-a1', children, { ORCA_AGENT_SESSION_ID: chats.a1.orcaId, ORCA_STRUCTURED_SESSION: '1', __CFBundleIdentifier: ORCA })
    since = dial.messages.length
    await a1.hook('SessionStart', { source: 'startup' })
    await lists(dial, [inT, a1, chats.a2], since, "A1's hooked copy in its row's place")
    await dial.next((m) => m.t === 'agent' && m.id === a1.id && m.name === chats.a1.title, 45_000, "A1 named by Orca's title", since)

    // 2. The dial turned to T's agent by hand, then a prompt typed in A1: the dial moves to A1.
    await dial.turnUntil(inT.id, 'the swipe', () => (d.log().includes('[device] swipe · ok') || undefined))
    since = dial.messages.length
    expect(await prompted(d, a1)).toBe('[device] prompt · moved')
    await dial.next((m) => m.t === 'focus' && m.agentId === a1.id, 30_000, "A1's focus", since)
    unlogged()
  })

  it("an Orca whose agent --help lacks list gives today's ring", async () => {
    const { d, dial, orca, plugin, inT, t, onA, worktreeB, front } = await twoWorktrees({ agentList: false })
    // Asked once whether it lists chats, at the dial's attach: it does not.
    await until('agent --help asked', () => ran(orca, 'agent --help').length > 0 || undefined, 30_000, 50)
    await lists(dial, [inT], 0, "T's agent alone")

    // Orca in front: B, which has no terminal, is an empty ring, and A is T's agent alone, as before Orca's chats.
    front(ORCA)
    let since = dial.messages.length
    plugin.front([], worktreeB)
    expect((await lists(dial, [], since, 'an empty list')).end.total).toBe(0)
    since = dial.messages.length
    plugin.front([t], onA)
    expect((await lists(dial, [inT], since, "T's agent alone again")).end.total).toBe(1)
    expect(orcaCount(dial)).toBe(1)

    // Neither list was read, `--help` was not asked again for the same binary, and nothing was said of it.
    expect(ran(orca, 'agent list --json')).toEqual([])
    expect(ran(orca, 'worktree list --json')).toEqual([])
    expect(ran(orca, 'agent --help')).toHaveLength(1)
    expect(chatLines(d)).toEqual([])
  })
})
