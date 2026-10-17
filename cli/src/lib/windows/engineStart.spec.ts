import { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { isHeldStartCommand } from '../nativePaneHold.js'
import {
  ENGINE_EXIT_CLEAR_CMD, ENGINE_EXIT_NOTICE_PS, isWindowsHeldPane, nativeLaunchConfirmed, windowsAfterExit, windowsHeldPaneArgv, windowsPaneLaunch, windowsStartupArgs,
  WindowsStartupUnverified,
} from './engineStart.js'
import { WindowsLaunchRefused, windowsLaunchRefusal } from './launch.js'

describe('the startup a Windows launch makes without a script', () => {
  it('puts the flags its native launch read from the help first, and refuses a launch nobody probed', () => {
    expect(windowsStartupArgs('codex', { startupArgs: ['--no-daemon'] })).toEqual(['--no-daemon'])
    expect(windowsStartupArgs('codex', { startupArgs: [] })).toEqual([])
    expect(windowsStartupArgs('claude', undefined)).toEqual([])
    expect(windowsStartupArgs('opencode', undefined)).toEqual([])
    const refused = (() => { try { windowsStartupArgs('codex', undefined) } catch (error) { return error } })()
    expect(refused).toBeInstanceOf(WindowsStartupUnverified)
    expect(refused).toBeInstanceOf(WindowsLaunchRefused)
    // Every launch path maps a Windows refusal to its row's answer (create, fork, restore, resume, restart, swap).
    expect(windowsLaunchRefusal(refused)).toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED',
      detail: 'Could not verify Codex startup options. Please try opening this session again.' })
    expect(() => windowsLaunchRefusal(new Error('other'))).toThrow('other')
  })

  it('confirms a native launch as its script guard would', () => {
    const proof = (current: boolean) => ({ files: [], current: () => current }) as unknown as NativeLaunch['proofs'][number]
    const executable = (current: boolean) => ({ command: 'codex.exe', identity: 'x', current: () => current })
    expect(nativeLaunchConfirmed({ proofs: [] })).toBe(true)
    expect(nativeLaunchConfirmed({ executable: executable(true), proofs: [proof(true)] })).toBe(true)
    expect(nativeLaunchConfirmed({ executable: executable(true), ready: () => true, proofs: [] })).toBe(true)
    expect(nativeLaunchConfirmed({ executable: executable(true), ready: () => false, proofs: [] })).toBe(false)
    expect(nativeLaunchConfirmed({ executable: executable(false), proofs: [] })).toBe(false)
    expect(nativeLaunchConfirmed({ executable: executable(true), proofs: [proof(true), proof(false)] })).toBe(false)
  })
})

describe('a held pane on Windows', () => {
  it('is the daemon\'s Node with the detail and token as arguments, told by its start command', () => {
    const token = '0f0e0d0c-0b0a-4908-8706-050403020100'
    const argv = windowsHeldPaneArgv('Waiting for "Codex" & co.', token, 'C:\\node\\node.exe')
    expect(argv[0]).toBe('C:\\node\\node.exe')
    expect(argv.slice(3)).toEqual(['harness-held', 'Waiting for "Codex" & co.', token])
    // The detail is an argument, never script text.
    expect(argv[2]).not.toContain('Codex')
    expect(isHeldStartCommand(argv.join(' '), token)).toBe(true)
    expect(windowsHeldPaneArgv('why').slice(3)).toEqual(['harness-held', 'why'])
    expect(windowsHeldPaneArgv('why')[0]).toMatch(/node/)
  })

  // A signal here; on Windows, Node's kill is TerminateProcess, and Ctrl-C in a pane is a console event
  // (engineStart.real.spec.ts sends it there).
  it.skipIf(process.platform === 'win32')('says why and keeps waiting through an interrupt', async () => {
    const [node, ...args] = windowsHeldPaneArgv('Waiting for the Store.', undefined, process.execPath)
    const child = spawn(node!, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      let output = ''
      await new Promise<void>((resolve) => child.stdout.on('data', (chunk: Buffer) => { output += chunk; if (output.includes('\n')) resolve() }))
      expect(output).toBe('Waiting for the Store.\r\n')
      child.kill('SIGINT')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
    } finally { child.kill('SIGKILL') }
  })
})

describe('the shell a Windows engine\'s pane becomes', () => {
  it('is the default shell; PowerShell first says what happened, from its environment alone', () => {
    for (const shell of [['pwsh.exe', '-NoLogo'], ['powershell.exe', '-NoLogo'], ['C:\\Program Files\\PowerShell\\7\\PWSH.EXE']]) {
      expect(windowsAfterExit('codex', shell)).toEqual({ command: [...shell, '-NoExit', '-Command', ENGINE_EXIT_NOTICE_PS], env: { HARNESS_ENGINE_COMMAND: 'codex' } })
    }
    // cmd.exe, where there is no PowerShell, takes both variables out again with fixed text and says nothing.
    expect(windowsAfterExit('claude', ['C:\\Windows\\system32\\cmd.exe'])).toEqual({
      command: ['C:\\Windows\\system32\\cmd.exe', '/k', 'set HARNESS_ENGINE_COMMAND=& set HARNESS_ENGINE_EXIT='], env: { HARNESS_ENGINE_COMMAND: 'claude' } })
    expect(ENGINE_EXIT_CLEAR_CMD).toBe('set HARNESS_ENGINE_COMMAND=& set HARNESS_ENGINE_EXIT=')
    expect(windowsAfterExit('claude').command[0]).toMatch(/pwsh|powershell|cmd/i)
    // Fixed text: the name and the status are read from the environment the host gives the shell.
    expect(ENGINE_EXIT_NOTICE_PS).toContain('$env:HARNESS_ENGINE_COMMAND')
    expect(ENGINE_EXIT_NOTICE_PS).toContain('$env:HARNESS_ENGINE_EXIT')
    expect(ENGINE_EXIT_NOTICE_PS).not.toContain('"')
  })

  it('is given, with the workspace and the names to clear, to an engine\'s pane on Windows only', () => {
    const native = { clearEnvironment: ['CODEX_HOME', 'ANTHROPIC_API_KEY'] }
    expect(windowsPaneLaunch('claude', { cwd: '/work', clearEnv: ['A'] }, 'darwin')).toEqual({})
    expect(windowsPaneLaunch('claude', { cwd: '/work' }, 'win32')).toEqual({ cwd: '/work', afterExit: windowsAfterExit('claude') })
    // A grid launch's provider keys and the native launch's cleared locations, once each.
    expect(windowsPaneLaunch('codex', { cwd: null, clearEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], native }, 'win32'))
      .toEqual({ clearInherited: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME'], afterExit: windowsAfterExit('codex') })
    expect(windowsPaneLaunch('codex', { clearEnv: [], native: { clearEnvironment: [] } }, 'win32')).toEqual({ afterExit: windowsAfterExit('codex') })
    // The command a person would type names it. On Windows Command Code's is `command-code`: `cmd` is the command
    // processor there (F7, B4.13).
    expect(windowsPaneLaunch('commandcode', {}, 'win32').afterExit?.env).toEqual({ HARNESS_ENGINE_COMMAND: 'command-code' })
    vi.stubEnv('CODEX_PATH', 'C:\\tools\\codex.exe')
    try {
      expect(windowsPaneLaunch('codex', {}, 'win32').afterExit?.env).toEqual({ HARNESS_ENGINE_COMMAND: 'codex.exe' })
    } finally { vi.unstubAllEnvs() }
    // A terminal's shell, or a held pane, ending is the pane's end; a held pane is told by its flag, never its argv.
    expect(windowsPaneLaunch('terminal', { cwd: '/work' }, 'win32')).toEqual({ cwd: '/work' })
    expect(windowsPaneLaunch('codex', { cwd: '/work', held: true }, 'win32')).toEqual({ cwd: '/work' })
    expect(windowsPaneLaunch('codex', { cwd: '/work' })).toEqual(process.platform === 'win32' ? { cwd: '/work', afterExit: windowsAfterExit('codex') } : {})
  })

  it('tells a held pane by the argv it made, not by what an argv says', () => {
    expect(isWindowsHeldPane(windowsHeldPaneArgv('why', 't'))).toBe(true)
    // A first message that names it, or a copy of the held argv, is no held pane.
    expect(isWindowsHeldPane(['claude.exe', 'harness-held', 'why'])).toBe(false)
    expect(isWindowsHeldPane([...windowsHeldPaneArgv('why', 't')])).toBe(false)
  })
})
