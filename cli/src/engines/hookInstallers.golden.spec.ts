/**
 * What the Claude Code and Codex hook installers write, byte for byte, in every state their files are found
 * in. Recorded from the former `engines/{claude,codex}/installHooks.ts` before they became declared settings
 * applied by one kit installer (docs/design/2026-10-08-engine-hooks.md): the two detected drift and wrote
 * differently (in place versus atomically, which hook counts as ours, what a malformed file means), and
 * every one of those differences reaches a person's own settings. Each case runs the installer twice and
 * keeps what each run logged and threw, and every file left behind: its bytes, its mode, a symlink kept or
 * replaced, a temporary file left over.
 *
 * `RECORD_HOOK_GOLDEN=1` writes the fixture. Record it again only for a change meant to alter what lands
 * in an engine's settings, and say so in that change.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const GOLDEN = fileURLToPath(new URL('./__fixtures__/hook-installers.golden.json', import.meta.url))
const RECORD = process.env.RECORD_HOOK_GOLDEN === '1'
const PORT = 19473
const OTHER_PORT = 19474
/** A hook of ours from another install: another path, another port, and the bare `node` of old releases. */
const OLD = "node '/opt/old/notify.mjs' --port 18473"
/** Permission cases mean nothing to root, which may write anywhere. */
const ROOT_USER = process.getuid?.() === 0

type Engine = 'claude' | 'codex'
type Via = 'install' | 'installIn'
interface Target { engine: Engine; via: Via; home: string; file: string; cmd: string; otherCmd: string; elsewhere: string }
interface Case { name: string; setup?: (target: Target) => void; noHome?: boolean; permissions?: boolean }

/** The events each former installer wrote, with their matchers, to build the files a current install leaves. */
const EVENTS: Record<Engine, Array<{ event: string; matcher?: string }>> = {
  claude: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure'].map((event) => ({ event })),
  codex: [{ event: 'SessionStart', matcher: 'startup|resume|clear|compact' }, { event: 'UserPromptSubmit' }],
}
const current = (engine: Engine, cmd: string, timeout = 5) => ({
  hooks: Object.fromEntries(EVENTS[engine].map(({ event, matcher }) => [event, [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout }] }]])),
})
const pretty = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'
const write = (file: string, text: string, mode?: number): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (mode !== undefined) chmodSync(file, mode)
}
const foreign = (engine: Engine) => ({
  model: 'opus', nested: { list: [1, 2.5, 'x'], none: null }, note: 'café ✓ 🎉',
  hooks: {
    [EVENTS[engine][0].event]: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'foreign-start', timeout: 9 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'foreign-prompt' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'foreign-tool' }] }],
  },
})

const CASES: Case[] = [
  { name: 'no file' },
  { name: 'no home folder', noHome: true },
  { name: 'empty file', setup: ({ file }) => write(file, '') },
  { name: 'whitespace only', setup: ({ file }) => write(file, '  \n') },
  { name: 'malformed JSON', setup: ({ file }) => write(file, '{not-json') },
  { name: 'byte order mark', setup: ({ file }) => write(file, '﻿{}') },
  { name: 'JSON null', setup: ({ file }) => write(file, 'null') },
  { name: 'JSON array', setup: ({ file }) => write(file, '[]') },
  { name: 'JSON string', setup: ({ file }) => write(file, '"text"') },
  { name: 'JSON number', setup: ({ file }) => write(file, '42') },
  { name: 'hooks is a string', setup: ({ file }) => write(file, '{"hooks":"nope","keep":1}') },
  { name: 'hooks is an array', setup: ({ file }) => write(file, '{"hooks":[]}') },
  { name: 'hooks is null', setup: ({ file }) => write(file, '{"hooks":null}') },
  { name: 'an event is not a list', setup: ({ file, engine }) => write(file, JSON.stringify({ hooks: { [EVENTS[engine][0].event]: { a: 1 } } })) },
  { name: 'odd blocks', setup: ({ file, engine }) => write(file, JSON.stringify({ hooks: { [EVENTS[engine][0].event]: [null, 'text', { hooks: 'no' }, { hooks: [null, {}] }] } })) },
  { name: 'a command that is not text', setup: ({ file, engine }) => write(file, JSON.stringify({ hooks: { [EVENTS[engine][0].event]: [{ hooks: [{ type: 'command', command: 5 }] }] } })) },
  { name: 'duplicate keys', setup: ({ file, engine, cmd }) => write(file, `{"hooks":{},"hooks":${JSON.stringify(current(engine, cmd).hooks)}}`) },
  { name: 'foreign hooks only', setup: ({ file, engine }) => write(file, pretty(foreign(engine))) },
  { name: 'our old hook', setup: ({ file, engine }) => write(file, pretty(current(engine, OLD))) },
  {
    name: 'our old hook beside foreign hooks', setup: ({ file, engine }) => {
      const settings = foreign(engine) as { hooks: Record<string, unknown[]> }
      for (const { event } of EVENTS[engine]) settings.hooks[event] = [...(settings.hooks[event] ?? []), { hooks: [{ type: 'command', command: OLD, timeout: 5 }] }]
      write(file, pretty(settings))
    },
  },
  {
    name: 'ours current on some events, old or missing on others', setup: ({ file, engine, cmd }) => {
      const settings = current(engine, cmd)
      const [first, ...rest] = EVENTS[engine]
      settings.hooks[first.event] = [{ ...(first.matcher ? { matcher: first.matcher } : {}), hooks: [{ type: 'command', command: OLD, timeout: 5 }] }]
      if (rest.length > 1) delete settings.hooks[rest[0].event]
      write(file, pretty(settings))
    },
  },
  { name: 'ours current', setup: ({ file, engine, cmd }) => write(file, pretty(current(engine, cmd))) },
  { name: 'ours current, minified', setup: ({ file, engine, cmd }) => write(file, JSON.stringify(current(engine, cmd))) },
  {
    name: 'ours current before foreign hooks', setup: ({ file, engine, cmd }) => {
      const settings = current(engine, cmd) as { hooks: Record<string, unknown[]> }
      for (const { event } of EVENTS[engine]) settings.hooks[event].push({ hooks: [{ type: 'command', command: 'foreign-after' }] })
      write(file, pretty(settings))
    },
  },
  { name: 'ours current with another timeout', setup: ({ file, engine, cmd }) => write(file, pretty(current(engine, cmd, 30))) },
  {
    name: 'ours twice on an event', setup: ({ file, engine, cmd }) => {
      const settings = current(engine, cmd) as { hooks: Record<string, unknown[]> }
      const { event } = EVENTS[engine][0]
      settings.hooks[event].push(settings.hooks[event][0])
      write(file, pretty(settings))
    },
  },
  {
    name: 'ours twice, the first old', setup: ({ file, engine, cmd }) => {
      const settings = current(engine, cmd) as { hooks: Record<string, unknown[]> }
      const { event, matcher } = EVENTS[engine][0]
      settings.hooks[event].unshift({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: OLD, timeout: 5 }] })
      write(file, pretty(settings))
    },
  },
  {
    name: 'our block led by a foreign hook', setup: ({ file, engine, cmd }) => {
      const settings = current(engine, cmd) as { hooks: Record<string, Array<{ hooks: unknown[] }>> }
      for (const { event } of EVENTS[engine]) settings.hooks[event][0].hooks.unshift({ type: 'command', command: 'foreign-first' })
      write(file, pretty(settings))
    },
  },
  {
    name: 'our block with another matcher', setup: ({ file, engine, cmd }) => {
      const settings = current(engine, cmd) as { hooks: Record<string, Array<{ matcher?: string }>> }
      for (const { event } of EVENTS[engine]) settings.hooks[event][0].matcher = 'other'
      write(file, pretty(settings))
    },
  },
  {
    name: 'our block missing its matcher', setup: ({ file, engine, cmd }) => {
      const settings = current(engine, cmd) as { hooks: Record<string, Array<{ matcher?: string }>> }
      for (const { event } of EVENTS[engine]) delete settings.hooks[event][0].matcher
      write(file, pretty(settings))
    },
  },
  { name: 'ours current for another port', setup: ({ file, engine, otherCmd }) => write(file, pretty(current(engine, otherCmd))) },
  {
    name: 'a symlink to foreign settings', setup: ({ file, engine, elsewhere }) => {
      write(join(elsewhere, 'real.json'), pretty(foreign(engine)))
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'real.json'), file)
    },
  },
  {
    name: 'a symlink to current settings', setup: ({ file, engine, cmd, elsewhere }) => {
      write(join(elsewhere, 'real.json'), pretty(current(engine, cmd)))
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'real.json'), file)
    },
  },
  {
    name: 'a dangling symlink', setup: ({ file, elsewhere }) => {
      mkdirSync(elsewhere, { recursive: true })
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'missing.json'), file)
    },
  },
  {
    name: 'a symlink into a missing folder', setup: ({ file, elsewhere }) => {
      mkdirSync(dirname(file), { recursive: true })
      symlinkSync(join(elsewhere, 'gone', 'missing.json'), file)
    },
  },
  { name: 'a read-only file', permissions: true, setup: ({ file, engine }) => write(file, pretty(foreign(engine)), 0o444) },
  { name: 'a read-only file, current', permissions: true, setup: ({ file, engine, cmd }) => write(file, pretty(current(engine, cmd)), 0o444) },
  { name: 'an unreadable file', permissions: true, setup: ({ file, engine }) => write(file, pretty(foreign(engine)), 0o200) },
  { name: 'a read-only folder', permissions: true, setup: ({ home }) => chmodSync(home, 0o555) },
  {
    name: 'a read-only folder holding a writable file', permissions: true, setup: ({ file, engine, home }) => {
      write(file, pretty(foreign(engine)))
      chmodSync(home, 0o555)
    },
  },
  { name: 'a private file', setup: ({ file, engine }) => write(file, pretty(foreign(engine)), 0o600) },
  { name: 'the file is a folder', setup: ({ file }) => mkdirSync(file, { recursive: true }) },
  {
    name: 'a temporary file left by this process', setup: ({ file, engine }) => {
      write(file, pretty(foreign(engine)))
      write(`${file}.${process.pid}.tmp`, 'junk', 0o600)
    },
  },
]
/** The cases also run against each engine's default home, which the installer finds on its own. */
const DEFAULT_HOME_CASES = new Set(['no file', 'no home folder', 'malformed JSON', 'foreign hooks only', 'our old hook', 'ours current', 'a symlink to foreign settings'])

interface Run { logs: string[]; threw: string | null }
interface Entry { type: 'dir' | 'file' | 'link'; mode?: string; text?: string; target?: string }
interface Outcome { runs: Run[]; files: Record<string, Entry> }

let root = ''
const saved: Record<string, string | undefined> = {}
let hooks: typeof import('./hooks.js')['engineHooks']
let command: typeof import('./kit/notifyHooks.js')['command']
let tokens: Array<[string, string]> = []
const golden: Record<string, Outcome> = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, Outcome>
const recorded: Record<string, Outcome> = {}

const homes = (): Record<Engine, Record<Via, string>> => ({
  claude: { install: join(root, 'home', '.claude'), installIn: join(root, 'moved', 'claude-work') },
  codex: { install: join(root, 'home', '.codex'), installIn: join(root, 'moved', 'codex-work') },
})
const FILE: Record<Engine, string> = { claude: 'settings.json', codex: 'hooks.json' }

const normalize = (text: string): string => tokens.reduce((out, [value, token]) => out.split(value).join(token), text)
const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return `thrown ${typeof error}`
  const { code, syscall, path, dest } = error as NodeJS.ErrnoException & { dest?: string }
  return [error.name, code, syscall, path && normalize(path), dest && normalize(dest)].filter(Boolean).join(' ')
}

/** Everything under the case's folders: what a person would find in their engine's home afterwards. */
function snapshot(): Record<string, Entry> {
  const files: Record<string, Entry> = {}
  const walk = (dir: string): void => {
    let names: string[]
    try { names = readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      const path = join(dir, name)
      const stat = lstatSync(path)
      const key = normalize(relative(root, path))
      if (stat.isSymbolicLink()) files[key] = { type: 'link', target: normalize(readlinkSync(path)) }
      else if (stat.isDirectory()) {
        files[key] = { type: 'dir', mode: (stat.mode & 0o777).toString(8) }
        walk(path)
      } else {
        const mode = stat.mode & 0o777
        // A file the person cannot read is still compared: read it for the record, then put its mode back.
        if (!(mode & 0o400)) chmodSync(path, mode | 0o400)
        const text = normalize(readFileSync(path, 'utf8'))
        if (!(mode & 0o400)) chmodSync(path, mode)
        files[key] = { type: 'file', mode: mode.toString(8), text }
      }
    }
  }
  for (const top of ['home', 'moved', 'elsewhere']) walk(join(root, top))
  return files
}

/** Give back write access everywhere, so that the next case starts from nothing. */
function reset(): void {
  const open = (path: string): void => {
    let stat
    try { stat = lstatSync(path) } catch { return }
    if (stat.isSymbolicLink()) return
    chmodSync(path, stat.isDirectory() ? 0o755 : 0o644)
    if (stat.isDirectory()) for (const name of readdirSync(path)) open(join(path, name))
  }
  for (const top of ['home', 'moved', 'elsewhere']) {
    open(join(root, top))
    rmSync(join(root, top), { recursive: true, force: true })
  }
  mkdirSync(join(root, 'home'), { recursive: true })
}

function run(engine: Engine, via: Via, scenario: Case): Outcome {
  reset()
  const home = homes()[engine][via]
  const commandFor = (port: number): string => engine === 'claude' ? command(port, 'claude') : command(port, 'codex', home)
  const target: Target = { engine, via, home, file: join(home, FILE[engine]), cmd: commandFor(PORT), otherCmd: commandFor(OTHER_PORT), elsewhere: join(root, 'elsewhere') }
  if (!scenario.noHome) mkdirSync(home, { recursive: true })
  scenario.setup?.(target)
  const runs: Run[] = []
  for (let i = 0; i < 2; i++) {
    const logs: string[] = []
    const capture = (level: string) => (...args: unknown[]) => {
      logs.push(`${level} ${args.map((arg) => typeof arg === 'string' ? normalize(arg) : describeError(arg)).join(' ')}`)
    }
    const spies = [vi.spyOn(console, 'log').mockImplementation(capture('log')), vi.spyOn(console, 'error').mockImplementation(capture('error')),
      vi.spyOn(console, 'warn').mockImplementation(capture('warn'))]
    let threw: string | null = null
    try {
      if (via === 'install') hooks[engine].install(PORT)
      else hooks[engine].installIn(PORT, home)
    } catch (error) { threw = describeError(error) } finally { for (const spy of spies) spy.mockRestore() }
    runs.push({ logs, threw })
  }
  return { runs, files: snapshot() }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hook-golden-'))
  for (const name of ['HOME', 'CODEX_HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_PROJECTS_DIR']) saved[name] = process.env[name]
  // Every folder the hook command names is inside the throwaway root, so the command reads the same on every machine.
  process.env.HOME = join(root, 'home')
  process.env.CODEX_HOME = join(root, 'home', '.codex')
  process.env.ADAPTER_DATA_DIR = join(root, 'data')
  process.env.ADAPTER_RUNTIME_DIR = join(root, 'runtime')
  delete process.env.CLAUDE_PROJECTS_DIR
  mkdirSync(join(root, 'data'), { recursive: true })
  mkdirSync(join(root, 'runtime'), { recursive: true })
  vi.resetModules()
  ;({ engineHooks: hooks } = await import('./hooks.js'))
  const notify = await import('./kit/notifyHooks.js')
  command = notify.command
  const all = homes()
  const commands: Array<[string, string]> = []
  for (const port of [PORT, OTHER_PORT]) {
    commands.push([command(port, 'claude'), `<command claude ${port}>`])
    for (const via of ['install', 'installIn'] as const) commands.push([command(port, 'codex', all.codex[via]), `<command codex ${port} ${via}>`])
  }
  // Longest first: Claude Code's command is the start of Codex's, and every command contains the folders below.
  commands.sort(([a], [b]) => b.length - a.length)
  // Codex's review records hash a command, which names this machine's folders: each known one by its command.
  const { reviewHash } = await import('./kit/hookReview.js')
  const { hooks: codex } = await import('./codex/hookContract.js')
  const hashes: Array<[string, string]> = []
  for (const [cmd, token] of commands.filter(([, token]) => token.startsWith('<command codex'))) {
    for (const { event, matcher } of EVENTS.codex) {
      // 30: the case that finds Harness's hook current with a timeout of its own, recorded as the file has it.
      for (const timeout of [5, 30]) hashes.push([reviewHash(codex.settings.reviewed!, event, matcher, { command: cmd, timeout }), `<hash ${event} ${token.slice(1, -1)}${timeout === 5 ? '' : ` timeout ${timeout}`}>`])
    }
  }
  // The real path first: on macOS the temporary folder is reached through /var, and Codex keys by /private/var.
  tokens = [...hashes, ...commands, [notify.HOOK_SCRIPT, '<script>'], [process.execPath, '<node>'], [realpathSync(root), '<root>'], [root, '<root>'], [`.${process.pid}.`, '.<pid>.']]
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  if (root) { reset(); rmSync(root, { recursive: true, force: true }) }
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(recorded, null, 1) + '\n')
})

describe.each(['claude', 'codex'] as const)('%s hook installer, byte for byte', (engine) => {
  for (const via of ['installIn', 'install'] as const) {
    for (const scenario of CASES.filter((one) => via === 'installIn' || DEFAULT_HOME_CASES.has(one.name))) {
      const key = `${engine} ${via}: ${scenario.name}`
      it.skipIf(scenario.permissions && ROOT_USER)(key, () => {
        const previous = process.umask(0o022)
        try {
          const outcome = run(engine, via, scenario)
          recorded[key] = outcome
          if (!RECORD) expect(outcome).toEqual(golden[key])
        } finally { process.umask(previous) }
      })
    }
  }
})

it('has a recorded outcome for every case, and no other', () => {
  if (RECORD) return
  const expected = (['claude', 'codex'] as const).flatMap((engine) => (['installIn', 'install'] as const).flatMap((via) =>
    CASES.filter((one) => via === 'installIn' || DEFAULT_HOME_CASES.has(one.name)).map((one) => `${engine} ${via}: ${one.name}`)))
  expect(Object.keys(golden).sort()).toEqual(expected.sort())
})
