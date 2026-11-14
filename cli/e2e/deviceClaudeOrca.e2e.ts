/**
 * The dial answers Claude Code outside Harness (docs/specs/2026-11-13-device-claude-orca.md), on the real daemon: the
 * plugin's PermissionRequest hook runs the real `harness device claude approve`, which asks over the daemon's socket, and
 * a fake dial on the desk (harness/fakeDial.ts) shows the card and answers it:
 * - with no dial, the client answers nothing at once, and no devices process is started for it;
 * - Allow and Deny on the dial print the hook's decision, byte for byte; the client going closes the card;
 * - with a window open the dial shows its tab, where no card can be answered, so nothing is asked;
 * - the mod's inbox poll is refused with no dial and held with one.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'

const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the Harness device."}}}\n'
/** An answer at once, not a card's 300 s: room for the CLI's own start on a loaded machine. */
const AT_ONCE_MS = 30_000

/** One run of the hook's client, as Claude Code runs it: the prompt's input on stdin, the decision on stdout. */
interface Approve { child: ChildProcess; done: Promise<{ stdout: string; code: number | null; ms: number }> }

/** One list the dial was sent: its rows, between `agents.begin` and `agents.end`, and the end. */
interface Roster { rows: DialMessage[]; end: DialMessage }
function rosters(dial: FakeDial, since = 0): Roster[] {
  const out: Roster[] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push({ rows, end: m }); rows = null }
  }
  return out
}
const showing = (dial: FakeDial, what: string, test: (roster: Roster) => boolean, since = 0, ms = 45_000): Promise<Roster> =>
  until(what, () => {
    const last = rosters(dial, since).at(-1)
    return last && test(last) ? last : null
  }, ms, 100)

/** A POST of the mod's poll over the daemon's socket, as the mod sends it: its status once answered. */
const inboxPoll = (d: IsolatedDaemon, sessionId: string, signal?: AbortSignal): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: d.socketPath, path: '/api/hook/inbox', method: 'POST', headers: { 'Content-Type': 'application/json' }, signal },
      (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(JSON.stringify({ sessionId }))
  })

describe('the dial answers Claude Code outside Harness', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const clients: ChildProcess[] = []
  afterEach(async () => {
    for (const child of clients.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })
  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    return { d, desk: theDesk }
  }
  /** The dial on the desk, welcomed and shown its first list. */
  const plugged = async (theDesk: Desk): Promise<FakeDial> => {
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return dial
  }
  /** The real CLI, from the run's bundle or the sources as the daemon is started, for a Bash prompt in [folder]. */
  const approve = (d: IsolatedDaemon, folder: string, command: string, sessionId = randomUUID()): Approve => {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const env: NodeJS.ProcessEnv = { ...d.env }
    // A terminal outside Harness: no pane of ours, nor of the tmux this run is started in.
    for (const name of ['TMUX', 'TMUX_PANE', 'HARNESS_PANE']) delete env[name]
    const bundle = process.env.E2E_BUNDLE_PATH
    const script = bundle ? [bundle] : ['--import', 'tsx', 'src/cli.ts']
    const started = Date.now()
    const child = spawn(process.execPath, [...script, 'device', 'claude', 'approve'], { cwd: CLI_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] })
    clients.push(child)
    let stdout = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr!.resume()
    const done = new Promise<{ stdout: string; code: number | null; ms: number }>((resolve) =>
      child.once('exit', (code) => resolve({ stdout, code, ms: Date.now() - started })))
    child.stdin!.end(JSON.stringify({
      session_id: sessionId, cwd, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command },
    }))
    return { child, done }
  }
  const card = (dial: FakeDial, since = 0): Promise<DialMessage> =>
    dial.next((m) => m.t === 'question' && String(m.id).startsWith('approval:'), 45_000, 'the approval card', since)
  /** The card answered as the dial's review screen answers it: read for its token, then the choice's mask. */
  const choose = async (dial: FakeDial, shown: DialMessage, mask: number): Promise<void> => {
    const agentId = String(shown.agentId)
    const since = dial.messages.length
    dial.send({ t: 'question.read', agentId, requestId: 'read-1' })
    const state = await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 15_000, 'the card\'s state', since)
    expect(state).toMatchObject({ ok: true, id: shown.id })
    dial.send({ t: 'answer.reviewed', agentId, token: state.token, requestId: 'review-1', choices: [mask] })
    const receipt = await dial.next((m) => m.t === 'answer.receipt' && m.requestId === 'review-1', 15_000, 'the receipt', since)
    expect(receipt).toMatchObject({ ok: true })
  }
  const closed = (dial: FakeDial, shown: DialMessage, since = 0): Promise<DialMessage> =>
    dial.next((m) => m.t === 'question.close' && m.agentId === shown.agentId && m.id === shown.id, 45_000, 'the card closing', since)

  it('no dial: the client prints nothing at once and exits 0, and no devices process was started', async () => {
    const { d } = await fresh()
    const run = await approve(d, 'in-orca', 'printf hi').done
    expect(run).toMatchObject({ stdout: '', code: 0 })
    expect(run.ms).toBeLessThan(AT_ONCE_MS)
    expect(devicesPids(d)).toEqual([])
  })

  it('the dial gets the card, and Allow prints the allow decision', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const client = approve(d, 'in-orca', 'printf hi')
    const shown = await card(dial)
    expect(shown.name).toBe('in-orca')
    expect(shown.questions).toEqual([{ key: 'approval', q: 'Allow Bash?\nprintf hi', options: ['Allow', 'Deny'], multi: false }])
    const roster = await showing(dial, 'the agent listed with its approval', (r) =>
      String(r.rows.find((row) => row.id === shown.agentId)?.caps ?? '').includes('a'))
    expect(roster.rows.find((row) => row.id === shown.agentId)).toMatchObject({ name: 'in-orca' })
    await choose(dial, shown, 1)
    expect(await client.done).toMatchObject({ stdout: ALLOW, code: 0 })
    await closed(dial, shown)
  })

  it('Deny prints the deny decision with its message', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const client = approve(d, 'in-orca', 'rm -rf build')
    const shown = await card(dial)
    await choose(dial, shown, 2)
    expect(await client.done).toMatchObject({ stdout: DENY, code: 0 })
    await closed(dial, shown)
  })

  it('killing the client closes the card', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const client = approve(d, 'in-orca', 'printf hi')
    const shown = await card(dial)
    // The person answered in the terminal: Claude Code kills its hook.
    client.child.kill('SIGKILL')
    await closed(dial, shown)
  })

  it('with a window open the client prints nothing at once', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const window = await LocalClient.connect(d)
    const since = dial.messages.length
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    window.send('app_panes', { agentIds: [], foreground: true })
    await showing(dial, 'the tab\'s list', (r) => r.end.tab === 't1', since)
    const run = await approve(d, 'in-orca', 'printf hi').done
    expect(run).toMatchObject({ stdout: '', code: 0 })
    expect(run.ms).toBeLessThan(AT_ONCE_MS)
    expect(dial.messages.some((m) => m.t === 'question' && String(m.id).startsWith('approval:'))).toBe(false)
    window.close()
  })

  it('the inbox route answers 503 with no dial, and holds a poll with one', async () => {
    const { d, desk } = await fresh()
    const sessionId = randomUUID()
    expect(await inboxPoll(d, sessionId)).toBe(503)
    await plugged(desk)
    // Held: no answer within a second; the devices would end it only after 25 s.
    await expect(inboxPoll(d, sessionId, AbortSignal.timeout(1_000))).rejects.toThrow(/abort/i)
  })
})
