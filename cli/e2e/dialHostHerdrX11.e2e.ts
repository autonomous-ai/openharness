/**
 * An agent in a herdr pane whose client runs in a terminal with no page of its own stays on its pane's page, and a tap
 * brings that terminal's window forward (docs/plans/2026-11-21-dial-linux-followups-design.md § 2), on the real daemon:
 * herdr's client attached to a herdr server of the test's own (harness/herdrServer.ts) runs in an xterm on an X11
 * desktop of the test's own (harness/x11Desk.ts), another xterm in front of it, and the suite's hooked fake Claude Code
 * in a herdr pane. A fake dial on the desk taps the agent: the raise finds the window by the client's process, and herdr
 * focuses the agent's pane. No `herdr` the daemon runs reaches the developer's, and the daemon's process table hides
 * every herdr outside the test's tree (ownHerdrsOnly).
 *
 * Skipped where herdr (or the cc that builds its agent) or the X11 programs are not installed, and off Linux; CI's
 * `e2e (dial hosts)` job installs them, and there a missing one fails the file (harness/dialHosts.ts).
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage } from './harness/fakeDial.js'
import { herdrBinary, ownHerdrsOnly, PrivateHerdr } from './harness/herdrServer.js'
import { X11Desk, x11Installed } from './harness/x11Desk.js'

const execFileAsync = promisify(execFile)

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }

/** The daemon's lines that start with [prefix], each from its `[device]` on. */
const lines = (d: IsolatedDaemon, prefix: string): string[] =>
  d.log().split('\n').filter((line) => line.includes(prefix)).map((line) => line.slice(line.indexOf('[device]')))
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => lines(d, line).includes(line), 30_000, 50)

describe.skipIf(!herdrBinary || !x11Installed)("herdr's client in an xterm", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let herdr: PrivateHerdr | undefined
  let x11: X11Desk | undefined
  afterEach(async () => {
    // The xterms first, then herdr: its panes hold the daemon's engine, and the daemon's close sweeps what names its
    // root.
    await x11?.stop()
    await herdr?.stop()
    await desk?.close()
    await daemon?.close()
    x11 = undefined
    herdr = undefined
    desk = undefined
    daemon = undefined
  })

  it("keeps the agent on its herdr pane's page, and a tap raises the client's xterm and focuses the agent's pane", async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    ownHerdrsOnly(d)
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    // Up before the daemon: its raise looks for the desktop as it starts.
    const x = await X11Desk.start(d)
    x11 = x
    Object.assign(d.env, { DISPLAY: x.display, XAUTHORITY: x.xauthority })
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    await said(d, '[device] raise · x11')

    // 1. herdr's client in an xterm, then another xterm, which openbox puts in front.
    const server = await PrivateHerdr.start(d)
    herdr = server
    const client = await server.client((argv, env) => x.terminal('client', argv, env))
    const other = await x.terminal('web', ['/bin/cat'])
    await until('the other xterm active', async () => await x.active() === other.window, 20_000, 100)

    // 2. The hooked agent in a herdr pane, started once the client is attached, so its first lookup finds it. xterm is
    // no app the dial lists: the client's place is its process alone, and the agent stays on the page herdr's pane
    // gives it, as with no client. That pane says TERM_PROGRAM=herdr, which names no app, and no app is among its
    // parents: Other's (herdr 0.9.5).
    const agent = await server.hooked('api')
    await said(d, '[device] herdr client · none')
    const apps = (m: DialMessage) => m.apps as Array<{ id: string; count: number }>
    const frame = await until("herdr's pane's page holding the agent", () => {
      const last = dial.messages.filter((m) => m.t === 'apps').at(-1)
      return last && apps(last).some((a) => a.id === 'terminal' && a.count === 1) ? last : undefined
    }, 45_000, 100)
    expect(apps(frame).filter((a) => a.count > 0)).toEqual([expect.objectContaining({ id: 'terminal', count: 1 })])
    await dial.next((m) => m.t === 'agent' && m.id === agent.id && m.host === 'herdr', 45_000, 'the agent listed')
    expect(lines(d, '[device] herdr client · found')).toEqual([])
    // herdr focuses only an agent it has seen, and its detection lags the hook by a moment (herdr 0.9.5).
    await until('herdr to see the agent', async () => {
      const read = await server.rpc('agent.get', { target: agent.pane }).catch(() => undefined)
      return (read?.agent as { agent_status?: string } | undefined)?.agent_status === 'idle'
    }, 30_000, 100)
    expect(await server.focused()).not.toBe(agent.pane)

    // 3. The tap raises the client's xterm by the client's process, and herdr focuses the agent's pane.
    const since = dial.messages.length
    dial.send({ t: 'agent.open', agentId: agent.id })
    await until("the client's xterm active", async () => await x.active() === client.window, 30_000, 100)
    await until("the agent's pane focused in herdr", async () => await server.focused() === agent.pane, 30_000, 100)
    // The opener answered true: the dial turns to the agent, and no toast says it did not open.
    await dial.next((m) => m.t === 'focus' && m.agentId === agent.id, 30_000, 'the focus on the agent', since)
    expect(dial.messages.slice(since).filter((m) => m.t === 'toast')).toEqual([])

    // 4. No folder, session, pane, tty or config folder of the case's in the daemon's log.
    const tty = (await execFileAsync('/bin/ps', ['-o', 'tty=', '-p', String(client.pid)])).stdout.trim()
    expect(tty).toMatch(/^pts\/[0-9]+$/)
    for (const secret of [join(d.projectsDir, 'api'), agent.sessionId, agent.pane, tty, join(d.env.HOME!, '.config', 'herdr')]) {
      expect(d.log()).not.toContain(secret)
    }
  })
})
