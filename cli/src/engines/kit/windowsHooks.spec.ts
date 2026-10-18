import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGY_HOOK_SETTINGS } from '../agy/contract.js'
import { hooks as claude } from '../claude/hookContract.js'
import { hooks as codex } from '../codex/hookContract.js'
import { COMMANDCODE_HOOK_SETTINGS } from '../commandcode/contract.js'
import { COPILOT_HOOK_SETTINGS } from '../copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from '../cursor/contract.js'
import { DEVIN_HOOK_SETTINGS } from '../devin/contract.js'
import { GROK_HOOK_SETTINGS } from '../grok/contract.js'
import { managedNodePath } from '../../lib/nodeRuntime.js'
import { installHermesHooks } from '../nativeHooks.js'
import { installHookSettings, notifyHookEntry } from './hookSettings.js'
import { HookPreparationHeld } from './nativeHookFiles.js'
import { installNativeHookSettings } from './nativeHookSettings.js'
import { hookArgv, hookScriptCandidates, identitySettings, quoteHookCommand } from './notifyHooks.js'

const dirs: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const argv = ['C:\\h\\node.exe', 'C:\\h\\cli\\notify.mjs', '--port', '18473', '--data-dir', 'C:\\h\\cli\\data']

describe('the hook each engine runs on Windows', () => {
  it('is declared for every engine whose hooks Harness installs there, and for no other', () => {
    expect(claude.settings.win32Runner).toBe('argv')
    expect(codex.settings.win32Runner).toBe('powershell')
    expect(COPILOT_HOOK_SETTINGS.win32Runner).toBe('powershell')
    expect(COMMANDCODE_HOOK_SETTINGS.win32Runner).toBe('cmd')
    for (const rule of [CURSOR_HOOK_SETTINGS, DEVIN_HOOK_SETTINGS, GROK_HOOK_SETTINGS, AGY_HOOK_SETTINGS]) expect('win32Runner' in rule).toBe(false)
  })

  it('writes Claude Code exec form on Windows: node.exe and its arguments, no shell', () => {
    expect(notifyHookEntry(claude.settings, argv, 'win32')).toEqual({ command: argv[0], args: argv.slice(1) })
  })

  // Codex 0.162.1 runs a hook in the session's shell, which on Windows is PowerShell: `powershell.exe -NoProfile -Command
  // <line>` (codex-rs core/src/session/mod.rs `build_hooks_config`, shell-command/src/shell_detect.rs). A line quoted for
  // cmd.exe is a PowerShell parse error there, and every hook exited 1 (B4.15, the Windows VM).
  it('writes Codex a line PowerShell reads', () => {
    expect(notifyHookEntry(codex.settings, argv, 'win32'))
      .toEqual({ command: "& 'C:\\h\\node.exe' 'C:\\h\\cli\\notify.mjs' --port 18473 --data-dir 'C:\\h\\cli\\data'" })
  })

  it('keeps the POSIX line for both off Windows', () => {
    const posix = ['/h/node', '/h/notify.mjs', '--port', '1']
    expect(notifyHookEntry(claude.settings, posix, 'darwin')).toEqual({ command: "'/h/node' '/h/notify.mjs' --port 1" })
    expect(notifyHookEntry(codex.settings, posix, 'linux')).toEqual({ command: "'/h/node' '/h/notify.mjs' --port 1" })
  })

  it('installs nothing for an engine with no Windows runner, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installNativeHookSettings({ ...GROK_HOOK_SETTINGS, file: join(dir, 'grok', 'hooks', 'harness.json') }, 19473, {}, 'win32')).toBe(true)
    expect(existsSync(join(dir, 'grok'))).toBe(false)
    expect(log).toHaveBeenCalledWith('[hooks] grok hooks are not installed on Windows yet')
  })
})

describe('a hook preparation\'s identity', () => {
  // installHookSettings and installNativeHookSettings name a preparation by JSON.stringify of the settings, among
  // others. Off Windows that string must be byte for byte what it was before win32Runner existed (mac/Linux unchanged).
  it('is the settings without win32Runner off Windows, byte for byte, and the whole declaration on Windows', () => {
    const { win32Runner: _claude, ...claudeBefore } = claude.settings
    const { win32Runner: _copilot, ...copilotBefore } = COPILOT_HOOK_SETTINGS
    expect(JSON.stringify(identitySettings(claude.settings, 'darwin'))).toBe(JSON.stringify(claudeBefore))
    expect(JSON.stringify(identitySettings(codex.settings, 'linux'))).not.toContain('win32Runner')
    expect(JSON.stringify(identitySettings(COPILOT_HOOK_SETTINGS, 'darwin'))).toBe(JSON.stringify(copilotBefore))
    expect(JSON.stringify(identitySettings(CURSOR_HOOK_SETTINGS, 'darwin'))).toBe(JSON.stringify(CURSOR_HOOK_SETTINGS))
    expect(identitySettings(COPILOT_HOOK_SETTINGS, 'win32')).toBe(COPILOT_HOOK_SETTINGS)
    expect(JSON.stringify(identitySettings(claude.settings, 'win32'))).toContain('"win32Runner":"argv"')
  })
})

describe('the notify.mjs a hook line names', () => {
  const root = 'C:\\Users\\u\\.harness\\cli'
  it('is the stable cli\\notify.mjs when the CLI runs from its Windows install', () => {
    expect(hookScriptCandidates(`${root}\\0.5.0`, `${root}\\0.5.0\\cli.js`, 'win32', root)[0]).toBe(`${root}\\notify.mjs`)
  })
  it('is the sibling for a CLI run from anywhere else, and always off Windows', () => {
    expect(hookScriptCandidates('C:\\work\\e2e\\dist', 'C:\\work\\e2e\\dist\\cli.js', 'win32', root)[0]).toBe(join('C:\\work\\e2e\\dist', 'notify.mjs'))
    expect(hookScriptCandidates('/Users/u/.harness/cli', '/Users/u/.harness/cli/cli.js', 'darwin', '/Users/u/.harness/cli'))
      // join, not literals: on a Windows host the path module writes backslashes, whatever platform is asked about.
      .toEqual([join('/Users/u/.harness/cli', 'notify.mjs'), join('/Users/u/.harness/cli', 'notify.mjs'), join('/Users/u/.harness/cli', '..', '..', '..', 'hook', 'notify.mjs')])
  })
})

// B4.1 review: a hook line a runner would misread is refused (quoteHookCommand). That refusal is an install that
// failed, logged with its reason like any other, never a rejected promise the daemon reports with a stack trace.
describe('a hook argument the Windows runner refuses', () => {
  it('fails the install with its reason for PowerShell (Codex): a typographic quote in the home it names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const home = join(dir, 'co\u2019dex')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installHookSettings('codex', codex.settings, 19473, home, {}, 'win32')).toBe(false)
    // One line, no stack (B4.10 review).
    expect(error.mock.calls).toEqual([['[hooks] Codex hooks are not installed: a hook argument holds a double or typographic quote, which PowerShell passes on differently']])
    expect(existsSync(home)).toBe(false)
  })

  it('fails the install with its reason for PowerShell (Copilot): a typographic quote in its home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const copilotHome = join(dir, 'O\u2019Brien')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rule = { ...COPILOT_HOOK_SETTINGS, file: join(copilotHome, 'hooks', 'harness.json') }
    expect(await installNativeHookSettings(rule, 19473, { environment: { HOME: dir, COPILOT_HOME: copilotHome } }, 'win32')).toBe(false)
    expect(error.mock.calls).toEqual([['[hooks] Copilot hooks are not installed: a hook argument holds a double or typographic quote, which PowerShell passes on differently']])
    expect(existsSync(copilotHome)).toBe(false)
  })

  // Any held preparation is one line on Windows; off Windows the log is what it always was: the failure line and the error.
  it('is one line on Windows for any held install, and the failure line with its error off Windows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const claudeHome = join(dir, 'claude'), rule = { ...COMMANDCODE_HOOK_SETTINGS, file: join(dir, 'commandcode', 'settings.json') }
    for (const file of [join(claudeHome, claude.settings.file), rule.file]) {
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '{"hooks":[]}\n')
    }
    expect(await installHookSettings('claude', claude.settings, 19473, claudeHome, {}, 'win32')).toBe(false)
    expect(await installNativeHookSettings(rule, 19473, {}, 'win32')).toBe(false)
    expect(error.mock.calls).toEqual([
      ['[hooks] Claude Code hooks are not installed: the hook settings do not have the declared object shape'],
      ['[hooks] Command Code hooks are not installed: the hooks member is not an object'],
    ])
    error.mockClear()
    expect(await installHookSettings('claude', claude.settings, 19473, claudeHome, {}, 'linux')).toBe(false)
    expect(await installNativeHookSettings(rule, 19473, {}, 'linux')).toBe(false)
    expect(error.mock.calls.map(([line, reason]) => [line, (reason as Error).message])).toEqual([
      [claude.settings.messages.failed, 'Hook preparation is waiting: the hook settings do not have the declared object shape'],
      [COMMANDCODE_HOOK_SETTINGS.messages.failed, 'Hook preparation is waiting: the hooks member is not an object'],
    ])
    expect(error.mock.calls.every(([, reason]) => reason instanceof HookPreparationHeld)).toBe(true)
  })
})

// B4.2 review: exec form keeps its arguments in `args`. A drift check that compared `command` alone saw every exec-form
// hook as current, whatever its port; one that compared the line saw none, and rewrote the file at every start.
describe('Claude Code\'s exec-form hook already in place', () => {
  it('is left alone: a second install writes nothing and says it is current', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const home = join(dir, 'claude'), file = join(home, claude.settings.file)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installHookSettings('claude', claude.settings, 19473, home, {}, 'win32')).toBe(true)
    const written = readFileSync(file, 'utf8'), before = statSync(file, { bigint: true })
    const hook = JSON.parse(written).hooks.Stop[0].hooks[0]
    expect(hook.args).toEqual(expect.arrayContaining(['--port', '19473']))
    expect(hook.command).toBe(managedNodePath())
    log.mockClear()
    expect(await installHookSettings('claude', claude.settings, 19473, home, {}, 'win32')).toBe(true)
    expect(log.mock.calls.map(([line]) => line)).toEqual([claude.settings.messages.current])
    const after = statSync(file, { bigint: true })
    expect(readFileSync(file, 'utf8')).toBe(written)
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
  })

  it('is rewritten when only its arguments changed (another port)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const home = join(dir, 'claude'), file = join(home, claude.settings.file)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installHookSettings('claude', claude.settings, 19473, home, {}, 'win32')).toBe(true)
    log.mockClear()
    expect(await installHookSettings('claude', claude.settings, 19474, home, {}, 'win32')).toBe(true)
    expect(log.mock.calls[0]![0]).toMatch(/^\[hooks\] updated/)
    const events = JSON.parse(readFileSync(file, 'utf8')).hooks as Record<string, Array<{ hooks: Array<{ args: string[] }> }>>
    for (const blocks of Object.values(events)) {
      expect(blocks).toHaveLength(1)
      expect(blocks[0]!.hooks[0]!.args).toEqual(expect.arrayContaining(['--port', '19474']))
    }
  })
})

// The B3.21 VM log: every start printed a stack trace for each of these engines' files. With no runner verified
// there, each is one line, and nothing is an error.
describe('an engine with no hooks on Windows', () => {
  it.each([CURSOR_HOOK_SETTINGS, DEVIN_HOOK_SETTINGS, GROK_HOOK_SETTINGS, AGY_HOOK_SETTINGS])('logs one line for $engine, no error', async (rule) => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await installNativeHookSettings({ ...rule, file: join(dir, 'x', 'hooks.json') }, 19473, {}, 'win32')).toBe(true)
    expect(log.mock.calls).toEqual([[`[hooks] ${rule.engine} hooks are not installed on Windows yet`]])
    expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'x'))).toBe(false)
  })

  it('logs one line for hermes, no error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await installHermesHooks(19473, join(dir, 'hermes'), {}, 'win32')).toBe(true)
    expect(log.mock.calls).toEqual([['[hooks] hermes hooks are not installed on Windows yet']])
    expect(error).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'hermes'))).toBe(false)
  })
})

// Fix round 1 of the B4.6 review: an install that succeeds on Windows, and is then left alone.
describe('Codex\'s PowerShell hook on Windows', () => {
  it('is written as the line PowerShell reads, and a second install writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const home = join(dir, 'codex'), file = join(home, codex.settings.file), config = join(home, codex.settings.reviewed!.file)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await installHookSettings('codex', codex.settings, 19473, home, {}, 'win32')).toBe(true)
    const line = notifyHookEntry(codex.settings, hookArgv(19473, 'codex', home), 'win32')!
    expect(line.args).toBeUndefined()
    const events = JSON.parse(readFileSync(file, 'utf8')).hooks as Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>>
    expect(Object.keys(events)).toEqual(codex.settings.events.map(({ event }) => event))
    for (const blocks of Object.values(events)) expect(blocks.map(block => block.hooks)).toEqual([[expect.objectContaining({ command: line.command })]])
    expect(JSON.stringify(events)).not.toContain('"args"')
    const stamp = (path: string) => { const info = statSync(path, { bigint: true }); return [readFileSync(path, 'utf8'), info.ino, info.mtimeNs] }
    const before = [stamp(file), stamp(config)]
    log.mockClear()
    expect(await installHookSettings('codex', codex.settings, 19473, home, {}, 'win32')).toBe(true)
    expect(log.mock.calls[0]![0]).toBe(codex.settings.messages.current.replace('{file}', file))
    expect([stamp(file), stamp(config)]).toEqual(before)
  })
})

// B4.10 (the B4.6 carries): the Copilot (PowerShell) and Command Code (cmd.exe, nested schema) installs that succeed on
// Windows, and are then left alone. hookFiles.real.spec.ts runs the same round trips on NTFS.
describe('Copilot\'s PowerShell and Command Code\'s cmd.exe hooks on Windows', () => {
  const stamp = (path: string) => { const info = statSync(path, { bigint: true }); return [readFileSync(path, 'utf8'), info.ino, info.mtimeNs] }

  it('writes Copilot a PowerShell line per event, and a second install writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const rule = { ...COPILOT_HOOK_SETTINGS, file: join(dir, 'copilot', 'hooks', 'harness.json') }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installNativeHookSettings(rule, 19473, {}, 'win32')).toBe(true)
    const line = quoteHookCommand('powershell', hookArgv(19473, 'copilot')) as string
    expect(line.startsWith('& ')).toBe(true)
    expect(JSON.parse(readFileSync(rule.file, 'utf8'))).toEqual({ version: 1, hooks: Object.fromEntries(COPILOT_HOOK_SETTINGS.events.map(event =>
      [event, [{ type: 'command', command: `${line} --copilot-event ${event}` }]])) })
    const before = stamp(rule.file)
    log.mockClear()
    expect(await installNativeHookSettings(rule, 19473, {}, 'win32')).toBe(true)
    expect(log.mock.calls).toEqual([[COPILOT_HOOK_SETTINGS.messages.current]])
    expect(stamp(rule.file)).toEqual(before)
  })

  it('writes Command Code one cmd.exe line in each nested block, and a second install writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const rule = { ...COMMANDCODE_HOOK_SETTINGS, file: join(dir, 'commandcode', 'settings.json') }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installNativeHookSettings(rule, 19473, {}, 'win32')).toBe(true)
    const line = quoteHookCommand('cmd', hookArgv(19473, 'commandcode')) as string
    expect(line.startsWith('"')).toBe(true)
    expect(JSON.parse(readFileSync(rule.file, 'utf8')).hooks).toEqual(Object.fromEntries(COMMANDCODE_HOOK_SETTINGS.events.map(event =>
      [event, [{ hooks: [{ type: 'command', command: line, timeout: COMMANDCODE_HOOK_SETTINGS.timeout }] }]])))
    const before = stamp(rule.file)
    log.mockClear()
    expect(await installNativeHookSettings(rule, 19473, {}, 'win32')).toBe(true)
    expect(log.mock.calls).toEqual([[COMMANDCODE_HOOK_SETTINGS.messages.current]])
    expect(stamp(rule.file)).toEqual(before)
  })
})

// Fix round 1 of the B4.6 review: mac and Linux do not change. Off Windows the line alone decides whether a hook of
// ours is current, as before Windows hooks: a stray `args` beside it is not drift there, and nothing is written.
// Off Windows only: on a Windows host the POSIX line these write holds drive paths, which is no line of Harness's there
// (carried B4.2, final review R2-1), so faking 'linux' on Windows would not install what macOS and Linux do.
describe.skipIf(process.platform === 'win32')('a hook of ours with a stray args key, off Windows', () => {
  const stray = (file: string) => {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; args?: string[] }> }>> }
    for (const blocks of Object.values(settings.hooks)) for (const block of blocks) for (const hook of block.hooks) {
      if (hook.command.includes('notify.mjs')) hook.args = ['stray']
    }
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  }
  const stamp = (path: string) => { const info = statSync(path, { bigint: true }); return [readFileSync(path, 'utf8'), info.ino, info.mtimeNs] }

  it('is current for Claude Code: no write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const home = join(dir, 'claude'), file = join(home, claude.settings.file)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await installHookSettings('claude', claude.settings, 19473, home, {}, 'linux')).toBe(true)
    stray(file)
    expect(readFileSync(file, 'utf8')).toContain('"stray"')
    const before = stamp(file)
    log.mockClear()
    expect(await installHookSettings('claude', claude.settings, 19473, home, {}, 'linux')).toBe(true)
    expect(log.mock.calls.map(([line]) => line)).toContain(claude.settings.messages.current)
    expect(stamp(file)).toEqual(before)
  })

  it('is current for Command Code\'s nested settings: no write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-hooks-')); dirs.push(dir)
    const rule = { ...COMMANDCODE_HOOK_SETTINGS, file: join(dir, 'commandcode', 'settings.json') }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await installNativeHookSettings(rule, 19473, {}, 'linux')).toBe(true)
    stray(rule.file)
    expect(readFileSync(rule.file, 'utf8')).toContain('"stray"')
    const before = stamp(rule.file)
    log.mockClear()
    expect(await installNativeHookSettings(rule, 19473, {}, 'linux')).toBe(true)
    expect(log.mock.calls).toEqual([[COMMANDCODE_HOOK_SETTINGS.messages.current]])
    expect(stamp(rule.file)).toEqual(before)
  })
})
