import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_INSTALL, ENGINE_WINDOWS_INSTALL } from '../../lib/engineInstall.js'
import { createWindowsInstallations, INSTALL_RUNNER, powershellInstallScript, windowsInstallCommand, WINDOWS_INSTALL_LIMIT_MS } from './windowsInstall.js'

const fakeChild = (pid = 4242) => Object.assign(new EventEmitter(), { pid, unref: vi.fn() })

describe('how an engine is installed on Windows', () => {
  const where = { npm: 'C:\\h\\node\\npm.cmd', prefix: 'C:\\Users\\a b\\.local', comspec: 'C:\\Windows\\cmd.exe', powershell: 'C:\\ps.exe' }

  it('runs npm through cmd, into the person\'s own folder', () => {
    const run = windowsInstallCommand(ENGINE_WINDOWS_INSTALL.pi, where, 'x64')
    expect(run.file).toBe(where.comspec)
    expect(run.verbatim).toBe(true)
    expect(run.args.join(' ')).toContain('"C:\\h\\node\\npm.cmd" install --global --prefix "C:\\Users\\a b\\.local" --no-fund --no-audit --loglevel=error --ignore-scripts @earendil-works/pi-coding-agent')
  })

  // Its Arm build stops before its screen opens (Windows VM, B4.12): the x64 build runs under Windows' emulation.
  it('installs OpenCode\'s x64 build on Windows on Arm, and only there', () => {
    expect(windowsInstallCommand(ENGINE_WINDOWS_INSTALL.opencode, where, 'arm64').args.join(' ')).toContain('--cpu=x64 opencode-ai')
    expect(windowsInstallCommand(ENGINE_WINDOWS_INSTALL.opencode, where, 'x64').args.join(' ')).not.toContain('--cpu')
  })

  it('runs a vendor\'s installer in PowerShell, which asks nothing', () => {
    const run = windowsInstallCommand(ENGINE_WINDOWS_INSTALL.amp, where, 'x64')
    expect(run.file).toBe(where.powershell)
    expect(run.args).toContain('-NonInteractive')
    // Encoded, its errors would come out as CLIXML, and the person would be shown XML as the reason.
    expect(run.args).not.toContain('-EncodedCommand')
    expect(run.args.at(-2)).toBe('-Command')
    expect(run.args.at(-1)).toBe(powershellInstallScript('https://ampcode.com/install.ps1'))
    expect(run.args.at(-1)).not.toContain('"')
  })

  it('reads a script served as bytes, and passes on the vendor\'s own flags', () => {
    const script = powershellInstallScript('https://hermes-agent.nousresearch.com/install.ps1', ['-NonInteractive'])
    expect(script).toContain('[byte[]]')
    expect(script).toContain('[scriptblock]::Create($text.TrimStart([char]0xFEFF))) -NonInteractive }')
    expect(powershellInstallScript('https://ampcode.com/install.ps1')).toContain('[char]0xFEFF))) }')
  })

  // A failed download went on to run an empty script and exit 0: an install that "finished" and left nothing.
  it('stops at a download that failed, and says so', () => {
    const script = powershellInstallScript('https://ampcode.com/install.ps1')
    expect(script).toContain('-ErrorAction Stop')
    expect(script).toContain('could not be downloaded')
    expect(script).toContain('exit 1')
  })
})

describe('what runs an installer', () => {
  it('passes on its output and how it ended, and keeps its own variable to itself', () => {
    const script = "console.log('said ' + process.env.HARNESS_INSTALL_COMMAND); console.error('wrong'); process.exit(3)"
    const run = spawnSync(process.execPath, ['-e', INSTALL_RUNNER], { encoding: 'utf8', env: { ...process.env,
      HARNESS_INSTALL_COMMAND: JSON.stringify({ file: process.execPath, args: ['-e', script], verbatim: false }) } })
    expect(run.status).toBe(3)
    expect(run.stdout).toBe('said undefined\n')
    expect(run.stderr).toBe('wrong\n')
  })

  it('says why, when the installer cannot start', () => {
    const run = spawnSync(process.execPath, ['-e', INSTALL_RUNNER], { encoding: 'utf8', env: { ...process.env,
      HARNESS_INSTALL_COMMAND: JSON.stringify({ file: join(tmpdir(), 'no-such-installer'), args: [], verbatim: false }) } })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('ENOENT')
  })
})

describe('the Windows installations', () => {
  let directory: string
  let spawn: ReturnType<typeof vi.fn>
  let children: ReturnType<typeof fakeChild>[]
  let alive: ReturnType<typeof vi.fn>
  let now: number
  let end: ReturnType<typeof vi.fn>
  const recipe = ENGINE_INSTALL.kilo
  const current = () => true
  const make = () => createWindowsInstallations({ directory, spawn: spawn as never, alive: alive as never, now: () => now, endTree: end as never,
    where: () => ({ node: 'C:\\n\\node.exe', npm: 'C:\\n\\npm.cmd', prefix: 'C:\\h\\.local', comspec: 'C:\\cmd.exe', powershell: 'C:\\ps.exe', nodeDir: 'C:\\n' }) })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'windows-install-'))
    children = []
    spawn = vi.fn(() => { const child = fakeChild(); children.push(child); return child })
    alive = vi.fn(() => true)
    end = vi.fn(async () => {})
    now = 1_000_000
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('starts one hidden install, however many ask', async () => {
    const install = make()
    expect(await install.ensure('kilo', recipe, {}, 'r1', current)).toMatchObject({ complete: false, running: true })
    expect(await install.ensure('kilo', recipe, {}, 'r2', current)).toMatchObject({ complete: false, running: true })
    expect(spawn).toHaveBeenCalledTimes(1)
    const options = spawn.mock.calls[0]![2]
    // Detached to outlive the daemon, and so only the runner: without a console PowerShell exits 0 having run nothing.
    expect(spawn.mock.calls[0]![0]).toBe('C:\\n\\node.exe')
    expect(spawn.mock.calls[0]![1]).toEqual(['-e', INSTALL_RUNNER])
    expect(options).toMatchObject({ windowsHide: true, detached: true })
    expect(JSON.parse(options.env.HARNESS_INSTALL_COMMAND)).toMatchObject({ file: 'C:\\cmd.exe', verbatim: true })
    expect(options.stdio[0]).toBe('ignore')
    expect(options.env.PATH.startsWith('C:\\n;')).toBe(true)
  })

  it('is done when the installer exits well, and asks nothing more', async () => {
    const install = make()
    await install.ensure('kilo', recipe, {}, 'r1', current)
    children[0]!.emit('exit', 0, null)
    expect(await install.status('kilo', 'r1', current)).toBeNull()
  })

  it('says why, in the installer\'s last line, and a new request tries again', async () => {
    const install = make()
    await install.ensure('kilo', recipe, {}, 'r1', current)
    writeFileSync(join(directory, 'kilo.log'), 'first\n\u001b[31mnpm ERR! network timeout\u001b[0m\r\n\r\n')
    children[0]!.emit('exit', 1, null)
    expect(await install.ensure('kilo', recipe, {}, 'r1', current)).toEqual({ complete: false, failed: true, detail: 'npm ERR! network timeout' })
    expect(await install.status('kilo', 'r1', current)).toMatchObject({ failed: true })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(await install.ensure('kilo', recipe, {}, 'r2', current)).toMatchObject({ running: true })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('has words of its own for an installer that said nothing', async () => {
    const install = make()
    await install.ensure('kilo', recipe, {}, 'r1', current)
    children[0]!.emit('exit', 3, null)
    expect(await install.ensure('kilo', recipe, {}, 'r1', current)).toEqual({ complete: false, failed: true, detail: 'its installer stopped with code 3.' })
  })

  // Asked again after a good install, the launch looked and did not find it: never another install in a loop.
  it('says so when a finished install left nothing to run', async () => {
    const install = make()
    await install.ensure('kilo', recipe, {}, 'r1', current)
    children[0]!.emit('exit', 0, null)
    const again = await install.ensure('kilo', recipe, {}, 'r1', current)
    expect(again).toMatchObject({ complete: false, failed: true })
    expect((again as { detail: string }).detail).toContain('could not find it')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('ends an install at its limit, with its whole tree', async () => {
    vi.useFakeTimers()
    try {
      const install = make()
      await install.ensure('kilo', recipe, {}, 'r1', current)
      await vi.advanceTimersByTimeAsync(WINDOWS_INSTALL_LIMIT_MS)
      expect(end).toHaveBeenCalledWith(4242)
      children[0]!.emit('exit', 1, null)
      expect(await install.ensure('kilo', recipe, {}, 'r1', current)).toMatchObject({ failed: true, detail: 'it took longer than 20 minutes.' })
    } finally { vi.useRealTimers() }
  })

  // The PC restarted, or Harness did: an install nobody is running must not hold a launch for good.
  it('takes over from an install whose process is gone, or that is past its limit', async () => {
    await make().ensure('kilo', recipe, {}, 'r1', current)
    alive.mockReturnValue(false)
    const after = make()
    expect(await after.status('kilo', 'r1', current)).toBeNull()
    expect(await after.ensure('kilo', recipe, {}, 'r2', current)).toMatchObject({ running: true })
    expect(spawn).toHaveBeenCalledTimes(2)

    alive.mockReturnValue(true)
    now += WINDOWS_INSTALL_LIMIT_MS + 120_000
    expect(await make().status('kilo', 'r2', current)).toBeNull()
  })

  it('sees an install still running after Harness restarted, and waits for it', async () => {
    await make().ensure('kilo', recipe, {}, 'r1', current)
    const after = make()
    expect(await after.status('kilo', 'r1', current)).toMatchObject({ running: true })
    expect(await after.ensure('kilo', recipe, {}, 'r1', current)).toMatchObject({ running: true })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('reads a broken record as no record', async () => {
    writeFileSync(join(directory, 'kilo.json'), '{nope')
    expect(await make().status('kilo', 'r1', current)).toBeNull()
  })

  it('reports a program that could not start, and does nothing for a request that lost its authority', async () => {
    const install = make()
    expect(await install.ensure('kilo', recipe, {}, 'r1', () => false)).toMatchObject({ complete: false })
    expect(spawn).not.toHaveBeenCalled()
    spawn.mockImplementationOnce(() => { throw new Error('spawn ENOENT') })
    expect(await install.ensure('kilo', recipe, {}, 'r2', current)).toEqual({ complete: false, failed: true, detail: 'spawn ENOENT' })
    expect(existsSync(join(directory, 'kilo.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(directory, 'kilo.json'), 'utf8')).state).toBe('failed')
  })
})
