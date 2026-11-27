/**
 * The dial and the terminal apps follow each other, tab by tab (docs/specs/2026-11-15-dial-terminal-follow.md), on the
 * real daemon: Claude Code runs on a pseudo-terminal of its own (harness/outsideAgent.ts) with Terminal's bundle id in its
 * hook environment, so `ps` gives it a real tty, and a fake dial on the desk turns to it. The real Terminal is never
 * asked anything: no Harness Device runs, and the test writes the `front` and `tab` lines on the stdin of the real
 * `harness hardware watch --json` and reads its `select` lines on its stdout, as Harness Device does.
 *
 * macOS only: off macOS the daemon gives no agent a tab.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'
import { Outside } from './harness/outsideAgent.js'

/** Node may fire the 400 ms rest's timer a millisecond early; the exact 400 is cableSession.spec.ts's, on a fake clock. */
const REST_AT_LEAST_MS = 395
const TERMINAL = 'com.apple.Terminal'
/** The everyday daemon's port: a watch under test that reached it would take the stream from this Mac's Harness Device. */
const EVERYDAY_PORT = '18473'
/** A tty no agent of a throwaway daemon holds. */
const NO_AGENT_TTY = '/dev/ttys9999'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** The name of [pid]'s terminal, as `ps` gives it, and its tty as the daemon reads it. */
const ttyName = (pid: number): string => execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim()
const ttyOf = (pid: number): string => `/dev/${ttyName(pid)}`

describe.skipIf(process.platform !== 'darwin')('the dial and the terminal apps follow each other', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  const outside: Outside[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** The daemon's lines that start with [prefix], each from its `[device]` on. */
  const lines = (d: IsolatedDaemon, prefix: string): string[] =>
    d.log().split('\n').filter((line) => line.includes(prefix)).map((line) => line.slice(line.indexOf('[device]')))
  const said = (d: IsolatedDaemon, line: string): Promise<true> =>
    until(`"${line}" in the daemon's log`, () => d.log().includes(line), 30_000, 50)

  /**
   * `harness hardware watch --json` as Harness Device runs it, under the daemon's environment only: it finds this
   * daemon's data folder and the devices' socket in it, never this Mac's, so it can never take the tabs stream from a
   * real Harness Device's watch. Terminal is in front from its first line. Each stdout line is kept with when it came.
   */
  const watch = (d: IsolatedDaemon) => {
    const env = { ...d.env, TMUX_PANE: '' }
    expect(env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
    expect(devicesListenerPath(d.dataDir, process.platform, env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
    expect(env.PORT).not.toBe(EVERYDAY_PORT)
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], { cwd: CLI_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    const printed: Array<{ line: string; at: number }> = []
    createInterface({ input: child.stdout! }).on('line', (line) => { printed.push({ line, at: Date.now() }) })
    const write = (value: unknown): void => { child.stdin!.write(`${JSON.stringify(value)}\n`) }
    write({ front: TERMINAL })
    return {
      tab: (tty: string): void => write({ tab: { app: 'terminal-app', tty } }),
      selects: () => printed.filter(({ line }) => line.startsWith('{"select"')),
    }
  }

  /**
   * A daemon of its own, a dial with no appFilter (one ring holds every agent) shown its first list, and three agents
   * listed on it: A and B in Terminal tabs, W in WezTerm with no pane. Then the watch, with Terminal in front.
   */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const inTerminal = async (folder: string): Promise<Outside> => {
      const engine = await Outside.start(d, folder, { __CFBundleIdentifier: TERMINAL })
      outside.push(engine)
      await dial.next((m) => m.t === 'agent' && m.id === engine.id, 45_000, `${folder} listed`)
      return engine
    }
    const a = await inTerminal('a')
    const b = await inTerminal('b')
    const w = new InOrca(d, 'w', children, { WEZTERM_PANE: '7' })
    await w.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'agent' && m.id === w.id, 45_000, 'w listed')
    return { d, dial, a, b, w, run: watch(d) }
  }

  /** The dial turns to W, then to A, again every 2 s until the watch prints A's select: the stream opens after
   *  `connected`, with no frame to wait on. Looked for every 50 ms, so the select's 2 s echo window is still open when
   *  it is found. When the turn to A that printed it was sent, and the line. */
  const swipedTo = async (dial: FakeDial, w: InOrca, a: Outside, run: ReturnType<typeof watch>) => {
    let before = 0
    const select = await until("A's select line", () => {
      const [line] = run.selects()
      if (line) return line
      if (Date.now() - before < 2_000) return undefined
      dial.send({ t: 'focus', agentId: w.id })
      before = Date.now()
      dial.send({ t: 'focus', agentId: a.id })
      return undefined
    }, 60_000, 50)
    return { before, select }
  }

  it('a tab line with an agent\'s tty moves the dial to it', async () => {
    const { d, dial, a, b, run } = await fresh()
    dial.send({ t: 'focus', agentId: a.id })
    const since = dial.messages.length
    // The report waits for Terminal's settle by itself: nothing is retried.
    run.tab(ttyOf(b.pid))
    await dial.next((m) => m.t === 'focus' && m.agentId === b.id, 30_000, "B's focus", since)
    await said(d, '[device] tab · moved')
  })

  it('a tty of no agent does not', async () => {
    const { d, dial, a, run } = await fresh()
    const since = dial.messages.length
    run.tab(NO_AGENT_TTY)
    await said(d, '[device] tab · skipped · unknown agent')
    // The dial landed on A as it was listed, and each push re-asserts A, here or late from the list `fresh` waited on: a
    // move would name another agent.
    expect(dial.messages.slice(since).filter((m) => m.t === 'focus' && m.agentId !== a.id)).toEqual([])
  })

  it('a swipe that rests on an agent prints one select line after at least 395 ms, and the report that echoes it does not move the dial', async () => {
    const { d, dial, a, w, run } = await fresh()
    const tty = ttyOf(a.pid)
    const { before, select } = await swipedTo(dial, w, a, run)
    expect(select.line).toBe(JSON.stringify({ select: { app: 'terminal-app', tty } }))
    expect(select.at - before).toBeGreaterThanOrEqual(REST_AT_LEAST_MS)
    expect(run.selects()).toHaveLength(1)
    await said(d, '[device] swipe · ok')

    dial.send({ t: 'focus', agentId: w.id })
    const since = dial.messages.length
    run.tab(tty)
    await said(d, '[device] tab · skipped · echo')
    expect(dial.messages.slice(since).filter((m) => m.t === 'focus' && m.agentId === a.id)).toEqual([])
  })

  it("the daemon's log has no tty, no bundle id and no session id", async () => {
    const { d, dial, a, b, w, run } = await fresh()
    await swipedTo(dial, w, a, run)
    await said(d, '[device] swipe · ok')
    run.tab(ttyOf(b.pid))
    await said(d, '[device] tab · moved')
    run.tab(NO_AGENT_TTY)
    await said(d, '[device] tab · skipped · unknown agent')
    expect(lines(d, '[device] tab').every((line) => /^\[device\] tab · (moved|skipped · (no tile|echo|unknown agent|not in front))$/.test(line))).toBe(true)
    const log = d.log()
    // A tty by its name alone too: `ttys012` with no `/dev/` before it names the tab as well.
    for (const secret of [ttyName(a.pid), ttyName(b.pid), 'ttys9999', TERMINAL, a.sessionId, b.sessionId, w.sessionId]) {
      expect(log).not.toContain(secret)
    }
  })
})
