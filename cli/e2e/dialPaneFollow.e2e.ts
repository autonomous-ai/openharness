/**
 * The dial and the apps follow each other, pane by pane (docs/specs/2026-11-14-dial-pane-follow.md), on the real daemon:
 * Claude Code in Orca terminals tells its terminal's handle through its own hooks (harness/inOrca.ts), a fake dial on the
 * desk turns to it, and a fake `orca`, first on the daemon's PATH, notes each run. The real Orca never runs: a swipe has
 * no `open`, and nothing here taps. The app in front is a line on the stdin of the real `harness hardware watch --json`,
 * as the Harness Device app writes it.
 *
 * Each case lists its sessions and acts at once: the observed source checks a session's process every 30 s, and a
 * session's process here is whatever its hook's shell left as its parent.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'

/** Node may fire the 400 ms rest's timer a millisecond early; the exact 400 is cableSession.spec.ts's, on a fake clock. */
const REST_AT_LEAST_MS = 395

/** `orca`, as the daemon finds it: each run's arguments in a file of its own, and the exit code a test wrote (0 if none). */
const fakeOrca = (runs: string, exitFile: string): string =>
  `#!/bin/sh\nprintf '%s' "$*" > "$(mktemp '${runs}/run.XXXXXX')"\ncode=$(cat '${exitFile}' 2>/dev/null)\nexit "\${code:-0}"\n`

interface Run { args: string; at: number }

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

const ORCA = 'com.stablyai.orca'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const RELAYED = '<cross-session-message from="b">hi</cross-session-message>'

describe('the dial and the apps follow each other', () => {
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
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    const runsDir = join(d.root, 'orca-runs')
    mkdirSync(runsDir)
    const exitFile = join(d.root, 'orca-exit')
    writeFileSync(join(d.root, 'bin', 'orca'), fakeOrca(runsDir, exitFile), { mode: 0o755 })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const runs = (): Run[] => readdirSync(runsDir).map((name) => {
      const path = join(runsDir, name)
      return { args: readFileSync(path, 'utf8'), at: statSync(path).mtimeMs }
    })
    return { d, dial, runs, refuse: () => writeFileSync(exitFile, '1') }
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

  /** The daemon's swipe lines, each from its `[device]` on. */
  const swipeLines = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[device] swipe')).map((line) => line.slice(line.indexOf('[device]')))
  const said = (d: IsolatedDaemon, line: string): Promise<true> =>
    until(`"${line}" in the daemon's log`, () => d.log().includes(line), 30_000, 50)

  /** [bundle] comes in front: the watch the Harness Device app runs, told on its stdin, which it holds open. */
  const front = (d: IsolatedDaemon, bundle: string): void => {
    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(watch)
    watch.stdin!.write(`${JSON.stringify({ front: bundle })}\n`)
  }

  /** [claude]'s typed prompt, again every 500 ms until the dial hears its agent's focus. The front settles 1 s after the
   *  watch's line, with no frame to wait on: a prompt before it is skipped, and one after the move finds the dial there. */
  const typedUntilMoved = (dial: FakeDial, claude: InOrca): Promise<true> => {
    const since = dial.messages.length
    return until("the dial turned to the prompt's agent", async () => {
      await claude.hook('UserPromptSubmit', { prompt: 'run the tests' })
      return dial.messages.slice(since).some((m) => m.t === 'focus' && m.agentId === claude.id)
    }, 60_000, 500)
  }

  /** Two sessions in Orca terminals, listed, and the dial turned to the first by hand, its rest over. */
  const turnedToFirst = async (d: IsolatedDaemon, dial: FakeDial, first: InOrca, second: InOrca): Promise<void> => {
    await listed(dial, first, second)
    dial.send({ t: 'focus', agentId: first.id })
    await said(d, '[device] swipe · ok')
  }

  it("the dial's turn to an agent in an Orca terminal runs the fake switch once, 400 ms after", async () => {
    const { d, dial, runs } = await fresh()
    const a = inOrca(d, 'a')
    await listed(dial, a.claude)
    const before = Date.now()
    dial.send({ t: 'focus', agentId: a.claude.id })
    await said(d, '[device] swipe · ok')
    const [run, ...more] = runs()
    expect(more).toEqual([])
    expect(run.args).toBe(`terminal switch --terminal ${a.handle} --json`)
    expect(run.at - before).toBeGreaterThanOrEqual(REST_AT_LEAST_MS)
    expect(swipeLines(d)).toEqual(['[device] swipe · ok'])
  })

  it('a turn to an agent outside Orca runs nothing', async () => {
    const { d, dial, runs } = await fresh()
    const b = inOrca(d, 'b')
    const w = new InOrca(d, 'w', children, { WEZTERM_PANE: '7' })
    await listed(dial, b.claude, w)
    dial.send({ t: 'focus', agentId: w.id })
    dial.send({ t: 'focus', agentId: b.claude.id })
    await said(d, '[device] swipe · ok')
    expect(runs().map((run) => run.args)).toEqual([`terminal switch --terminal ${b.handle} --json`])
    // W started no rest: B's turn superseded none.
    expect(swipeLines(d)).toEqual(['[device] swipe · ok'])
  })

  it('a switch the fake orca refuses is one log line, and the dial is sent no toast', async () => {
    const { d, dial, runs, refuse } = await fresh()
    const a = inOrca(d, 'a')
    await listed(dial, a.claude)
    refuse()
    const since = dial.messages.length
    dial.send({ t: 'focus', agentId: a.claude.id })
    await said(d, '[device] swipe · failed')
    expect(runs()).toHaveLength(1)
    expect(swipeLines(d)).toEqual(['[device] swipe · failed'])
    expect(dial.messages.slice(since).filter((m) => m.t === 'toast')).toEqual([])
  })

  it("the daemon's log has no handle and no session id", async () => {
    const { d, dial, runs } = await fresh()
    const a = inOrca(d, 'a')
    const b = inOrca(d, 'b')
    await listed(dial, a.claude, b.claude)
    dial.send({ t: 'focus', agentId: b.claude.id })
    dial.send({ t: 'focus', agentId: a.claude.id })
    await said(d, '[device] swipe · ok')
    // B's turn did not rest: it ran nothing and is one line. Its run's time alone could not tell (500 ms from the dial's
    // send to orca's run with no rest at all, measured on a Mac).
    expect(swipeLines(d)).toEqual(['[device] swipe · superseded', '[device] swipe · ok'])
    expect(runs().map((run) => run.args)).toEqual([`terminal switch --terminal ${a.handle} --json`])
    const log = d.log()
    for (const secret of [a.handle, b.handle, a.claude.sessionId, b.claude.sessionId]) expect(log).not.toContain(secret)
  })

  it('a prompt typed in Orca, with Orca in front, moves the dial to its agent', async () => {
    const { d, dial } = await fresh()
    const a = inOrca(d, 'a').claude
    const b = inOrca(d, 'b').claude
    await turnedToFirst(d, dial, a, b)
    front(d, ORCA)
    await typedUntilMoved(dial, b)
    await said(d, '[device] prompt · moved')
  })

  it('a message from another session does not move it', async () => {
    const { d, dial } = await fresh()
    const a = inOrca(d, 'a').claude
    const b = inOrca(d, 'b').claude
    await turnedToFirst(d, dial, a, b)
    front(d, ORCA)
    // Orca has settled in front and the dial is on B: A's typed prompt would move it now.
    await typedUntilMoved(dial, b)
    const since = dial.messages.length
    await a.hook('UserPromptSubmit', { prompt: RELAYED })
    await said(d, '[device] prompt · skipped · relayed')
    expect(dial.messages.slice(since).filter((m) => m.t === 'focus' && m.agentId === a.id)).toEqual([])
  })

  it('a prompt in the Claude app, with the Claude app in front, moves the dial', async () => {
    const { d, dial } = await fresh()
    const a = inOrca(d, 'a').claude
    // The Claude app's own session: no Orca terminal around it.
    const c = new InOrca(d, 'c', children, { __CFBundleIdentifier: CLAUDE_APP, ORCA_AGENT_SESSION_ID: '' })
    await turnedToFirst(d, dial, a, c)
    front(d, CLAUDE_APP)
    await typedUntilMoved(dial, c)
    await said(d, '[device] prompt · moved')
  })

  it("the daemon's log has no bundle id, no session id, no handle and no word of a prompt", async () => {
    const { d, dial } = await fresh()
    const a = inOrca(d, 'a')
    const b = inOrca(d, 'b')
    await turnedToFirst(d, dial, a.claude, b.claude)
    front(d, ORCA)
    await typedUntilMoved(dial, b.claude)
    await a.claude.hook('UserPromptSubmit', { prompt: RELAYED })
    await said(d, '[device] prompt · skipped · relayed')
    const log = d.log()
    for (const secret of [ORCA, a.handle, b.handle, a.claude.sessionId, b.claude.sessionId, 'run the tests', 'cross-session', '>hi<']) {
      expect(log).not.toContain(secret)
    }
  })
})
