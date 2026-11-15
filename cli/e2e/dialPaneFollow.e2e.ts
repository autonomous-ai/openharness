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
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
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

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const ORCA = 'com.stablyai.orca'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const RELAYED = '<cross-session-message from="b">hi</cross-session-message>'
/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'd1'.repeat(16), computerId: 'e2e-pane-follow-computer', name: 'Fixture', token: 'e2e-pane-follow-token' }

describe('the dial and the apps follow each other', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
  })

  /** A daemon of its own, the fake `orca` in its `bin` before it starts, and the dial on the desk shown its first list.
   *  [env] and [before], run on the created daemon before it starts, and what the dial's greeting names, are a case's own. */
  const fresh = async ({ env = {}, before, capabilities }: { env?: Record<string, string>; before?: (d: IsolatedDaemon) => void; capabilities?: Record<string, string> } = {}) => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...env } })
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
    before?.(d)
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', capabilities)
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

  /** [bundle] comes in front: the watch the Harness Device app runs, told on its stdin, which it holds open until it quits. */
  const front = (d: IsolatedDaemon, bundle: string): ChildProcess => {
    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(watch)
    watch.stdin!.write(`${JSON.stringify({ front: bundle })}\n`)
    return watch
  }

  /** The daemon's prompt lines, each from its `[device]` on: one for each turn's start while a dial is linked. */
  const promptLines = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[device] prompt · ')).map((line) => line.slice(line.indexOf('[device]')))
  const moved = (d: IsolatedDaemon): number => promptLines(d).filter((line) => line === '[device] prompt · moved').length

  /** [claude]'s typed prompt, again each time its line says it was skipped, until one moves the dial, then its focus. The
   *  front settles 1 s after the watch's line, with no frame to wait on. Each prompt waits for its own line, so a retry is
   *  never sent while a move is under way, and the call counts one move. */
  const typedUntilMoved = async (d: IsolatedDaemon, dial: FakeDial, claude: InOrca): Promise<void> => {
    const since = dial.messages.length
    await until("the prompt's move", async () => {
      const told = promptLines(d).length
      await claude.hook('UserPromptSubmit', { prompt: 'run the tests' })
      return await until("the prompt's line", () => promptLines(d)[told], 30_000, 50) === '[device] prompt · moved'
    }, 60_000, 500)
    await dial.next((m) => m.t === 'focus' && m.agentId === claude.id, 30_000, "the prompt's agent's focus", since)
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
    const { d, dial } = await fresh({ capabilities: FILTER })
    const a = inOrca(d, 'a').claude
    const b = inOrca(d, 'b').claude
    await turnedToFirst(d, dial, a, b)
    front(d, ORCA)
    await typedUntilMoved(d, dial, b)
    expect(moved(d)).toBe(1)
  })

  it('a message from another session does not move it', async () => {
    const { d, dial } = await fresh({ capabilities: FILTER })
    const a = inOrca(d, 'a').claude
    const b = inOrca(d, 'b').claude
    await turnedToFirst(d, dial, a, b)
    front(d, ORCA)
    // Orca has settled in front and the dial is on B: A's typed prompt would move it now.
    await typedUntilMoved(d, dial, b)
    const since = dial.messages.length
    await a.hook('UserPromptSubmit', { prompt: RELAYED })
    await said(d, '[device] prompt · skipped · relayed')
    // A's typed prompt then moves it, the one move since: a focus the relayed one sent late would come before it.
    const typed = dial.messages.length
    await typedUntilMoved(d, dial, a)
    expect(dial.messages.slice(since, typed).filter((m) => m.t === 'focus' && m.agentId === a.id)).toEqual([])
    expect(moved(d)).toBe(2)
  })

  it("a prompt does not move the dial once the watch's stdin ends, and does once a new watch has Orca in front", async () => {
    const { d, dial } = await fresh({ capabilities: FILTER })
    const a = inOrca(d, 'a').claude
    const b = inOrca(d, 'b').claude
    await turnedToFirst(d, dial, a, b)
    const watch = front(d, ORCA)
    await typedUntilMoved(d, dial, b)
    expect(moved(d)).toBe(1)

    // The Device app quits: the watch's stdin ends, and the watch tells none. B's prompt, the dial already on B, says
    // nothing and moves nothing while Orca is still settled, so it waits out none's settle with no move to undo.
    const since = dial.messages.length
    const told = promptLines(d).length
    watch.stdin!.end()
    await until('none settled in front', async () => {
      await b.hook('UserPromptSubmit', { prompt: 'run the tests' })
      return promptLines(d).length > told
    }, 60_000, 500)
    // The hook exits before the daemon reads its post, so the last of B's lines may still be on its way, and it reads as
    // A's would. A relayed prompt always has a line, and the lines come in the order the prompts were sent: once its line
    // is there, none of B's is still to come.
    const relayed = promptLines(d).length
    await b.hook('UserPromptSubmit', { prompt: RELAYED })
    await until('the relayed line', () => promptLines(d).slice(relayed).includes('[device] prompt · skipped · relayed'), 30_000, 50)

    // A's typed prompt is not in front: its own line says so, and it moves nothing.
    const skipped = promptLines(d).length
    await a.hook('UserPromptSubmit', { prompt: 'run the tests' })
    expect(await until("A's prompt's line", () => promptLines(d)[skipped], 30_000, 50)).toBe('[device] prompt · skipped · not in front')
    expect(new Set(promptLines(d).slice(told)))
      .toEqual(new Set(['[device] prompt · skipped · not in front', '[device] prompt · skipped · relayed']))

    // A new watch has Orca in front: A's prompt moves the dial, the one move since. A focus the skipped one sent late
    // would come before this one's.
    front(d, ORCA)
    const typed = dial.messages.length
    await typedUntilMoved(d, dial, a)
    expect(dial.messages.slice(since, typed).filter((m) => m.t === 'focus' && m.agentId === a.id)).toEqual([])
    expect(moved(d)).toBe(2)
  })

  it('a prompt in the Claude app, with the Claude app in front, moves the dial', async () => {
    const { d, dial } = await fresh({ capabilities: FILTER })
    const a = inOrca(d, 'a').claude
    // The Claude app's own session: no Orca terminal around it.
    const c = new InOrca(d, 'c', children, { __CFBundleIdentifier: CLAUDE_APP, ORCA_AGENT_SESSION_ID: '' })
    // The dial on A, in Orca's ring, by hand.
    await listed(dial, a)
    dial.send({ t: 'focus', agentId: a.id })
    await said(d, '[device] swipe · ok')
    // C has a ring of its own: the dial is shown it once the Claude app has settled in front.
    const since = dial.messages.length
    await c.hook('SessionStart', { source: 'startup' })
    front(d, CLAUDE_APP)
    await dial.next((m) => m.t === 'apps' && m.shown === 'claude', 45_000, "the Claude app's ring", since)
    await dial.next((m) => m.t === 'agent' && m.id === c.id, 45_000, 'C listed', since)
    await typedUntilMoved(d, dial, c)
    expect(moved(d)).toBe(1)
  })

  it("the daemon's log has no bundle id, no session id, no handle and no word of a prompt", async () => {
    const { d, dial } = await fresh({ capabilities: FILTER })
    const a = inOrca(d, 'a')
    const b = inOrca(d, 'b')
    await turnedToFirst(d, dial, a.claude, b.claude)
    front(d, ORCA)
    await typedUntilMoved(d, dial, b.claude)
    await a.claude.hook('UserPromptSubmit', { prompt: RELAYED })
    await said(d, '[device] prompt · skipped · relayed')
    const log = d.log()
    for (const secret of [ORCA, a.handle, b.handle, a.claude.sessionId, b.claude.sessionId, 'run the tests', 'cross-session', '>hi<']) {
      expect(log).not.toContain(secret)
    }
  })

  it('the turn of a prompt the dial spoke does not move the dial, and the next typed prompt does', async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.speech = 'run the spoken tests'
    const { d, dial, runs } = await fresh({
      env: { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
      capabilities: FILTER,
      // Signed in as ME: the session `harness login` leaves, which the core reads at start.
      before: (d) => writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
        autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
        expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
      }), { mode: 0o600 }),
    })
    const a = inOrca(d, 'a')
    const b = inOrca(d, 'b')
    const switchesTo = (handle: string): number => runs().filter((run) => run.args === `terminal switch --terminal ${handle} --json`).length

    // 1. The dial on B, by hand.
    await listed(dial, a.claude, b.claude)
    dial.send({ t: 'focus', agentId: b.claude.id })
    await until("B's switch", () => switchesTo(b.handle) === 1, 30_000, 50)

    // 2. Orca settled in front: A's typed prompt moves the dial. Then its turn ends: Orca's route types only at an idle prompt.
    front(d, ORCA)
    await typedUntilMoved(d, dial, a.claude)
    expect(moved(d)).toBe(1)
    // The tile it centred, reported as the firmware does: the daemon drops the dial's turns until it hears it (750 ms).
    dial.send({ t: 'focus', agentId: a.claude.id })
    let since = dial.messages.length
    await a.claude.hook('Stop')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === a.claude.id, 30_000, "A's turn done", since)

    // 3. The dial speaks to A: the fake backend transcribes, the fake orca types it at A's prompt.
    since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: a.claude.id, uploadId: 'spoken-1', sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId: 'spoken-1' })
    const heard = await dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the transcript', since)
    expect(heard).toMatchObject({ t: 'voice.transcript', text: 'run the spoken tests', agentId: a.claude.id })
    expect(relay.seen.filter((line) => line.startsWith('POST /api/voice/stt'))).toEqual(['POST /api/voice/stt?lang=en'])
    expect(runs().filter((run) => run.args.startsWith('terminal send')).map((run) => run.args))
      .toEqual([`terminal send --terminal ${a.handle} --text=run the spoken tests --enter --wait-submit 5 --json`])
    await said(d, '[device] voice · orca')

    // 4. The dial on B again, by hand.
    dial.send({ t: 'focus', agentId: b.claude.id })
    await until("B's second switch", () => switchesTo(b.handle) === 2, 30_000, 50)
    since = dial.messages.length

    // 5. The turn Orca's typing starts is the dial's: the dial stays on B.
    await a.claude.hook('UserPromptSubmit', { prompt: 'run the spoken tests' })
    await said(d, '[device] prompt · skipped · dial prompt')

    // 6. The next prompt typed at A is the person's: the dial moves to it again, the one move since step 2. A focus the
    // dial's turn sent late would come before this one's.
    await a.claude.hook('Stop')
    const typed = dial.messages.length
    await typedUntilMoved(d, dial, a.claude)
    expect(dial.messages.slice(since, typed).filter((m) => m.t === 'focus' && m.agentId === a.claude.id)).toEqual([])
    expect(moved(d)).toBe(2)

    // 7. No word of it, no handle and no session id in the daemon's log.
    const log = d.log()
    for (const secret of ['spoken tests', a.handle, b.handle, a.claude.sessionId, b.claude.sessionId]) expect(log).not.toContain(secret)
  })
})
