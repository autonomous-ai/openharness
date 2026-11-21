/**
 * Claude Code in a pane of the person's herdr shows on the page of the app that holds the herdr client attached to it,
 * and a swipe reaches it there (docs/plans/2026-11-19-dial-herdr-in-terminal-app-design.md), on the real daemon: the
 * suite's fake Claude Code runs in panes of a herdr server of the test's own (harness/herdrServer.ts), whose hooks carry
 * herdr's HERDR_PANE_ID and no app, and a `herdr` client attached to that server runs in a tab of a fake Terminal: a Node
 * under `$HOME/Applications/Terminal.app` of the daemon's throwaway home, whose Info.plist says `com.apple.Terminal`,
 * running the pseudo-terminal helper (harness/outsideAgent.ts). A fake dial on the desk lists them, and the test writes
 * the `front` and `tab` lines on the stdin of the real `harness hardware watch --json` and reads its `select` lines on its
 * stdout, as Harness Device does.
 *
 * Never the person's herdr, Terminal, daemon, ~/.claude or ~/.codex: no Harness Device runs, no window opens, the
 * daemon's `herdr` reaches the test's server alone, and its `open` is the harness's fake (HARNESS_OPEN_BIN), checked to
 * be inside the test's own root. A herdr of the person's may run on this Mac: the daemon's process table hides every
 * herdr outside the test's tree (ownHerdrsOnly), so its lookup never asks of them, and the test checks that from what
 * the table kept and dropped.
 *
 * macOS only, with herdr and `cc` installed: off macOS the lookup answers nothing.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { herdrBinary, othersNow, ownHerdrsOnly, PrivateHerdr } from './harness/herdrServer.js'
import { InOrca } from './harness/inOrca.js'
import { Outside } from './harness/outsideAgent.js'

const execFileAsync = promisify(execFile)

const TERMINAL = 'com.apple.Terminal'
const ORCA = 'com.stablyai.orca'
/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** The everyday daemon's port: a watch under test that reached it would take the stream from this Mac's Harness Device. */
const EVERYDAY_PORT = '18473'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

describe.skipIf(process.platform !== 'darwin' || !herdrBinary)("an agent in the person's herdr, on the page of the app that holds its client", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let server: PrivateHerdr | undefined
  const children: ChildProcess[] = []
  const closing: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    // The client, then herdr: its panes are the daemon's root's, and the daemon's close sweeps what names the root.
    for (const close of closing.splice(0)) await close()
    await server?.stop()
    await desk?.close()
    await daemon?.close()
    server = undefined
    daemon = undefined
    desk = undefined
  })

  /**
   * `harness hardware watch --json` as Harness Device runs it, under the daemon's environment only: it finds this
   * daemon's data folder and the devices' socket in it, never this Mac's. Terminal is in front from its first line.
   */
  const watch = (d: IsolatedDaemon) => {
    const env = { ...d.env, TMUX_PANE: '' }
    expect(env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
    expect(devicesListenerPath(d.dataDir, process.platform, env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
    expect(env.PORT).not.toBe(EVERYDAY_PORT)
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], { cwd: CLI_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    const printed: string[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => { printed.push(line) })
    const write = (value: unknown): void => { child.stdin!.write(`${JSON.stringify(value)}\n`) }
    const front = (bundle: string): void => write({ front: bundle })
    front(TERMINAL)
    return { front, tab: (tty: string): void => write({ tab: { app: 'terminal-app', tty } }), selects: () => printed.filter((line) => line.startsWith('{"select"')) }
  }

  /** The daemon's swipe lines, each from its `[device]` on. */
  const swipes = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[device] swipe ·')).map((line) => line.slice(line.indexOf('[device]')))
  const focused = async (herdr: PrivateHerdr, pane: string): Promise<boolean> =>
    ((await herdr.rpc('agent.get', { target: pane })).agent as { focused?: boolean }).focused === true

  /**
   * A daemon of its own whose process table holds no herdr but the test's, a dial that holds one app's ring shown its
   * first list, then a herdr server of the test's own with its client in a Terminal tab, and two hooked agents in its
   * panes, B to swipe from and the agent, each started once the client is attached, so its first hook finds it. Then the
   * watch, with Terminal in front.
   */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const hidden = ownHerdrsOnly(d)
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    // The open the daemon runs is the harness's fake in its root, never the real one.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)
    const others = othersNow()
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    // Pane ids with letters, as a person's herdr gives once a workspace has had nine panes: `w2:pE`, never `w1:p1` alone.
    const herdr = await PrivateHerdr.start(d, { lettered: true })
    server = herdr
    const client = await herdr.tabClient('terminal-app')
    closing.push(() => client.close())
    const b = await herdr.hooked('b')
    const agent = await herdr.hooked('in-herdr')
    for (const { pane } of [b, agent]) expect(pane).toMatch(/:p[0-9A-Z]*[A-Z]/)
    await herdr.report(b.pane, 'idle')
    await herdr.report(agent.pane, 'idle')
    for (const listed of [b, agent]) await dial.next((m) => m.t === 'agent' && m.id === listed.id, 45_000, `${listed.id} listed`)
    return { d, dial, herdr, client, b, agent, hidden, others, run: watch(d) }
  }

  /** The dial turns to B, then to the agent, again every 2 s until the watch prints [select]: the stream opens after
   *  `connected`, with no frame to wait on. */
  const swipedTo = async (dial: FakeDial, b: { id: string }, agent: { id: string }, run: ReturnType<typeof watch>, select: string) => {
    let before = 0
    await until('the select line', () => {
      if (run.selects().includes(select)) return true
      if (Date.now() - before < 2_000) return undefined
      dial.send({ t: 'focus', agentId: b.id })
      before = Date.now()
      dial.send({ t: 'focus', agentId: agent.id })
      return undefined
    }, 60_000, 50)
  }
  const selectOf = (tty: string): string => JSON.stringify({ select: { app: 'terminal-app', tty } })

  it("an agent in the person's herdr is on Terminal's page, one row each, and on no herdr page", async () => {
    const { d, dial, client, b, agent, hidden, others, herdr } = await fresh()
    const apps = (m: DialMessage) => m.apps as Array<{ id: string; count: number }>
    const frame = await until("Terminal's page holding both agents", () => {
      const last = dial.messages.filter((m) => m.t === 'apps').at(-1)
      return last && apps(last).some((a) => a.id === 'terminal-app' && a.count === 2) ? last : undefined
    }, 45_000, 100)
    expect(apps(frame).map((a) => a.id)).not.toContain('herdr')
    // Its ring's list, as the dial was last sent it: each agent once, and nothing else.
    const roster = await until('a list with both agents', () => {
      const begin = dial.messages.map((m) => m.t).lastIndexOf('agents.begin')
      const end = dial.messages.map((m) => m.t).lastIndexOf('agents.end')
      const rows = begin >= 0 && end > begin ? dial.messages.slice(begin, end).filter((m) => m.t === 'agent') : []
      return rows.some((m) => m.id === agent.id) && rows.some((m) => m.id === b.id) ? rows : undefined
    }, 45_000, 100)
    expect(roster.map((m) => m.id).sort()).toEqual([agent.id, b.id].sort())
    expect(d.log()).toContain('[device] herdr client · found')
    // The lookup saw the test's herdrs alone: the person's, there from start to end, were dropped from its table.
    const kept = hidden.kept()
    expect(kept).toEqual(expect.arrayContaining([herdr.pid, client.pid]))
    const now = othersNow()
    for (const pid of [...others, ...now]) expect(kept).not.toContain(pid)
    const dropped = hidden.dropped()
    for (const pid of others.filter((pid) => now.includes(pid))) expect(dropped).toContain(pid)
  })

  it("with Terminal in front a swipe selects the client's tab, then the agent's herdr pane", async () => {
    const { dial, herdr, client, b, agent, run } = await fresh()
    await swipedTo(dial, b, agent, run, selectOf(client.tty))
    await until("the agent's pane focused in herdr", () => focused(herdr, agent.pane), 30_000, 100)
    dial.send({ t: 'focus', agentId: b.id })
    await until("B's pane focused in herdr", () => focused(herdr, b.pane), 30_000, 100)
  })

  it('with another app in front a swipe changes nothing in herdr', async () => {
    const { d, dial, herdr, b, agent, run } = await fresh()
    // The person clicks B's pane, through the daemon's own herdr, which reaches the test's server alone.
    await execFileAsync(join(dirname(d.env.CLAUDE_PATH!), 'herdr'), ['agent', 'focus', b.pane], { env: d.env })
    await until("B's pane focused in herdr", () => focused(herdr, b.pane), 30_000, 100)
    // Then brings Orca forward: its ring, once Orca settled in front.
    const orca = new InOrca(d, 'o', children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
    await orca.hook('SessionStart', { source: 'startup' })
    const since = dial.messages.length
    run.front(ORCA)
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca', 45_000, "Orca's ring", since)
    // A turn to B, then to the agent, each a swipe the daemon ends with a line.
    const before = swipes(d).length
    dial.send({ t: 'focus', agentId: b.id })
    dial.send({ t: 'focus', agentId: agent.id })
    await until('both swipes ended', () => swipes(d).length >= before + 2, 30_000, 50)
    expect(await focused(herdr, b.pane)).toBe(true)
  })

  it("a tab line with the client's tty turns the dial to the agent heard from last", async () => {
    const { d, dial, herdr, client, agent, run } = await fresh()
    // The agent's turn: it is heard from after B.
    let since = dial.messages.length
    await herdr.type(agent.pane, 'hello')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === agent.id, 45_000, "the agent's turn done", since)
    // Another agent in a Terminal tab of its own, the dial on it.
    const other = await Outside.start(d, 'other', { __CFBundleIdentifier: TERMINAL })
    closing.unshift(() => other.close())
    await dial.next((m) => m.t === 'agent' && m.id === other.id, 45_000, 'the other listed')
    dial.send({ t: 'focus', agentId: other.id })
    since = dial.messages.length
    run.tab(client.tty)
    await dial.next((m) => m.t === 'focus' && m.agentId === agent.id, 30_000, "the agent's focus", since)
    await until('the tab line moved the dial', () => d.log().includes('[device] tab · moved'), 30_000, 50)
  })

  it("the daemon's log has no tty, pane id, config path or session id", async () => {
    const { d, dial, client, b, agent, run } = await fresh()
    await swipedTo(dial, b, agent, run, selectOf(client.tty))
    await until('the swipe ended', () => swipes(d).includes('[device] swipe · ok'), 30_000, 50)
    const log = d.log()
    expect(log).toContain('[device] herdr client · found')
    // A tty by its name alone too: `ttys012` with no `/dev/` before it names the tab as well.
    for (const secret of [client.tty.slice('/dev/'.length), b.pane, agent.pane, join(d.env.HOME!, '.config', 'herdr'), b.sessionId, agent.sessionId]) {
      expect(log).not.toContain(secret)
    }
  })
})
