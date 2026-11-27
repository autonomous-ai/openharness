import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lastTurnTextFromRawLines } from '../engines/claude/normalize.js'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as fakeEngineHelpProbe.spec.ts
// loads it.
const { fakeEngineShim } = await import('../../e2e/harness/daemon.js' as string) as {
  fakeEngineShim: (name: 'claude' | 'codex', config: Record<string, unknown>) => string
}

/** The hooks the fake runs here: each writes its input to a file of its own, as two can run at once. */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification']
/** Under the 6 s a permission dialog waits before Claude Code says so to its Notification hooks. */
const AT_ONCE_MS = 3_000

let root = ''
let engine: ChildProcess | undefined

afterEach(() => {
  engine?.kill('SIGKILL')
  engine = undefined
  rmSync(root, { recursive: true, force: true })
  root = ''
})

/** The fake Claude Code in a throwaway root, its home there too, started with [args] and typed into on its stdin as at
 *  its composer. A test's next start runs in the same root and home, so it can go on in a conversation of the first. */
function start(env: Record<string, string> = {}, args: string[] = []): { hooks(): Array<Record<string, unknown>>; type(text: string): void; hooked(event: string, test?: (input: Record<string, unknown>) => boolean, timeout?: number): Promise<Record<string, unknown>> } {
  const first = !root
  if (first) root = mkdtempSync(join(tmpdir(), 'fake-until-'))
  const home = join(root, 'home')
  const ran = join(root, 'hooks')
  const bin = join(root, 'claude')
  if (first) {
    mkdirSync(ran)
    mkdirSync(join(home, '.claude'), { recursive: true })
    const command = `cat > '${ran}'/$$.json`
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command }] }]])),
    }))
    writeFileSync(bin, fakeEngineShim('claude', {
      port: 1, dataDir: join(root, 'data'), claudeProjectsDir: join(home, '.claude', 'projects'), codexHome: join(root, 'codex'), root,
      hookLog: join(root, 'hook-runs.log'),
    }), { mode: 0o755 })
  }
  // Only its own home: none of this machine's Claude Code settings reach it.
  engine = spawn(bin, args, { cwd: root, env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'ignore', 'ignore'] })
  const hooks = (): Array<Record<string, unknown>> => {
    const inputs: Array<Record<string, unknown>> = []
    // A hook still writing its file is read at the next look.
    for (const name of readdirSync(ran)) try { inputs.push(JSON.parse(readFileSync(join(ran, name), 'utf8')) as Record<string, unknown>) } catch { /* half written */ }
    return inputs
  }
  return {
    hooks,
    type: (text) => { engine!.stdin!.write(`${text}\r`) },
    hooked: (event, test = () => true, timeout = 20_000) => vi.waitFor(() => {
      const found = hooks().find((input) => input.hook_event_name === event && test(input))
      if (!found) throw new Error(`no ${event} hook yet`)
      return found
    }, { timeout, interval: 20 }),
  }
}

/** The last turn's answer as the daemon reads it from the transcript the Stop hook names. */
const answerOf = (stop: Record<string, unknown>): string | undefined =>
  lastTurnTextFromRawLines(readFileSync(String(stop.transcript_path), 'utf8').split('\n'))?.assistantText

describe('the fake Claude Code\'s `!until <name>`', () => {
  it('answers with the text of its release file, exactly', async () => {
    const claude = start()
    claude.type('!until eval-turn')
    await claude.hooked('UserPromptSubmit')
    writeFileSync(join(root, 'eval-turn.release'), 'Eval exact answer.')
    expect(answerOf(await claude.hooked('Stop'))).toBe('Eval exact answer.')
  }, 30_000)

  it('answers as before when its release file is empty', async () => {
    const claude = start()
    claude.type('!until eval-turn')
    await claude.hooked('UserPromptSubmit')
    writeFileSync(join(root, 'eval-turn.release'), '')
    expect(answerOf(await claude.hooked('Stop'))).toBe('answer 1: !until eval-turn')
  }, 30_000)

  it('asks permission to run its permit file\'s command the moment that file is written, its Notification at once', async () => {
    const claude = start()
    claude.type('!until eval-turn')
    await claude.hooked('UserPromptSubmit')
    writeFileSync(join(root, 'eval-turn.permit'), 'printf eval')
    const asked = await claude.hooked('PermissionRequest')
    expect(asked).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'printf eval' } })
    await claude.hooked('Notification', (input) => input.notification_type === 'permission_prompt', AT_ONCE_MS)
    expect(claude.hooks().filter((input) => input.hook_event_name === 'Stop')).toEqual([])
  }, 30_000)

  it('goes on once its permission is answered until its release file, then answers with that file\'s text', async () => {
    const claude = start()
    claude.type('!until eval-turn')
    const transcript = String((await claude.hooked('UserPromptSubmit')).transcript_path)
    writeFileSync(join(root, 'eval-turn.permit'), 'printf eval')
    await claude.hooked('PermissionRequest')
    // Enter on the dialog's first row: allowed. The release is written only once the command's result is in.
    claude.type('')
    await vi.waitFor(() => { expect(readFileSync(transcript, 'utf8')).toContain('ran printf eval') }, { timeout: 20_000, interval: 20 })
    expect(claude.hooks().filter((input) => input.hook_event_name === 'Stop')).toEqual([])
    writeFileSync(join(root, 'eval-turn.release'), 'Eval exact answer.')
    expect(answerOf(await claude.hooked('Stop'))).toBe('Eval exact answer.')
  }, 30_000)

  it('answers with the command its permission ran when its release file is empty', async () => {
    const claude = start()
    claude.type('!until eval-turn')
    await claude.hooked('UserPromptSubmit')
    writeFileSync(join(root, 'eval-turn.permit'), 'printf eval')
    await claude.hooked('PermissionRequest')
    claude.type('')
    writeFileSync(join(root, 'eval-turn.release'), '')
    expect(answerOf(await claude.hooked('Stop'))).toBe('ran printf eval')
  }, 30_000)
})

describe('the fake Claude Code\'s session title', () => {
  it('names the title it was given in its hooks, as the Claude app\'s sessions do', async () => {
    const claude = start({ FAKE_CLAUDE_SESSION_TITLE: 'Eval a' })
    expect(await claude.hooked('SessionStart')).toMatchObject({ session_title: 'Eval a' })
    claude.type('hello')
    expect(await claude.hooked('UserPromptSubmit')).toMatchObject({ session_title: 'Eval a' })
  }, 30_000)

  it('names none when given none', async () => {
    const claude = start()
    expect(await claude.hooked('SessionStart')).not.toHaveProperty('session_title')
  }, 30_000)

  // The devices name a session the scan found from Claude Code's own process record (cable/hosts/record.ts): a name the
  // person gave is written there with `nameSource: 'user'`.
  it('writes the title it was given in its process record, as the person\'s name for the session', async () => {
    const claude = start({ FAKE_CLAUDE_SESSION_TITLE: 'Eval a' })
    const { session_id: sessionId } = await claude.hooked('SessionStart')
    expect(await processRecord()).toMatchObject({ sessionId, name: 'Eval a', nameSource: 'user' })
  }, 30_000)

  it('writes no name in its process record when given none', async () => {
    const claude = start()
    await claude.hooked('SessionStart')
    const record = await processRecord()
    expect(record).not.toHaveProperty('name')
    expect(record).not.toHaveProperty('nameSource')
  }, 30_000)

  // Claude Code keeps the name with the conversation and says it from any process that goes on in it: herdr 0.9.5 that
  // starts again resumes its panes' conversations itself (`resume_agents_on_restore`), in shells no test gave the title
  // (dial eval I14, whose rows then lost their names).
  it('names the title its conversation was given when a process given none goes on in it', async () => {
    const { session_id: sessionId } = await start({ FAKE_CLAUDE_SESSION_TITLE: 'Eval a' }).hooked('SessionStart')
    // Gone with no hook, as herdr's server takes its panes' processes; its record with it, as Claude Code's at its exit.
    engine!.kill('SIGKILL')
    rmSync(join(root, 'home', '.claude', 'sessions'), { recursive: true, force: true })
    const resumed = start({}, ['--resume', String(sessionId)])
    expect(await resumed.hooked('SessionStart', (input) => input.source === 'resume'))
      .toMatchObject({ session_id: sessionId, session_title: 'Eval a' })
    expect(await processRecord()).toMatchObject({ sessionId, name: 'Eval a', nameSource: 'user' })
  }, 30_000)
})

/** The fake's record, `~/.claude/sessions/<pid>.json`, the one file there once it is written. */
const processRecord = (): Promise<Record<string, unknown>> => vi.waitFor(() => {
  const folder = join(root, 'home', '.claude', 'sessions')
  const [file] = readdirSync(folder)
  return JSON.parse(readFileSync(join(folder, file), 'utf8')) as Record<string, unknown>
}, { timeout: 20_000, interval: 20 })
