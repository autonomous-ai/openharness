/**
 * A tap on the dial brings the agent's window forward on an X11 desktop (docs/plans/2026-11-19-dial-linux-design.md
 * § 2), on the real daemon: an X11 desktop of the test's own (harness/x11Desk.ts) runs the suite's hooked fake Claude
 * Code in an xterm, another xterm in front of it, and a fake dial on the desk taps the agent. The daemon finds the
 * display from its DISPLAY, or with none from the X server's socket in /tmp/.X11-unix, as one started before the
 * session exported it would.
 *
 * Skipped where the X11 programs are not installed, and off Linux; the case with neither variable also where an X server
 * of the developer's holds a lower display. CI's `e2e (dial hosts)` job installs them, and there a missing one fails the
 * file (harness/dialHosts.ts), and a lower display the case.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed, type TestContext } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { X11Desk, x11Installed } from './harness/x11Desk.js'

/** The last list the dial was sent, its rows between `agents.begin` and `agents.end`, once it passes [test]. */
const showing = (dial: FakeDial, what: string, test: (rows: DialMessage[]) => boolean): Promise<DialMessage[]> =>
  until(what, () => {
    let rows: DialMessage[] | null = null
    let last: DialMessage[] | null = null
    for (const m of dial.messages) {
      if (m.t === 'agents.begin') rows = []
      else if (m.t === 'agent' && rows) rows.push(m)
      else if (m.t === 'agents.end' && rows) { last = rows; rows = null }
    }
    return last && test(last) ? last : null
  }, 45_000, 100)
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)

describe.skipIf(!x11Installed)("a tap raises the agent's window on X11", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let x11: X11Desk | undefined
  afterEach(async () => {
    // The X11 desk first: its xterms hold the daemon's engines.
    await x11?.stop()
    await desk?.close()
    await daemon?.close()
    x11 = undefined
    desk = undefined
    daemon = undefined
  })

  /** A daemon on its own X11 desk, given its DISPLAY and XAUTHORITY when [exported], with a dial attached; then the tap. */
  async function tapRaises(exported: boolean, context: TestContext): Promise<void> {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    // Up before the daemon: its raise looks for the desktop as it starts.
    const x = await X11Desk.start(d)
    x11 = x
    // With neither, the daemon takes the lowest X server of root's or this account's: one below the desk's is the
    // developer's own display, where the tap must never raise a window. A dial-hosts runner has none.
    if (!exported && x.serverBelow()) {
      if (process.env.E2E_DIAL_HOSTS === '1') throw new Error(`an X server holds a display below ${x.display} on a dial-hosts run`)
      context.skip(`an X server of this account's or root's holds a display below ${x.display}`)
    }
    if (exported) Object.assign(d.env, { DISPLAY: x.display, XAUTHORITY: x.xauthority })
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    await said(d, '[device] raise · x11')

    // 1. The agent's xterm, then another, which openbox puts in front.
    const agent = await x.terminal('api')
    const other = await x.terminal('web')
    await until('the other xterm active', async () => await x.active() === other.window, 20_000, 100)
    const sessionId = await until("the agent's SessionStart hook to run",
      () => d.hookLog().match(new RegExp(`claude pid=${agent.pid} SessionStart\\(startup\\) session=(\\S+) ran`))?.[1], 30_000, 100)
    const id = observedAgentId('claude', sessionId)
    await showing(dial, 'the agent listed', (rows) => rows.some((r) => r.id === id))

    // 2. The tap raises the agent's xterm through wmctrl.
    const since = dial.messages.length
    dial.send({ t: 'agent.open', agentId: id })
    await until("the agent's xterm active", async () => await x.active() === agent.window, 30_000, 100)
    // The opener answered true: the dial turns to the agent, and no toast says it did not open.
    await dial.next((m) => m.t === 'focus' && m.agentId === id, 30_000, 'the focus on the agent', since)
    expect(dial.messages.slice(since).filter((m) => m.t === 'toast')).toEqual([])
  }

  it('with the DISPLAY and XAUTHORITY the session exported', (context) => tapRaises(true, context))

  it('with neither, from the X server socket and ~/.Xauthority', (context) => tapRaises(false, context))
})
