import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// The real Harness.exe installs a zip with a GUI stand-in. Its sibling DLL is fixture-only bytes: the
// C4.7 package smoke checks the real bundle and C5.2 scenario 7 checks the staged app in a desktop session.
const installer = join(process.cwd(), 'scripts', 'install.ps1')
const windows = process.platform === 'win32'
const scratch: string[] = []
const registryRoots: string[] = []
const ownedApps: string[] = []

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (['psmodulepath', 'harness_install_manifest'].includes(key.toLowerCase())) delete env[key]
  }
  return { ...env, ...extra }
}

function powershell(script: string, env: NodeJS.ProcessEnv = {}) {
  const utf8 = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(utf8 + script, 'utf16le').toString('base64')], {
    encoding: 'utf8', env: cleanEnv(env), timeout: 240_000,
  })
  return { status: run.status, stdout: (run.stdout ?? '').trim(), stderr: run.stderr ?? '' }
}

function folder(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  scratch.push(dir)
  return dir
}

// Slow ARM PowerShell startup left this cleanup hook running for 68 seconds before its timeout.
afterAll(() => {
  // Each path is in a unique test-owned install. Retain a Process handle, check its full image path,
  // and wait for confirmed exit before deleting any directory that held it.
  const failures: string[] = []
  for (const app of ownedApps) {
    const script = `$ErrorActionPreference = 'Stop'; $target = ${quote(app)}; ` +
      `try { foreach ($p in @(Get-Process -Name 'harness-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $target })) { ` +
      `$null = $p.Handle; $p.Kill(); if (-not $p.WaitForExit(10000)) { throw "Owned app $($p.Id) did not exit" }; $p.Dispose() }; ` +
      `if (@(Get-Process -Name 'harness-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $target }).Count) { throw 'Owned app still runs' } ` +
      `} catch { Write-Error $_; exit 1 }`
    const stopped = powershell(script)
    if (stopped.status !== 0) failures.push(`${app}: ${stopped.stderr || stopped.stdout}`)
  }
  if (failures.length) throw new Error(`Owned app exit unconfirmed; test scratch retained: ${failures.join('; ')}`)
  for (const key of registryRoots) {
    const existing = spawnSync('reg.exe', ['query', `HKCU\\${key}`], { encoding: 'utf8' })
    if (existing.status === 1) continue
    if (existing.status !== 0) { failures.push(`registry ${key}: query failed: ${existing.stderr}`); continue }
    const removed = spawnSync('reg.exe', ['delete', `HKCU\\${key}`, '/f'], { encoding: 'utf8' })
    if (removed.status !== 0) failures.push(`registry ${key}: ${removed.stderr}`)
  }
  if (failures.length) throw new Error(`Owned registry cleanup failed; scratch retained: ${failures.join('; ')}`)
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
}, 180_000)

// The six-call malformed-entry case took 137 seconds with slow ARM PowerShell startup.
// One set of answers for both installers: installer/src/model.rs runs the same vectors against select_entry.
const vectors = JSON.parse(readFileSync(join(process.cwd(), '..', 'installer', 'tests', 'entry-vectors.json'), 'utf8')) as
  { name: string; platform: string; document: object; expect: string }[]

// The fourteen-call vector case took about 140 seconds with slow ARM PowerShell startup, so it is one PowerShell.
describe.runIf(windows)('install.ps1 -App selects the desktop zip', { timeout: 240_000 }, () => {
  it('chooses what harness-install.exe chooses, for every shared vector', () => {
    const script = `$ErrorActionPreference = 'Stop'; . ${quote(installer)}; ` +
      `foreach ($v in (${quote(JSON.stringify(vectors))} | ConvertFrom-Json)) { ` +
      `try { $e = Select-HarnessAppEntry -Document $v.document -Platform $v.platform; "$($e.version) $($e.url)" } catch { $_.Exception.Message } }`
    const result = powershell(script, { HARNESS_INSTALL_LIBRARY: '1' })
    expect(result.status, result.stderr).toBe(0)
    const got = result.stdout.split(/\r?\n/)
    expect(got).toHaveLength(vectors.length)
    vectors.forEach((vector, index) => expect(got[index], vector.name).toBe(vector.expect))
  })
})

describe.runIf(windows)('install.ps1 -App runs the real launcher in an isolated profile', { timeout: 300_000 }, () => {
  function launcher(): string {
    const candidates = [process.env.HARNESS_DESKTOP_LAUNCHER_BIN, ...['debug', 'release'].map((profile) => join(process.cwd(), '..', 'pty', 'target', profile, 'harness-desktop-launcher.exe'))]
    const found = candidates.find((path): path is string => !!path && existsSync(path))
    if (!found) throw new Error('Build pty/bin harness-desktop-launcher or set HARNESS_DESKTOP_LAUNCHER_BIN')
    return found
  }

  let standIn: string | undefined
  function standInApp(): string {
    if (standIn) return standIn
    const out = join(folder('harness-app-standin-'), 'stand-in.exe')
    const code = 'public static class StandIn { public static void Main() { System.Threading.Thread.Sleep(120000); } }'
    const made = powershell(`Add-Type -OutputType WindowsApplication -OutputAssembly ${quote(out)} -TypeDefinition ${quote(code)}`)
    if (made.status !== 0 || !existsSync(out)) throw new Error(`Cannot build GUI stand-in: ${made.stdout} ${made.stderr}`)
    return (standIn = out)
  }

  function build(version: string, badSha = false): string {
    const dir = folder('harness-app-build-')
    const src = join(dir, 'src')
    const app = join(src, 'app', version)
    mkdirSync(app, { recursive: true })
    copyFileSync(launcher(), join(src, 'Harness.exe'))
    copyFileSync(join(process.cwd(), '..', 'desktop', 'windows', 'runner', 'resources', 'app_icon.ico'), join(src, 'Harness.ico'))
    copyFileSync(standInApp(), join(app, 'harness-desktop.exe'))
    writeFileSync(join(app, 'harness_pipe_io.dll'), 'C4.8 fixture only: not a loadable DLL')
    writeFileSync(join(src, 'current'), `${version}\r\n`)
    const name = `harness-desktop-${version}-windows-x64.zip`
    const tar = join(process.env.SystemRoot!, 'System32', 'tar.exe')
    const made = spawnSync(tar, ['-a', '-cf', join(dir, name), '-C', src, 'Harness.exe', 'Harness.ico', 'current', 'app'], { encoding: 'utf8' })
    expect(made.status, made.stderr).toBe(0)
    const bytes = readFileSync(join(dir, name))
    const ref = { version, url: name, sha256: badSha ? 'f'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    const manifest = join(dir, 'metadata.json')
    writeFileSync(manifest, JSON.stringify({ 'desktop-windows-x64': ref, 'desktop-windows-arm64': ref }))
    return manifest
  }

  function world() {
    const home = join(folder('harness-app-home-'), "Nguyễn Văn A' & 100% !x")
    const temp = join(home, 'AppData', 'Local', 'Temp')
    const install = join(home, 'AppData', 'Local', 'Programs', 'Harness')
    const programs = join(home, 'Start Menu', 'Programs')
    mkdirSync(temp, { recursive: true })
    mkdirSync(programs, { recursive: true })
    const registry = `Software\\HarnessTest\\${randomUUID()}`
    registryRoots.push(registry)
    const env = {
      USERPROFILE: home, TEMP: temp, TMP: temp,
      HARNESS_DESKTOP_INSTALL_ROOT: install, HARNESS_DESKTOP_PROGRAMS_DIR: programs, HARNESS_DESKTOP_REGISTRY_ROOT: registry,
      HARNESS_DESKTOP_NO_DIALOG: '1',
    }
    return { home, temp, install, programs, registry, env }
  }

  const stagingLeft = (temp: string) => readdirSync(temp).filter((name) => name.startsWith('.harness-desktop-staging-'))
  const query = (key: string, value: string) => spawnSync('reg.exe', ['query', `HKCU\\${key}`, '/v', value], { encoding: 'utf8' })
  const registryValue = (key: string, value: string) => powershell(
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(key)}); if (-not $key) { throw 'Registry key missing' }; $key.GetValue(${quote(value)})`,
  )
  const pathValue = () => query('Environment', 'Path').stdout
  const task = (name: string) => {
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', name, '/XML'], { encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout }
  }
  const taskSnapshot = () => ['Harness harnessd', 'Harness harnessd at sign-in'].map((name) => task(`${name} (${process.env.USERNAME})`))

  function installApp(manifest: string, env: NodeJS.ProcessEnv, args: string[] = [], script = installer) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-App', '-Manifest', manifest, ...args], {
      encoding: 'utf8', env: cleanEnv(env), timeout: 240_000,
    })
  }

  function withHeldStaging(): string {
    // The real Windows Remove-Item sees a file held by this PowerShell process. This temporary copy
    // changes only the test's cleanup environment; the App install/download/launcher path stays real.
    const override = String.raw`function Remove-Item {
  [CmdletBinding()]
  param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
  if ($Recurse -and (Split-Path -Leaf $LiteralPath) -like '.harness-desktop-staging-*') {
    $held = Join-Path $LiteralPath 'held-for-cleanup-test'
    [IO.File]::WriteAllText($held, 'held by the C4.8 native test')
    $lock = [IO.File]::Open($held, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse -Force -ErrorAction Stop }
    finally { $lock.Dispose() }
  } else {
    Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
  }
}`
    const script = join(folder('harness-app-cleanup-control-'), 'install.ps1')
    writeFileSync(script, readFileSync(installer, 'utf8').replace('# --- Run ---', `${override}\n# --- Run ---`))
    return script
  }

  function running(app: string): number {
    const script = `$deadline = (Get-Date).AddSeconds(10); do { $count = @(Get-Process -Name 'harness-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq ${quote(app)} }).Count; if ($count) { break }; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $deadline); $count`
    return Number(powershell(script).stdout)
  }

  function harnessInstall(): string {
    const candidates = [process.env.HARNESS_INSTALL_BIN, ...['debug', 'release'].map((profile) => join(process.cwd(), '..', 'installer', 'target', profile, 'harness-install.exe'))]
    const found = candidates.find((path): path is string => !!path && existsSync(path))
    if (!found) throw new Error('Build installer/ (cargo build) or set HARNESS_INSTALL_BIN')
    return found
  }

  // harness-install.exe in quiet mode: no window, and its log in this world's TEMP.
  function installExe(manifest: string, env: NodeJS.ProcessEnv) {
    const run = spawnSync(harnessInstall(), ['--quiet'], {
      encoding: 'utf8', env: cleanEnv({ ...env, HARNESS_INSTALL_MANIFEST: manifest }), timeout: 240_000,
    })
    const log = join(env.TEMP!, 'harness-install.log')
    return { status: run.status, log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
  }

  // What either installer leaves behind: the install, its registration and a running app, and nothing else.
  function expectInstalled(w: ReturnType<typeof world>, version: string) {
    const app = join(w.install, 'app', version, 'harness-desktop.exe')
    expect(readFileSync(join(w.install, 'current'))).toEqual(Buffer.from(`${version}\r\n`))
    for (const path of [join(w.install, 'Harness.exe'), join(w.install, 'Harness.ico'), app, join(w.install, 'app', version, 'harness_pipe_io.dll'), join(w.programs, 'Harness.lnk')]) {
      expect(existsSync(path)).toBe(true)
    }
    expect(query(`${w.registry}\\Classes\\harness`, 'URL Protocol').status).toBe(0)
    expect(registryValue(`${w.registry}\\Classes\\harness\\shell\\open\\command`, '').stdout).toBe(`"${join(w.install, 'Harness.exe')}" "%1"`)
    const uninstall = `${w.registry}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Harness`
    expect(query(uninstall, 'DisplayVersion').stdout).toMatch(new RegExp(`DisplayVersion\\s+REG_SZ\\s+${version.replace(/\./g, '\\.')}`))
    expect(registryValue(uninstall, 'DisplayIcon').stdout).toBe(`${join(w.install, 'Harness.ico')},0`)
    const shortcut = powershell(
      `$ErrorActionPreference = 'Stop'; $shell = New-Object -ComObject Shell.Application; ` +
      `$dir = $shell.Namespace(${quote(w.programs)}); if (-not $dir) { throw 'Start Menu folder could not be opened' }; ` +
      `$item = $dir.ParseName('Harness.lnk'); if (-not $item) { throw 'Harness.lnk could not be opened' }; ` +
      `$link = $item.GetLink; if (-not $link) { throw 'Harness.lnk is not a readable shortcut' }; ` +
      `$icon = ''; $index = $link.GetIconLocation([ref]$icon); $target = $link.Path; ` +
      `if (-not $target -or -not $icon) { throw 'Harness.lnk is missing its target or icon' }; ` +
      `[pscustomobject]@{ target = $target; icon = $icon; index = $index } | ConvertTo-Json -Compress`,
    )
    expect(shortcut.status, shortcut.stderr).toBe(0)
    expect(JSON.parse(shortcut.stdout)).toEqual({
      target: join(w.install, 'Harness.exe'), icon: join(w.install, 'Harness.ico'), index: 0,
    })
    expect(existsSync(join(w.home, '.harness'))).toBe(false)
    expect(stagingLeft(w.temp)).toEqual([])
    expect(running(app)).toBeGreaterThan(0)
  }

  it('installs the complete fixture, registers it, returns before the GUI exits, and leaves no staging', () => {
    const w = world()
    ownedApps.push(join(w.install, 'app', '9.8.7', 'harness-desktop.exe'))
    const oldPath = pathValue()
    const oldTasks = taskSnapshot()
    const started = Date.now()
    const result = installApp(build('9.8.7'), w.env, ['-Desktop', '-NoService'])
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect((Date.now() - started) / 1000).toBeLessThan(90)
    expect(result.stdout).toContain('Harness 9.8.7 is installed, and it is opening now.')
    expectInstalled(w, '9.8.7')
    expect(pathValue()).toBe(oldPath)
    expect(taskSnapshot()).toEqual(oldTasks)
  })

  // F's installer, held to install.ps1 -App's expectations (installer spec §4.2).
  it('harness-install.exe installs the same fixture with the same result', () => {
    const w = world()
    ownedApps.push(join(w.install, 'app', '9.8.13', 'harness-desktop.exe'))
    const oldPath = pathValue()
    const started = Date.now()
    const result = installExe(build('9.8.13'), w.env)
    expect(result.status, result.log).toBe(0)
    expect((Date.now() - started) / 1000).toBeLessThan(90)
    expect(result.log).toContain('Harness 9.8.13 is installed, and it is opening now.')
    expectInstalled(w, '9.8.13')
    expect(pathValue()).toBe(oldPath)
  })

  it('harness-install.exe refuses a checksum mismatch with exit 1, names the step, and installs nothing', () => {
    const w = world()
    const result = installExe(build('9.8.14', true), w.env)
    expect(result.status, result.log).toBe(1)
    expect(result.log).toContain('Harness could not be installed. The step that failed: Downloading Harness.')
    expect(result.log).toContain('failed its checksum')
    expect(existsSync(w.install)).toBe(false)
    expect(query(`${w.registry}\\Classes\\harness`, 'URL Protocol').status).not.toBe(0)
    expect(stagingLeft(w.temp)).toEqual([])
  })

  it('rejects a checksum mismatch with exit 1 and no install or owned staging', () => {
    const w = world()
    const result = installApp(build('9.8.8', true), w.env)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('The step that failed: Downloading Harness.')
    expect(result.stdout).toContain('failed its checksum')
    expect(existsSync(w.install)).toBe(false)
    expect(query(`${w.registry}\\Classes\\harness`, 'URL Protocol').status).not.toBe(0)
    expect(stagingLeft(w.temp)).toEqual([])
  })

  it('runs a published app-default copy under iex and leaves the caller alive with LASTEXITCODE 0', () => {
    const w = world()
    const app = join(w.install, 'app', '9.8.9', 'harness-desktop.exe')
    ownedApps.push(app)
    const source = readFileSync(installer, 'utf8')
    const published = join(folder('harness-app-published-'), 'install.ps1')
    writeFileSync(published, source.replace('$HarnessInstallApp = $false', '$HarnessInstallApp = $true'))
    const result = powershell(`iex (Get-Content -Raw -LiteralPath ${quote(published)}); "exit code $LASTEXITCODE"; 'still here'`, { ...w.env, HARNESS_INSTALL_MANIFEST: build('9.8.9') })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Harness 9.8.9 is installed, and it is opening now.')
    expect(result.stdout).toContain('exit code 0')
    expect(result.stdout.endsWith('still here')).toBe(true)
    expect(running(app)).toBeGreaterThan(0)
    expect(stagingLeft(w.temp)).toEqual([])
  })

  it('leaves an iex caller alive with LASTEXITCODE 1 after a bad download', () => {
    const w = world()
    const source = readFileSync(installer, 'utf8')
    const published = join(folder('harness-app-published-'), 'install.ps1')
    writeFileSync(published, source.replace('$HarnessInstallApp = $false', '$HarnessInstallApp = $true'))
    const result = powershell(`iex (Get-Content -Raw -LiteralPath ${quote(published)}); "exit code $LASTEXITCODE"; 'still here'`, { ...w.env, HARNESS_INSTALL_MANIFEST: build('9.8.10', true) })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('The step that failed: Downloading Harness.')
    expect(result.stdout).toContain('exit code 1')
    expect(result.stdout.endsWith('still here')).toBe(true)
    expect(existsSync(w.install)).toBe(false)
    expect(stagingLeft(w.temp)).toEqual([])
  })

  it('warns with the retained staging path while a successfully installed app keeps exit 0', () => {
    const w = world()
    const app = join(w.install, 'app', '9.8.11', 'harness-desktop.exe')
    ownedApps.push(app)
    const result = installApp(build('9.8.11'), w.env, [], withHeldStaging())
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const left = stagingLeft(w.temp)
    expect(left).toHaveLength(1)
    expect(result.stdout).toContain(`Temporary files remain at ${join(w.temp, left[0]!)}.`)
    expect(result.stdout).toContain('Harness was installed and can be used.')
    expect(result.stdout).toContain('Harness 9.8.11 is installed, and it is opening now.')
    expect(existsSync(app)).toBe(true)
    expect(running(app)).toBeGreaterThan(0)
  })

  it('warns with the retained staging path while preserving a failed download and exit 1', () => {
    const w = world()
    const result = installApp(build('9.8.12', true), w.env, [], withHeldStaging())
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
    const left = stagingLeft(w.temp)
    expect(left).toHaveLength(1)
    expect(result.stdout).toContain(`Temporary files remain at ${join(w.temp, left[0]!)}.`)
    expect(result.stdout).toContain('The install failed for the reason above.')
    expect(result.stdout).toContain('The step that failed: Downloading Harness.')
    expect(result.stdout).toContain('failed its checksum')
    expect(result.stdout).not.toContain('is installed, and it is opening now.')
    expect(existsSync(w.install)).toBe(false)
  })
})
