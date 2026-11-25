import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as fakeEngineUntil.spec.ts
// loads it.
const { fakeEngineShim } = await import('../../e2e/harness/daemon.js' as string) as {
  fakeEngineShim: (name: 'claude' | 'codex', config: Record<string, unknown>) => string
}

/** The hooks the fake runs here. Each appends its input as one line to one file: the engine waits for these hooks in
 *  turn, so the file's order is the order they ran in. */
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop']

let root = ''
let engines: ChildProcess[] = []

afterEach(() => {
  // Each in its own process group: the npm Codex wrapper's engine child goes with it.
  for (const engine of engines) try { if (engine.pid) process.kill(-engine.pid, 'SIGKILL') } catch { /* already gone */ }
  engines = []
  rmSync(root, { recursive: true, force: true })
})

interface Started {
  /** Every hook input so far, in the order they ran. */
  hooks(): Array<Record<string, unknown>>
  type(text: string): void
  hooked(event: string, test?: (input: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
  /** Until the engine noted a line holding [text] in its hook log. */
  logged(text: string): Promise<void>
  exited: Promise<void>
  /** Another process of the same engine, in the same root and homes. */
  another(args?: string[]): Started
}

/** A fake engine in a throwaway root, its homes there too, typed into on its stdin as at its composer. [claudeJson]: the
 *  text of Claude Code's `~/.claude.json`, given the folder the engine runs in as it reads it. */
function start(name: 'claude' | 'codex', { config = {}, args = [], bom = false, claudeJson }: {
  config?: Record<string, unknown>; args?: string[]; bom?: boolean; claudeJson?: (cwd: string) => string
} = {}): Started {
  root = mkdtempSync(join(tmpdir(), 'fake-admission-'))
  const home = join(root, 'home')
  const codexHome = join(root, 'codex')
  const ran = join(root, 'hooks.jsonl')
  const hookLog = join(root, 'hook-runs.log')
  const settings = name === 'claude' ? join(home, '.claude', 'settings.json') : join(codexHome, 'hooks.json')
  mkdirSync(dirname(settings), { recursive: true })
  // The real path: a process's working folder is one (macOS's tmpdir is under a link).
  if (claudeJson) writeFileSync(join(home, '.claude.json'), claudeJson(realpathSync(root)))
  const command = `{ cat; echo; } >> '${ran}'`
  writeFileSync(settings, `${bom ? '﻿' : ''}${JSON.stringify({
    hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ hooks: [{ type: 'command', command }] }]])),
  })}`)
  // Not in the root itself, where Codex's home is named as its command.
  const bin = join(root, 'bin', name)
  mkdirSync(dirname(bin))
  writeFileSync(bin, fakeEngineShim(name, {
    port: 1, dataDir: join(root, 'data'), claudeProjectsDir: join(home, '.claude', 'projects'), codexHome, root, hookLog, ...config,
  }), { mode: 0o755 })
  const hooks = (): Array<Record<string, unknown>> => {
    let text = ''
    try { text = readFileSync(ran, 'utf8') } catch { return [] }
    // A hook still writing its line is read at the next look.
    return text.split('\n').flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } })
  }
  const launch = (argv: string[]): Started => {
    // Only its own home: none of this machine's engine settings reach it.
    const engine = spawn(bin, argv, { cwd: root, env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'ignore'], detached: true })
    engines.push(engine)
    return {
      hooks,
      type: (text) => { engine.stdin!.write(`${text}\r`) },
      hooked: (event, test = () => true) => vi.waitFor(() => {
        const found = hooks().find((input) => input.hook_event_name === event && test(input))
        if (!found) throw new Error(`no ${event} hook yet`)
        return found
      }, { timeout: 20_000, interval: 20 }),
      logged: (text) => vi.waitFor(() => {
        expect(existsSync(hookLog) ? readFileSync(hookLog, 'utf8') : '').toContain(text)
      }, { timeout: 20_000, interval: 20 }),
      exited: new Promise<void>((resolve) => engine.once('exit', () => resolve())),
      another: (more = []) => launch(more),
    }
  }
  return launch(args)
}

const eventsOf = (hooks: Array<Record<string, unknown>>): string[] =>
  hooks.map((input) => `${String(input.hook_event_name)}${input.source ? `(${String(input.source)})` : ''}`)

// Claude Code on Windows announces SessionStart before its transcript exists (2-3 s measured, CLI 0.6.89).
describe('the fake Claude Code\'s `lateTranscript`', () => {
  /** The files that say a session's transcript is kept back, and release it: one pair per session. */
  const waiting = (sessionId: unknown) => join(root, `transcript.${String(sessionId)}.waiting`)
  const release = (sessionId: unknown) => join(root, `transcript.${String(sessionId)}.release`)
  const createdOnRelease = async (sessionId: unknown) => {
    await vi.waitFor(() => {
      expect(existsSync(waiting(sessionId))).toBe(false)
      expect(existsSync(release(sessionId))).toBe(false)
    }, { timeout: 20_000, interval: 20 })
  }

  it('names a transcript that does not exist yet, keeps its records back, and creates it once released', async () => {
    const claude = start('claude', { config: { lateTranscript: true } })
    const started = await claude.hooked('SessionStart', (input) => input.source === 'startup')
    const transcript = String(started.transcript_path)
    expect(existsSync(transcript)).toBe(false)
    expect(existsSync(waiting(started.session_id))).toBe(true)
    claude.type('hello late')
    await claude.hooked('Stop')
    expect(existsSync(transcript)).toBe(false)
    writeFileSync(release(started.session_id), '')
    await vi.waitFor(() => { expect(readFileSync(transcript, 'utf8')).toContain('"content":"hello late"') }, { timeout: 20_000, interval: 20 })
    await createdOnRelease(started.session_id)
  }, 40_000)

  it('creates a `!clear`\'s new transcript late too', async () => {
    const claude = start('claude', { config: { lateTranscript: true } })
    const started = await claude.hooked('SessionStart', (input) => input.source === 'startup')
    writeFileSync(release(started.session_id), '')
    await createdOnRelease(started.session_id)
    claude.type('!clear')
    const cleared = await claude.hooked('SessionStart', (input) => input.source === 'clear')
    expect(existsSync(String(cleared.transcript_path))).toBe(false)
    expect(existsSync(waiting(cleared.session_id))).toBe(true)
  }, 40_000)

  it('creates a fork\'s new transcript late too', async () => {
    const forked = randomUUID()
    const claude = start('claude', { config: { lateTranscript: true }, args: ['--resume', forked, '--fork-session'] })
    const started = await claude.hooked('SessionStart')
    expect(started.session_id).not.toBe(forked)
    expect(existsSync(String(started.transcript_path))).toBe(false)
    expect(existsSync(waiting(started.session_id))).toBe(true)
  }, 40_000)

  it('keeps each process\'s transcript back on its own, two in one root', async () => {
    const first = start('claude', { config: { lateTranscript: true } })
    const one = await first.hooked('SessionStart')
    const second = first.another()
    const two = await second.hooked('SessionStart', (input) => input.session_id !== one.session_id)
    expect([existsSync(waiting(one.session_id)), existsSync(waiting(two.session_id))]).toEqual([true, true])
    writeFileSync(release(one.session_id), '')
    await createdOnRelease(one.session_id)
    expect(existsSync(String(one.transcript_path))).toBe(true)
    expect(existsSync(String(two.transcript_path))).toBe(false)
    expect(existsSync(waiting(two.session_id))).toBe(true)
  }, 40_000)
})

// Codex sends SessionStart at its first prompt, not as it starts.
describe('the fake Codex\'s `lazySessionStart`', () => {
  it('runs no hook before its first prompt', async () => {
    const codex = start('codex', { config: { lazySessionStart: true } })
    codex.type('!exit')
    await codex.exited
    expect(codex.hooks()).toEqual([])
  }, 30_000)

  it('runs SessionStart, then UserPromptSubmit, at its first prompt', async () => {
    const codex = start('codex', { config: { lazySessionStart: true } })
    codex.type('hello')
    await codex.hooked('Stop')
    expect(eventsOf(codex.hooks())).toEqual(['SessionStart(startup)', 'UserPromptSubmit', 'Stop'])
  }, 30_000)

  it('names a resumed process\'s first SessionStart `resume`', async () => {
    const codex = start('codex', { config: { lazySessionStart: true }, args: ['resume', randomUUID()] })
    codex.type('hello')
    await codex.hooked('Stop')
    expect(eventsOf(codex.hooks())).toEqual(['SessionStart(resume)', 'UserPromptSubmit', 'Stop'])
  }, 30_000)

  // Codex queues a new conversation's SessionStart and runs it only inside a turn (codex-rs core/src/hook_runtime.rs).
  it('runs nothing at a `!clear` before any prompt', async () => {
    const codex = start('codex', { config: { lazySessionStart: true } })
    codex.type('!clear')
    codex.type('!exit')
    await codex.exited
    expect(codex.hooks()).toEqual([])
  }, 30_000)

  it('runs nothing at a `!clear` after a prompt', async () => {
    const codex = start('codex', { config: { lazySessionStart: true } })
    codex.type('hello')
    await codex.hooked('Stop')
    codex.type('!clear')
    codex.type('!exit')
    await codex.exited
    expect(eventsOf(codex.hooks())).toEqual(['SessionStart(startup)', 'UserPromptSubmit', 'Stop'])
  }, 30_000)

  it('runs a `!clear`\'s SessionStart (`clear`) at the next prompt, before its UserPromptSubmit', async () => {
    const codex = start('codex', { config: { lazySessionStart: true } })
    codex.type('!clear')
    codex.type('hello')
    await codex.hooked('Stop')
    expect(eventsOf(codex.hooks())).toEqual(['SessionStart(clear)', 'UserPromptSubmit', 'Stop'])
  }, 30_000)
})

// A hook killed at its timeout on a loaded machine never reaches the daemon.
describe('the fake engines\' `lostHooks`', () => {
  it('runs no lost SessionStart on a resumed process, and a `!clear`\'s at once', async () => {
    const resumed = randomUUID()
    const claude = start('claude', { config: { lostHooks: ['SessionStart:resume'] }, args: ['--resume', resumed] })
    await claude.logged(`SessionStart(resume) session=${resumed} lost`)
    expect(claude.hooks()).toEqual([])
    claude.type('!clear')
    await claude.hooked('SessionStart')
    expect(eventsOf(claude.hooks())).toEqual(['SessionStart(clear)'])
  }, 30_000)
})

// Claude Code reads its hook settings past a leading BOM (one Windows PowerShell 5 writes); Codex 0.169+ does not
// (codex-rs/hooks/src/engine/discovery.rs: `fs::read_to_string`, then `serde_json::from_str`; a parse failure warns and
// loads no hooks).
describe('the fake engines\' hook settings', () => {
  it('claude runs the hooks of a settings file that starts with a BOM', async () => {
    const fake = start('claude', { bom: true })
    expect(await fake.hooked('SessionStart')).toMatchObject({ source: 'startup' })
  }, 30_000)

  it('codex loads no hooks from a hooks.json that starts with a BOM, and notes why', async () => {
    const fake = start('codex', { bom: true })
    await fake.logged(`hooks not loaded: ${join(root, 'codex', 'hooks.json')} is not JSON`)
    fake.type('hello')
    fake.type('!exit')
    await fake.exited
    expect(fake.hooks()).toEqual([])
  }, 30_000)
})

// Claude Code reads its `.claude.json` past a leading BOM, as it reads its settings: the trust it holds counts, and the
// answer to its question is saved with the rest of the file.
describe('the fake Claude Code\'s `trustPrompt` over a `.claude.json` that starts with a BOM', () => {
  it('asks nothing in a folder it trusts', async () => {
    const claude = start('claude', { config: { trustPrompt: true },
      claudeJson: (cwd) => `﻿${JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } })}` })
    expect(await claude.hooked('SessionStart')).toMatchObject({ source: 'startup' })
  }, 30_000)

  it('saves a folder it is told to trust with the rest of the file', async () => {
    let folder = ''
    const claude = start('claude', { config: { trustPrompt: true }, claudeJson: (cwd) => {
      folder = cwd
      return `﻿${JSON.stringify({ numStartups: 3, projects: { '/elsewhere': { hasTrustDialogAccepted: true } } })}`
    } })
    claude.type('')
    await claude.hooked('SessionStart')
    expect(JSON.parse(readFileSync(join(root, 'home', '.claude.json'), 'utf8'))).toEqual({
      numStartups: 3, projects: { '/elsewhere': { hasTrustDialogAccepted: true }, [folder]: { hasTrustDialogAccepted: true } },
    })
  }, 30_000)
})
