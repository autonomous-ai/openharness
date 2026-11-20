// Every program the dial's work starts on Windows is an .exe with its arguments, never cmd.exe. The launchers are real
// installs' own, byte for byte (fixtures/, docs/plans/2026-11-19-dial-windows-vm-notes.md `## Task 1`).
import { mkdirSync,mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseElectronLauncher, windowsProgram, WindowsProgramRefused } from './program.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
/** Arguments cmd.exe would run, split or expand. */
const HOSTILE = ['fix&calc', 'a | b', '100%PATH%', 'say "hi', 'a^b', 'line one\r\nline two']
const INSTALL = ['--install-extension', 'x.vsix', '--force']

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
/** [name] in a new folder of its own. */
const folder = (name: string): string => { const dir = mkdtempSync(join(tmpdir(), 'win-program-')); dirs.push(dir); return join(dir, name) }
const touch = (file: string, text = ''): string => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return file }

/** VS Code as its user setup installs it: `bin\code.cmd`, `Code.exe`, and the app under its build's commit. */
function vscode(root = folder('Microsoft VS Code')) {
  return {
    launcher: touch(join(root, 'bin', 'code.cmd'), fixture('code.cmd')),
    exe: touch(join(root, 'Code.exe')),
    script: touch(join(root, '8a14f0cc1b', 'resources', 'app', 'out', 'cli.js')),
  }
}

/** Cursor as its user setup installs it: `resources\app\bin\cursor.cmd`, `Cursor.exe` at the root, the app beside bin. */
function cursor(root = folder('cursor')) {
  return {
    launcher: touch(join(root, 'resources', 'app', 'bin', 'cursor.cmd'), fixture('cursor.cmd')),
    exe: touch(join(root, 'Cursor.exe')),
    script: touch(join(root, 'resources', 'app', 'out', 'cli.js')),
  }
}

/** Codex as npm installs it in [npm], and a folder with a node.exe to put on PATH. */
function npmCodex(npm = folder('npm')) {
  const shim = touch(join(npm, 'codex.cmd'), fixture('npm-codex.cmd'))
  const script = touch(join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
  const nodeDir = folder('nodejs')
  const node = touch(join(nodeDir, 'node.exe'))
  return { npm, shim, script, node, environment: { PATH: `${nodeDir};${npm}` } }
}

/** The refusal [start] throws. */
function refusal(start: () => unknown): WindowsProgramRefused {
  try { start() } catch (error) {
    if (error instanceof WindowsProgramRefused) return error
    throw error
  }
  throw new Error('it was started')
}

describe('a program on Windows', () => {
  it('runs an .exe as it is, every argument whole', () => {
    const exe = 'C:\\Program Files\\Tool\\tool.exe'
    expect(windowsProgram(exe, HOSTILE, { platform: 'win32' })).toStrictEqual({ file: exe, args: HOSTILE })
  })

  it('runs an npm shim as node on its script: the node beside the shim, else the one on PATH', () => {
    const { npm, shim, script, node, environment } = npmCodex()
    expect(windowsProgram(shim, HOSTILE, { platform: 'win32', environment })).toStrictEqual({ file: node, args: [script, ...HOSTILE] })
    const beside = touch(join(npm, 'node.exe'))
    expect(windowsProgram(shim, ['exec'], { platform: 'win32', environment })).toStrictEqual({ file: beside, args: [script, 'exec'] })
  })

  it('runs the .exe an npm shim names', () => {
    const npm = folder('npm')
    const shim = touch(join(npm, 'opencode.cmd'), fixture('npm-opencode.cmd'))
    const exe = touch(join(npm, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
    expect(windowsProgram(shim, HOSTILE, { platform: 'win32', environment: {} })).toStrictEqual({ file: exe, args: HOSTILE })
  })

  it('runs VS Code\'s and Cursor\'s own launcher as the app\'s .exe on its CLI script, the rest of the environment kept', () => {
    const environment = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a' }
    const code = vscode()
    expect(windowsProgram(code.launcher, INSTALL, { platform: 'win32', environment })).toStrictEqual({
      file: code.exe, args: [code.script, ...INSTALL], env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
    })
    const editor = cursor()
    expect(windowsProgram(editor.launcher, INSTALL, { platform: 'win32', environment })).toStrictEqual({
      file: editor.exe, args: [editor.script, ...INSTALL], env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('sets and clears what the launcher\'s own lines do, a name in any case', () => {
    const code = vscode()
    const environment = { PATH: 'C:\\Windows', VSCODE_DEV: '1', electron_run_as_node: '0' }
    expect(windowsProgram(code.launcher, [], { platform: 'win32', environment }).env).toStrictEqual({ PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' })
  })

  it('reads the launcher at every start', () => {
    const root = join(tmpdir(), 'Microsoft VS Code')
    const launcher = join(root, 'bin', 'code.cmd')
    const before = join(root, '8a14f0cc1b', 'resources', 'app', 'out', 'cli.js')
    const after = join(root, '0123456789', 'resources', 'app', 'out', 'cli.js')
    const files = new Map([[launcher, fixture('code.cmd')], [join(root, 'Code.exe'), ''], [before, '']])
    const read = (file: string): string => {
      const text = files.get(file)
      if (text === undefined) throw new Error('ENOENT')
      return text
    }
    const start = () => windowsProgram(launcher, ['--version'], { platform: 'win32', environment: {}, read, exists: (file) => files.has(file) })
    expect(start().args).toEqual([before, '--version'])
    // An update puts its build's folder in place of the old one, then rewrites the launcher.
    files.delete(before)
    files.set(after, '')
    expect(refusal(start).program).toBe(launcher)
    files.set(launcher, fixture('code.cmd').replace('8a14f0cc1b', '0123456789'))
    expect(start().args).toEqual([after, '--version'])
  })

  it('refuses orca.cmd, which only cmd.exe runs, with plain words and with a message body', () => {
    const bin = folder(join('orca', 'resources', 'bin'))
    const launcher = touch(join(bin, 'orca.cmd'), fixture('orca.cmd'))
    touch(join(bin, 'orca.exe'))
    for (const args of [['--help'], ['orchestration', 'send', '--to', 'a', '--text', 'line one\nline two']]) {
      expect(refusal(() => windowsProgram(launcher, args, { platform: 'win32', environment: {} })).program).toBe(launcher)
    }
  })

  it('finds every program in a profile named with spaces, Vietnamese letters, \', & and %', () => {
    const profile = folder('Nguyễn Văn A\' & 100%')
    const code = vscode(join(profile, 'AppData', 'Local', 'Programs', 'Microsoft VS Code'))
    expect(windowsProgram(code.launcher, HOSTILE, { platform: 'win32', environment: {} }))
      .toStrictEqual({ file: code.exe, args: [code.script, ...HOSTILE], env: { ELECTRON_RUN_AS_NODE: '1' } })
    const codex = npmCodex(join(profile, 'AppData', 'Roaming', 'npm'))
    expect(windowsProgram(codex.shim, HOSTILE, { platform: 'win32', environment: codex.environment }))
      .toStrictEqual({ file: codex.node, args: [codex.script, ...HOSTILE] })
  })

  it('refuses any other batch file, with plain words too, naming it but not its folder', () => {
    const profile = folder('Nguyễn Văn A')
    const launcher = touch(join(profile, 'tools', 'tool.cmd'), '@echo off\r\nstart calc %*\r\n')
    for (const args of [['hello'], HOSTILE]) {
      const refused = refusal(() => windowsProgram(launcher, args, { platform: 'win32', environment: {} }))
      expect(refused.program).toBe(launcher)
      expect(refused.message).toContain('tool.cmd')
      expect(refused.message).not.toContain(profile)
    }
    const bat = touch(join(profile, 'tools', 'tool.bat'), '@echo off\r\nstart calc %*\r\n')
    expect(refusal(() => windowsProgram(bat, ['hello'], { platform: 'win32', environment: {} })).program).toBe(bat)
  })

  it('refuses an npm shim it cannot carry out: its script gone, or no node to run it with', () => {
    const { shim, script, environment } = npmCodex()
    expect(refusal(() => windowsProgram(shim, ['exec'], { platform: 'win32', environment: { PATH: '' } })).program).toBe(shim)
    rmSync(script)
    for (const args of [['exec'], HOSTILE]) {
      expect(refusal(() => windowsProgram(shim, args, { platform: 'win32', environment })).program).toBe(shim)
    }
  })

  it('refuses VS Code\'s launcher when its .exe is not there, or it cannot be read', () => {
    const code = vscode()
    expect(refusal(() => windowsProgram(code.launcher, INSTALL, { platform: 'win32', environment: {}, read: () => { throw new Error('EACCES') } })).program)
      .toBe(code.launcher)
    rmSync(code.exe)
    expect(refusal(() => windowsProgram(code.launcher, INSTALL, { platform: 'win32', environment: {} })).program).toBe(code.launcher)
  })

  it('refuses a launcher whose shape changed, as a later VS Code\'s may', () => {
    const changed = [
      fixture('code.cmd').replace(/endlocal\r\n$/, 'endlocal & start calc\r\n'),
      `${fixture('code.cmd')}start calc\r\n`,
      fixture('code.cmd').replace('set ELECTRON_RUN_AS_NODE=1\r\n', ''),
      fixture('code.cmd').replace('cli.js" %*', 'cli.js" --verbose %*'),
    ]
    for (const text of changed) {
      const code = vscode()
      writeFileSync(code.launcher, text)
      expect(refusal(() => windowsProgram(code.launcher, ['hello'], { platform: 'win32', environment: {} })).program).toBe(code.launcher)
    }
  })

  it('is the program as given off Windows', () => {
    const code = vscode()
    expect(windowsProgram(code.launcher, HOSTILE, { platform: 'darwin' })).toStrictEqual({ file: code.launcher, args: HOSTILE })
    expect(windowsProgram('/usr/local/bin/code', INSTALL, { platform: 'linux' })).toStrictEqual({ file: '/usr/local/bin/code', args: INSTALL })
  })
})

describe('reading an editor\'s own launcher', () => {
  it('finds the .exe and the script VS Code\'s and Cursor\'s name, beside the launcher', () => {
    const root = join(tmpdir(), 'Programs')
    expect(parseElectronLauncher(fixture('code.cmd'), join(root, 'Microsoft VS Code', 'bin'))).toEqual({
      exe: join(root, 'Microsoft VS Code', 'Code.exe'),
      script: join(root, 'Microsoft VS Code', '8a14f0cc1b', 'resources', 'app', 'out', 'cli.js'),
    })
    expect(parseElectronLauncher(fixture('cursor.cmd'), join(root, 'cursor', 'resources', 'app', 'bin'))).toEqual({
      exe: join(root, 'cursor', 'Cursor.exe'),
      script: join(root, 'cursor', 'resources', 'app', 'out', 'cli.js'),
    })
  })

  it('reads no other batch file as one', () => {
    for (const text of [fixture('orca.cmd'), fixture('npm-codex.cmd'), fixture('npm-opencode.cmd'), '@echo off\r\nstart calc %*\r\n', '',
      fixture('code.cmd').replace('..\\Code.exe', '..\\%APP%.exe'),
      fixture('code.cmd').replace('cli.js"', 'cli.js" "%~dp0..\\x.js"')]) {
      expect(parseElectronLauncher(text, 'bin')).toBeNull()
    }
  })
})
