/**
 * A second look when a turn stops (docs/plans/2026-11-26-needs-you-right-design.md, Part 5), on the real daemon with the
 * hooks the devices' setup carries: a fake dial on the desk makes the first attach set Claude Code and Codex up, as
 * deviceStartLine.e2e.ts does, and the test runs each session's two Stop hooks as the engine runs them: Harness's own
 * (the real hook/notify.mjs the daemon installed, through InOrca and CodexOutside) and the plugin's carried
 * `hooks/stop` or `hooks/codex-stop` command, through `/bin/sh -c` with the Stop input on stdin, which runs the real
 * `harness device claude stop` or `codex stop` from the launcher in the test's home. No engine runs: the test writes
 * each answer to the session's transcript and stands in for the continuation a block starts.
 *
 * Absence is shown against an anchor: a second session B, with no question, stops at the same moment, and its told
 * summary is the barrier. Unless a case says otherwise, A has reported once in an earlier turn, so its stops wait for
 * their reports (decision 18):
 * - the person away, a question ends the turn: one block, the first end not told, the notice rings once and the
 *   continuation's end is told once, silent, for Claude Code and for Codex, whichever hook comes first;
 * - no question, the person there, a notice rung in the turn, no dial, or a second look before the person's next
 *   prompt: nothing printed, and the devices' one word for it;
 * - a block the engine lost: its end told once, when the hold goes quiet;
 * - a late report holds the end until it comes; no report: told at 6 s, and the session no longer waited for; a
 *   session that never reported rests on the grace, as before.
 * No daemon log line holds an answer's words or a session id.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { CONTINUE_MAX_MS, CONTINUE_QUIET_MS, REPORT_WAIT_MS } from '../src/cable/hosts/observed.js'
import { harnessPath, thisComputer } from '../src/config/harnessHome.js'
import { stopOutput } from '../src/deviceClaude/stop.js'
import { DIAL_PLUGIN_ID } from '../src/devices/dialSkill.js'
import { tellDevices } from '../src/devices/listenerClient.js'
import { LocalClient } from './harness/client.js'
import { CodexOutside } from './harness/codexOutside.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { fileBundle } from './harness/fileBundle.js'
import { InOrca } from './harness/inOrca.js'

// The daemons and the commands on a build: from the sources the CLI carries no plugin to set up.
const bundle = fileBundle()

type Engine = 'claude' | 'codex'
type Run = { code: number | null; stdout: string; stderr: string }
type StopFields = { stop_hook_active: boolean; last_assistant_message: string }

/** In every answer and notice, so a log line that holds one is found. */
const CANARY = 'PRIVATE_ANSWER_CANARY'
const LINE = `${CANARY} needs the export database picked`
const quiet: Run = { code: 0, stdout: '', stderr: '' }
const blocked: Run = { code: 0, stdout: `${stopOutput()}\n`, stderr: '' }

const skillOf = (home: string): string => join(home, 'skills', 'dial', 'SKILL.md')
/** The plugin folder the setup carries, in Harness's marketplace folder for the daemon's home. */
const carried = (d: IsolatedDaemon): string =>
  join(harnessPath('claude-marketplace', d.env.HOME!, process.platform, thisComputer(d.env)), 'plugins', 'harness-device')
/** The daemon's Claude Code home, which a Claude Code session hands its hooks as CLAUDE_CONFIG_DIR. */
const claudeHomeOf = (d: IsolatedDaemon): string => dirname(d.env.CLAUDE_PROJECTS_DIR!)
/** The carried manifest's Stop command for [engine]. */
const stopCommand = (d: IsolatedDaemon, engine: Engine): string => {
  const manifest = JSON.parse(readFileSync(join(carried(d), 'hooks', engine === 'claude' ? 'hooks.json' : 'codex.json'), 'utf8')) as
    { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }
  return manifest.hooks.Stop[0]!.hooks[0]!.command
}

/** One session, Claude Code or Codex, as its engine would drive it. */
interface Session {
  readonly id: string
  readonly sessionId: string
  readonly cwd: string
  /** What `harness device notify` reads its caller from, in this session's shell. */
  readonly caller: Record<string, string>
  start(): Promise<void>
  /** The person's prompt: written to its transcript, and its UserPromptSubmit hook. */
  prompt(text: string): Promise<void>
  /** Its answer, written to its transcript as the engine writes it before the Stop. */
  answer(text: string): void
  /** Harness's own Stop hook. */
  stop(fields: StopFields): Promise<void>
  /** The plugin's Stop hook, the carried command, as the engine runs it. */
  look(fields: StopFields): Promise<Run>
}

describe('a second look when a turn stops', () => {
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

  /** A child's exit and its output, with [stdin] written whole. */
  function run(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin = ''): Promise<Run> {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = '', stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const done = new Promise<Run>((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr })))
    child.stdin!.end(stdin)
    return done
  }

  /** Claude Code in an Orca terminal, its transcript in the daemon's Claude Code projects, where the answer is read. */
  function claudeSession(d: IsolatedDaemon, folder: string): Session {
    const s = new InOrca(d, folder, children)
    const transcript = join(d.env.CLAUDE_PROJECTS_DIR!, `-e2e-${folder}`, `${s.sessionId}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, '')
    let parent: string | null = null
    const write = (record: Record<string, unknown>): void => {
      const uuid = randomUUID()
      appendFileSync(transcript, `${JSON.stringify({ parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'cli',
        cwd: s.cwd, sessionId: s.sessionId, version: '2.1.287', timestamp: new Date().toISOString(), uuid, ...record })}\n`)
      parent = uuid
    }
    return {
      id: s.id, sessionId: s.sessionId, cwd: s.cwd,
      caller: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: s.sessionId },
      start: () => s.hook('SessionStart', { source: 'startup', transcript_path: transcript }),
      prompt: async (text) => {
        write({ type: 'user', message: { role: 'user', content: text } })
        await s.hook('UserPromptSubmit', { prompt: text, transcript_path: transcript })
      },
      answer: (text) => write({ type: 'assistant', message: { id: `msg_${randomUUID()}`, role: 'assistant', model: 'claude-e2e',
        content: [{ type: 'text', text }], stop_reason: 'end_turn' } }),
      stop: (fields) => s.hook('Stop', { transcript_path: transcript, permission_mode: 'default', ...fields }),
      // Claude Code puts the plugin's folder in place of `${CLAUDE_PLUGIN_ROOT}`, hands CLAUDE_CONFIG_DIR, and names its
      // TUI in CLAUDE_CODE_ENTRYPOINT.
      look: (fields) => run('/bin/sh', ['-c', stopCommand(d, 'claude').replaceAll('${CLAUDE_PLUGIN_ROOT}', carried(d))],
        { ...s.env, CLAUDE_CONFIG_DIR: claudeHomeOf(d), CLAUDE_CODE_ENTRYPOINT: 'cli' }, s.cwd,
        JSON.stringify({ session_id: s.sessionId, transcript_path: transcript, cwd: s.cwd, hook_event_name: 'Stop', permission_mode: 'default', ...fields })),
    }
  }

  /** Codex in Ghostty, its rollout in the daemon's Codex home (a TUI's: its head's source is not `exec`). */
  function codexSession(d: IsolatedDaemon, folder: string): Session {
    const c = new CodexOutside(d, folder, children, { TERM_PROGRAM: 'ghostty' })
    let turnId = randomUUID()
    const write = (payload: Record<string, unknown>): void =>
      appendFileSync(c.transcriptPath, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload })}\n`)
    return {
      id: c.id, sessionId: c.sessionId, cwd: c.cwd,
      caller: { CODEX_THREAD_ID: c.sessionId },
      start: () => c.hook('SessionStart', { source: 'startup' }),
      prompt: async (text) => {
        turnId = randomUUID()
        write({ type: 'user_message', message: text })
        await c.hook('UserPromptSubmit', { prompt: text, turn_id: turnId })
      },
      answer: (text) => write({ type: 'agent_message', message: text }),
      stop: (fields) => c.hook('Stop', { turn_id: turnId, ...fields }),
      // Codex sets PLUGIN_ROOT.
      look: (fields) => run('/bin/sh', ['-c', stopCommand(d, 'codex')], { ...c.env, PLUGIN_ROOT: carried(d) }, c.cwd,
        JSON.stringify({ session_id: c.sessionId, turn_id: turnId, transcript_path: c.transcriptPath, cwd: c.cwd, hook_event_name: 'Stop',
          model: 'probe-model', permission_mode: 'default', ...fields })),
    }
  }

  /**
   * A daemon whose first attach set [engine] up with the plugin on, a launcher in its home, and two sessions of [engine]
   * listed on the dial: A and the anchor B. The person is away: VS Code in front and the dial on B.
   */
  async function attached(engine: Engine): Promise<{ d: IsolatedDaemon; dial: FakeDial; a: Session; b: Session }> {
    const d = await IsolatedDaemon.create({ scriptPath: bundle.path, env: { CABLE_DISABLE: 'false' }, claudeVersion: '2.1.287' })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await theDesk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    launcher(d)
    if (engine === 'claude') {
      const claudeHome = claudeHomeOf(d)
      await until('Claude Code\'s skill', () => existsSync(skillOf(claudeHome)), 45_000, 100)
      await until('the carried Claude Code Stop hook', () => existsSync(join(carried(d), 'hooks', 'stop')), 45_000, 100)
      // The plugin as `claude plugin install` leaves it: its entry in the user settings.
      const settings = join(claudeHome, 'settings.json')
      const current = JSON.parse(readFileSync(settings, 'utf8')) as { enabledPlugins?: Record<string, boolean> }
      writeFileSync(settings, JSON.stringify({ ...current, enabledPlugins: { ...current.enabledPlugins, [DIAL_PLUGIN_ID]: true } }))
    } else {
      // The fake Codex is older than MIN_CODEX, so the setup writes no plugin table: the test writes it.
      const codexHome = d.env.CODEX_HOME!
      await until('Codex\'s skill', () => existsSync(skillOf(codexHome)), 45_000, 100)
      await until('the carried Codex Stop hook', () => existsSync(join(carried(d), 'hooks', 'codex-stop')), 45_000, 100)
      writeFileSync(join(codexHome, 'config.toml'), `[plugins."${DIAL_PLUGIN_ID}"]\nenabled = true\n`)
    }
    const session = engine === 'claude' ? claudeSession : codexSession
    const a = session(d, 'stop-look-a')
    const b = session(d, 'stop-look-b')
    for (const s of [a, b]) {
      await s.start()
      await dial.next((m) => m.t === 'agent' && m.id === s.id, 45_000, 'the session listed')
    }
    await withFront(d, dial, 'vscode', b)
    return { d, dial, a, b }
  }

  /** `~/.local/bin/harness` as the installer leaves it, where the hooks look first: the file's bundle. */
  function launcher(d: IsolatedDaemon): void {
    const bin = join(d.env.HOME!, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'harness'), `#!/bin/sh\nexec '${process.execPath}' '${bundle.path}' "$@"\n`, { mode: 0o755 })
  }

  /** The app in front, as `harness hardware watch` tells the devices' listener, and the dial turned to [shown]; the list
   *  asked after it is the barrier: the turn is taken once the list's end comes back. */
  async function withFront(d: IsolatedDaemon, dial: FakeDial, app: string, shown: Session): Promise<void> {
    expect(await tellDevices(d.dataDir, { type: 'front', app })).toBe(true)
    dial.send({ t: 'focus', agentId: shown.id })
    const since = dial.messages.length
    dial.send({ t: 'agents.list' })
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the list after the turn', since)
  }

  /** The real `harness device notify`, run as the session's shell runs it. */
  const notify = (d: IsolatedDaemon, s: Session): Promise<Run> =>
    run(process.execPath, [bundle.path, 'device', 'notify', LINE], { ...d.env, TMUX_PANE: '', ...s.caller }, s.cwd)

  const of = (dial: FakeDial, s: Session, t: string, since: number): DialMessage[] =>
    dial.messages.slice(since).filter((m) => m.t === t && m.agentId === s.id)
  const summaryOf = (dial: FakeDial, s: Session, since: number, ms = 45_000): Promise<DialMessage> =>
    dial.next((m) => m.t === 'summary' && m.agentId === s.id, ms, 'its summary', since)
  /** When [message] reached the dial. */
  const arrived = (dial: FakeDial, message: DialMessage): number => dial.arrivedAt[dial.messages.indexOf(message)]!

  /** The devices' words for each report so far, in order: `yes`, `no ask`, `no dial`, `notice`, `present`, `nudged`. */
  const nudges = (d: IsolatedDaemon): string[] =>
    d.log().split('\n').flatMap((line) => /\[device\] nudge · (?:claude|codex) · ([a-z ]+)$/.exec(line)?.[1] ?? [])
  /** The words of the reports after [before], once as many as [words] are logged. */
  async function reported(d: IsolatedDaemon, before: number, words: string[]): Promise<void> {
    await until('the reports in the daemon\'s log', () => nudges(d).length >= before + words.length || null, 30_000, 50)
    expect(nudges(d).slice(before)).toEqual(words)
  }
  const silentByNotice = (d: IsolatedDaemon): number =>
    d.log().split('\n').filter((line) => line.includes('[cable] notify · silent · rule:notice · notice · 0ms')).length

  /** No daemon log line holds an answer's words or a session's id. */
  function clean(d: IsolatedDaemon, ...sessions: Session[]): void {
    const secrets = [CANARY, ...sessions.map((s) => s.sessionId)]
    expect(d.log().split('\n').filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([])
  }

  let turns = 0
  /** The person's prompt to [s] and its answer, distinct each turn so each turn's summary is told. */
  async function turn(s: Session, asks: boolean): Promise<string> {
    const n = ++turns
    await s.prompt(`${CANARY} prompt ${n}`)
    const answer = asks ? `${CANARY} answer ${n}: Which database should the export use, Postgres or SQLite?` : `${CANARY} answer ${n}: the export is done.`
    s.answer(answer)
    return answer
  }

  /** A turn of A with no question, its two Stop hooks run: it has reported once, so its next stops wait for their reports. */
  async function reportedOnce(d: IsolatedDaemon, dial: FakeDial, a: Session): Promise<void> {
    const since = dial.messages.length
    const before = nudges(d).length
    const answer = await turn(a, false)
    await a.stop({ stop_hook_active: false, last_assistant_message: answer })
    expect(await a.look({ stop_hook_active: false, last_assistant_message: answer })).toEqual(quiet)
    await reported(d, before, ['no ask'])
    await summaryOf(dial, a, since)
  }

  /**
   * The person away, A's question-ending stop and B's plain one at the same moment, A's two hooks in [order] (the engine
   * runs the native first in every run Task 1 saw): one block, no end of A told by B's summary, A's notice rings once,
   * and its continuation's stop (`stop_hook_active`) ends its turn once, silent.
   */
  async function blockedOnce(d: IsolatedDaemon, dial: FakeDial, a: Session, b: Session, order: 'native first' | 'plugin first'): Promise<void> {
    await reportedOnce(d, dial, a)
    const since = dial.messages.length
    const before = nudges(d).length
    const silent = silentByNotice(d)
    const asked = await turn(a, true)
    const done = await turn(b, false)
    const stops = (): Promise<unknown> =>
      Promise.all([a.stop({ stop_hook_active: false, last_assistant_message: asked }), b.stop({ stop_hook_active: false, last_assistant_message: done })])
    if (order === 'native first') await stops()
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(blocked)
    const yes = dial.messages.length
    if (order === 'plugin first') await stops()
    await summaryOf(dial, b, since)
    expect(of(dial, a, 'summary', since)).toEqual([])
    expect(of(dial, a, 'turn.done', since)).toEqual([])

    // The continuation rings the dial, and its own stop ends the turn.
    expect(await notify(d, a)).toMatchObject({ code: 0, stdout: 'shown\n' })
    await dial.next((m) => m.t === 'question' && m.agentId === a.id, 45_000, 'the notice', since)
    const continued = `${CANARY} rang the dial for the export database.`
    a.answer(continued)
    await a.stop({ stop_hook_active: true, last_assistant_message: continued })
    expect(await a.look({ stop_hook_active: true, last_assistant_message: continued })).toEqual(quiet)
    expect(await summaryOf(dial, a, since)).toMatchObject({ tier: 'silent', silent: true })
    expect(of(dial, a, 'summary', since)).toHaveLength(1)
    expect(of(dial, a, 'turn.done', since)).toHaveLength(1)
    expect(of(dial, a, 'question', since)).toHaveLength(1)
    // No prompt of the person's came for the block: no turn of A's started after it.
    expect(of(dial, a, 'turn.started', yes)).toEqual([])
    await until('the silent end in the daemon\'s log', () => silentByNotice(d) > silent || null, 30_000, 50)
    await reported(d, before, ['yes', 'no ask'])
    clean(d, a, b)
  }

  it('Claude Code, the person away: one block, the first end not told, the notice rings once, the next stop ends silent', async () => {
    const { d, dial, a, b } = await attached('claude')
    await blockedOnce(d, dial, a, b, 'native first')
  })

  it('no question: nothing printed, reported with ask false', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    const since = dial.messages.length
    const before = nudges(d).length
    const answer = await turn(a, false)
    const done = await turn(b, false)
    await Promise.all([a.stop({ stop_hook_active: false, last_assistant_message: answer }), b.stop({ stop_hook_active: false, last_assistant_message: done })])
    expect(await a.look({ stop_hook_active: false, last_assistant_message: answer })).toEqual(quiet)
    // Its end waited for its report: nothing of it told before the hook had its answer.
    const looked = dial.messages.length
    expect(of(dial, a, 'turn.done', since)).toEqual([])
    expect(dial.messages.indexOf(await summaryOf(dial, a, since))).toBeGreaterThanOrEqual(looked)
    expect(of(dial, a, 'turn.done', since)).toHaveLength(1)
    await reported(d, before, ['no ask'])
    clean(d, a, b)
  })

  it('the person there: no block', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    // Orca in front and the dial on A; the person's prompt to it comes next.
    await withFront(d, dial, 'orca', a)
    const since = dial.messages.length
    const before = nudges(d).length
    const asked = await turn(a, true)
    await a.stop({ stop_hook_active: false, last_assistant_message: asked })
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(quiet)
    await reported(d, before, ['present'])
    await summaryOf(dial, a, since)
    clean(d, a, b)
  })

  it('a notice rung in this turn: no block; a card from an earlier turn: one block', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    let since = dial.messages.length
    let before = nudges(d).length
    let asked = await turn(a, true)
    expect(await notify(d, a)).toMatchObject({ code: 0, stdout: 'shown\n' })
    await dial.next((m) => m.t === 'question' && m.agentId === a.id, 45_000, 'the notice', since)
    await a.stop({ stop_hook_active: false, last_assistant_message: asked })
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(quiet)
    await reported(d, before, ['notice'])
    await summaryOf(dial, a, since)

    // The person's next prompt starts another turn: what A rang was the last one's.
    since = dial.messages.length
    before = nudges(d).length
    asked = await turn(a, true)
    await a.stop({ stop_hook_active: false, last_assistant_message: asked })
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(blocked)
    const continued = `${CANARY} nothing is needed after all.`
    a.answer(continued)
    await a.stop({ stop_hook_active: true, last_assistant_message: continued })
    expect(await a.look({ stop_hook_active: true, last_assistant_message: continued })).toEqual(quiet)
    await summaryOf(dial, a, since)
    await reported(d, before, ['yes', 'no ask'])
    clean(d, a, b)
  })

  it('no dial: no block', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    const window = await LocalClient.connect(d)
    await desk!.unplug('E2E-A')
    await until('the dial to read as unplugged', async () => {
      const answer = await window.request('harness_devices_list', {})
      return (answer.status?.devices as Array<{ id: string; attached: boolean }> | undefined)?.find((device) => device.id === 'E2E-A')?.attached === false || null
    }, 30_000, 500)
    window.close()
    const before = nudges(d).length
    const asked = await turn(a, true)
    await a.stop({ stop_hook_active: false, last_assistant_message: asked })
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(quiet)
    await reported(d, before, ['no dial'])
    clean(d, a, b)
  })

  it('the block lost: told once when the hold goes quiet', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    const since = dial.messages.length
    const asked = await turn(a, true)
    await a.stop({ stop_hook_active: false, last_assistant_message: asked })
    // Before the hook runs: its yes, and the hold's start, come after this.
    const looking = Date.now()
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(blocked)
    // No next stop, and the transcript left as it is: the hold ends after CONTINUE_QUIET_MS of quiet, within its cap.
    const summary = await summaryOf(dial, a, since, CONTINUE_QUIET_MS + 30_000)
    expect(arrived(dial, summary) - looking).toBeGreaterThanOrEqual(CONTINUE_QUIET_MS)
    expect(arrived(dial, summary) - looking).toBeLessThan(CONTINUE_MAX_MS)
    expect(of(dial, a, 'summary', since)).toHaveLength(1)
    expect(of(dial, a, 'turn.done', since)).toHaveLength(1)
    clean(d, a, b)
  })

  it('the yes before the blocked stop', async () => {
    const { d, dial, a, b } = await attached('claude')
    await blockedOnce(d, dial, a, b, 'plugin first')
  })

  it('a second look before the person\'s next prompt: no block', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    const since = dial.messages.length
    const before = nudges(d).length
    const asked = await turn(a, true)
    await a.stop({ stop_hook_active: false, last_assistant_message: asked })
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(blocked)
    // A continuation whose stop the engine does not mark as the second (no `stop_hook_active`), ending on a question again.
    const again = `${CANARY} still open: Postgres or SQLite?`
    a.answer(again)
    await a.stop({ stop_hook_active: false, last_assistant_message: again })
    expect(await a.look({ stop_hook_active: false, last_assistant_message: again })).toEqual(quiet)
    await summaryOf(dial, a, since)
    expect(of(dial, a, 'turn.done', since)).toHaveLength(1)
    await reported(d, before, ['yes', 'nudged'])
    clean(d, a, b)
  })

  it('Codex, the person away', async () => {
    const { d, dial, a, b } = await attached('codex')
    await blockedOnce(d, dial, a, b, 'native first')
  })

  it('a late report, as on Windows: the turn end waits for it', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    // A's hook held back until B's turn was told, past the grace: A's end is not told until its report.
    let since = dial.messages.length
    let before = nudges(d).length
    const answer = await turn(a, false)
    let done = await turn(b, false)
    await Promise.all([
      a.stop({ stop_hook_active: false, last_assistant_message: answer }),
      b.stop({ stop_hook_active: false, last_assistant_message: done }),
      b.look({ stop_hook_active: false, last_assistant_message: done }).then((run) => expect(run).toEqual(quiet)),
    ])
    await summaryOf(dial, b, since)
    expect(of(dial, a, 'summary', since)).toEqual([])
    expect(of(dial, a, 'turn.done', since)).toEqual([])
    expect(await a.look({ stop_hook_active: false, last_assistant_message: answer })).toEqual(quiet)
    await summaryOf(dial, a, since)
    expect(of(dial, a, 'summary', since)).toHaveLength(1)
    await reported(d, before, ['no ask', 'no ask'])

    // The same with a question: the late yes holds the end, and the notice rings.
    since = dial.messages.length
    before = nudges(d).length
    const asked = await turn(a, true)
    done = await turn(b, false)
    await Promise.all([
      a.stop({ stop_hook_active: false, last_assistant_message: asked }),
      b.stop({ stop_hook_active: false, last_assistant_message: done }),
      b.look({ stop_hook_active: false, last_assistant_message: done }).then((run) => expect(run).toEqual(quiet)),
    ])
    await summaryOf(dial, b, since)
    expect(await a.look({ stop_hook_active: false, last_assistant_message: asked })).toEqual(blocked)
    expect(of(dial, a, 'summary', since)).toEqual([])
    expect(of(dial, a, 'turn.done', since)).toEqual([])
    expect(await notify(d, a)).toMatchObject({ code: 0, stdout: 'shown\n' })
    await dial.next((m) => m.t === 'question' && m.agentId === a.id, 45_000, 'the notice', since)
    const continued = `${CANARY} rang the dial for the export database.`
    a.answer(continued)
    await a.stop({ stop_hook_active: true, last_assistant_message: continued })
    expect(await a.look({ stop_hook_active: true, last_assistant_message: continued })).toEqual(quiet)
    expect(await summaryOf(dial, a, since)).toMatchObject({ tier: 'silent' })
    expect(of(dial, a, 'question', since)).toHaveLength(1)
    expect(of(dial, a, 'summary', since)).toHaveLength(1)
    await reported(d, before, ['no ask', 'yes', 'no ask'])
    clean(d, a, b)
  })

  it('no report: told at 6 s, and the session no longer waited for', async () => {
    const { d, dial, a, b } = await attached('claude')
    await reportedOnce(d, dial, a)
    const missed = (): number => d.log().split('\n').filter((line) => line.includes('[observed] stop report missed')).length
    let since = dial.messages.length
    const answer = await turn(a, false)
    // Before the Stop is sent: the wait starts when it comes, after this.
    let stopping = Date.now()
    await a.stop({ stop_hook_active: false, last_assistant_message: answer })
    const summary = await summaryOf(dial, a, since, REPORT_WAIT_MS + 15_000)
    expect(arrived(dial, summary) - stopping).toBeGreaterThanOrEqual(REPORT_WAIT_MS)
    expect(arrived(dial, summary) - stopping).toBeLessThan(10_000)
    await until('the missed report in the daemon\'s log', () => missed() > 0 || null, 30_000, 50)
    expect(missed()).toBe(1)

    // Its next stop, again with no hook, rests on the grace as B's does.
    since = dial.messages.length
    const next = await turn(a, false)
    const done = await turn(b, false)
    stopping = Date.now()
    await Promise.all([a.stop({ stop_hook_active: false, last_assistant_message: next }), b.stop({ stop_hook_active: false, last_assistant_message: done })])
    await summaryOf(dial, b, since)
    expect(arrived(dial, await summaryOf(dial, a, since)) - stopping).toBeLessThan(REPORT_WAIT_MS)
    expect(missed()).toBe(1)
    clean(d, a, b)
  })

  it('a session that never reported: the grace, as today', async () => {
    const { d, dial, a, b } = await attached('claude')
    const since = dial.messages.length
    const answer = await turn(a, false)
    const done = await turn(b, false)
    const stopping = Date.now()
    await Promise.all([a.stop({ stop_hook_active: false, last_assistant_message: answer }), b.stop({ stop_hook_active: false, last_assistant_message: done })])
    await summaryOf(dial, b, since)
    expect(arrived(dial, await summaryOf(dial, a, since)) - stopping).toBeLessThan(REPORT_WAIT_MS)
    clean(d, a, b)
  })
})
