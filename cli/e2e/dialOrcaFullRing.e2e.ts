/**
 * A ring that replaces a full one reaches the dial whole (docs/plans/2026-11-20-dial-orca-pick-choose-pane-design.md), on
 * the real daemon. Diego, 2026-11-20 17:32:40: the dial held another app's 16 agents, Orca came in front with one, and
 * the firmware, which adds a list's agents before it removes the old tiles and holds 16 (app_main.c
 * `refresh_projects`), refused Orca's agent, removed the 16 and showed "Choose a pane". The daemon now sends such a
 * ring in two steps: the agents the dial already holds (here none), then, a second later, the ring. WezTerm stands in
 * for the other app: a hook that names `WEZTERM_PANE` is all its sessions need, and no WezTerm runs.
 *
 * The route (the plan's "Decisions made in this plan"): the fault lives between the daemon's pushes and the firmware's
 * carousel, so only a dial that keeps its carousel as the firmware does shows it (harness/fakeDial.ts `carousel()`).
 * Everything else is the harness's own: a throwaway daemon with its own home, data folder and port; the dial a fake on a
 * pseudo-terminal; `orca` the fake first on the daemon's PATH, without `watch-focus` as Orca 1.4.256; the sessions
 * Claude Code's hooks under the daemon's environment (harness/inOrca.ts); the app in front a line on the stdin of the
 * real `harness hardware watch --json`, as the Harness Device app writes it. The real Orca and dial never run.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { InOrca } from './harness/inOrca.js'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const ORCA = 'com.stablyai.orca'
const WEZTERM = 'com.github.wez.wezterm'
/** The tiles the round dial holds, the ring that fills it. */
const FULL = 16
const DIAL = 'E2E-A'
/** The dial log ends each line with the dial's port, the desk's serial here. */
const SPLIT_LINE = /cable: agents split · \d+ kept · \d+ in ring \[usb E2E-A\]$/
const PICK_LINE = /\[device\] app filter: pick · (same|ignored)$/

describe("Orca's ring over a full dial", () => {
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

  /** The app in front, as the Harness Device app tells it: one watch, held open, each call a line on its stdin. */
  const frontWatch = (d: IsolatedDaemon): ((bundle: string) => void) => {
    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(watch)
    return (bundle) => { watch.stdin!.write(`${JSON.stringify({ front: bundle })}\n`) }
  }

  /** Each list the dial was sent after [since], as its ids, and where each ended. */
  const lists = (dial: FakeDial, since: number): Array<{ ids: unknown[]; end: number }> => {
    const out: Array<{ ids: unknown[]; end: number }> = []
    let ids: unknown[] | null = null
    dial.messages.forEach((m, at) => {
      if (at < since) return
      if (m.t === 'agents.begin') ids = []
      else if (m.t === 'agent' && ids) ids.push(m.id)
      else if (m.t === 'agents.end' && ids) { out.push({ ids, end: at }); ids = null }
    })
    return out
  }

  /** The daemon's lines that hold [part]. */
  const lines = (d: IsolatedDaemon, part: string): string[] => d.log().split('\n').filter((line) => line.includes(part))

  it("Orca's ring over a full ring of another app reaches the dial whole, with its first agent on the face", async () => {
    // 1. The daemon, the fake `orca` without watch-focus, the dial plugged and its first list.
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    const orca = FakeOrca.install(d, { watchFocus: false })
    let dial: FakeDial | undefined
    onTestFailed(() => {
      console.log(`---- the carousel\n${JSON.stringify(dial?.carousel())}`)
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
    })
    await d.start()
    dial = await desk.plug(DIAL, 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    // 2. WezTerm in front, and sixteen sessions in its panes.
    const front = frontWatch(d)
    front(WEZTERM)
    const wezterm = Array.from({ length: FULL }, (_, i) => new InOrca(d, `w${i}`, children, { WEZTERM_PANE: String(i + 1) }))
    for (const claude of wezterm) await claude.hook('SessionStart', { source: 'startup' })

    // 3. The dial shows WezTerm's ring, its sixteen tiles full.
    const full = wezterm.map((claude) => claude.id).sort()
    await until("WezTerm's sixteen tiles", () => {
      const shown = dial!.messages.filter((m) => m.t === 'apps').at(-1)?.shown
      const { tiles } = dial!.carousel()
      return shown === 'wezterm' && tiles.length === FULL && [...tiles].sort().join() === full.join()
    }, 60_000, 50)
    expect(dial.carousel().refused).toBe(0)

    // 4. Two sessions in Orca's tabs, one worktree: counted on the APPS page, not on the dial.
    const [o1, o2] = [0, 1].map((i) => {
      const handle = `term_${randomUUID()}`
      return { handle, claude: new InOrca(d, `o${i}`, children, { ORCA_TERMINAL_HANDLE: handle, __CFBundleIdentifier: ORCA }) }
    })
    orca.layout([[[o1.handle], [o2.handle]]])
    for (const { claude } of [o1, o2]) await claude.hook('SessionStart', { source: 'startup' })
    await until('Orca counted 2', () => dial!.messages.some((m) => m.t === 'apps' &&
      (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'orca' && app.count === 2)), 45_000, 50)

    // 5. Orca comes in front.
    const since = dial.messages.length
    front(ORCA)

    // 6. Orca's two agents on the glass, the first on the face, none refused: never "Choose a pane".
    const orcaRing = [o1.claude.id, o2.claude.id]
    await until("Orca's ring on the glass", () =>
      JSON.stringify(dial!.carousel()) === JSON.stringify({ tiles: orcaRing, active: o1.claude.id, refused: 0 }), 45_000, 50)
    // An empty step 1, as the dial held none of Orca's, then the ring, its landing after it.
    const sent = lists(dial, since)
    expect(sent.map((list) => list.ids)).toEqual([[], orcaRing])
    expect(dial.messages.slice(sent[1]!.end + 1).some((m) => m.t === 'focus' && m.agentId === o1.claude.id)).toBe(true)
    expect(lines(d, 'cable: agents split · 0 kept · 2 in ring')).toHaveLength(1)

    // 7. A pick of Orca, already shown, switches nothing and says why; the glass stays as it is.
    const glass = dial.carousel()
    dial.pick('orca')
    await until('the pick said same', () => lines(d, '[device] app filter: pick · same').length === 1, 30_000, 50)
    expect(dial.carousel()).toEqual(glass)

    // 8. Fixed words and counts only: no terminal handle and no session id in the log.
    for (const line of lines(d, 'agents split')) expect(line).toMatch(SPLIT_LINE)
    for (const line of lines(d, 'app filter: pick ·')) expect(line).toMatch(PICK_LINE)
    const log = d.log()
    for (const secret of [o1.handle, o2.handle, ...[...wezterm, o1.claude, o2.claude].map((claude) => claude.sessionId)]) {
      expect(log).not.toContain(secret)
    }
  })
})
