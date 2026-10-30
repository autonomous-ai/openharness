// An engine's Windows argv must never reach cmd.exe's parser. The shims are npm's own, copied from the Windows VM
// (`C:\Users\admin\AppData\Roaming\npm\{codex,opencode}.cmd`, npm 11.19.0, 2026-10-15).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseNpmCmdShim, peMachine, WindowsBatchLaunchRefused, WindowsEngineUnavailable, windowsEngineArgv, windowsEngineUnavailable, windowsLaunchRefusal } from './launch.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const CODEX_SHIM = readFileSync(join(FIXTURES, 'npm-codex.cmd'), 'utf8')
const OPENCODE_SHIM = readFileSync(join(FIXTURES, 'npm-opencode.cmd'), 'utf8')
// cmd-shim before npm 7, which some machines still have.
const OLD_SHIM = '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\pkg\\cli.js" %*\r\n) ELSE (\r\n'
  + '  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\node_modules\\pkg\\cli.js" %*\r\n)'
/** The prompts cmd.exe would have run, split or expanded. */
const HOSTILE = ['fix&calc', 'a "b & calc', 'echo %PATH%', 'line one\n\nline two', 'x | y', '(a)', 'wow!', 'a^b', '<in', '`x`']

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const folder = (): string => { const dir = mkdtempSync(join(tmpdir(), 'win-launch-')); dirs.push(dir); return dir }
const touch = (file: string, text = ''): string => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return file }

/** An npm global folder holding Codex as npm installs it, and a folder with node.exe for PATH. */
function npmCodex(nodeBeside = false) {
  const npm = folder(), nodeDir = folder()
  copyFileSync(join(FIXTURES, 'npm-codex.cmd'), join(npm, 'codex.cmd'))
  touch(join(npm, 'codex')); touch(join(npm, 'codex.ps1'))
  const script = touch(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
  const node = touch(join(nodeDir, 'node.exe'))
  if (nodeBeside) touch(join(npm, 'node.exe'))
  return { npm, script, node, environment: { PATH: `${nodeDir};${npm}` } }
}

describe('reading an npm cmd-shim', () => {
  it('finds the node script of the shim npm 11 writes', () => {
    expect(parseNpmCmdShim(CODEX_SHIM, 'C:\\npm')).toEqual({
      kind: 'node', nodeArgs: [], script: join('C:\\npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    })
  })

  it('finds the program of a shim for a package that ships an exe', () => {
    expect(parseNpmCmdShim(OPENCODE_SHIM, 'C:\\npm')).toEqual({ kind: 'exe', program: join('C:\\npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe') })
  })

  it('reads the older cmd-shim, and node options from a shebang', () => {
    expect(parseNpmCmdShim(OLD_SHIM, 'C:\\npm')).toEqual({ kind: 'node', nodeArgs: [], script: join('C:\\npm', 'node_modules', 'pkg', 'cli.js') })
    const withOptions = CODEX_SHIM.replace('"%_prog%"  "%dp0%', '"%_prog%" --no-warnings  "%dp0%')
    expect(parseNpmCmdShim(withOptions, 'C:\\npm')).toMatchObject({ kind: 'node', nodeArgs: ['--no-warnings'] })
  })

  it('reads nothing else as one', () => {
    expect(parseNpmCmdShim('@echo off\r\nclaude-real %*\r\n', 'C:\\x')).toBeNull()
    expect(parseNpmCmdShim('@echo off\r\necho hi\r\n', 'C:\\x')).toBeNull()
    // A shebang for sh, not node.
    expect(parseNpmCmdShim(CODEX_SHIM.replaceAll('node', 'sh').replace('codex.js', 'codex'), 'C:\\x')).toBeNull()
    // A runner option that is not a plain word.
    expect(parseNpmCmdShim(CODEX_SHIM.replace('"%_prog%"  "%dp0%', '"%_prog%" %X%  "%dp0%'), 'C:\\x')).toBeNull()
    // A target that is neither node's script nor an exe.
    expect(parseNpmCmdShim('"%dp0%\\node_modules\\x\\run.cmd" %*', 'C:\\x')).toBeNull()
    expect(parseNpmCmdShim('"%_prog%" "%dp0%\\x.js" %*', 'C:\\x')).toBeNull()
    expect(parseNpmCmdShim('weird "%dp0%\\x.js" %*', 'C:\\x')).toBeNull()
  })
})

describe('an engine\'s argv on Windows', () => {
  it('runs an npm engine as node on its script, so a hostile first message is only an argument', () => {
    const { script, node, environment } = npmCodex()
    for (const prompt of HOSTILE) {
      expect(windowsEngineArgv('codex', ['codex', '--approve-for-me', prompt], { environment, platform: 'win32' }))
        .toEqual([node, script, '--approve-for-me', prompt])
    }
  })

  it('prefers the node beside the shim, as the shim does', () => {
    const { npm, script, environment } = npmCodex(true)
    expect(windowsEngineArgv('codex', ['codex'], { environment, platform: 'win32' })).toEqual([join(npm, 'node.exe'), script])
  })

  it('runs the exe an npm shim names, and a native exe as it is', () => {
    const npm = folder()
    copyFileSync(join(FIXTURES, 'npm-opencode.cmd'), join(npm, 'opencode.cmd'))
    const program = touch(join(npm, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
    expect(windowsEngineArgv('opencode', ['opencode', 'fix&calc'], { environment: { PATH: npm }, platform: 'win32' })).toEqual([program, 'fix&calc'])
    const native = touch(join(folder(), 'claude.exe'))
    expect(windowsEngineArgv('claude', [native, '%PATH%'], { platform: 'win32' })).toEqual([native, '%PATH%'])
  })

  it('refuses any other batch file when an argument holds what cmd.exe reads, naming the engine', () => {
    const tools = folder()
    const batch = touch(join(tools, 'claude.cmd'), '@echo off\r\nclaude-real %*\r\n')
    for (const prompt of HOSTILE) {
      expect(() => windowsEngineArgv('claude', ['claude', prompt], { environment: { PATH: tools }, platform: 'win32' }))
        .toThrow(new WindowsBatchLaunchRefused('claude', batch))
    }
    expect(() => windowsEngineArgv('claude', ['claude', 'x'], { environment: { PATH: tools }, platform: 'win32' })).not.toThrow()
    expect(windowsEngineArgv('claude', ['claude', '--resume', 'abc-123'], { environment: { PATH: tools }, platform: 'win32' })).toEqual([batch, '--resume', 'abc-123'])
    const bat = touch(join(folder(), 'codex.bat'), '@echo off\r\n')
    expect(() => windowsEngineArgv('codex', [bat, 'a&b'], { platform: 'win32' })).toThrow(/codex on Windows/)
  })

  it('refuses an npm shim it cannot carry out: no node to run it with, its script gone, or the shim unreadable', () => {
    const { npm, script } = npmCodex()
    expect(() => windowsEngineArgv('codex', ['codex', 'a&b'], { environment: { PATH: npm }, platform: 'win32' })).toThrow(WindowsBatchLaunchRefused)
    rmSync(script)
    const nodeDir = folder(); touch(join(nodeDir, 'node.exe'))
    expect(() => windowsEngineArgv('codex', ['codex', 'a&b'], { environment: { PATH: `${nodeDir};${npm}` }, platform: 'win32' })).toThrow(WindowsBatchLaunchRefused)
    const unreadable = () => { throw new Error('EACCES') }
    expect(() => windowsEngineArgv('codex', ['codex', 'a&b'], { environment: { PATH: npm }, platform: 'win32', read: unreadable })).toThrow(WindowsBatchLaunchRefused)
    // A shim for an exe that is not there.
    const other = folder()
    copyFileSync(join(FIXTURES, 'npm-opencode.cmd'), join(other, 'opencode.cmd'))
    expect(() => windowsEngineArgv('opencode', ['opencode', '"'], { environment: { PATH: other }, platform: 'win32' })).toThrow(WindowsBatchLaunchRefused)
    // A batch file named by a path that is not there.
    expect(() => windowsEngineArgv('codex', ['C:\\nowhere\\codex.cmd', '%x%'], { environment: {}, platform: 'win32' })).toThrow(WindowsBatchLaunchRefused)
  })

  it('is the argv as it was off Windows', () => {
    const { environment } = npmCodex()
    expect(windowsEngineArgv('codex', ['codex', 'fix&calc'], { environment, platform: 'darwin' })).toEqual(['codex', 'fix&calc'])
    expect(windowsEngineArgv('codex', [], { environment, platform: 'linux' })).toEqual([])
  })
})

describe('the refusal as a create answers it', () => {
  it('is ENGINE_LAUNCH_REFUSED with its sentence; anything else is thrown on', () => {
    expect(windowsLaunchRefusal(new WindowsBatchLaunchRefused('codex', 'C:\\x\\codex.bat')))
      .toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: expect.stringContaining('C:\\x\\codex.bat is a batch file') })
    expect(() => windowsLaunchRefusal(new Error('other'))).toThrow('other')
  })
})

describe('an engine whose Windows build cannot run', () => {
  const pe = (machine: number): Buffer => {
    const bytes = Buffer.alloc(0x100)
    bytes.write('MZ', 0, 'latin1'); bytes.writeUInt32LE(0x80, 0x3c)
    bytes.write('PE\0\0', 0x80, 'latin1'); bytes.writeUInt16LE(machine, 0x84)
    return bytes
  }

  it('reads the machine a program is built for from its PE header', () => {
    expect(peMachine('x', () => pe(0xaa64))).toBe('arm64')
    expect(peMachine('x', () => pe(0x8664))).toBe('x64')
    expect(peMachine('x', () => Buffer.from('#!/bin/sh\n'))).toBeNull()
    expect(peMachine('x', () => { throw new Error('gone') })).toBeNull()
  })

  it('refuses the Arm build of OpenCode before a pane opens, in words for the person', () => {
    const exe = touch(join(folder(), 'opencode.exe'))
    let refused: unknown
    try { windowsEngineArgv('opencode', [exe], { platform: 'win32', machine: () => 'arm64' }) } catch (error) { refused = error }
    expect(refused).toBeInstanceOf(WindowsEngineUnavailable)
    expect(windowsLaunchRefusal(refused)).toEqual({ ok: false, error: 'ENGINE_LAUNCH_REFUSED', detail: windowsEngineUnavailable('opencode', exe, () => 'arm64') })
    expect((refused as Error).message).toMatch(/OpenCode/)
  })

  it('starts its x64 build, any other engine, and a version probe as before', () => {
    const exe = touch(join(folder(), 'opencode.exe'))
    expect(windowsEngineArgv('opencode', [exe, '--help'], { platform: 'win32', machine: () => 'x64' })).toEqual([exe, '--help'])
    expect(windowsEngineArgv('codex', [exe], { platform: 'win32', machine: () => 'arm64' })).toEqual([exe])
    expect(windowsEngineArgv('the engine', [exe, '--version'], { platform: 'win32', machine: () => 'arm64' })).toEqual([exe, '--version'])
  })
})
