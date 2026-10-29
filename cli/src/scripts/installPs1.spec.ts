import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SERVICE_REGISTERED_NOT_RUNNING } from '../lib/serviceCommand.js'

// vitest runs from cli/, so this is cli/scripts/install.ps1, the file published to the CDN.
const installer = join(process.cwd(), 'scripts', 'install.ps1')
const source = readFileSync(installer, 'utf8')

describe('install.ps1, as written', () => {
  it('is pure ASCII: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page', () => {
    const offending = source.split(/\r?\n/).flatMap((line, i) => (/[^\t\r\x20-\x7e]/.test(line) ? [`${i + 1}: ${line}`] : []))
    expect(offending).toEqual([])
  })

  it('has exactly one manifest-base line, the production one, for the staging upload to rewrite', () => {
    const lines = source.split(/\r?\n/).filter((line) => line.startsWith("$HarnessManifestBase = '"))
    expect(lines).toEqual(["$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'"])
  })

  it('never writes machine-wide state: no machine PATH, no HKLM write, no elevation', () => {
    expect(source).not.toMatch(/'Machine'|\[EnvironmentVariableTarget\]::Machine|LocalMachine/)
    expect(source).not.toMatch(/-Verb\s+RunAs/i)
    for (const line of source.split(/\r?\n/).filter((l) => l.includes('HKLM:'))) expect(line).toContain('Get-ItemProperty')
  })

  it('runs its install only outside library mode, and never exits a session it was iex-ed into', () => {
    expect(source).toContain("if ($env:HARNESS_INSTALL_LIBRARY -ne '1') {")
    expect(source).toContain('if ($HarnessScriptPath) { exit $harnessExit }')
  })

  it('installs harness.exe, a program, as the harness command: no batch file re-parses the arguments', () => {
    expect(source).not.toMatch(/@echo off|%\*/i)
    expect(source).toContain("$HarnessPtyFiles = @('harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe')")
    expect(source).toContain("$command = Join-Path $bin 'harness.exe'")
    // An earlier install's harness.cmd is removed, not left beside it.
    expect(source).toContain("$old = Join-Path $bin 'harness.cmd'")
  })

  it('uses no command that module autoload must find: Get-FileHash is not recognized under a PowerShell 7 PSModulePath', () => {
    const code = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#'))
    expect(code.filter((line) => /Get-FileHash|Expand-Archive|New-TemporaryFile|Format-Hex|Import-PowerShellDataFile/i.test(line))).toEqual([])
  })

  it('tells the task registered but not running now (exit 5, serviceCommand.ts) from a failure', () => {
    expect(SERVICE_REGISTERED_NOT_RUNNING).toBe(5)
    expect(source).toContain('if ($exit -eq 5 -and -not $why) { return }')
  })

  // G8 / final review R3-6: a reinstall over a signed-in, running install still said `harness login # 1. sign in`.
  it('skips the setup steps in its closing guide when this computer is signed in and Harness runs', () => {
    expect(source).toContain('Write-HarnessDone -Version $version -Desktop:$Desktop -NoService:$NoService -Command $command')
    const ready = source.match(/^function Test-HarnessReady[\s\S]*?^}\r?$/m)?.[0] ?? ''
    expect(ready).toContain('auth status --json')
    expect(ready).toContain('$auth.loggedIn -ne $true')
    // The row as the CLI prints it (`status     ● running · …`), its glyph optional (Windows PowerShell may read it in
    // the console code page), and `● started` too. The CLI's stderr never reaches the closing text (re-review P3).
    expect(ready).toContain("'^\\s*status\\s+(\\S+\\s+)?(running|started)\\b'")
    expect(ready).toContain('auth status --json 2>$null')
    expect(ready).toContain('& $Command status 2>$null')
    expect(ready).toContain("$ErrorActionPreference = 'Continue'")
    const done = source.match(/^function Write-HarnessDone[\s\S]*?^}\r?$/m)?.[0] ?? ''
    expect(done.indexOf('Test-HarnessReady -Command $Command')).toBeLessThan(done.indexOf('harness login'))
    expect(done).toContain('This computer is signed in and Harness is running: nothing more to set up.')
  })

  it('never installs hn or tmux on Windows', () => {
    expect(source).not.toMatch(/harness-tui|tmux/i)
  })

  it('moves a running daemon to the new build when it is run again over an install', () => {
    expect(source).toContain('$before = Read-HarnessCurrentCli -Root $root')
    expect(source).toContain('$ptyBefore = Read-HarnessCurrentPty -Root $root')
    expect(source).toContain('$null = Restart-HarnessDaemon -Command $command -Before $before -After $version -PtyBefore $ptyBefore -PtyAfter $ptyAfter')
  })

  it('clears a terminal host probation when it moves current-pty, and names the host when a host-only move does not start', () => {
    const pty = source.match(/^function Install-HarnessPty[\s\S]*?^}\r?$/m)?.[0] ?? ''
    expect(pty).toContain("if ($before -ne $version) { Remove-Item -LiteralPath (Join-Path $ptyRoot 'pty-pending.json') -Force -ErrorAction SilentlyContinue }")
    expect(pty.indexOf('Write-HarnessPointer -Path $pointer -Value $version')).toBeLessThan(pty.indexOf("'pty-pending.json'"))
    expect(source).toContain(`Write-Host "  Harness did not start again on terminal host \${PtyAfter}. Run 'harness start'."`)
  })

  it('keeps exactly one app-default line off in the CLI source', () => {
    expect(source.split(/\r?\n/).filter((line) => line.startsWith('$HarnessInstallApp ='))).toEqual(['$HarnessInstallApp = $false'])
    expect(source).toContain('if ($App -or $HarnessInstallApp) {')
  })

  it('waits for the extracted launcher only, not the installed app it starts', () => {
    const start = source.match(/^function Start-HarnessAppInstall[\s\S]*?^}\r?$/m)?.[0] ?? ''
    expect(start).toContain('$process.WaitForExit()')
    expect(start).not.toMatch(/Start-Process/)
  })
})

const windows = process.platform === 'win32'
const scratch: string[] = []
const subkeys: string[] = []
// The registry keys first: a folder a still-running program holds cannot be removed, and must not leave keys behind.
afterAll(() => {
  for (const key of subkeys) spawnSync('reg.exe', ['delete', `HKCU\\${key}`, '/f'], { encoding: 'utf8' })
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* left in the temp folder */ }
  }
})

/**
 * The PSModulePath Windows PowerShell 5.1 starts with:
 * - `default`: none given, so 5.1 builds its own (a person's PowerShell window, a cmd window);
 * - `inherited`: whatever this process has. Under a PowerShell 7 step (CI) that puts 7's modules first;
 * - `powershell7`: that CI shape on any computer, with a stand-in for 7's Microsoft.PowerShell.Utility first. Like
 *   7's own, it lists Get-FileHash among its cmdlets and nests the Utility DLL, which 5.1 finds in its own GAC. 5.1's
 *   autoload loads it for the first Utility cmdlet used, and Get-FileHash, a script function only 5.1's own module
 *   defines, is then "not recognized" (CI run 38826134075; the same with pwsh 7.6.7's real module on the VM).
 */
type ModulePath = 'default' | 'inherited' | 'powershell7'
let powershell7Modules: string | undefined
function powershellEnv(modulePath: ModulePath, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'psmodulepath')
  if (modulePath !== 'inherited' && key) delete env[key]
  if (modulePath === 'powershell7') {
    if (!powershell7Modules) {
      powershell7Modules = mkdtempSync(join(tmpdir(), 'harness-ps7-modules-'))
      scratch.push(powershell7Modules)
      const module = join(powershell7Modules, 'Microsoft.PowerShell.Utility')
      mkdirSync(module)
      writeFileSync(join(module, 'Microsoft.PowerShell.Utility.psd1'), "@{ ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '3.0'; NestedModules = @('Microsoft.PowerShell.Commands.Utility.dll'); CmdletsToExport = @('Add-Type', 'ConvertFrom-Json', 'Get-FileHash', 'Invoke-WebRequest', 'New-Object', 'Select-Object', 'Start-Sleep', 'Write-Host') }\r\n")
    }
    const system = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
    env.PSModulePath = `${powershell7Modules};${join(process.env.ProgramFiles!, 'WindowsPowerShell', 'Modules')};${system}`
  }
  return { ...env, ...extra }
}

/** Run [script] in Windows PowerShell 5.1 with the installer dot-sourced in library mode. */
function ps(script: string, env: NodeJS.ProcessEnv = {}, modulePath: ModulePath = 'default'): { status: number | null; stdout: string; stderr: string } {
  const text = `$ErrorActionPreference = 'Stop'; . '${installer}'; ${script}`
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
    encoding: 'utf8', env: powershellEnv(modulePath, { HARNESS_INSTALL_LIBRARY: '1', ...env }), timeout: 120_000,
  })
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr }
}

/** The message a call throws, or `no error`. */
const thrown = (call: string) => ps(`try { ${call} | Out-Null; 'no error' } catch { $_.Exception.Message }`).stdout

// Each case starts powershell.exe several times, and one start takes 1 to 2 seconds on the ARM64 VM: the
// default 5 seconds timed out six of the seven cases there.
describe.runIf(windows)('install.ps1 building blocks, in Windows PowerShell 5.1', { timeout: 120_000 }, () => {
  it('names this computer\'s platform from the native architecture, and refuses one Harness is not built for', () => {
    expect(ps("Get-HarnessPlatform -Architecture 'AMD64'").stdout).toBe('win32-x64')
    expect(ps("Get-HarnessPlatform -Architecture 'ARM64'").stdout).toBe('win32-arm64')
    expect(thrown("Get-HarnessPlatform -Architecture 'x86'")).toContain('not supported')
    expect(ps('Get-HarnessPlatform').stdout).toMatch(/^win32-(x64|arm64)$/)
  })

  it('refuses a Windows older than ConPTY, and a Windows without its own tar.exe', () => {
    expect(thrown('Test-HarnessHost -Build 17134')).toContain('Windows 10 version 1809 or later')
    const empty = mkdtempSync(join(tmpdir(), 'harness-ps1-root-'))
    scratch.push(empty)
    expect(thrown(`Test-HarnessHost -Build 22631 -SystemRoot '${empty}'`)).toContain('tar.exe')
    expect(ps('Test-HarnessHost').stdout.toLowerCase()).toBe(join(process.env.SystemRoot!, 'System32', 'tar.exe').toLowerCase())
  })

  // 2026-10-28: 0 of 25 Windows Store installs succeeded; where git was missing, the clone failed at once.
  it('finds git on PATH or where Git for Windows installs it, and says how to get Git for Windows when there is none', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ps1-git-'))
    scratch.push(root)
    const cmd = join(root, 'Git', 'cmd')
    mkdirSync(cmd, { recursive: true })
    writeFileSync(join(cmd, 'git.exe'), '')
    expect(ps(`Find-HarnessGit -Path 'C:\\nowhere;${cmd}' -Roots @()`).stdout).toBe(join(cmd, 'git.exe'))
    expect(ps(`Find-HarnessGit -Path '' -Roots @('${root}')`).stdout).toBe(join(cmd, 'git.exe'))
    expect(ps(`Find-HarnessGit -Path '' -Roots @()`).stdout).toBe('')
    // A PATH entry on a drive that is not there (an unplugged USB disk, an unmapped share), or one written in quotes:
    // Join-Path stops on the first under errors-stop, and a finished install then exited as failed (review of #2025).
    const absent = 'ZYXWVUTSRQ'.split('').find((letter) => !existsSync(`${letter}:\\`))!
    const odd = ps(`Find-HarnessGit -Path '${absent}:\\gone;"C:\\quoted dir";${cmd}' -Roots @('${absent}:\\gone')`)
    expect(odd.stdout, odd.stderr).toBe(join(cmd, 'git.exe'))
    expect(odd.status).toBe(0)
    const missing = ps(`Write-HarnessGitNote -Git ''`).stdout
    expect(missing).toContain('Git for Windows is not installed')
    expect(missing).toContain('winget install --id Git.Git -e')
    expect(missing).toContain('https://git-scm.com/download/win')
    expect(ps(`Write-HarnessGitNote -Git '${join(cmd, 'git.exe')}'`).stdout).toBe('')
  })

  it('trusts https:// and local files only, and resolves a local manifest\'s relative names against its folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-ref-'))
    scratch.push(dir)
    const manifest = join(dir, 'install-manifest.json')
    writeFileSync(manifest, '{}')
    expect(ps(`Resolve-HarnessRef 'cli.js' '${manifest}'`).stdout).toBe(join(dir, 'cli.js'))
    expect(ps(`Resolve-HarnessRef 'https://cdn.example/a.zip' '${manifest}'`).stdout).toBe('https://cdn.example/a.zip')
    expect(thrown(`Resolve-HarnessRef 'http://cdn.example/a.zip' '${manifest}'`)).toContain('https://')
    expect(thrown("Resolve-HarnessRef 'cli.js' 'https://cdn.example/metadata.json'")).toContain('not an https:// address')
    expect(thrown("Get-HarnessJson 'http://cdn.example/metadata.json'")).toContain('https://')
  })

  it('keeps a download only when its size and SHA-256 are the manifest\'s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-dl-'))
    scratch.push(dir)
    const file = join(dir, 'payload.bin')
    writeFileSync(file, 'harness')
    const sha = 'a'.repeat(64) // a valid shape, not this file's digest
    const real = createHash('sha256').update('harness').digest('hex')
    const out = join(dir, 'out.bin')
    expect(ps(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${real}' -Size 7; 'ok'`).stdout).toBe('ok')
    // Also with PowerShell 7's modules first on PSModulePath, as a PowerShell 7 window or CI hands it on.
    expect(ps(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${real}' -Size 7; 'ok'`, {}, 'powershell7').stdout).toBe('ok')
    expect(ps(`Get-HarnessSha256 '${file}'`, {}, 'powershell7').stdout).toBe(real)
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${real}' -Size 8`)).toContain('7 bytes, but the manifest says 8')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 '${sha}' -Size 7`)).toContain('failed its checksum')
    expect(thrown(`Save-HarnessVerified -Source '${file}' -Destination '${out}' -Sha256 'nope' -Size 7`)).toContain('no valid SHA-256')
  })

  it('writes a pointer as its value and CRLF, with no BOM, and replaces one that is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-ptr-'))
    scratch.push(dir)
    const pointer = join(dir, 'current')
    expect(ps(`Write-HarnessPointer -Path '${pointer}' -Value '1.2.3'; 'ok'`).stdout).toBe('ok')
    expect(ps(`Write-HarnessPointer -Path '${pointer}' -Value '1.2.4'; 'ok'`).stdout).toBe('ok')
    expect(readFileSync(pointer)).toEqual(Buffer.from('1.2.4\r\n'))
    expect(readdirSync(dir)).toEqual(['current']) // no temporary file left beside it
  })

  it('adds the bin folder to the user\'s PATH once, keeping the value\'s kind and what was there', () => {
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    spawnSync('reg.exe', ['add', `HKCU\\${subkey}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', '%SystemRoot%\\fake', '/f'], { encoding: 'utf8' })
    const bin = 'C:\\Users\\someone\\.harness\\bin'
    expect(ps(`Add-HarnessUserPath -Directory '${bin}' -SubKey '${subkey}'`).stdout).toBe('True')
    expect(ps(`Add-HarnessUserPath -Directory '${bin}\\' -SubKey '${subkey}'`).stdout).toBe('False')
    const query = spawnSync('reg.exe', ['query', `HKCU\\${subkey}`, '/v', 'Path'], { encoding: 'utf8' }).stdout
    expect(query).toContain('REG_EXPAND_SZ')
    expect(query).toContain(`%SystemRoot%\\fake;${bin}`)
  })

  it('writes PATH under HARNESS_INSTALL_ENV_KEY when no -SubKey is given, so a test never reaches the real one', () => {
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    const bin = `C:\\Users\\someone\\.harness-${randomUUID()}\\bin`
    expect(ps(`Add-HarnessUserPath -Directory '${bin}'`, { HARNESS_INSTALL_ENV_KEY: subkey }).stdout).toBe('True')
    expect(spawnSync('reg.exe', ['query', `HKCU\\${subkey}`, '/v', 'Path'], { encoding: 'utf8' }).stdout).toContain(bin)
    expect(spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' }).stdout).not.toContain(bin)
  })

  it('reads one -Manifest document for all three entries, and says which entry is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-man-'))
    scratch.push(dir)
    const manifest = join(dir, 'install-manifest.json')
    writeFileSync(manifest, JSON.stringify({ cli: { version: '1.2.3' }, node: { 'win32-x64': { version: 'v22.0.0' } }, pty: { 'win32-x64': { version: '1.2.3' } } }))
    expect(ps(`(Get-HarnessManifests -Manifest '${manifest}' -Platform 'win32-x64').node.entry.version`).stdout).toBe('v22.0.0')
    expect(ps(`(Get-HarnessManifests -Manifest '${manifest}' -Platform 'win32-x64').pty.source`).stdout).toBe(manifest)
    const partial = join(dir, 'partial.json')
    writeFileSync(partial, JSON.stringify({ cli: { version: '1.2.3' }, node: { 'win32-x64': { version: 'v22.0.0' } }, pty: {} }))
    expect(thrown(`Get-HarnessManifests -Manifest '${partial}' -Platform 'win32-x64'`)).toContain("no 'win32-x64' entry")
    expect(thrown(`Get-HarnessManifests -Manifest '${join(dir, 'missing.json')}' -Platform 'win32-x64'`)).toContain('missing.json')
  })
})

// A whole install starts powershell.exe, Node and cmd many times, and unpacks an 80 MB node.exe: about a minute a
// case on the ARM64 VM.
describe.runIf(windows)('install.ps1, installing for real from a local manifest', { timeout: 300_000 }, () => {
  /**
   * The real harness.exe (pty/src/command.rs), which these cases run: $HARNESS_EXE_BIN, or this tree's cargo build.
   * Build it with `cd pty && cargo build --bin harness`.
   */
  function harnessExe(): Buffer {
    const candidates = [process.env.HARNESS_EXE_BIN, ...['release', 'debug'].map((profile) => join(process.cwd(), '..', 'pty', 'target', profile, 'harness.exe'))]
    const found = candidates.find((file): file is string => !!file && existsSync(file))
    if (!found) throw new Error('No harness.exe: build it with `cd pty && cargo build --bin harness`, or set HARNESS_EXE_BIN.')
    return readFileSync(found)
  }

  /**
   * A build of everything install.ps1 downloads:
   * - a Node zip of nodejs.org's shape, holding the Node running this test;
   * - a pty zip with the real harness.exe, and four files that only need to exist (nothing here runs them);
   * - a CLI that answers `version`, waits on `wait <file>` until that file exists, and echoes any other arguments
   *   as JSON.
   * Each manifest entry names its file relative to the manifest. [exeSuffix] makes a harness.exe with other bytes
   * that still runs (bytes after a program's end are ignored).
   */
  function build(platform: string, overrides: { cliSha?: string; exeSuffix?: string; ptyVersion?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-build-'))
    scratch.push(dir)
    const tar = join(process.env.SystemRoot!, 'System32', 'tar.exe')
    const archiveRoot = `node-v22.0.0-win-${platform.slice('win32-'.length)}`
    mkdirSync(join(dir, 'src', archiveRoot), { recursive: true })
    writeFileSync(join(dir, 'src', archiveRoot, 'node.exe'), readFileSync(process.execPath))
    spawnSync(tar, ['-a', '-cf', join(dir, 'node.zip'), '-C', join(dir, 'src'), archiveRoot])
    mkdirSync(join(dir, 'payload'))
    for (const name of ['harness-pty.exe', 'harness-launch.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']) writeFileSync(join(dir, 'payload', name), name)
    writeFileSync(join(dir, 'payload', 'harness.exe'), Buffer.concat([harnessExe(), Buffer.from(overrides.exeSuffix ?? '')]))
    spawnSync(tar, ['-a', '-cf', join(dir, 'pty.zip'), '-C', join(dir, 'payload'), 'harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe'])
    writeFileSync(join(dir, 'cli.js'), [
      "import { existsSync } from 'node:fs'",
      'const a = process.argv.slice(2)',
      "if (a[0] === 'version') console.log('9.8.7')",
      "else if (a[0] === 'wait') { setInterval(() => { if (existsSync(a[1])) process.exit(0) }, 100); setTimeout(() => process.exit(9), 120000) }",
      "else { console.log(JSON.stringify(a)); process.exitCode = a.includes('fail') ? 7 : 0 }",
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'notify.mjs'), 'export {}\n')
    const ref = (name: string) => {
      const bytes = readFileSync(join(dir, name))
      return { url: name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    }
    const cli = ref('cli.js')
    const manifest = {
      cli: { version: '9.8.7', cli: { ...cli, sha256: overrides.cliSha ?? cli.sha256 }, notify: ref('notify.mjs') },
      node: { [platform]: { version: 'v22.0.0', ...ref('node.zip'), archiveRoot } },
      pty: { [platform]: { version: overrides.ptyVersion ?? '9.8.7', ...ref('pty.zip') } },
    }
    writeFileSync(join(dir, 'install-manifest.json'), JSON.stringify(manifest, null, 2))
    return join(dir, 'install-manifest.json')
  }

  /**
   * A fresh profile whose name has a space, a non-ASCII letter, a CJK character and an `&`: quoting and code pages
   * are what such a name breaks.
   */
  function profile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-home-'))
    scratch.push(dir)
    const home = join(dir, 'Jö 日 & co')
    mkdirSync(home)
    return home
  }

  function install(home: string, manifest: string, subkey: string, extra: string[] = ['-NoService'], modulePath: ModulePath = 'default') {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer, '-Manifest', manifest, ...extra], {
      encoding: 'utf8', env: powershellEnv(modulePath, { USERPROFILE: home, HARNESS_INSTALL_ENV_KEY: subkey }), timeout: 300_000,
    })
  }

  const platform = () => ps('Get-HarnessPlatform').stdout
  const freshKey = () => {
    const subkey = `Software\\HarnessInstallTest\\${randomUUID()}`
    subkeys.push(subkey)
    return subkey
  }

  /** This process's environment with [bin] first on PATH, under the name Windows gave PATH here. */
  function withBin(bin: string): NodeJS.ProcessEnv {
    const env = { ...process.env }
    const name = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
    env[name] = `${bin};${env[name] ?? ''}`
    return env
  }

  /**
   * The Path value under HKCU\<subkey>, as stored (not expanded). Not through `reg.exe query`: it prints to a pipe in
   * the OEM code page, which turns `ö` and `日` into other bytes, so the profile path would never match.
   * PowerShell prints the value as base64 of its UTF-16 bytes, which no code page can change.
   */
  function userPathValue(subkey: string): string {
    const script = `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${subkey}'); $v = if ($k) { [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v))`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    return Buffer.from(run.stdout.trim(), 'base64').toString('utf16le')
  }

  const ticks = (file: string) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${file}').LastWriteTimeUtc.Ticks`], { encoding: 'utf8' }).stdout.trim()

  it('lays the version folders, the pointers and both programs down, and harness works by its full path', () => {
    const home = profile()
    const subkey = freshKey()
    const key = platform()
    // What an earlier install wrote: a harness.cmd, which re-parsed its arguments. It must go.
    mkdirSync(join(home, '.harness', 'bin'), { recursive: true })
    writeFileSync(join(home, '.harness', 'bin', 'harness.cmd'), '@echo off\r\n')
    const run = install(home, build(key), subkey)
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)

    const root = join(home, '.harness')
    const node = join(root, 'runtime', `node-v22.0.0-${key}`, 'node.exe')
    expect(readFileSync(join(root, 'cli', 'current'), 'utf8')).toBe('9.8.7\r\n')
    expect(readFileSync(join(root, 'runtime', 'current-node'), 'utf8')).toBe(`${node}\r\n`)
    expect(readFileSync(join(root, 'runtime', 'pty', 'current-pty'), 'utf8')).toBe('9.8.7\r\n')
    expect(JSON.parse(readFileSync(join(root, 'cli', '9.8.7', 'package.json'), 'utf8'))).toEqual({ type: 'module' })
    expect(readFileSync(join(root, 'cli', 'notify.mjs'), 'utf8')).toBe('export {}\n')
    expect(readFileSync(join(root, 'bin', 'harness-launch.exe'), 'utf8')).toBe('harness-launch.exe')
    expect(readFileSync(join(root, 'bin', 'harness.exe')).equals(harnessExe())).toBe(true)
    expect(existsSync(join(root, 'bin', 'harness.cmd'))).toBe(false)
    for (const name of ['harness-pty.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']) expect(readFileSync(join(root, 'runtime', 'pty', '9.8.7', name), 'utf8')).toBe(name)

    // By its full path, whose folder has a space, an `&` and letters outside the ANSI code page: from PowerShell,
    // and from cmd, with the exit code passed back both ways.
    const command = join(root, 'bin', 'harness.exe')
    const viaPowerShell = spawnSync('powershell.exe', ['-NoProfile', '-Command', `& '${command}' echo 'two words' '50%'; exit $LASTEXITCODE`], { encoding: 'utf8' })
    expect(viaPowerShell.stdout.trim()).toBe('["echo","two words","50%"]')
    expect(spawnSync('powershell.exe', ['-NoProfile', '-Command', `& '${command}' fail; exit $LASTEXITCODE`], { encoding: 'utf8' }).status).toBe(7)
    const viaCmd = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" version"`], { encoding: 'utf8', windowsVerbatimArguments: true })
    expect(viaCmd.stdout.trim()).toBe('9.8.7')
    expect(spawnSync('cmd.exe', ['/d', '/s', '/c', `""${command}" fail"`], { encoding: 'utf8', windowsVerbatimArguments: true }).status).toBe(7)

    const path = userPathValue(subkey)
    expect(path.split(';')).toContain(join(root, 'bin'))
    expect(run.stdout).toContain('harness 9.8.7 installed')
  })

  it('runs again over itself: nothing downloaded twice, PATH not doubled, the programs and notify.mjs left as they are', () => {
    const home = profile()
    const subkey = freshKey()
    const manifest = build(platform())
    // This process's own PSModulePath, as it is: a PowerShell 7 one in CI.
    expect(install(home, manifest, subkey, ['-NoService'], 'inherited').status).toBe(0)
    const kept = ['bin\\harness.exe', 'bin\\harness-launch.exe', 'cli\\notify.mjs'].map((name) => join(home, '.harness', name))
    const before = kept.map(ticks)
    const again = install(home, manifest, subkey, ['-NoService'], 'inherited')
    expect(again.status, again.stdout).toBe(0)
    expect(again.stdout).not.toContain('Downloading')
    expect(kept.map(ticks)).toEqual(before)
    const path = userPathValue(subkey)
    expect(path.split(';').filter((entry) => entry === join(home, '.harness', 'bin'))).toHaveLength(1)
  })

  it('replaces a harness.exe that is running, and removes the old one once it has exited', async () => {
    const home = profile()
    const subkey = freshKey()
    const platformKey = platform()
    expect(install(home, build(platformKey), subkey).status).toBe(0)
    const bin = join(home, '.harness', 'bin')
    const release = join(home, 'release')
    const running = spawn(join(bin, 'harness.exe'), ['wait', release], { stdio: 'ignore' })
    const exited = new Promise((resolve) => running.on('exit', resolve))
    // What Copy-HarnessFile leaves of a program that was running: Replace's own name for it, or its fallback's.
    const aside = (name: string) => /~RF.*\.TMP$/i.test(name) || name.includes('.old-')
    // A newer terminal host, whose harness.exe has other bytes. The same version would keep its complete folder.
    const newer = build(platformKey, { exeSuffix: 'newer', ptyVersion: '9.8.8' })
    try {
      const run = install(home, newer, subkey)
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
      expect(readFileSync(join(bin, 'harness.exe')).subarray(-'newer'.length).toString()).toBe('newer')
      expect(spawnSync(join(bin, 'harness.exe'), ['version'], { encoding: 'utf8' }).stdout.trim()).toBe('9.8.7')
      // The running one was renamed, as a running program can be; it cannot be deleted yet.
      expect(readdirSync(bin).filter(aside)).toHaveLength(1)
    } finally {
      writeFileSync(release, '')
      await exited
    }
    expect(install(home, newer, subkey).status).toBe(0)
    expect(readdirSync(bin).filter(aside)).toEqual([])
  })

  it('installs when PowerShell 7\'s modules come first on PSModulePath, as a PowerShell 7 window hands it on', () => {
    const home = profile()
    const subkey = freshKey()
    const run = install(home, build(platform()), subkey, ['-NoService'], 'powershell7')
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    expect(spawnSync(join(home, '.harness', 'bin', 'harness.exe'), ['version'], { encoding: 'utf8' }).stdout.trim()).toBe('9.8.7')
  })

  it('says, in a sentence, which step failed, and points nothing at a CLI it did not verify', () => {
    const home = profile()
    const subkey = freshKey()
    const run = install(home, build(platform(), { cliSha: '0'.repeat(64) }), subkey)
    expect(run.status).toBe(1)
    expect(run.stdout).toContain('Harness could not be installed. The step that failed: Installing the Harness CLI.')
    expect(run.stdout).toContain('failed its checksum')
    expect(() => readFileSync(join(home, '.harness', 'cli', 'current'))).toThrow()
  })

  it('reports the failure and leaves the PowerShell it was iex-ed into running', () => {
    const missing = join(tmpdir(), `harness-missing-${randomUUID()}.json`)
    // The throwaway PATH key as well: the install must fail before PATH, but if it ever did not, it lands there.
    const subkey = freshKey()
    const text = `$env:HARNESS_INSTALL_MANIFEST = '${missing}'; Get-Content -Raw -LiteralPath '${installer}' | Invoke-Expression; Write-Output "after $LASTEXITCODE"`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], { encoding: 'utf8', env: powershellEnv('default', { USERPROFILE: profile(), HARNESS_INSTALL_ENV_KEY: subkey }), timeout: 120_000 })
    expect(run.stdout).toContain('The step that failed: Reading the release manifests.')
    expect(run.stdout.trim().endsWith('after 1')).toBe(true)
  })

  it('passes arguments to the CLI exactly as cmd and Windows PowerShell 5.1 users quote them, and runs nothing else', () => {
    const home = profile()
    const subkey = freshKey()
    expect(install(home, build(platform()), subkey).status).toBe(0)
    const env = withBin(join(home, '.harness', 'bin'))
    const work = mkdtempSync(join(tmpdir(), 'harness-ps1-args-'))
    scratch.push(work)

    // cmd: `harness <what a cmd user types>`. Quotes or `^` keep cmd's own `&`, `|`, `<`, `>` and `^` away; inside
    // quotes `""` is a quote; `%^OS%` keeps cmd from expanding a variable. What arrives is what was meant.
    const typed: Array<[string, string[]]> = [
      ['"a b"', ['a b']],
      ['"a&b"', ['a&b']],
      ['a^&b', ['a&b']],
      ['50%', ['50%']],
      ['"x^y"', ['x^y']],
      ['x^^y', ['x^y']],
      ['wow!', ['wow!']],
      ['%^OS%', ['%OS%']],
      ['"say ""hi"" & echo pwned > x"', ['say "hi" & echo pwned > x']],
      ['send agent-1 "a & b | c > d"', ['send', 'agent-1', 'a & b | c > d']],
    ]
    for (const [line, expected] of typed) {
      const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `"harness ${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, env, cwd: work })
      expect(run.status, `${line}: ${run.stderr}`).toBe(0)
      expect(JSON.parse(run.stdout.trim()), line).toEqual(expected)
    }

    // Windows PowerShell 5.1: `harness '<text>'`. No cmd is involved at all.
    const said: Array<[string, string[]]> = [
      ["& harness 'a&b'", ['a&b']],
      ["harness 'a & b | c > d' '%OS%' '50%' 'x^y' 'wow!'", ['a & b | c > d', '%OS%', '50%', 'x^y', 'wow!']],
      // 5.1 passes an inner `"` to a program unescaped, so the program reads it as quoting: the quotes are lost,
      // and nothing else happens. `\"` is how 5.1 users write a quote for a program; PowerShell 7.3+ needs neither.
      ["harness 'say \"hi\" & echo pwned > x'", ['say hi & echo pwned > x']],
      ["harness 'say \\\"hi\\\" & echo pwned > x'", ['say "hi" & echo pwned > x']],
    ]
    for (const [line, expected] of said) {
      const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`${line}; exit $LASTEXITCODE`, 'utf16le').toString('base64')], { encoding: 'utf8', env, cwd: work })
      expect(run.status, `${line}: ${run.stderr}`).toBe(0)
      expect(JSON.parse(run.stdout.trim()), line).toEqual(expected)
    }
    // Nothing ran but the CLI: no `> x` or `> d` made a file.
    expect(readdirSync(work)).toEqual([])
  })

  it('installs by irm | iex under the Restricted execution policy, and harness then runs from a Restricted PowerShell', () => {
    const home = profile()
    const subkey = freshKey()
    const manifest = build(platform())
    const text = `Get-Content -Raw -LiteralPath '${installer}' | Invoke-Expression; Write-Output "after $LASTEXITCODE"`
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
      encoding: 'utf8', env: powershellEnv('default', { USERPROFILE: home, HARNESS_INSTALL_ENV_KEY: subkey, HARNESS_INSTALL_MANIFEST: manifest }), timeout: 300_000,
    })
    expect(run.stdout.trim().endsWith('after 0'), `${run.stdout}\n${run.stderr}`).toBe(true)
    // The command is a program, never a .ps1, so a Restricted PowerShell runs it.
    const command = join(home, '.harness', 'bin', 'harness.exe')
    const version = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', `& '${command}' version; exit $LASTEXITCODE`], { encoding: 'utf8' })
    expect(version.status, version.stderr).toBe(0)
    expect(version.stdout.trim()).toBe('9.8.7')
  })
})

describe.runIf(windows)('install.ps1, run again over a live install', { timeout: 120_000 }, () => {
  /** A `harness` that logs each call, one per line, reports the daemon as [state] to `status`, then runs [lines]. */
  function fakeHarness(state: string, lines: string[] = []): { command: string; calls: () => string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'harness-ps1-restart-'))
    scratch.push(dir)
    const log = join(dir, 'calls.log')
    const command = join(dir, 'harness.cmd')
    writeFileSync(command, ['@echo off', `echo %*>>"${log}"`, `if "%1"=="status" echo    status     ${state}`, ...lines, 'exit /b 0', ''].join('\r\n'))
    return { command, calls: () => { try { return readFileSync(log, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } catch { return [] } } }
  }
  const last = (text: string) => text.split(/\r?\n/).at(-1)

  it('restarts a running daemon once when the version changed: stop, then start', () => {
    const harness = fakeHarness('running - backend connected')
    const run = ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.0' -After '1.0.1'`)
    expect(last(run.stdout), run.stderr).toBe('True')
    expect(run.stdout).toContain('Moving the running Harness from 1.0.0 to 1.0.1')
    expect(harness.calls()).toEqual(['status', 'stop', 'start'])
  })

  it('goes on once `harness start` has started the daemon, which holds the handles it was given for as long as it runs', () => {
    // The daemon `harness start` leaves running inherits that command's output handles (seen on the VM: the installer
    // waited on `harness start | ForEach-Object` for as long as the new daemon ran). Here a process left behind holds
    // them for 120 seconds, and the restart must take under 60. The margins are wide on purpose: a slow runner (the
    // arm64 one took 22 s for a restart that waits on nothing) can blur a gap of a few seconds, but it cannot make
    // a restart that does not wait take longer than a holder that would be waited on for two minutes.
    const harness = fakeHarness('running - backend connected', ['if "%1"=="start" start "" /b cmd /c "ping -n 121 127.0.0.1 >nul & rem holder-of-handles"'])
    try {
      // The holder keeps whatever handles it was given, so these go to files: a pipe would not reach end of file
      // until the holder ended, and this test would wait on it as well.
      const text = `$ErrorActionPreference = 'Stop'; . '${installer}'; $clock = [Diagnostics.Stopwatch]::StartNew(); $moved = Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.0' -After '1.0.1'; "took $($clock.ElapsedMilliseconds)"; $moved`
      const outPath = join(dirname(harness.command), 'out.txt')
      const errPath = join(dirname(harness.command), 'err.txt')
      const out = openSync(outPath, 'w')
      const err = openSync(errPath, 'w')
      try {
        spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
          env: powershellEnv('default', { HARNESS_INSTALL_LIBRARY: '1' }), timeout: 110_000, stdio: ['ignore', out, err],
        })
      } finally { closeSync(out); closeSync(err) }
      const run = { stdout: readFileSync(outPath, 'utf8').trim(), stderr: readFileSync(errPath, 'utf8') }
      expect(last(run.stdout), run.stderr).toBe('True')
      expect(Number(/took (\d+)/.exec(run.stdout)?.[1])).toBeLessThan(60_000)
      expect(harness.calls()).toEqual(['status', 'stop', 'start'])
    } finally {
      // End the holder (the cmd that started the ping, and the ping under it), so nothing outlives the test.
      const kill = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*holder-of-handles*' } | ForEach-Object { taskkill /T /F /PID $_.ProcessId | Out-Null }"
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(kill, 'utf16le').toString('base64')], { encoding: 'utf8' })
    }
  })

  it('starts nothing, and says the daemon stays on the old build, when it does not stop', () => {
    const harness = fakeHarness('running - backend connected', ['if "%1"=="stop" exit /b 1'])
    const run = ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.0' -After '1.0.1'`)
    expect(last(run.stdout), run.stderr).toBe('False')
    expect(run.stdout).toContain('Harness is still running version 1.0.0; it moves to 1.0.1 when it next restarts (harness stop, then harness start).')
    expect(harness.calls()).toEqual(['status', 'stop'])
  })

  it('says so when Harness does not start again on the new build', () => {
    const harness = fakeHarness('running - backend connected', ['if "%1"=="start" exit /b 3'])
    const run = ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.0' -After '1.0.1'`)
    expect(last(run.stdout), run.stderr).toBe('True')
    expect(run.stdout).toContain("Harness did not start again on version 1.0.1. Run 'harness start'.")
  })

  it('leaves the daemon alone on the same version, on a first install, and when no daemon runs', () => {
    const same = fakeHarness('running - backend connected')
    expect(ps(`Restart-HarnessDaemon -Command '${same.command}' -Before '1.0.1' -After '1.0.1'`).stdout).toBe('False')
    expect(ps(`Restart-HarnessDaemon -Command '${same.command}' -Before '' -After '1.0.1'`).stdout).toBe('False')
    expect(same.calls()).toEqual([])
    const stopped = fakeHarness('stopped')
    expect(ps(`Restart-HarnessDaemon -Command '${stopped.command}' -Before '1.0.0' -After '1.0.1'`).stdout).toBe('False')
    expect(stopped.calls()).toEqual(['status'])
  })

  it('names the terminal host when Harness does not start again after a host-only move', () => {
    const harness = fakeHarness('running - backend connected', ['if "%1"=="start" exit /b 3'])
    const run = ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.1' -After '1.0.1' -PtyBefore '2.0.0' -PtyAfter '2.0.1'`)
    expect(last(run.stdout), run.stderr).toBe('True')
    expect(run.stdout).toContain("Harness did not start again on terminal host 2.0.1. Run 'harness start'.")
  })

  it('removes a terminal host probation marker when it moves current-pty, and keeps it when the pointer stays', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ps1-pending-'))
    scratch.push(root)
    const ptyRoot = join(root, 'runtime', 'pty')
    for (const version of ['1.0.0', '2.0.0']) {
      mkdirSync(join(ptyRoot, version), { recursive: true })
      for (const name of ['harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe']) writeFileSync(join(ptyRoot, version, name), name)
    }
    const marker = join(ptyRoot, 'pty-pending.json')
    writeFileSync(join(ptyRoot, 'current-pty'), '1.0.0\r\n')
    writeFileSync(marker, JSON.stringify({ version: '1.0.0', previous: '0.9.0' }))
    const moved = ps(`$null = Install-HarnessPty -Root '${root}' -Entry @{ version = '2.0.0' } -Source '' -Tar ''`)
    expect(moved.status, moved.stderr).toBe(0)
    expect(readFileSync(join(ptyRoot, 'current-pty'), 'utf8')).toBe('2.0.0\r\n')
    expect(existsSync(marker)).toBe(false)
    writeFileSync(marker, JSON.stringify({ version: '2.0.0', previous: '1.0.0' }))
    const same = ps(`$null = Install-HarnessPty -Root '${root}' -Entry @{ version = '2.0.0' } -Source '' -Tar ''`)
    expect(same.status, same.stderr).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })

  it('restarts the daemon when only the terminal host moved', () => {
    const harness = fakeHarness('running - backend connected')
    const run = ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.1' -After '1.0.1' -PtyBefore '2.0.0' -PtyAfter '2.0.1'`)
    expect(last(run.stdout), run.stderr).toBe('True')
    expect(run.stdout).toContain('Moving the running Harness to terminal host 2.0.1 (your agents keep running)...')
    expect(harness.calls()).toEqual(['status', 'stop', 'start'])
  })

  it('does not restart the daemon when neither the CLI nor the terminal host changed', () => {
    const harness = fakeHarness('running - backend connected')
    expect(ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.1' -After '1.0.1' -PtyBefore '2.0.1' -PtyAfter '2.0.1'`).stdout).toBe('False')
    // A first terminal host install has nothing running to move.
    expect(ps(`Restart-HarnessDaemon -Command '${harness.command}' -Before '1.0.1' -After '1.0.1' -PtyBefore '' -PtyAfter '2.0.1'`).stdout).toBe('False')
    expect(harness.calls()).toEqual([])
  })

  it('closes without the setup steps when this computer is signed in and Harness runs', () => {
    // With a line on stderr, as a sign-in refresh warning would be: it must not reach the closing text.
    const ready = fakeHarness('running - backend connected', ['if "%1"=="auth" echo refreshing the sign-in 1>&2', 'if "%1"=="auth" echo {"loggedIn":true}'])
    const done = ps(`Write-HarnessDone -Version '1.0.1' -Command '${ready.command}'`)
    expect(done.stdout, done.stderr).toContain('This computer is signed in and Harness is running: nothing more to set up.')
    expect(done.stdout).not.toContain('harness login')
    expect(done.stdout).not.toContain('refreshing the sign-in')
    const glyph = fakeHarness('\u25cf started \u00b7 backend connected', ['if "%1"=="auth" echo {"loggedIn":true}'])
    expect(ps(`Write-HarnessDone -Version '1.0.1' -Command '${glyph.command}'`).stdout).toContain('nothing more to set up')
  })

  // Apart from the case above, with room: each PowerShell takes about 20 s on the Arm runner, and seven ran past 120 s.
  it('closes with the setup steps when this computer is not signed in, or Harness does not run', () => {
    for (const [state, auth] of [['stopped', '{"loggedIn":true}'], ['running - backend connected', '{"loggedIn":false}'], ['running - backend connected', 'not json']]) {
      const other = fakeHarness(state, [`if "%1"=="auth" echo ${auth}`])
      expect(ps(`Write-HarnessDone -Version '1.0.1' -Command '${other.command}'`).stdout, `${state} ${auth}`).toContain('harness login')
    }
    expect(ps(`Write-HarnessDone -Version '1.0.1'`).stdout).toContain('harness login')
  }, 240_000)

  // Re-review N1: harness service install says it itself (serviceCommand.ts); the installer passes its lines on and adds none.
  it('passes on what `harness service install` said when it registered the task but did not start it now (exit 5), and adds nothing', () => {
    const registered = fakeHarness('stopped', ['if "%1"=="service" echo Task Scheduler will start the Harness daemon when you sign in to Windows.', 'if "%1"=="service" exit /b 5'])
    const run = ps(`Register-HarnessService -Command '${registered.command}'`)
    expect(run.stdout.split(/\r?\n/), run.stderr).toEqual(['Task Scheduler will start the Harness daemon when you sign in to Windows.'])
    expect(run.stdout).not.toContain('could not set itself to start')
    expect(registered.calls()).toEqual(['service install'])
    const failed = fakeHarness('stopped', ['if "%1"=="service" exit /b 1'])
    expect(ps(`Register-HarnessService -Command '${failed.command}'`).stdout).toContain('Harness could not set itself to start when you sign in (harness service install exited 1).')
  })

  it('reads the version cli\\current names, and none before a first install', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-ps1-current-'))
    scratch.push(root)
    expect(ps(`Read-HarnessCurrentCli -Root '${root}'`).stdout).toBe('')
    mkdirSync(join(root, 'cli'))
    writeFileSync(join(root, 'cli', 'current'), '1.0.0\r\n')
    expect(ps(`Read-HarnessCurrentCli -Root '${root}'`).stdout).toBe('1.0.0')
  })
})
