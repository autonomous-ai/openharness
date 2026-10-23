// Hook files on real Windows (Phase B4): the path walk, the writers, the recognizers, and the lines run the way Claude
// Code, Codex, Command Code and Copilot run them. Windows only. It writes only below its own temporary folder, with
// explicit homes: os.homedir() is USERPROFILE there, which vitest.setup.ts does not redirect, so no engine default is
// written. No wall-clock bound: every wait ends on an event.
//   cd cli && npx vitest run src/lib/windows/hookFiles.real.spec.ts
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { hooks as codexContract } from '../../engines/codex/hookContract.js'
import { COMMANDCODE_HOOK_SETTINGS } from '../../engines/commandcode/contract.js'
import { COPILOT_HOOK_SETTINGS } from '../../engines/copilot/contract.js'
import { engineHooks } from '../../engines/hooks.js'
import { createHomeAdopter, readAdoptedHomes } from '../../engines/kit/homeAdoption.js'
import { NativeEvidenceBudget } from '../../engines/kit/nativeEvidence.js'
import { HookPreparationHeld, inspectHookFile, runHookPreparation } from '../../engines/kit/nativeHookFiles.js'
import { NativePaths } from '../../engines/kit/nativePaths.js'
import { HOOK_SCRIPT, hookArgv, isOurs, quoteHookCommand } from '../../engines/kit/notifyHooks.js'
import { installCommandCodeHooks, installCopilotHooks } from '../../engines/nativeHooks.js'

const enabled = process.platform === 'win32'
const root = enabled ? mkdtempSync(join(tmpdir(), 'hook-files-')) : ''
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })
afterEach(() => { vi.restoreAllMocks() })

const PORT = 19473
const stamp = (file: string) => { const info = statSync(file, { bigint: true }); return [readFileSync(file, 'utf8'), info.ino, info.mtimeNs] }
/** A profile folder under the temporary root, with a fake notify.mjs that prints its arguments (base64 JSON). */
function profile(name: string): { home: string; echo: string; environment: Record<string, string> } {
  const home = join(root, name), echo = join(home, 'echo notify.mjs')
  mkdirSync(home, { recursive: true })
  // Base64, so a console code page or PowerShell's re-encoding of a native program's output cannot change what is compared.
  writeFileSync(echo, "process.stdout.write(Buffer.from(JSON.stringify(process.argv.slice(2))).toString('base64'))\n")
  return { home, echo, environment: { HOME: home } }
}
/** What the program the line started got as its arguments. */
function delivered(result: SpawnSyncReturns<string>): string[] {
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'))
}
/** The installed line with notify.mjs swapped for the echo script; every other byte is the one the file holds. */
function withEcho(line: string, echo: string): string {
  expect(line.split(HOOK_SCRIPT)).toHaveLength(2)
  return line.replace(HOOK_SCRIPT, () => echo)
}
// Each engine's own way to run a hook line on Windows.
// Codex 0.162.1 (codex-rs): its Windows session shell, `powershell.exe -NoProfile -Command <line>`, the line one argument
// that Rust quotes as Node does (core/src/session/mod.rs `build_hooks_config`; seen on the VM in B4.15).
const codexRuns = (line: string) => spawnSync('powershell.exe', ['-NoProfile', '-Command', line], { encoding: 'utf8' })
// Codex prefers PowerShell 7 when it is installed (B4.15), `pwsh -NoProfile -Command <line>`. pwsh 7.3 and later pass
// a native program's arguments by their own rules ($PSNativeCommandArgumentPassing), so the same line is run there too.
// The VM has no pwsh; windows-latest has it.
const pwshInstalled = enabled && spawnSync('where.exe', ['pwsh'], { stdio: 'ignore' }).status === 0
const codexRunsPwsh = (line: string) => spawnSync('pwsh', ['-NoProfile', '-Command', line], { encoding: 'utf8' })
// Command Code: Node's spawn(line, { shell: true }), which is cmd.exe /d /s /c "<line>".
const commandCodeRuns = (line: string) => spawnSync(line, { shell: true, encoding: 'utf8' })
// Copilot CLI copies `command` to its `powershell` field and runs it in Windows PowerShell. Its exact flags are not
// documented; these are the ones a Node program passes to run a command line (assumption, B4.10 report).
const copilotRuns = (line: string) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], { encoding: 'utf8' })

;(enabled ? describe : describe.skip)('hook files on Windows', () => {
  it('walks a drive path, and refuses a junction on the way rather than following it', () => {
    const real = join(root, 'real'), link = join(root, 'junction')
    mkdirSync(real)
    writeFileSync(join(real, 'settings.json'), '{}')
    execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, real], { stdio: 'ignore' })
    try {
      expect(new NativePaths(new NativeEvidenceBudget()).resolveSync(join(real, 'settings.json'))?.path).toBe(join(real, 'settings.json'))
      expect(() => new NativePaths(new NativeEvidenceBudget()).resolveSync(join(link, 'settings.json'), true)).toThrow(/reparse point/)
    } finally { rmSync(link) } // the junction only, never what it points to
  })

  it('installs Claude Code exec form and a Codex line for PowerShell, and finds both current the second time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // An explicit profile, so no engine home of the real USERPROFILE is named in the lines.
    const { home, environment } = profile('defaults'), claudeHome = join(home, '.claude'), codexHome = join(home, '.codex')
    expect(await engineHooks.claude.installIn(PORT, claudeHome, { environment })).toBe(true)
    expect(await engineHooks.codex.installIn(PORT, codexHome, { environment })).toBe(true)
    const claude = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf8'))
    const hook = claude.hooks.SessionStart[0].hooks[0]
    expect(hook.command).toMatch(/\\node\.exe$/i)
    expect(hook.args[0]).toMatch(/\\notify\.mjs$/)
    expect(isOurs({ hooks: [hook] })).toBe(true)
    // Agent Messages' block is a POSIX line and is not installed on Windows yet.
    expect(claude.hooks.PostToolUse).toBeUndefined()
    const codex = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8'))
    expect(codex.hooks.SessionStart[0].hooks[0].command).toMatch(new RegExp(`^& '[^']+node\\.exe' '[^']+notify\\.mjs' --port ${PORT} `, 'i'))
    expect(isOurs(codex.hooks.SessionStart[0])).toBe(true)
    // No ~\.grok, ~\.cursor, … of the person running the spec.
    const realHomes = `${process.env.USERPROFILE}\\.`
    expect([...hook.args, codex.hooks.SessionStart[0].hooks[0].command].filter((text: string) => text.includes(realHomes))).toEqual([])
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain('trusted_hash')
    const files = [join(claudeHome, 'settings.json'), join(codexHome, 'hooks.json'), join(codexHome, 'config.toml')]
    const before = files.map(stamp)
    log.mockClear()
    expect(await engineHooks.claude.installIn(PORT, claudeHome, { environment })).toBe(true)
    expect(await engineHooks.codex.installIn(PORT, codexHome, { environment })).toBe(true)
    expect(files.map(stamp)).toEqual(before)
    expect(log).toHaveBeenCalledWith('[hooks] Claude session + turn (Stop/StopFailure) hooks already installed')
    expect(log).toHaveBeenCalledWith(codexContract.settings.messages.current.replace('{file}', join(codexHome, 'hooks.json')))
  })

  it('installs Copilot\'s PowerShell lines and Command Code\'s nested cmd.exe line, and leaves both alone the second time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { home, environment } = profile('round trip')
    const copilot = join(home, '.copilot', 'hooks', 'harness.json'), commandCode = join(home, '.commandcode', 'settings.json')
    expect(await installCopilotHooks(PORT, { environment })).toBe(true)
    expect(await installCommandCodeHooks(PORT, { environment })).toBe(true)
    const powershell = quoteHookCommand('powershell', hookArgv(PORT, 'copilot', undefined, undefined, environment)) as string
    const cmd = quoteHookCommand('cmd', hookArgv(PORT, 'commandcode', undefined, undefined, environment)) as string
    expect(JSON.parse(readFileSync(copilot, 'utf8'))).toEqual({ version: 1, hooks: Object.fromEntries(COPILOT_HOOK_SETTINGS.events.map(event =>
      [event, [{ type: 'command', command: `${powershell} --copilot-event ${event}` }]])) })
    expect(JSON.parse(readFileSync(commandCode, 'utf8')).hooks).toEqual(Object.fromEntries(COMMANDCODE_HOOK_SETTINGS.events.map(event =>
      [event, [{ hooks: [{ type: 'command', command: cmd, timeout: COMMANDCODE_HOOK_SETTINGS.timeout }] }]])))
    const before = [stamp(copilot), stamp(commandCode)]
    log.mockClear()
    expect(await installCopilotHooks(PORT, { environment })).toBe(true)
    expect(await installCommandCodeHooks(PORT, { environment })).toBe(true)
    expect(log.mock.calls).toEqual([[COPILOT_HOOK_SETTINGS.messages.current], [COMMANDCODE_HOOK_SETTINGS.messages.current]])
    expect([stamp(copilot), stamp(commandCode)]).toEqual(before)
  })

  it('delivers every argument whole the way each engine runs its line, from a profile named Thảo Nguyễn', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { home, echo, environment } = profile('Thảo Nguyễn')
    const homes = { claude: join(home, '.claude'), codex: join(home, '.codex') }
    expect(await engineHooks.claude.installIn(PORT, homes.claude, { environment })).toBe(true)
    expect(await engineHooks.codex.installIn(PORT, homes.codex, { environment })).toBe(true)
    expect(await installCommandCodeHooks(PORT, { environment })).toBe(true)
    expect(await installCopilotHooks(PORT, { environment })).toBe(true)
    const read = (file: string) => JSON.parse(readFileSync(join(home, file), 'utf8')).hooks
    const flags = (engine: 'claude' | 'codex' | 'commandcode' | 'copilot') => hookArgv(PORT, engine, engine === 'codex' ? homes.codex : undefined, undefined, environment).slice(2)
    expect(flags('codex')).toContain(homes.codex)

    // Claude Code exec form: the program and its arguments, no shell.
    const exec = read('.claude\\settings.json').SessionStart[0].hooks[0]
    expect(delivered(spawnSync(exec.command, exec.args.map((arg: string) => arg === HOOK_SCRIPT ? echo : arg), { encoding: 'utf8' }))).toEqual(flags('claude'))
    expect(delivered(codexRuns(withEcho(read('.codex\\hooks.json').SessionStart[0].hooks[0].command, echo)))).toEqual(flags('codex'))
    expect(delivered(commandCodeRuns(withEcho(read('.commandcode\\settings.json').SessionStart[0].hooks[0].command, echo)))).toEqual(flags('commandcode'))
    expect(delivered(copilotRuns(withEcho(read('.copilot\\hooks\\harness.json').sessionStart[0].command, echo))))
      .toEqual([...flags('copilot'), '--copilot-event', 'sessionStart'])
  }, 60_000) // a ceiling for the slow arm64 runner's process starts, not a timing assertion

  it('refuses a home with & ( ) for the cmd.exe engine with its reason, and the PowerShell engines pass it whole', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { home, echo, environment } = profile('Thảo & co (1)')
    expect(await installCommandCodeHooks(PORT, { environment })).toBe(false)
    // One line, no stack.
    expect(error.mock.calls).toEqual([
      ['[hooks] Command Code hooks are not installed: a hook argument holds one of " % ! & | < > ^ ( ), which cmd.exe reads as more than text'],
    ])
    expect(existsSync(join(home, '.commandcode'))).toBe(false)
    // Inside PowerShell's single quotes these are text: Copilot's line, and Codex's.
    expect(await installCopilotHooks(PORT, { environment })).toBe(true)
    const line = JSON.parse(readFileSync(join(home, '.copilot', 'hooks', 'harness.json'), 'utf8')).hooks.agentStop[0].command
    expect(delivered(copilotRuns(withEcho(line, echo))))
      .toEqual([...hookArgv(PORT, 'copilot', undefined, undefined, environment).slice(2), '--copilot-event', 'agentStop'])
    const codexHome = join(home, '.codex')
    expect(await engineHooks.codex.installIn(PORT, codexHome, { environment })).toBe(true)
    const codexLine = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command
    expect(delivered(codexRuns(withEcho(codexLine, echo)))).toEqual(hookArgv(PORT, 'codex', codexHome, undefined, environment).slice(2))
  }, 60_000)

  it.skipIf(!pwshInstalled)('delivers every argument of the Codex line whole under pwsh 7, from a profile named Thảo & co (1)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { home, echo, environment } = profile('pwsh Thảo & co (1)')
    const codexHome = join(home, '.codex')
    expect(await engineHooks.codex.installIn(PORT, codexHome, { environment })).toBe(true)
    const line = JSON.parse(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command
    expect(delivered(codexRunsPwsh(withEcho(line, echo)))).toEqual(hookArgv(PORT, 'codex', codexHome, undefined, environment).slice(2))
  }, 60_000)

  it('replaces a settings file another handle holds open once it lets go, and keeps it whole while it does not', async () => {
    mkdirSync(join(root, 'held'))
    const file = join(root, 'held', 'settings.json'), leftovers = () => readdirSync(join(root, 'held')).filter(name => name.endsWith('.tmp'))
    writeFileSync(file, '{}\n')
    // An open handle, as an engine reading its settings has. Observed on the VM: a rename over an open handle fails
    // (EPERM on Windows 11), from another process or this one, until it closes.
    let held: number | null = openSync(file, 'r')
    try {
      // Still held after every try: the reason, not the errno (any of EPERM, EACCES, EBUSY can be the last one).
      await expect(runHookPreparation([file], async (attempt) => (await inspectHookFile(file).replace('{"held":true}\n', attempt)).verify()))
        .rejects.toThrow(new HookPreparationHeld('the settings file is open in another program'))
      expect([readFileSync(file, 'utf8'), leftovers()]).toEqual(['{}\n', []])
      // Let go at the first retry: verify runs once before the rename after the flush, and again before each retry.
      let flushed = false, checks = 0, released = false
      await runHookPreparation([file], async (attempt) => {
        const watched = {
          ...attempt,
          flush: async (fd: number) => { await attempt.flush(fd); flushed = true },
          verify: () => { attempt.verify(); if (flushed && ++checks === 2 && held !== null) { closeSync(held); held = null; released = true } },
        }
        return (await inspectHookFile(file).replace('{"ok":true}\n', watched)).verify()
      })
      expect(released).toBe(true)
      expect([readFileSync(file, 'utf8'), leftovers()]).toEqual(['{"ok":true}\n', []])
    } finally { if (held !== null) closeSync(held) }
  }, 60_000)

  it('adopts a moved Claude Code home with a Windows path', () => {
    const file = join(root, 'engine-homes.json'), home = join(root, 'claude-work')
    expect(createHomeAdopter(file).adopt({ claude: [home], codex: [] }).claude).toContain(home)
    expect(readAdoptedHomes(file).homes.claude).toContain(home)
  })
})
