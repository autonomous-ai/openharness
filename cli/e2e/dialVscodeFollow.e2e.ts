/**
 * A rest shows a Claude Code session in the VS Code extension's tab (docs/plans/2026-11-17-dial-vscode-follow-design.md),
 * on the real daemon: two sessions whose hooks name the extension (`CLAUDE_CODE_ENTRYPOINT=claude-vscode`, VS Code's bundle
 * id), and a fake dial on the desk resting on each while VS Code is in front, run each one's own link once, sent to VS Code
 * alone; with another app in front, a rest runs nothing. The app in front is a line on the stdin of the real `harness
 * hardware watch --json`, as the Harness Device app writes it.
 *
 * The real VS Code and `/usr/bin/open` never run: the daemon's `open` is the harness's fake (HARNESS_OPEN_BIN,
 * harness/daemon.ts), checked to be inside the test's own root before anything rests. Skipped off macOS: the link is
 * macOS's, so there no rest exists.
 *
 * Orca holds more agents than VS Code until VS Code settles in front, so the dial's switch to VS Code's ring is the
 * settle: nothing waits a fixed second.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'

// How the real CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const ORCA = 'com.stablyai.orca'
const VSCODE = 'com.microsoft.VSCode'
const link = (session: string) => `vscode://anthropic.claude-code/open?session=${session}`

describe.skipIf(process.platform !== 'darwin')("a rest shows a session in the VS Code extension's tab", () => {
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

  /** A daemon of its own and a dial on the desk that holds one app's ring, shown its first list. */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, dial }
  }

  /** The watch the Harness Device app runs, its stdin held open: each [bundle] written is the next app in front. */
  const watch = (d: IsolatedDaemon): ((bundle: string) => void) => {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(child)
    return (bundle) => { child.stdin!.write(`${JSON.stringify({ front: bundle })}\n`) }
  }

  /** The daemon's swipe lines, each read whole from its `[device]` on. */
  const swipes = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[device] swipe ·')).map((line) => line.slice(line.indexOf('[device]')))
  const swiped = (d: IsolatedDaemon, n: number) =>
    until(`swipe line ${n}`, () => swipes(d).length >= n ? swipes(d) : undefined, 30_000, 50)

  it('with VS Code in front, a rest on each extension session runs its own link once; with another app in front, none', async () => {
    const { d, dial } = await fresh()
    // The open the daemon runs is the harness's fake in its root, never the real one.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)

    // 1. Orca holds more agents than VS Code until VS Code settles in front, so the ring's switch to VS Code is the settle.
    for (const folder of ['a', 'b', 'c']) {
      const session = new InOrca(d, folder, children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
      const since = dial.messages.length
      await session.hook('SessionStart', { source: 'startup' })
      await dial.next((m) => m.t === 'agent' && m.id === session.id, 45_000, `${folder} listed`, since)
    }

    // 2. Two sessions in the VS Code extension's panel, counted behind Orca's ring.
    const inVscode = (folder: string) => new InOrca(d, folder, children,
      { __CFBundleIdentifier: VSCODE, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', ORCA_AGENT_SESSION_ID: '' })
    const v1 = inVscode('v1')
    const v2 = inVscode('v2')
    let since = dial.messages.length
    await v1.hook('SessionStart', { source: 'startup' })
    await v2.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca'
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'vscode' && app.count === 2), 45_000, 'VS Code counted', since)

    // 3. VS Code in front, as the Harness Device app's watch says it: its ring, with both rows.
    const front = watch(d)
    since = dial.messages.length
    front(VSCODE)
    const ring = dial.messages.indexOf(await dial.next((m) => m.t === 'apps' && m.shown === 'vscode', 45_000, "VS Code's ring", since))
    for (const session of [v1, v2]) await dial.next((m) => m.t === 'agent' && m.id === session.id, 45_000, 'listed in VS Code\'s ring', ring)

    // 4. A rest on each: its own session's link, sent to VS Code alone, once.
    dial.send({ t: 'focus', agentId: v2.id })
    expect(await swiped(d, 1)).toEqual(['[device] swipe · ok'])
    expect(d.opens()).toEqual([['-b', VSCODE, link(v2.sessionId)]])
    dial.send({ t: 'focus', agentId: v1.id })
    expect(await swiped(d, 2)).toEqual(['[device] swipe · ok', '[device] swipe · ok'])
    expect(d.opens()).toEqual([['-b', VSCODE, link(v2.sessionId)], ['-b', VSCODE, link(v1.sessionId)]])

    // 5. Another app in front: a rest runs nothing. VS Code's settle back (a second) outlasts a rest (400 ms), so its
    // ring shown again means the rest had its chance.
    since = dial.messages.length
    front(ORCA)
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca', 45_000, "Orca's ring", since)
    dial.send({ t: 'focus', agentId: v2.id })
    since = dial.messages.length
    front(VSCODE)
    await dial.next((m) => m.t === 'apps' && m.shown === 'vscode', 45_000, "VS Code's ring again", since)
    expect(d.opens()).toEqual([['-b', VSCODE, link(v2.sessionId)], ['-b', VSCODE, link(v1.sessionId)]])
    expect(swipes(d)).toEqual(['[device] swipe · ok', '[device] swipe · ok'])

    // 6. Every rest above was taken as a hand's, none dropped; no line names a session or its link, and no link failed back
    // to opening VS Code alone.
    const log = d.log()
    expect(log).not.toContain('cable: dropped dial focus')
    for (const secret of [v1.sessionId, v2.sessionId, 'vscode://', '[device] open · vscode · fallback']) expect(log).not.toContain(secret)
  })
})
