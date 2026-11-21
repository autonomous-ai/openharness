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
})

/** The fake Claude Code in a throwaway root, its home there too, typed into on its stdin as at its composer. */
function start(env: Record<string, string> = {}): { hooks(): Array<Record<string, unknown>>; type(text: string): void; hooked(event: string, test?: (input: Record<string, unknown>) => boolean, timeout?: number): Promise<Record<string, unknown>> } {
  root = mkdtempSync(join(tmpdir(), 'fake-until-'))
  const home = join(root, 'home')
  const ran = join(root, 'hooks')
  mkdirSync(ran)
  mkdirSync(join(home, '.claude'), { recursive: true })
  const command = `cat > '${ran}'/$$.json`
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command }] }]])),
  }))
  const bin = join(root, 'claude')
  writeFileSync(bin, fakeEngineShim('claude', {
    port: 1, dataDir: join(root, 'data'), claudeProjectsDir: join(home, '.claude', 'projects'), codexHome: join(root, 'codex'), root,
    hookLog: join(root, 'hook-runs.log'),
  }), { mode: 0o755 })
  // Only its own home: none of this machine's Claude Code settings reach it.
  engine = spawn(bin, [], { cwd: root, env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'ignore', 'ignore'] })
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
})
