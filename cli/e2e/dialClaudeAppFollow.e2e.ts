/**
 * The session the Claude app shows moves the dial (docs/specs/2026-11-15-dial-claude-app-follow.md), on the real daemon:
 * the harness-device mod's attach, sent as the mod sends it (the real `harness device claude link --json` names the
 * devices' socket, then one post on it), turns a fake dial on the desk to its agent while the Claude app has settled in
 * front, and once it settles from behind. The app in front is a line on the stdin of the real `harness hardware watch
 * --json`, as the Harness Device app writes it. The real Claude app, Orca and dial never run: no session carries the
 * Claude app's host session id, and nothing here taps or swipes, so nothing can reach `open`.
 *
 * Orca holds more agents than the Claude app until the Claude app settles in front, so the dial's switch to the Claude
 * app's ring is the settle: nothing waits a fixed second.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { fetchOverSocket } from '../src/lib/localTransport.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'

// How the real CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const ORCA = 'com.stablyai.orca'
const CLAUDE_APP = 'com.anthropic.claudefordesktop'

describe('the session the Claude app shows moves the dial', () => {
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
    // The Claude app's host session id would let a follow open the app: no session here may carry it.
    expect(d.env.CLAUDE_CODE_HOST_SESSION_ID).toBeUndefined()
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

  /** A session in an Orca terminal of its own. */
  const inOrca = (d: IsolatedDaemon, folder: string): InOrca =>
    new InOrca(d, folder, children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
  /** A session of the Claude app's own: no Orca terminal around it, and no host session id. */
  const inClaudeApp = (d: IsolatedDaemon, folder: string): InOrca =>
    new InOrca(d, folder, children, { __CFBundleIdentifier: CLAUDE_APP, ORCA_AGENT_SESSION_ID: '' })

  /** Each session started, and its row on the dial: the shown ring's. */
  const listed = async (dial: FakeDial, ...sessions: InOrca[]): Promise<void> => {
    for (const claude of sessions) {
      const since = dial.messages.length
      await claude.hook('SessionStart', { source: 'startup' })
      await dial.next((m) => m.t === 'agent' && m.id === claude.id, 45_000, 'the agent listed', since)
    }
  }

  /** A Claude app session started behind Orca's ring: no row of its own, the Claude app's count in the app list. */
  const counted = async (dial: FakeDial, claude: InOrca, count: number): Promise<void> => {
    const since = dial.messages.length
    await claude.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca'
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'claude' && app.count === count), 45_000, 'the Claude app counted', since)
  }

  /** The watch the Harness Device app runs, its stdin held open: each [bundle] written is the next app in front. */
  const watch = (d: IsolatedDaemon): ((bundle: string) => void) => {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(child)
    return (bundle) => { child.stdin!.write(`${JSON.stringify({ front: bundle })}\n`) }
  }

  /** The Claude app written in [front], and the index of the ring [dial] is shown once the app has settled there. */
  const settled = async (dial: FakeDial, front: (bundle: string) => void): Promise<number> => {
    const since = dial.messages.length
    front(CLAUDE_APP)
    return dial.messages.indexOf(await dial.next((m) => m.t === 'apps' && m.shown === 'claude', 45_000, "the Claude app's ring", since))
  }

  /** The mod's socket: the real `harness device claude link --json` under the daemon's environment, the plugin's entry in
   *  the throwaway home's Claude Code settings first, as `claude plugin install` leaves it. */
  const devicesSocket = async (d: IsolatedDaemon): Promise<string> => {
    const settings = join(d.env.HOME!, '.claude', 'settings.json')
    const current = JSON.parse(readFileSync(settings, 'utf8')) as { enabledPlugins?: Record<string, boolean> }
    writeFileSync(settings, JSON.stringify({ ...current, enabledPlugins: { ...current.enabledPlugins, 'harness-device@openharness': true } }))
    const child = spawn(process.execPath, [...CLI_ENTRY, 'device', 'claude', 'link', '--json'], {
      cwd: CLI_ROOT, env: d.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    expect(code, stderr).toBe(0)
    const { devicesSocket: path } = JSON.parse(stdout) as { socketPath: string; devicesSocket?: string }
    expect(path).toEqual(expect.any(String))
    return path!
  }

  /** The mod's attach of [sessionId] on the devices' socket, and its answer's status. */
  const attach = async (socket: string, sessionId: string): Promise<number> => {
    const answer = await fetchOverSocket(socket)('http://localhost/', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'attach', sessionId }),
    })
    return answer.status
  }

  /** The daemon's attach lines, each read whole from its `[device]` on. */
  const attachLines = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').filter((line) => line.includes('[device] attach')).map((line) => line.slice(line.indexOf('[device]')))
  const lineAt = (d: IsolatedDaemon, n: number): Promise<string> =>
    until(`attach line ${n + 1}`, () => attachLines(d)[n], 30_000, 50)

  it('link names the devices\' socket, and an attach with the Claude app in front moves the dial', async () => {
    const { d, dial } = await fresh()
    const c1 = inClaudeApp(d, 'c1')
    const c2 = inClaudeApp(d, 'c2')
    await listed(dial, inOrca(d, 'a'), inOrca(d, 'b'))
    await counted(dial, c1, 1)
    await settled(dial, watch(d))
    await listed(dial, c2)
    const socket = await devicesSocket(d)

    let since = dial.messages.length
    expect(await attach(socket, c1.sessionId)).toBe(204)
    await dial.next((m) => m.t === 'focus' && m.agentId === c1.id, 30_000, "C1's focus", since)
    expect(await lineAt(d, 0)).toBe('[device] attach · moved')

    since = dial.messages.length
    expect(await attach(socket, c2.sessionId)).toBe(204)
    await dial.next((m) => m.t === 'focus' && m.agentId === c2.id, 30_000, "C2's focus", since)
    expect(await lineAt(d, 1)).toBe('[device] attach · moved')

    // A session the devices do not list: taken, and nothing moves.
    since = dial.messages.length
    expect(await attach(socket, randomUUID())).toBe(204)
    expect(await lineAt(d, 2)).toBe('[device] attach · skipped · unknown agent')
    expect(dial.messages.slice(since).filter((m) => m.t === 'focus')).toEqual([])
    expect(attachLines(d)).toEqual(['[device] attach · moved', '[device] attach · moved', '[device] attach · skipped · unknown agent'])
  })

  it('with Orca in front an attach does not move the dial, and the Claude app settling in front does', async () => {
    const { d, dial } = await fresh()
    const c1 = inClaudeApp(d, 'c1')
    await listed(dial, inOrca(d, 'a'), inOrca(d, 'b'))
    await counted(dial, c1, 1)
    const front = watch(d)
    // Orca's ring is shown already, so its settle shows nothing to wait on; settled or not yet, the Claude app is not in front.
    front(ORCA)
    const socket = await devicesSocket(d)

    const since = dial.messages.length
    expect(await attach(socket, c1.sessionId)).toBe(204)
    expect(await lineAt(d, 0)).toBe('[device] attach · skipped · not in front')

    const ring = await settled(dial, front)
    await dial.next((m) => m.t === 'focus' && m.agentId === c1.id, 30_000, "C1's focus on settle", ring)
    // The skipped attach sent none: a focus it sent late would come before the ring. The settle's one move may send
    // the focus more than once (its ring's push re-asserts it), so the move is counted by its line.
    expect(dial.messages.slice(since, ring).filter((m) => m.t === 'focus' && m.agentId === c1.id)).toEqual([])
    expect(await lineAt(d, 2)).toBe('[device] attach · moved')
    expect(attachLines(d)).toEqual(['[device] attach · skipped · not in front', '[device] attach · on settle', '[device] attach · moved'])
  })

  it("the daemon's log has no session id and no bundle id, and no swipe line", async () => {
    const { d, dial } = await fresh()
    const a = inOrca(d, 'a')
    const b = inOrca(d, 'b')
    const c1 = inClaudeApp(d, 'c1')
    await listed(dial, a, b)
    await counted(dial, c1, 1)
    await settled(dial, watch(d))
    const socket = await devicesSocket(d)
    const unknown = randomUUID()
    expect(await attach(socket, c1.sessionId)).toBe(204)
    expect(await attach(socket, unknown)).toBe(204)
    expect(await lineAt(d, 1)).toBe('[device] attach · skipped · unknown agent')
    const log = d.log()
    for (const secret of [ORCA, CLAUDE_APP, a.sessionId, b.sessionId, c1.sessionId, unknown]) expect(log).not.toContain(secret)
    expect(log).not.toContain('[device] swipe')
  })
})
