import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { stripVTControlCharacters } from 'node:util'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_INSTALL, ENGINE_WINDOWS_INSTALL } from '../../lib/engineInstall.js'
import { createWindowsInstallations, INSTALL_RUNNER, powershellInstallScript, windowsInstallCommand, WINDOWS_INSTALL_LIMIT_MS } from './windowsInstall.js'
import { createWindowsInstallations as oldWindowsInstallations } from './__fixtures__/windowsInstall.2026-11-15.js'

// How the watched path is changed: opened for writing in place, or a file renamed onto it.
const disk = vi.hoisted(() => ({ watch: '', changes: [] as string[], refuseFlush: false }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const writes = (flags: unknown) => typeof flags === 'number' ? (flags & 3) !== 0 : typeof flags === 'string' && flags !== 'r'
  return { ...actual,
    fsyncSync: (fd: number) => {
      if (disk.refuseFlush) throw new Error('fixture durability unavailable')
      return actual.fsyncSync(fd)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (args[0] === disk.watch && writes(args[1])) disk.changes.push('write')
      return actual.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (args[0] === disk.watch) disk.changes.push('write')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (args[1] === disk.watch) disk.changes.push('rename')
      return actual.renameSync(...args)
    },
  }
})
afterEach(() => { disk.watch = ''; disk.changes = []; disk.refuseFlush = false })

// The mocked child writes as a separate process, outside the parent's observed calls.
const childFs = await vi.importActual<typeof import('node:fs')>('node:fs')
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
  const make = () => createWindowsInstallations({ directory, spawn: spawn as never, alive: alive as never, now: () => now,
    where: () => ({ node: 'C:\\n\\node.exe', npm: 'C:\\n\\npm.cmd', prefix: 'C:\\h\\.local', comspec: 'C:\\cmd.exe', powershell: 'C:\\ps.exe', nodeDir: 'C:\\n' }) })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'windows-install-'))
    children = []
    spawn = vi.fn((_node, _args, options) => {
      const child = fakeChild(); children.push(child)
      const command = JSON.parse(options.env.HARNESS_INSTALL_COMMAND)
      if (command.record) {
        const previous = JSON.parse(readFileSync(command.record, 'utf8'))
        expect(previous).toMatchObject({ state: 'failed', request: command.request, dispatch: command.dispatch })
        childFs.writeFileSync(command.record, JSON.stringify({ ...previous, pid: child.pid, startedAt: now }))
        // The real helper publishes its result before exit; the parent must not invent one from exit alone.
        child.on('exit', (code: number | null, signal: string | null) => {
          if (signal) return
          const lines = stripVTControlCharacters(readFileSync(command.log, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
          childFs.writeFileSync(command.record, JSON.stringify(code === 0 ? { state: 'done', request: command.request }
            : { state: 'failed', request: command.request, detail: lines.at(-1) ?? `its installer stopped with code ${code}.` }))
        })
      }
      return child
    })
    alive = vi.fn(() => true)
    end = vi.fn(async () => {})
    now = 1_000_000
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('refuses an installer until its dispatch record is durable', async () => {
    disk.refuseFlush = true
    const result = await make().ensure('kilo', recipe, {}, 'r1', current)
    expect(spawn.mock.calls.length).toBe(0)
    expect(result.complete).toBe(false)
  })

  it('refuses commit before spawning any installer', async () => {
    await make().ensure('kilo', recipe, {}, 'r1', current, async () => false)
    expect(spawn.mock.calls.length).toBe(0)
  })

  it('holds an unresolved dispatch for both the original request and a new request', async () => {
    writeFileSync(join(directory, 'kilo.json'), JSON.stringify({ state: 'failed', request: 'r1', detail: 'Installation dispatch is unconfirmed.', dispatch: 'fixture-token' }))
    for (const request of ['r1', 'r2']) {
      expect(await make().ensure('kilo', recipe, {}, request, current)).toMatchObject({ complete: false, detail: expect.stringContaining('recovery') })
    }
    expect(spawn.mock.calls.length).toBe(0)
  })

  it.each(['before dispatch', 'after dispatch'] as const)('an actual older controller cannot replay the saved request %s, but retains its legacy new-request retry', async phase => {
    writeFileSync(join(directory, 'kilo.json'), JSON.stringify({ state: 'failed', request: 'r1', detail: 'Installation dispatch is unconfirmed.', dispatch: 'fixture-token',
      ...(phase === 'after dispatch' ? { pid: 4242, startedAt: now } : {}) }))
    const older = oldWindowsInstallations({ directory, spawn: spawn as never, alive: alive as never, now: () => now, endTree: end as never,
      where: () => ({ node: 'C:\\n\\node.exe', npm: 'C:\\n\\npm.cmd', prefix: 'C:\\h\\.local', comspec: 'C:\\cmd.exe', powershell: 'C:\\ps.exe', nodeDir: 'C:\\n' }) })
    expect(await older.ensure('kilo', recipe, {}, 'r1', current)).toMatchObject({ failed: true })
    expect(spawn.mock.calls.length).toBe(0)
    expect(await older.ensure('kilo', recipe, {}, 'r2', current)).toMatchObject({ running: true })
    expect(spawn).toHaveBeenCalledOnce()
  })

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

  it('the hidden helper owns the twenty-minute deadline after its parent is gone', () => {
    const child = fakeChild(), kill = vi.fn(), exit = vi.fn(), timers: Array<{ run(): void; ms: number }> = []
    const require = createRequire(import.meta.url)
    runInNewContext(INSTALL_RUNNER, {
      require: (name: string) => name === 'node:child_process' ? { spawn: () => child, execFile: kill } : require(name),
      process: { env: { HARNESS_INSTALL_COMMAND: JSON.stringify({ file: 'fixture', args: [], verbatim: false }) }, platform: 'win32', exit },
      console, Buffer, clearTimeout: vi.fn(), setTimeout: (run: () => void, ms: number) => { timers.push({ run, ms }); return 1 },
    })
    expect(timers[0]!.ms).toBe(WINDOWS_INSTALL_LIMIT_MS)
    timers[0]!.run()
    expect(kill.mock.calls[0]!.slice(1, 3)).toEqual([['/PID', '4242', '/T', '/F'], { windowsHide: true, timeout: 5000 }])
    child.emit('exit', 1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('holds a new dispatch whose helper dies instead of treating its exit as completion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await make().ensure('kilo', recipe, {}, 'r1', current)
    children[0]!.emit('exit', null, 'SIGKILL'); alive.mockReturnValue(false)
    for (const request of ['r1', 'r2']) {
      expect(await make().status('kilo', request, current)).toMatchObject({ complete: false, detail: expect.stringContaining('recovery') })
      expect(await make().ensure('kilo', recipe, {}, request, current)).toMatchObject({ complete: false, detail: expect.stringContaining('recovery') })
    }
    expect(spawn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[engine-setup] INSTALLATION_RECOVERY_REQUIRED'); warn.mockRestore()
  })

  // The PC restarted, or Harness did: an install nobody is running must not hold a launch for good.
  it('takes over from an install whose process is gone, or that is past its limit', async () => {
    writeFileSync(join(directory, 'kilo.json'), JSON.stringify({ state: 'running', pid: 4242, request: 'r1', startedAt: now }))
    alive.mockReturnValue(false)
    const after = make()
    expect(await after.status('kilo', 'r1', current)).toBeNull()
    expect(await after.ensure('kilo', recipe, {}, 'r2', current)).toMatchObject({ running: true })
    expect(spawn).toHaveBeenCalledTimes(1)

    alive.mockReturnValue(true)
    writeFileSync(join(directory, 'kilo.json'), JSON.stringify({ state: 'running', pid: 4242, request: 'r2', startedAt: now }))
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

  it('the save goes through a temporary file renamed onto the target', async () => {
    disk.watch = join(directory, 'kilo.json')
    await make().ensure('kilo', recipe, {}, 'r1', current)
    expect(disk.changes).toEqual(['rename'])
    if (process.platform !== 'win32') expect(statSync(disk.watch).mode & 0o777).toBe(0o600)
  })

  it('a file at the old temporary name is left alone', async () => {
    const planted = join(directory, `kilo.json.${process.pid}.next`)
    writeFileSync(planted, 'planted')
    await make().ensure('kilo', recipe, {}, 'r1', current)
    expect(readFileSync(planted, 'utf8')).toBe('planted')
  })

  it('reads a broken record as no record', async () => {
    writeFileSync(join(directory, 'kilo.json'), '{nope')
    expect(await make().status('kilo', 'r1', current)).toBeNull()
  })

  it('retains uncertain dispatch when parent bookkeeping fails after the helper started', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    spawn.mockImplementationOnce(() => { const child = fakeChild(); child.unref.mockImplementation(() => { throw Error('fixture parent bookkeeping'); }); return child })
    expect(await make().ensure('kilo', recipe, {}, 'r1', current)).toMatchObject({ complete: false, detail: expect.stringContaining('recovery') })
    expect(await make().ensure('kilo', recipe, {}, 'r2', current)).toMatchObject({ complete: false, detail: expect.stringContaining('recovery') })
    expect(spawn).toHaveBeenCalledOnce(); warn.mockRestore()
  })

  it('reports a program that could not start, and does nothing for a request that lost its authority', async () => {
    const install = make()
    expect(await install.ensure('kilo', recipe, {}, 'r1', () => false)).toMatchObject({ complete: false })
    expect(spawn.mock.calls.length).toBe(0)
    spawn.mockImplementationOnce(() => { throw new Error('spawn ENOENT') })
    expect(await install.ensure('kilo', recipe, {}, 'r2', current)).toEqual({ complete: false, failed: true, detail: 'spawn ENOENT' })
    expect(existsSync(join(directory, 'kilo.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(directory, 'kilo.json'), 'utf8')).state).toBe('failed')
  })
})

it.each([0, 3])('the real hidden helper durably settles its own token with exit %s', code => {
  const root = mkdtempSync(join(tmpdir(), 'windows-helper-journal-'))
  try {
    const record = join(root, 'codex.json'), log = join(root, 'codex.log'), witness = join(root, 'dispatch')
    writeFileSync(record, JSON.stringify({ state: 'failed', request: 'saved-request', dispatch: 'fixture-token' }))
    writeFileSync(log, 'installer output\n')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(witness)}, 'once'); process.exit(${code})`
    const run = spawnSync(process.execPath, ['-e', INSTALL_RUNNER], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: root, USERPROFILE: root, HARNESS_INSTALL_COMMAND: JSON.stringify({ file: process.execPath,
        args: ['-e', script], verbatim: false, record, request: 'saved-request', dispatch: 'fixture-token', log }) } })
    expect(run.status, run.stderr).toBe(code)
    expect(readFileSync(witness, 'utf8')).toBe('once')
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(code === 0 ? { state: 'done', request: 'saved-request' }
      : { state: 'failed', request: 'saved-request', detail: 'installer output' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('the real hidden helper refuses stale claim ownership before executing its installer', () => {
  const root = mkdtempSync(join(tmpdir(), 'windows-helper-stale-'))
  try {
    const record = join(root, 'codex.json'), witness = join(root, 'must-not-dispatch')
    const newer = { state: 'failed', request: 'new-request', dispatch: 'new-token' }
    writeFileSync(record, JSON.stringify(newer))
    const run = spawnSync(process.execPath, ['-e', INSTALL_RUNNER], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: root, USERPROFILE: root, HARNESS_INSTALL_COMMAND: JSON.stringify({ file: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(witness)}, 'wrong')`], verbatim: false,
        record, request: 'old-request', dispatch: 'old-token' }) } })
    expect(run.status).toBe(2)
    expect(existsSync(witness)).toBe(false)
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(newer)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
