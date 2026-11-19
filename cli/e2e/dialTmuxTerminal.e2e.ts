/**
 * Claude Code in a tmux session the person opened shows on the page of the app that holds the tmux client attached to
 * it, and a swipe reaches it there (docs/plans/2026-11-19-dial-tmux-terminal-design.md), on the real daemon: the engine
 * runs in a window of a session on the daemon's private tmux server (harness/ownTmux.ts), which a client attached from a
 * tab of a fake Terminal shows: a Node under `$HOME/Applications/Terminal.app` of the daemon's throwaway home, whose
 * Info.plist says `com.apple.Terminal`, running the pseudo-terminal helper that runs `tmux attach`
 * (harness/outsideAgent.ts). The pane has no bundle id, as on a server the daemon started. A fake dial on the desk lists
 * it, and the test writes the `front` lines on the stdin of the real `harness hardware watch --json` and reads its
 * `select` lines on its stdout, as Harness Device does.
 *
 * Never the person's tmux server, Terminal, daemon, ~/.claude or ~/.codex: no Harness Device runs, no window opens, and
 * the daemon's `open` is the harness's fake (HARNESS_OPEN_BIN), checked to be inside the test's own root.
 *
 * macOS only: off macOS no agent has a tab.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'
import { Outside } from './harness/outsideAgent.js'
import { InOwnTmux, tabClient } from './harness/ownTmux.js'

const TERMINAL = 'com.apple.Terminal'
const ORCA = 'com.stablyai.orca'
/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** The person's own session: never one Harness names. */
const SESSION = 'own-work'
/** The everyday daemon's port: a watch under test that reached it would take the stream from this Mac's Harness Device. */
const EVERYDAY_PORT = '18473'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

describe.skipIf(process.platform !== 'darwin')("an agent in the person's tmux, on the page of the app that holds its client", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  const closing: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const close of closing.splice(0)) await close()
    await desk?.close()
    await daemon?.close()
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
    const front = (bundle: string): void => { child.stdin!.write(`${JSON.stringify({ front: bundle })}\n`) }
    front(TERMINAL)
    return { front, selects: () => printed.filter((line) => line.startsWith('{"select"')) }
  }

  /** The daemon's swipe lines, each from its `[device]` on. */
  const swipes = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[device] swipe ·')).map((line) => line.slice(line.indexOf('[device]')))
  /** The active pane of the person's session. */
  const active = (d: IsolatedDaemon): Promise<string> => d.tmux.run('display-message', '-p', '-t', SESSION, '#{pane_id}')

  /**
   * A daemon of its own, a dial that holds one app's ring shown its first list, B in a Terminal tab to swipe from, and the
   * person's session: its first window a shell, attached from a Terminal tab, then the agent in a second window made in
   * the background, so its first hook finds that client. Then the watch, with Terminal in front.
   */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    // The open the daemon runs is the harness's fake in its root, never the real one.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const b = await Outside.start(d, 'b', { __CFBundleIdentifier: TERMINAL })
    closing.push(() => b.close())
    await dial.next((m) => m.t === 'agent' && m.id === b.id, 45_000, 'b listed')
    await d.tmux.run('new-session', '-d', '-s', SESSION, '-c', d.projectsDir, '/bin/sh')
    const client = await tabClient(d, SESSION, 'terminal-app')
    // Before the server goes with the daemon.
    closing.unshift(() => client.close())
    const shell = await active(d)
    const agent = await InOwnTmux.startIn(d, SESSION, 'in-tmux')
    return { d, dial, b, client, shell, agent, run: watch(d) }
  }

  /** The dial turns to B, then to the agent, again every 2 s until the watch prints [select]: the stream opens after
   *  `connected`, with no frame to wait on. */
  const swipedTo = async (dial: FakeDial, b: Outside, agent: InOwnTmux, run: ReturnType<typeof watch>, select: string) => {
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

  it("an agent in the person's tmux is on Terminal's page, one row, and on no tmux page", async () => {
    const { d, dial, agent } = await fresh()
    const apps = (m: DialMessage) => m.apps as Array<{ id: string; count: number }>
    const frame = await until("Terminal's page holding both agents", () => {
      const last = dial.messages.filter((m) => m.t === 'apps').at(-1)
      return last && apps(last).some((a) => a.id === 'terminal-app' && a.count === 2) ? last : undefined
    }, 45_000, 100)
    expect(apps(frame).map((a) => a.id)).not.toContain('tmux')
    // Its ring's list, as the dial was last sent it: the agent once.
    const roster = await until('a list with the agent', () => {
      const begin = dial.messages.map((m) => m.t).lastIndexOf('agents.begin')
      const end = dial.messages.map((m) => m.t).lastIndexOf('agents.end')
      const rows = begin >= 0 && end > begin ? dial.messages.slice(begin, end).filter((m) => m.t === 'agent') : []
      return rows.some((m) => m.id === agent.id) ? rows : undefined
    }, 45_000, 100)
    expect(roster.filter((m) => m.id === agent.id)).toHaveLength(1)
    expect(d.log()).toContain('[device] tmux client · found')
  })

  it("with Terminal in front a swipe selects the client's tab, then the agent's pane", async () => {
    const { d, dial, b, client, agent, run } = await fresh()
    await swipedTo(dial, b, agent, run, selectOf(await client.tty()))
    await until("the agent's pane active in the person's session", async () => (await active(d)) === agent.pane, 30_000, 50)
  })

  it('with another app in front a swipe changes nothing in tmux', async () => {
    const { d, dial, b, client, shell, agent, run } = await fresh()
    await swipedTo(dial, b, agent, run, selectOf(await client.tty()))
    await until("the agent's pane active in the person's session", async () => (await active(d)) === agent.pane, 30_000, 50)
    // The person goes back to the shell's window, then brings Orca forward: its ring, once Orca settled in front.
    await d.tmux.run('select-window', '-t', `${SESSION}:0`)
    expect(await active(d)).toBe(shell)
    const orca = new InOrca(d, 'o', children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
    await orca.hook('SessionStart', { source: 'startup' })
    const since = dial.messages.length
    run.front(ORCA)
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca', 45_000, "Orca's ring", since)
    // The dial was on the agent: a turn to B, then back, each a swipe the daemon ends with a line.
    const before = swipes(d).length
    dial.send({ t: 'focus', agentId: b.id })
    dial.send({ t: 'focus', agentId: agent.id })
    await until('both swipes ended', () => swipes(d).length >= before + 2, 30_000, 50)
    expect(await active(d)).toBe(shell)
  })

  it("the daemon's log has no tty, pane id, session name or session id", async () => {
    const { d, dial, b, client, agent, run } = await fresh()
    const tty = await client.tty()
    await swipedTo(dial, b, agent, run, selectOf(tty))
    await until('the swipe ended', () => swipes(d).includes('[device] swipe · ok'), 30_000, 50)
    const log = d.log()
    expect(log).toContain('[device] tmux client · found')
    // A tty by its name alone too: `ttys012` with no `/dev/` before it names the tab as well.
    for (const secret of [tty.slice('/dev/'.length), agent.pane, SESSION, agent.sessionId, b.sessionId]) expect(log).not.toContain(secret)
  })
})
