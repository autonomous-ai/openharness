/**
 * The dial shows Claude Code waiting outside Harness (docs/specs/2026-11-13-device-claude-orca.md), on the real daemon: the
 * session's own hooks (the real hook/notify.mjs the daemon installed) tell where it runs and when its turns go, the
 * plugin's PermissionRequest hook runs the real `harness device claude asked`, and a fake dial on the desk
 * (harness/fakeDial.ts) shows what it is shown:
 * - the client prints nothing and exits at once, and with no dial nothing more happens: no devices process is started;
 * - with a dial, the agent waits with "<summary> · answer in Orca", also as a question the dial only shows (every answer
 *   to it refused, and asked again of a dial plugged in again), and the session's Stop ends the wait and closes it;
 * - the mod's inbox poll is refused with no dial and held with one.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'

/** At once, not a held hook's seconds: room for the CLI's own start on a loaded machine. */
const AT_ONCE_MS = 30_000
/** Orca's names for the terminal, as its hook reads them; its secrets sit beside them and must never leave the hook. */
const IN_ORCA = { ORCA_AGENT_SESSION_ID: 'e2e-orca-session', ORCA_PAIRING_CODE: 'pairing-e2e-4f1e', ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-e2e-8b2d' }

/** A POST of the mod's poll over the daemon's socket, as the mod sends it: its status once answered. */
const inboxPoll = (d: IsolatedDaemon, sessionId: string, signal?: AbortSignal): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: d.socketPath, path: '/api/hook/inbox', method: 'POST', headers: { 'Content-Type': 'application/json' }, signal },
      (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', reject)
    req.end(JSON.stringify({ sessionId }))
  })

/** Claude Code in an Orca terminal, outside Harness: no tmux pane, no Harness pane, and Orca's own variables. */
class InOrca {
  readonly sessionId = randomUUID()
  readonly cwd: string
  constructor(private readonly d: IsolatedDaemon, folder: string, private readonly children: ChildProcess[]) {
    this.cwd = join(d.projectsDir, folder)
    mkdirSync(this.cwd, { recursive: true })
  }

  get id(): string { return observedAgentId('claude', this.sessionId) }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.d.env, ...IN_ORCA }
    for (const name of ['TMUX', 'TMUX_PANE', 'HARNESS_PANE']) delete env[name]
    return env
  }

  private run(file: string, args: string[], input: Record<string, unknown>, cwd = this.cwd): Promise<{ stdout: string; stderr: string; code: number | null; ms: number }> {
    const started = Date.now()
    const child = spawn(file, args, { cwd, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.children.push(child)
    let stdout = '', stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const done = new Promise<{ stdout: string; stderr: string; code: number | null; ms: number }>((resolve) =>
      child.once('exit', (code) => resolve({ stdout, stderr, code, ms: Date.now() - started })))
    child.stdin!.end(JSON.stringify({ session_id: this.sessionId, cwd: this.cwd, ...input }))
    return done
  }

  /** Its own hook for [event], the command the daemon installed in Claude Code's settings, run through a shell as Claude
   *  Code runs it. */
  async hook(event: 'SessionStart' | 'UserPromptSubmit' | 'Stop', fields: Record<string, unknown> = {}): Promise<void> {
    const settings = join(this.d.env.HOME!, '.claude', 'settings.json')
    const command = await until(`the ${event} hook in Claude Code's settings`, () => {
      try {
        const blocks = (JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> }).hooks?.[event] ?? []
        return blocks.flatMap((block) => block.hooks ?? []).map((hook) => hook.command).find((line) => line?.includes('notify.mjs'))
      } catch {
        return undefined
      }
    }, 30_000, 100)
    const run = await this.run('/bin/sh', ['-c', command], { hook_event_name: event, ...fields })
    expect(run.code, run.stderr).toBe(0)
  }

  /** The plugin's PermissionRequest hook: the real CLI, from the run's bundle or the sources as the daemon is started. */
  asked(command: string) {
    // The plugin as `claude plugin install` leaves it: its entry in the user settings, which `asked` reads before it tells
    // (`harness device claude disable` drops it). Beside the hooks the daemon installed there.
    const settings = join(this.d.env.HOME!, '.claude', 'settings.json')
    const current = JSON.parse(readFileSync(settings, 'utf8')) as { enabledPlugins?: Record<string, boolean> }
    writeFileSync(settings, JSON.stringify({ ...current, enabledPlugins: { ...current.enabledPlugins, 'harness-device@openharness': true } }))
    const bundle = process.env.E2E_BUNDLE_PATH
    const script = bundle ? [bundle] : ['--import', 'tsx', 'src/cli.ts']
    // From the CLI's folder, where tsx resolves; the session's folder is the input's.
    return this.run(process.execPath, [...script, 'device', 'claude', 'asked'], {
      hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command, description: 'Say hi' },
    }, CLI_ROOT)
  }
}

describe('the dial shows Claude Code waiting outside Harness', () => {
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
  /** What the dial was told the agent's line is, from [since]. */
  const line = (dial: FakeDial, agentId: string, text: string, what: string, since = 0): Promise<DialMessage> =>
    dial.next((m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === agentId && m.text === text, 45_000, what, since)

  it('no dial: the client prints nothing at once and exits 0, and no devices process is started', async () => {
    const { d } = await fresh()
    const claude = new InOrca(d, 'in-orca', children)
    await claude.hook('SessionStart', { source: 'startup' })
    const run = await claude.asked('printf hi')
    expect(run).toMatchObject({ stdout: '', stderr: '', code: 0 })
    expect(run.ms).toBeLessThan(AT_ONCE_MS)
    expect(devicesPids(d)).toEqual([])
  })

  it('the dial shows the agent waiting with "printf hi · answer in Orca", as a question nothing answers, and its Stop ends the wait', async () => {
    const { d, desk } = await fresh()
    let dial = await plugged(desk)
    const claude = new InOrca(d, 'in-orca', children)
    await claude.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'agent' && m.id === claude.id, 45_000, 'the agent listed')
    await claude.hook('UserPromptSubmit', { prompt: 'say hi' })
    await line(dial, claude.id, '', 'its turn started')
    const since = dial.messages.length
    const run = await claude.asked('printf hi')
    expect(run).toMatchObject({ stdout: '', stderr: '', code: 0 })
    expect(run.ms).toBeLessThan(AT_ONCE_MS)
    await line(dial, claude.id, 'printf hi · answer in Orca', 'the waiting line', since)
    // The round dial's asking face draws it from a question, which the dial only shows.
    const shown = [{ key: 'prompt', q: 'printf hi · answer in Orca', options: ['In Orca'] }]
    const question = await dial.next((m) => m.t === 'question' && m.agentId === claude.id, 45_000, 'the question', since)
    expect(question).toEqual({ t: 'question', agentId: claude.id, name: 'in-orca', engine: 'claude', machine: expect.any(String),
      id: expect.stringMatching(/^shown:/), questions: shown })
    // Nothing for the dial to answer with: no `a` on its row, and an answer, a reviewed one or spoken words are refused.
    expect(dial.messages.filter((m) => m.t === 'agent' && m.id === claude.id).map((row) => row.caps)).not.toContainEqual(expect.stringContaining('a'))
    const tried = dial.messages.length
    dial.send({ t: 'answer', agentId: claude.id, requestId: question.id, answers: { prompt: 'In Orca' } })
    dial.send({ t: 'question.read', agentId: claude.id, requestId: 'read-1' })
    const state = await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the question read', tried)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: shown })
    dial.send({ t: 'answer.reviewed', agentId: claude.id, requestId: 'send-1', token: state.token, choices: [1] })
    expect(await dial.next((m) => m.t === 'answer.receipt' && m.requestId === 'send-1', 45_000, 'the refusal', tried))
      .toMatchObject({ ok: false, error: 'Answer it in Orca.' })
    dial.send({ t: 'voice.begin', agentId: claude.id, questionToken: state.token, questionIndex: 0, uploadId: 'spoken-1' })
    dial.send({ t: 'voice.end', uploadId: 'spoken-1' })
    await dial.next((m) => m.t === 'voice.error' && m.uploadId === 'spoken-1', 45_000, 'the spoken refusal', tried)
    // A dial plugged in again is shown it again, after the drawer that clears its own.
    await desk.unplug('E2E-A')
    dial = await plugged(desk)
    await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer')
    const drawer = dial.messages.findIndex((m) => m.t === 'notif.replace')
    expect(await dial.next((m) => m.t === 'question' && m.agentId === claude.id, 45_000, 'the question again', drawer + 1)).toMatchObject({ id: question.id, questions: shown })
    // Orca's secrets never left the hook.
    expect(JSON.stringify(dial.messages)).not.toMatch(/pairing-e2e|spawn-e2e/)
    // Answered in Orca, the turn goes to its end: the session's Stop.
    const answered = dial.messages.length
    await claude.hook('Stop', { stop_hook_active: false })
    await dial.next((m) => m.t === 'question.close' && m.agentId === claude.id && m.id === question.id, 45_000, 'the question closed', answered)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === claude.id, 45_000, 'its turn done', answered)
    expect(dial.messages.slice(answered).some((m) => m.agentId === claude.id && m.text === 'printf hi · answer in Orca')).toBe(false)
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
