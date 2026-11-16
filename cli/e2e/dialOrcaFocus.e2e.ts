/**
 * The dial follows the pane focused in Orca, and Orca's ring follows Orca's tabs
 * (docs/plans/2026-11-16-dial-orca-focus-order-design.md), on the real daemon: Claude Code in Orca terminals tells its
 * terminal's handle through its own hooks (harness/inOrca.ts), and a fake `orca`, first on the daemon's PATH, prints the
 * layout and the focus lines a test tells it, with or without `watch-focus`. The real Orca never runs. The app in front
 * is a line on the stdin of the real `harness hardware watch --json`, as the Harness Device app writes it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { InOrca } from './harness/inOrca.js'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const ORCA = 'com.stablyai.orca'
const DIAL = 'E2E-A'
/** Every focus line the devices may say: an outcome, never a pane or an agent. */
const FOCUS_LINE = /^\[device\] focus · (moved|skipped · (echo|unknown agent|no tile|not in front))$/

describe("the dial follows Orca's focus and tabs", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** A daemon of its own, the fake `orca` in its `bin` before it starts, and the dial on the desk shown its first list. */
  const fresh = async ({ watchFocus }: { watchFocus: boolean }) => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    const orca = FakeOrca.install(d, { watchFocus })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await desk.plug(DIAL, 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, dial, orca }
  }

  /** A session in an Orca terminal of its own, with Orca's bundle id as an app's terminal inherits it. */
  const inOrca = (d: IsolatedDaemon, folder: string) => {
    const handle = `term_${randomUUID()}`
    return { handle, claude: new InOrca(d, folder, children, { ORCA_TERMINAL_HANDLE: handle, __CFBundleIdentifier: ORCA }) }
  }

  /** Each session started, and its row on the dial. */
  const listed = async (dial: FakeDial, ...sessions: InOrca[]): Promise<void> => {
    for (const claude of sessions) {
      await claude.hook('SessionStart', { source: 'startup' })
      await dial.next((m) => m.t === 'agent' && m.id === claude.id, 45_000, 'the agent listed')
    }
  }

  /** The daemon's lines that hold [prefix], each from its `[device]` on. */
  const lines = (d: IsolatedDaemon, prefix: string): string[] =>
    d.log().split('\n').filter((line) => line.includes(prefix)).map((line) => line.slice(line.indexOf('[device]')))
  const count = (d: IsolatedDaemon, line: string): number => lines(d, line).filter((said) => said === line).length
  const said = (d: IsolatedDaemon, line: string): Promise<true> =>
    until(`"${line}" in the daemon's log`, () => d.log().includes(line), 30_000, 50)

  /** [bundle] comes in front: the watch the Harness Device app runs, told on its stdin, which it holds open until it quits. */
  const front = (d: IsolatedDaemon, bundle: string): void => {
    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(watch)
    watch.stdin!.write(`${JSON.stringify({ front: bundle })}\n`)
  }

  /** [claude]'s typed prompt, again each time its line says it was skipped, until one moves the dial, then its focus. The
   *  front settles 1 s after the watch's line, with no frame to wait on. Each prompt waits for its own line, so a retry is
   *  never sent while a move is under way. */
  const typedUntilMoved = async (d: IsolatedDaemon, dial: FakeDial, claude: InOrca): Promise<void> => {
    const since = dial.messages.length
    await until("the prompt's move", async () => {
      const told = lines(d, '[device] prompt · ').length
      await claude.hook('UserPromptSubmit', { prompt: 'run the tests' })
      return await until("the prompt's line", () => lines(d, '[device] prompt · ')[told], 30_000, 50) === '[device] prompt · moved'
    }, 60_000, 500)
    await dial.next((m) => m.t === 'focus' && m.agentId === claude.id, 30_000, "the prompt's agent's focus", since)
  }

  /** Two sessions in Orca terminals, listed, and the dial turned to the first by hand, its rest over. */
  const turnedToFirst = async (d: IsolatedDaemon, dial: FakeDial, first: InOrca, second: InOrca): Promise<void> => {
    await listed(dial, first, second)
    dial.send({ t: 'focus', agentId: first.id })
    await said(d, '[device] swipe · ok')
  }

  /** The dial's latest list: the `agent` frames between its last `agents.begin` and `agents.end`, and where that end is. */
  const latestList = (dial: FakeDial): { agents: DialMessage[]; end: number } | undefined => {
    const end = dial.messages.findLastIndex((m) => m.t === 'agents.end')
    if (end < 0) return undefined
    const begin = dial.messages.findLastIndex((m, at) => at < end && m.t === 'agents.begin')
    return { agents: dial.messages.slice(begin + 1, end).filter((m) => m.t === 'agent'), end }
  }

  it('with watch-focus: Orca settling in front moves the dial to the focused pane, a focus change moves it again, and neither its own switch nor a prompt does', async () => {
    const { d, dial, orca } = await fresh({ watchFocus: true })
    const a = inOrca(d, 'a')
    const b = inOrca(d, 'b')
    // A's tab has a title the person gave it: a title is never logged.
    const title = `tab ${randomUUID()}`
    orca.layout([[{ title, panes: [a.handle] }, [b.handle]]])
    await listed(dial, a.claude, b.claude)

    // 1-2. B has focus in Orca as Orca comes in front: the watch's first line turns the dial to B.
    let since = dial.messages.length
    orca.focus(b.handle)
    front(d, ORCA)
    await dial.next((m) => m.t === 'focus' && m.agentId === b.claude.id, 45_000, "B's focus", since)
    await said(d, '[device] orca watch · started')
    await until('one focus move', () => count(d, '[device] focus · moved') === 1, 30_000, 50)

    // 3. The person focuses A in Orca: the dial follows, then reports the tile it centred, as the firmware does.
    since = dial.messages.length
    orca.focus(a.handle)
    await dial.next((m) => m.t === 'focus' && m.agentId === a.claude.id, 30_000, "A's focus", since)
    await until('two focus moves', () => count(d, '[device] focus · moved') === 2, 30_000, 50)
    dial.send({ t: 'focus', agentId: a.claude.id })

    // 4. The dial turns to B by hand: Orca is switched once, and Orca's focus line for it is the dial's own echo.
    since = dial.messages.length
    dial.send({ t: 'focus', agentId: b.claude.id })
    await said(d, '[device] swipe · ok')
    expect(orca.runs().map((run) => run.args)).toEqual([`terminal switch --terminal ${b.handle} --json`])
    orca.focus(b.handle)
    await said(d, '[device] focus · skipped · echo')
    expect(count(d, '[device] focus · moved')).toBe(2)

    // 5. A typed prompt in A, with the watch running, moves nothing: the focus already says where the person is.
    await a.claude.hook('UserPromptSubmit', { prompt: 'run the tests' })
    await said(d, '[device] prompt · skipped · focus followed')
    expect(dial.messages.slice(since).filter((m) => m.t === 'focus' && m.agentId === a.claude.id)).toEqual([])

    // 6. One probe of the CLI, one watch.
    expect(orca.asked().filter((args) => args === 'terminal --help')).toHaveLength(1)
    expect(orca.asked().filter((args) => args === 'terminal watch-focus --json')).toHaveLength(1)

    // 7. The dial is unplugged: the watch ends with it.
    await desk!.unplug(DIAL)
    await said(d, '[device] orca watch · ended')
    await until("the fake's watch gone", () => !orca.watching(), 30_000, 50)

    // 8. Outcomes only: no handle, no session id, no worktree path, no tab title.
    for (const line of lines(d, '[device] focus ·')) expect(line).toMatch(FOCUS_LINE)
    const log = d.log()
    for (const secret of [a.handle, b.handle, a.claude.sessionId, b.claude.sessionId, '/e2e/wt-', title]) expect(log).not.toContain(secret)
  })

  it("Orca's ring reaches the dial in tab order, and the dial stays on the agent it shows", async () => {
    // Orca 1.4.256, the one Diego runs: the order and the names need no watch-focus.
    const { d, dial, orca } = await fresh({ watchFocus: false })
    const a = inOrca(d, 'a')
    const b = inOrca(d, 'b')
    const c = inOrca(d, 'c')
    // C's tab first, renamed by the person (its pane's title is another), then a tab split into A and B.
    orca.layout([[{ title: 'PM', panes: [c.handle] }, [a.handle, b.handle]]])

    // 2. The dial on A, by hand.
    await turnedToFirst(d, dial, a.claude, b.claude)

    // 3. C starts, its session named by the person: the ring is read again, and the dial's list comes in Orca's tab order.
    const since = dial.messages.length
    const reads = count(d, '[device] orca order · read')
    await c.claude.hook('SessionStart', { source: 'startup', session_title: 'harness root' })
    const ordered = [c.claude.id, a.claude.id, b.claude.id]
    const list = await until('the ring in tab order', () => {
      const latest = latestList(dial)
      return latest && latest.end >= since && latest.agents.map((m) => m.id).join() === ordered.join() ? latest : undefined
    }, 45_000, 50)
    await until("C's read", () => count(d, '[device] orca order · read') > reads, 30_000, 50)

    // 4. The dial stays on A: it is said again after that list, and no focus since C started names another agent.
    await dial.next((m) => m.t === 'focus', 30_000, 'the focus after the list', list.end + 1)
    for (const m of dial.messages.slice(since)) if (m.t === 'focus') expect(m.agentId).toBe(a.claude.id)

    // 5. The reorder switched nothing in Orca: A's one switch is all.
    expect(orca.runs().map((run) => run.args)).toEqual([`terminal switch --terminal ${a.handle} --json`])

    // 6. The tab the person renamed names C above its session's name (decided 8).
    expect(list.agents.find((m) => m.id === c.claude.id)?.name).toBe('PM')
  })

  it('without watch-focus (Orca 1.4.256): no watch runs, and a prompt still moves the dial', async () => {
    const { d, dial, orca } = await fresh({ watchFocus: false })
    const a = inOrca(d, 'a').claude
    const b = inOrca(d, 'b').claude
    await turnedToFirst(d, dial, a, b)
    front(d, ORCA)

    // 2. Orca settles in front, and the probe finds no watch-focus.
    await said(d, '[device] orca watch · unsupported')

    // 3. Then B's typed prompt moves the dial, as before Orca could tell its focus.
    await typedUntilMoved(d, dial, b)
    expect(count(d, '[device] prompt · moved')).toBe(1)

    // 4. None is run, and no focus line is said.
    expect(lines(d, '[device] orca watch · started')).toEqual([])
    expect(lines(d, '[device] focus ·')).toEqual([])
    expect(orca.asked().filter((args) => args.startsWith('terminal watch-focus'))).toEqual([])
  })
})
