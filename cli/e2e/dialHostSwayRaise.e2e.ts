/**
 * A tap on the dial brings an agent's window forward on sway (docs/plans/2026-11-19-dial-linux-design.md § 2.3), on
 * the real daemon: a headless sway of the test's own (harness/swayDesk.ts) shows the suite's hooked fake Claude Code in
 * a foot window and a shell in another, focused; the fake dial's tap focuses the agent's. The daemon finds that sway
 * from its runtime folder alone, as after a login whose session exported no SWAYSOCK, and from SWAYSOCK alone.
 *
 * Skipped where sway or foot is not installed. CI's `e2e (dial hosts)` job installs them, and there a missing one fails
 * the file (harness/dialHosts.ts). No `swaymsg` the daemon runs reaches any other sway.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { PrivateSway, swayInstalled } from './harness/swayDesk.js'

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

describe.skipIf(!swayInstalled)("a tap focuses the agent's window on sway", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let sway: PrivateSway | undefined
  afterEach(async () => {
    // sway first: its windows hold the daemon's engine.
    await sway?.stop()
    await desk?.close()
    await daemon?.close()
    sway = undefined
    desk = undefined
    daemon = undefined
  })

  const tapFocuses = async (found: 'XDG_RUNTIME_DIR' | 'SWAYSOCK') => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    const desktop = await PrivateSway.start(d)
    sway = desktop
    // One way to the sway, never both: the other is left unset.
    if (found === 'XDG_RUNTIME_DIR') d.env.XDG_RUNTIME_DIR = desktop.runtimeDir
    else d.env.SWAYSOCK = desktop.socket
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
      console.log(`---- sway's log\n${desktop.log().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0b')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    await said(d, '[device] raise · sway')

    // 1. The fake Claude Code in a foot window, then a shell's foot, which sway focuses.
    const agent = await desktop.terminal('api')
    const sessionId = await until('its SessionStart hook to run',
      () => d.hookLog().match(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/)?.[1], 30_000, 100)
    const id = observedAgentId('claude', sessionId)
    await showing(dial, 'the hooked agent listed, able to be brought forward',
      (rows) => rows.some((r) => r.id === id && String(r.caps).includes('f')))
    const other = await desktop.shell()
    expect(await desktop.focused()).toBe(other)

    // 2. A tap focuses the agent's foot through `swaymsg [pid=…] focus`.
    const since = dial.messages.length
    dial.send({ t: 'agent.open', agentId: id })
    await until("the agent's window focused", async () => await desktop.focused() === agent, 30_000, 100)
    // The opener answered true: the dial turns to the agent, and no toast says it did not open.
    await dial.next((m) => m.t === 'focus' && m.agentId === id, 30_000, 'the focus on the agent', since)
    expect(dial.messages.slice(since).filter((m) => m.t === 'toast')).toEqual([])
  }

  it('a daemon given only its runtime folder finds sway there, and a tap focuses the agent\'s foot', () => tapFocuses('XDG_RUNTIME_DIR'))

  it("a daemon given only SWAYSOCK finds sway by it, and a tap focuses the agent's foot", () => tapFocuses('SWAYSOCK'))
})
