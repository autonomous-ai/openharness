/**
 * Claude Code in a tmux session the person opened is on tmux's page, seen in the app that holds the tmux client attached
 * to it, and a swipe reaches it there (docs/plans/2026-11-19-dial-tmux-terminal-design.md,
 * docs/plans/2026-11-23-dial-tmux-herdr-apps-design.md), on the real daemon: the engine
 * runs in a window of a session on the daemon's private tmux server (harness/ownTmux.ts), which a client attached from a
 * tab of a fake Terminal shows: a Node under `$HOME/Applications/Terminal.app` of the daemon's throwaway home, whose
 * Info.plist says `com.apple.Terminal`, running the pseudo-terminal helper that runs `tmux attach`
 * (harness/outsideAgent.ts). The pane has no bundle id, as on a server the daemon started. A fake dial on the desk lists
 * it, and the test writes the `front` lines on the stdin of the real `harness hardware watch --json` and reads its
 * `select` lines on its stdout, as Harness Device does.
 *
 * And an agent idle in such a session when the devices start again, which only the open scan finds
 * (docs/plans/2026-11-22-dial-iterm2-tmux-herdr-design.md): its client in a tab of a fake iTerm2 server, a Node at
 * `$HOME/Library/Application Support/iTerm2/iTermServer-3.6.6` of the daemon's throwaway home that launchd adopted.
 *
 * Never the person's tmux server, Terminal, iTerm2, daemon, ~/.claude or ~/.codex: no Harness Device runs, no window
 * opens, and the daemon's `open` is the harness's fake (HARNESS_OPEN_BIN), checked to be inside the test's own root.
 *
 * macOS only: off macOS no agent has a tab.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { UNKNOWN_APP } from '../src/cable/hosts/hostDetect.js'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'
import { Outside } from './harness/outsideAgent.js'
import { InOwnTmux, tabClient } from './harness/ownTmux.js'

const TERMINAL = 'com.apple.Terminal'
const ITERM = 'com.googlecode.iterm2'
const ORCA = 'com.stablyai.orca'
/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
/** The person's own session: never one Harness names. */
const SESSION = 'own-work'
/** The everyday daemon's port: a watch under test that reached it would take the stream from this Mac's Harness Device. */
const EVERYDAY_PORT = '18473'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

describe.skipIf(process.platform !== 'darwin')("an agent in the person's tmux, on tmux's page, seen in the app that holds its client", () => {
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
    const write = (value: unknown): void => { child.stdin!.write(`${JSON.stringify(value)}\n`) }
    const front = (bundle: string): void => write({ front: bundle })
    front(TERMINAL)
    return { front, tab: (tty: string): void => write({ tab: { app: 'terminal-app', tty } }), selects: () => printed.filter((line) => line.startsWith('{"select"')) }
  }

  /** The daemon's swipe lines, each from its `[device]` on. */
  const swipes = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[device] swipe ·')).map((line) => line.slice(line.indexOf('[device]')))
  /** The active pane of the person's session. */
  const active = (d: IsolatedDaemon): Promise<string> => d.tmux.run('display-message', '-p', '-t', SESSION, '#{pane_id}')

  /** A daemon of its own, with an empty desk and Claude Code's hooks in. */
  const started = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    // The open the daemon runs is the harness's fake in its root, never the real one.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    return { d, desk: theDesk }
  }

  /**
   * A daemon of its own, a dial that holds one app's ring shown its first list, B in a Terminal tab to swipe from, and the
   * person's session: its first window a shell, attached from a Terminal tab, then the agent in a second window made in
   * the background, so its first hook finds that client. Then the watch, with Terminal in front.
   */
  const fresh = async () => {
    const { d, desk } = await started()
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

  /**
   * The devices starting again while the agent is idle (Diego's report of 2026-11-22): the person's session, attached
   * from a tab under iTerm2's server, which launchd adopted, and the agent in it with a turn behind it, all before the
   * dial is plugged. No device yet, so no devices process: its hooks reach nobody, and only the open scan the dial's
   * attach runs finds it.
   */
  const foundByScan = async () => {
    const { d, desk } = await started()
    await d.tmux.run('new-session', '-d', '-s', SESSION, '-c', d.projectsDir, '/bin/sh')
    const client = await tabClient(d, SESSION, 'iterm-server')
    // Before the server goes with the daemon.
    closing.unshift(() => client.close())
    const agent = await InOwnTmux.startIn(d, SESSION, 'in-tmux')
    // A turn, so its conversation is on disk for the scan to list.
    await agent.type('before the dial')
    const stopped = new RegExp(`claude pid=\\d+ Stop\\S* session=${agent.sessionId} ran`)
    await until('its Stop hook to run', () => stopped.test(d.hookLog()), 30_000, 100)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    return { d, dial, client, agent }
  }
  const appsOf = (m: DialMessage) => m.apps as Array<{ id: string; count: number }>
  /** The last apps frame, once it holds [app]'s page with [count] agents. */
  const pageOf = (dial: FakeDial, what: string, app: string, count: number): Promise<DialMessage> =>
    until(what, () => {
      const last = dial.messages.filter((m) => m.t === 'apps').at(-1)
      return last && appsOf(last).some((a) => a.id === app && a.count === count) ? last : undefined
    }, 45_000, 100)
  /** Its ring's list, as the dial was last sent it, once it holds [agent]; [meanwhile] runs at each look. */
  const rosterWith = (dial: FakeDial, agent: InOwnTmux, meanwhile = (): void => {}): Promise<DialMessage[]> =>
    until('a list with the agent', () => {
      const begin = dial.messages.map((m) => m.t).lastIndexOf('agents.begin')
      const end = dial.messages.map((m) => m.t).lastIndexOf('agents.end')
      const rows = begin >= 0 && end > begin ? dial.messages.slice(begin, end).filter((m) => m.t === 'agent') : []
      if (rows.some((m) => m.id === agent.id)) return rows
      meanwhile()
      return undefined
    }, 45_000, 100)
  /** Neither the tab's tty, by its name alone too (`ttys012` names the tab as well), nor a pane, the person's session's
   *  name or a session id is in the daemon's log. */
  const unsaid = (d: IsolatedDaemon, tty: string, agent: InOwnTmux, ...others: Outside[]): void => {
    const log = d.log()
    for (const secret of [tty.slice('/dev/'.length), agent.pane, SESSION, agent.sessionId, ...others.map((o) => o.sessionId)]) {
      expect(log).not.toContain(secret)
    }
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
  const selectOf = (tty: string, app = 'terminal-app'): string => JSON.stringify({ select: { app, tty } })

  it("an agent in the person's tmux is on tmux's page, one row, and Terminal's page holds B alone", async () => {
    const { d, dial, agent } = await fresh()
    const frame = await pageOf(dial, "tmux's page holding the agent", 'tmux', 1)
    expect(appsOf(frame)).toContainEqual(expect.objectContaining({ id: 'terminal-app', count: 1 }))
    // Terminal settling in front ends a pick made before it (another app settled), so the pick is made again every 2 s
    // until tmux's ring is listed, as a person picks again.
    let picked = 0
    const roster = await rosterWith(dial, agent, () => {
      if (Date.now() - picked < 2_000) return
      dial.pick('tmux')
      picked = Date.now()
    })
    expect(roster.filter((m) => m.id === agent.id)).toHaveLength(1)
    expect(d.log()).toContain('[device] tmux client · found')
  })

  it("found by the scan after the devices start, an agent in the person's tmux whose client is in an iTerm2 tab is on tmux's page, one row, with no iTerm2 or Other page", async () => {
    const { d, dial, client, agent } = await foundByScan()
    const frame = await pageOf(dial, "tmux's page holding the agent", 'tmux', 1)
    // iTerm2 holds no agent of its own (Diego's decision 2, 2026-11-23).
    expect(appsOf(frame).map((a) => a.id)).not.toContain('iterm')
    expect(appsOf(frame).map((a) => a.id)).not.toContain(UNKNOWN_APP)
    expect((await rosterWith(dial, agent)).filter((m) => m.id === agent.id)).toHaveLength(1)
    // Said once the lookups settled, a moment after the place reached the dial.
    await until('the scan line', () => /\[observed\] scan · 1 found · .* · 1 nested placed/.test(d.log()), 30_000, 50)
    expect(d.log()).toContain('[device] tmux client · found')
    unsaid(d, await client.tty(), agent)
  })

  it("found by the scan, with iTerm2 in front a swipe selects the client's tab, then the agent's pane", async () => {
    const { d, dial, client, agent } = await foundByScan()
    await pageOf(dial, "tmux's page holding the agent", 'tmux', 1)
    // iTerm2 in front before B starts: the dial lists the ring of one page alone, and shows iTerm2's once it settles
    // there with B, whatever its default showed.
    const run = watch(d)
    run.front(ITERM)
    // After the scan, so it found the agent alone; in iTerm2 too, so B is on iTerm2's page.
    const b = await Outside.start(d, 'b', { __CFBundleIdentifier: ITERM })
    closing.push(() => b.close())
    await dial.next((m) => m.t === 'agent' && m.id === b.id, 45_000, 'b listed')
    const tty = await client.tty()
    await swipedTo(dial, b, agent, run, selectOf(tty, 'iterm'))
    await until("the agent's pane active in the person's session", async () => (await active(d)) === agent.pane, 30_000, 50)
    unsaid(d, tty, agent, b)
  })

  it("with Terminal in front a swipe selects the client's tab, then the agent's pane", async () => {
    const { d, dial, b, client, agent, run } = await fresh()
    await swipedTo(dial, b, agent, run, selectOf(await client.tty()))
    await until("the agent's pane active in the person's session", async () => (await active(d)) === agent.pane, 30_000, 50)
  })

  it("selecting the client's tab while Terminal comes to the front, before it settles, turns the dial to tmux's page and its agent", async () => {
    const { d, dial, b, client, agent, run } = await fresh()
    // B is Terminal's own agent, so Terminal has a page to settle on.
    await dial.next((m) => m.t === 'apps' && m.shown === 'terminal-app', 45_000, "Terminal's page")
    const since = dial.messages.length
    const tty = await client.tty()
    run.tab(tty)
    await dial.next((m) => m.t === 'apps' && m.shown === 'tmux', 30_000, "tmux's page", since)
    await dial.next((m) => m.t === 'focus' && m.agentId === agent.id, 30_000, "the agent's focus", since)
    await until('the tab line moved the dial', () => d.log().includes('[device] tab · moved'), 30_000, 50)
    expect(d.log().split('\n').filter((line) => line.includes('[device] app filter: switched · follow'))).toHaveLength(1)
    unsaid(d, tty, agent, b)
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
    expect(d.log()).toContain('[device] tmux client · found')
    unsaid(d, tty, agent, b)
  })
})
