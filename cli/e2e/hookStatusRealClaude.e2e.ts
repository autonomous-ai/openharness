/**
 * Hook-driven agent status with the real Claude Code, opt-in: it spends real model turns, so only a person or the
 * tester runs it, once, on a Mac with a signed-in Claude profile (docs/plans/2026-11-16-hook-driven-agent-status-plan.md,
 * Verification check 7):
 *
 *   E2E_REAL_CLAUDE="$(command -v claude)" E2E_CLAUDE_PROFILE="$CLAUDE_CONFIG_DIR" E2E_BUNDLE=1 TMPDIR=/tmp \
 *     npx vitest run --config vitest.e2e.config.ts e2e/hookStatusRealClaude.e2e.ts
 *
 * Claude Code runs in a pane of an `IsolatedDaemon` (throwaway root, own port, private tmux, signed out), signed in
 * through the profile and nothing more, as the dial skill eval runs it: `--setting-sources project` keeps the profile's
 * own hooks, which call the person's daemon and Orca, from loading, and `--settings` gives it the isolated daemon's hooks
 * alone. The profile's `settings.json` is the same before and after; `~/.claude`, `~/.codex` and `~/.harness` are never
 * named.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { assertHooksContained, IsolatedDaemon, until } from './harness/daemon.js'

const REAL_CLAUDE = process.env.E2E_REAL_CLAUDE ?? ''
const PROFILE = askedProfile()

/** The profile Claude Code signs in through. Asked for with no profile, or with the default one, it throws before
 *  anything starts: Claude Code would fall back to, or be pointed at, the person's own `~/.claude`. */
function askedProfile(): string {
  const profile = process.env.E2E_CLAUDE_PROFILE ?? ''
  if (!REAL_CLAUDE) return profile
  if (!profile) throw new Error('E2E_REAL_CLAUDE is set without E2E_CLAUDE_PROFILE: name the session\'s Claude profile, never the default ~/.claude')
  // The account's own home: vitest.setup.ts points HOME at a throwaway folder.
  const defaults = new Set([join(userInfo().homedir, '.claude'), join(homedir(), '.claude')])
  const named = resolve(profile)
  const real = existsSync(named) ? realpathSync(named) : named
  if (defaults.has(named) || defaults.has(real)) throw new Error(`E2E_CLAUDE_PROFILE is ${profile}: the default ~/.claude is never used`)
  return named
}

/** Each case's bound, its agent's start included. */
const CASE_MS = 180_000
const TURN_MS = 120_000
/** The person's own daemon's port: nothing here may name it. */
const PERSONAL_PORT = 18473
/** The recaps' quiet window before Finished (DONE_QUIET_MS). */
const QUIET_MS = 1_500
/** turn_ended and Finished cross the same socket but leave the daemon from different processes: how far apart their
 *  arrival may drift from when each was sent. */
const FRAME_SKEW_MS = 100
/** The daemon prints its turn-stop line before it sends the end; the line crosses its output pipe, the end the socket. */
const PIPE_SKEW_MS = 100
/** A wait's question shows at the question watcher's next poll (1.5 s), with room for that poll's own read. */
const QUESTION_AFTER_WAIT_MS = 3_000
/** The eval's list: a run never reaches the person's mail, calendar, documents or phone. */
const DENIED = ['PushNotification', 'RemoteTrigger', 'DesignSync',
  'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Calendar', 'mcp__claude_ai_Microsoft_365', 'mcp__claude_ai_Claude_Docs']
const TRUST = /Yes, I trust this folder/
const PERMISSION_DIALOG = /Do you want to proceed\?/

const sha256 = (file: string): string => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent'
const readIf = (file: string): string => { try { return readFileSync(file, 'utf8') } catch { return '' } }
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
/** The folder Claude Code keeps a working folder's transcripts in, under its home's `projects` (the eval's rule). */
const projectFolders = (cwd: string): string[] =>
  [...new Set([cwd, realpathSync(cwd)])].map((path) => join(PROFILE, 'projects', path.replace(/[^a-zA-Z0-9]/g, '-')))

/** The wrapper the daemon runs as Claude Code. The daemon's launch gives a `--settings` of its own (its status line and
 *  attribution) and Claude Code keeps only the last one, so it is folded into ours rather than given beside it; nothing
 *  is ever merged by writing the profile. A `--setting-sources` from the daemon would undo ours: refused, noted.
 *  It replaces itself with Claude Code (execve), so the pane's process is Claude Code's, as on a person's computer. */
const wrapperSource = (dir: string) => `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs')
const ours = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'flags.json'))}, 'utf8'))
const args = process.argv.slice(2)
const kept = []
const theirs = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--') { kept.push(...args.slice(i)); break }
  if (arg === '--setting-sources' || arg.startsWith('--setting-sources=')) {
    appendFileSync(${JSON.stringify(join(dir, 'refused.log'))}, 'the daemon\\'s launch passes --setting-sources\\n')
    process.exit(2)
  }
  if (arg === '--settings') { theirs.push(args[++i]); continue }
  if (arg.startsWith('--settings=')) { theirs.push(arg.slice('--settings='.length)); continue }
  kept.push(arg)
}
const read = (value) => JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(value, 'utf8'))
const settings = Object.assign({}, ...theirs.map(read), ours)
const real = ${JSON.stringify(REAL_CLAUDE)}
process.execve(real, [real, '--setting-sources', 'project', '--settings', JSON.stringify(settings), ...kept], {
  ...process.env,
  CLAUDE_CONFIG_DIR: ${JSON.stringify(PROFILE)},
  // The daemon's PATH has a security that refuses (e2e/harness/daemon.ts), and Claude Code reads its sign-in from the
  // Keychain with security by name: the system's, for Claude Code alone.
  PATH: ${JSON.stringify(join(dir, 'system'))} + ':' + process.env.PATH,
})
`

type Row = Record<string, any>
type Arrival = { frame: Frame; at: number }
/** When a frame arrived: a waiter registered before it comes resolves as it is read. */
const arrival = (frame: Promise<Frame>): Promise<Arrival> => frame.then((value) => ({ frame: value, at: Date.now() }))
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
const working = (agentId: string) => (frame: Frame) => isTurn('agent_activity', agentId)(frame) && frame.payload?.activity?.state === 'working'
const notified = (agentId: string) => (frame: Frame) => isTurn('turn_summary', agentId)(frame) && !!frame.payload?.notification

describe.runIf(REAL_CLAUDE && PROFILE)('hook-driven status with the real Claude Code', () => {
  let d: IsolatedDaemon
  let client: LocalClient
  let dir: string
  let settingsBefore: string
  const folders: string[] = []
  const profileSettings = join(PROFILE, 'settings.json')

  const rows = async (): Promise<Row[]> => (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
  /** A round trip that follows every frame awaited before it: "not since" is read after it. */
  const fence = () => rows()
  const daemonSettings = () => join(d.env.HOME!, '.claude', 'settings.json')

  /** Each installed hook names this daemon's port, or none and the pane sets it; never the person's daemon's. */
  function assertHooksPointHere(): Record<string, unknown> {
    const hooks = (JSON.parse(readFileSync(daemonSettings(), 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; args?: string[] }> }>> }).hooks ?? {}
    const commands = Object.values(hooks).flat().flatMap((block) => block.hooks ?? [])
      .filter((hook) => typeof hook.command === 'string').map((hook) => [hook.command, ...(hook.args ?? [])].join(' '))
    expect(commands.length, 'the daemon installed Claude Code hooks').toBeGreaterThan(0)
    for (const command of commands) {
      expect(command, 'a hook names the person\'s daemon\'s port').not.toContain(String(PERSONAL_PORT))
      const port = /--port['"]?\s+['"]?(\d+)/.exec(command)?.[1]
      if (port) expect([d.port, d.configuredPort], `a hook names another daemon's port: ${command}`).toContain(Number(port))
    }
    return hooks
  }

  beforeAll(async () => {
    settingsBefore = sha256(profileSettings)
    dir = mkdtempSync(join(tmpdir(), 'hsrc-'))
    mkdirSync(join(dir, 'system'))
    if (existsSync('/usr/bin/security')) symlinkSync('/usr/bin/security', join(dir, 'system', 'security'))
    // The daemon may ask its Claude Code for its version before its hooks are in: the deny list from the start.
    writeFileSync(join(dir, 'flags.json'), JSON.stringify({ permissions: { deny: DENIED } }))
    writeFileSync(join(dir, 'claude'), wrapperSource(dir), { mode: 0o755 })
    d = await IsolatedDaemon.create({ env: { HOOK_INSTALL_ENGINES: 'claude', CLAUDE_PATH: join(dir, 'claude') } })
    await d.start()
    expect([d.port, d.configuredPort]).not.toContain(PERSONAL_PORT)
    writeFileSync(join(dir, 'flags.json'), JSON.stringify({ hooks: assertHooksPointHere(), permissions: { deny: DENIED } }))
    client = await LocalClient.connect(d)
  }, CASE_MS)

  afterAll(async () => {
    try {
      if (d) {
        assertHooksContained(d.root, d.env)
        assertHooksPointHere()
      }
    } finally {
      client?.close()
      await d?.close()
      // What Claude Code made for these folders in the profile, as the eval removes its own; nothing else of it.
      for (const folder of folders) rmSync(folder, { recursive: true, force: true })
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
    expect(sha256(profileSettings), `${profileSettings} changed`).toBe(settingsBefore)
  }, CASE_MS)

  /** A Claude Code agent in ask mode, in a fresh git folder of the daemon's, bound to its conversation. */
  async function create(name: string): Promise<Row> {
    const cwd = join(d.projectsDir, name)
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd, env: d.env })
    folders.push(...projectFolders(cwd))
    onTestFailed(async () => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      const agent = (await rows().catch(() => [])).find((row) => row.cwd === cwd || row.project?.cwd === cwd)
      if (agent?.tmuxPane) console.log(`---- pane\n${await d.capture(agent.tmuxPane).catch(String)}`)
    })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: false }, 90_000)
    expect(created.error, `${name}: ${JSON.stringify(created)}`).toBeUndefined()
    const agent = await until(`${name} to bind its conversation`, async () => {
      const now = (await rows()).find((row) => row.id === created.agent.id)
      // Claude Code asks whether to trust a folder the profile has not seen: the person's answer, given in the pane.
      if (now?.tmuxPane && TRUST.test(await d.capture(now.tmuxPane))) await d.tmux.run('send-keys', '-t', now.tmuxPane, 'Enter')
      return now?.sessionId && now.status === 'active' ? now : null
    }, 60_000, 500).catch((error: Error) => {
      const kept = projectFolders(cwd).filter((folder) => existsSync(folder) && readdirSync(folder).some((file) => file.endsWith('.jsonl')))
      // Nothing in the profile is changed to make it pass.
      throw new Error(kept.length
        ? `the daemon did not take ${name}'s session: its transcript is under the profile (${kept.join(', ')}), not the daemon's Claude Code projects folder`
        : error.message)
    })
    expect(readIf(join(dir, 'refused.log')), 'the daemon\'s launch').toBe('')
    return agent
  }

  /** The agent's transcript in the profile, or '' when Claude Code wrote none there. */
  function transcript(agent: Row): string {
    const cwd = agent.project?.cwd ?? agent.cwd
    for (const folder of projectFolders(cwd)) {
      const text = readIf(join(folder, `${agent.sessionId}.jsonl`))
      if (text) return text
    }
    return ''
  }

  async function answer(agentId: string, question: Frame, pick: RegExp): Promise<Record<string, any>> {
    const shaped = question.payload!.questions[0] as { q: string; options: string[] }
    const option = shaped.options.find((label) => pick.test(label))
    expect(option, `an option matching ${pick} in ${JSON.stringify(shaped.options)}`).toBeDefined()
    const requestId = question.payload!.requestId as string
    const reply = client.next((frame) => frame.type === 'question_response_result' && frame.payload?.requestId === requestId, 45_000, 'question_response_result')
    client.send('question_response', { requestId, agentId, answers: { [shaped.q]: option } })
    return (await reply).payload as Record<string, any>
  }

  /** A wait on the person: not working from the wait hook, before its question; the question within 3 s of the hook;
   *  working again once answered; one turn_ended. Returns when the agent stopped reading as working. */
  async function waitsOnThePerson(agent: Row, prompt: string, pick: RegExp): Promise<number> {
    const since = client.frames.length
    const started = () => client.frames.slice(since).some(isTurn('turn_started', agent.id))
    // Sent at once at the wait hook (R4); a not-working state before the turn started is the last turn's.
    const waited = arrival(client.next((frame) => isTurn('agent_activity', agent.id)(frame) && frame.payload?.activity?.state !== 'working' && started(),
      TURN_MS, 'the agent to stop reading as working'))
    const asked = arrival(client.next(isTurn('commander_question', agent.id), TURN_MS, 'the question'))
    client.send('message', { agentId: agent.id, content: prompt })
    const [wait, question] = await Promise.all([waited, asked])
    expect(client.frames.indexOf(wait.frame), 'not working before the question').toBeLessThan(client.frames.indexOf(question.frame))
    expect(question.at - wait.at, 'the question after the wait hook, ms').toBeLessThanOrEqual(QUESTION_AFTER_WAIT_MS)
    const from = client.frames.length
    const ended = client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended once answered')
    const result = await answer(agent.id, question.frame, pick)
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    const end = await ended
    expect(client.frames.slice(from, client.frames.indexOf(end)).some(working(agent.id)), 'working again once answered').toBe(true)
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
    return wait.at
  }

  it('a normal turn ends at its Stop, and Finished comes once, no sooner than 1.5 s after', async () => {
    const agent = await create('normal')
    const since = client.frames.length
    const stopLine = `[hooks] ${String(agent.sessionId).slice(0, 8)} turn-stop`
    const logFrom = d.log().length
    const stop = { at: 0 }
    // Timed as the daemon prints it; the harness's own listener has already added it to the log.
    const seen = () => { if (!stop.at && d.log().includes(stopLine, logFrom)) stop.at = Date.now() }
    d.child!.stdout!.on('data', seen)
    d.child!.stderr!.on('data', seen)
    try {
      const ended = arrival(client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended'))
      const finished = arrival(client.next(notified(agent.id), TURN_MS, 'Finished'))
      client.send('message', { agentId: agent.id, content: 'Reply with the single word ready.' })
      const end = await ended
      await until('the daemon\'s turn-stop line', () => stop.at, 10_000, 20)
      expect(stop.at, 'turn_ended after the Stop hook').toBeLessThanOrEqual(end.at + PIPE_SKEW_MS)
      const done = await finished
      expect(done.at - end.at, 'Finished after the turn ended, ms').toBeGreaterThanOrEqual(QUIET_MS - FRAME_SKEW_MS)
      await fence()
      const after = client.frames.slice(since)
      expect(after.filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
      expect(after.filter(notified(agent.id))).toHaveLength(1)
      expect(client.frames.slice(client.frames.indexOf(end.frame)).filter(working(agent.id)), 'working after the turn ended').toEqual([])
    } finally {
      d.child?.stdout?.off('data', seen)
      d.child?.stderr?.off('data', seen)
    }
  }, CASE_MS)

  it('a permission: not working from the wait hook, the question at the next poll, working again once answered', async () => {
    const agent = await create('permission')
    // Polled from the prompt: when Claude Code drew its dialog, against when its wait hook ran.
    const drawn = until('the permission dialog in the pane', async () => PERMISSION_DIALOG.test(await d.capture(agent.tmuxPane)) && Date.now(), TURN_MS, 50)
    drawn.catch(() => { /* awaited below */ })
    const waitAt = await waitsOnThePerson(agent, 'Run the shell command date and tell me what it printed.', /^Yes/)
    // Task 1's Notification verdict, measured on the real engine; negative: the hook ran before the dialog was drawn.
    console.log(`[real claude] permission dialog first captured to the wait hook: ${waitAt - await drawn} ms`)
  }, CASE_MS)

  it('AskUserQuestion: the same', async () => {
    const agent = await create('ask')
    await waitsOnThePerson(agent, 'Use the AskUserQuestion tool to ask me to pick red or blue, then tell me which I picked.', /red/i)
  }, CASE_MS)

  it('Esc typed in the pane ends the turn as aborted, and nothing is announced', async () => {
    const agent = await create('esc')
    const isWorking = client.next(working(agent.id), TURN_MS, 'the agent to read as working')
    client.send('message', { agentId: agent.id, content: 'Write sixty numbered lines about tides.' })
    await isWorking
    const since = client.frames.length
    const ended = client.next(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended after Esc')
    await d.tmux.run('send-keys', '-t', agent.tmuxPane, 'Escape')
    expect((await ended).payload?.aborted).toBe(true)
    // Nothing announced can only be shown once the quiet window it would have come after is over.
    await sleep(QUIET_MS * 3)
    await fence()
    expect(client.frames.slice(since).filter(notified(agent.id))).toEqual([])
  }, CASE_MS)

  it('a background subagent keeps the lead working past its Stop, and the turn ends once after it stops', async (ctx) => {
    const agent = await create('subagent')
    const since = client.frames.length
    client.send('message', { agentId: agent.id, content: 'With the Task tool, start one background subagent that writes a 300-word poem. Reply started and end your turn.' })
    const end = await client.waitFor(isTurn('turn_ended', agent.id), TURN_MS, 'turn_ended', since)
    // Claude Code records a background launch as `async_launched` in the lead's transcript (engines/claude/normalize.ts).
    if (!transcript(agent).includes('"async_launched"')) ctx.skip('the model started no background subagent')
    const finished = client.frames.slice(since).find(isTurn('subagent_finished', agent.id))
    expect(finished && client.frames.indexOf(finished) < client.frames.indexOf(end), 'no turn_ended while the subagent runs').toBe(true)
    await fence()
    expect(client.frames.slice(since).filter(isTurn('turn_ended', agent.id))).toHaveLength(1)
  }, CASE_MS)
})
