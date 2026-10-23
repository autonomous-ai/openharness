import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OS_SYSTEMD_UNIT, OS_UNIT_FILE, PlatformService, SYSTEMD_UNIT, defaultPlatformDeps, logonTaskName, taskName, type CommandResult, type PlatformName } from '../harnessd/platform.js'
import { fakePlatform, type FakePlatform } from '../testing/fakePlatform.js'
import { TASK_RUN_WAIT_MS, serviceDefinition } from './platformDaemon.js'
import {
  SERVICE_REGISTERED_NOT_RUNNING, SERVICE_USAGE, USER_ENVIRONMENT_TIMEOUT_MS, WINDOWS_SERVICE_USAGE, readUserEnvironment, serviceCommand, serviceCommandDeps, type RegRun, type ServiceCommandDeps,
} from './serviceCommand.js'

/**
 * A computer in a temporary folder: a home, a data folder, an installed bundle, a pid file, and fake
 * launchctl or systemctl, run in this process, that run a stand-in master (pid 4242) and write its pid as
 * the real one does.
 */
function computer(platform: PlatformName) {
  const dir = mkdtempSync(join(tmpdir(), 'service-command-'))
  const home = join(dir, 'home')
  const data = join(dir, 'data')
  const pidFile = join(data, 'adapter.pid')
  const script = join(dir, 'cli', 'cli.js')
  mkdirSync(join(dir, 'cli'), { recursive: true })
  writeFileSync(script, '// the installed bundle\n')
  const fake = fakePlatform(join(dir, 'bin'), { pidFile })
  const clock = { now: 0 }
  /** A daemon `harness start` spawned, outside the platform: alive until `stopDaemon` stops it. */
  const outside = { pid: null as number | null }
  const out: string[] = []
  const err: string[] = []
  const stops: string[] = []
  const relaunches: number[] = []
  // The fakes run in this process (`fake.run`): these tests are about the command, not how launchctl and
  // systemctl start, and as processes the systemd ones timed out under load (fakePlatform.ts).
  const service = new PlatformService(platform, { ...defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home }), run: fake.run })
  const readPid = (): number | null => { try { return Number(readFileSync(pidFile, 'utf8')) || null } catch { return null } }
  const deps: ServiceCommandDeps = {
    service,
    logFile: join(data, 'harness.log'),
    readPid,
    isAlive: (pid) => pid === outside.pid || pid === fake.state().pid,
    masterPlatform: () => null,
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms },
    definition: () => serviceDefinition({ logFile: join(data, 'harness.log'), source: { ADAPTER_DATA_DIR: data }, nodePath: '/opt/node/bin/node', scriptPath: script, home }),
    bundleExists: (path) => existsSync(path),
    ensureDir: (path) => { mkdirSync(path, { recursive: true }) },
    stopDaemon: async () => {
      const pid = readPid()
      stops.push(String(pid))
      if (pid === outside.pid) { outside.pid = null; rmSync(pidFile, { force: true }) }
      return { pid, stopped: pid !== null }
    },
    withLock: (_purpose, fn) => fn(),
    relaunch: async () => { relaunches.push(clock.now) },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    tildify: (path) => path.replace(dir, '~'),
    startWaitMs: 1_000,
  }
  /** A daemon running outside the platform, as `harness start` leaves one. */
  const runOutside = (pid: number) => { outside.pid = pid; mkdirSync(data, { recursive: true }); writeFileSync(pidFile, `${pid}\n`) }
  return { dir, home, data, pidFile, script, fake, clock, out, err, stops, relaunches, service, deps, runOutside, outside }
}

describe('harness service', () => {
  it('prints its usage when asked, and refuses a verb it does not know', async () => {
    const c = computer('launchd')
    try {
      await expect(serviceCommand([], c.deps)).resolves.toBe(0)
      await expect(serviceCommand(['--help'], c.deps)).resolves.toBe(0)
      await expect(serviceCommand(['help'], c.deps)).resolves.toBe(0)
      expect(c.out).toEqual([SERVICE_USAGE, SERVICE_USAGE, SERVICE_USAGE])
      await expect(serviceCommand(['restart'], c.deps)).resolves.toBe(2)
      expect(c.err[0]).toMatch(/^Unknown command: harness service restart/)
      expect(c.fake.calls()).toEqual([])
    } finally { rmSync(c.dir, { recursive: true, force: true }) }
  })

  it('says so on a computer with neither launchd nor systemd', async () => {
    const c = computer('launchd')
    try {
      const none = { ...c.deps, service: null }
      await expect(serviceCommand(['install'], none)).resolves.toBe(1)
      await expect(serviceCommand(['status'], none)).resolves.toBe(0)
      expect(c.err).toEqual([
        'harness service runs harnessd under launchd (macOS), systemd (Linux) or Task Scheduler (Windows); this computer has none of them.',
        'harness service runs harnessd under launchd (macOS), systemd (Linux) or Task Scheduler (Windows); this computer has none of them.',
      ])
      await expect(serviceCommand(['status', '--json'], none)).resolves.toBe(0)
      expect(c.out).toEqual(['{"supported":false}'])
    } finally { rmSync(c.dir, { recursive: true, force: true }) }
  })

  it('installs and removes nothing on Harness OS, whose package runs harnessd under its own unit, and says how it stands', async () => {
    const c = computer('systemd')
    try {
      const base = { ...defaultPlatformDeps({ env: { PATH: c.fake.bin }, uid: 501, home: c.home }), run: c.fake.run }
      const os = { ...c.deps, service: new PlatformService('systemd', { ...base, readFile: (path) => (path === OS_UNIT_FILE ? '[Service]\n' : base.readFile(path)) }, true) }
      c.runOutside(2288)
      await expect(serviceCommand(['install'], os)).resolves.toBe(1)
      await expect(serviceCommand(['uninstall'], os)).resolves.toBe(1)
      expect(c.err).toEqual([
        `Harness OS runs harnessd under ${OS_SYSTEMD_UNIT} already: \`harness start\` and \`harness stop\` go through it, and there is nothing to install.`,
        `Harness OS runs harnessd under ${OS_SYSTEMD_UNIT} already: \`harness start\` and \`harness stop\` go through it, and there is nothing to uninstall.`,
      ])
      expect(c.stops).toEqual([])
      expect(c.outside.pid).toBe(2288)
      expect(c.fake.calls()).toEqual([])
      expect(existsSync(join(c.home, '.config', 'systemd', 'user', SYSTEMD_UNIT))).toBe(false)
      c.fake.set({ loaded: true, pid: 4242 })
      await expect(serviceCommand(['status', '--json'], os)).resolves.toBe(0)
      expect(JSON.parse(c.out.at(-1)!)).toMatchObject({ supported: true, file: OS_UNIT_FILE, target: OS_SYSTEMD_UNIT, installed: true, current: true, registered: true, pid: 4242 })
    } finally { rmSync(c.dir, { recursive: true, force: true }) }
  })
})

describe.each(['launchd', 'systemd'] as const)('harness service under %s', (platform) => {
  let c: ReturnType<typeof computer>
  beforeEach(() => { c = computer(platform) })
  afterEach(() => rmSync(c.dir, { recursive: true, force: true }))
  const verbs = () => c.fake.calls().map((call) => (call[0] === 'systemctl' ? [call[0], call[2]] : call.slice(0, 2)).join(' '))

  describe('install', () => {
    it('writes the definition, registers it, and waits for the master the platform starts', async () => {
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(0)
      expect(readFileSync(c.service.file, 'utf8')).toBe(c.service.render(c.deps.definition()))
      expect(readFileSync(c.service.file, 'utf8')).toContain(c.data)
      expect(c.fake.state()).toMatchObject({ loaded: true, pid: 4242 })
      expect(c.stops).toEqual([]) // nothing was running to stop
      expect(existsSync(c.data)).toBe(true) // the log's folder, which the platform will not make
      expect(c.out[0]).toBe(`✓ harnessd runs under ${platform} (pid 4242): it starts at login and comes back if it dies.`)
      expect(c.out).toContain('  undo: harness service uninstall')
      expect(verbs()).toEqual(platform === 'launchd'
        ? ['launchctl print', 'launchctl print', 'launchctl enable', 'launchctl bootstrap', 'launchctl print']
        : ['systemctl daemon-reload', 'systemctl show', 'loginctl show-user', 'systemctl daemon-reload', 'systemctl enable', 'systemctl show', 'loginctl show-user'])
    })

    it('stops a daemon `harness start` left running first, so there is one supervisor', async () => {
      c.runOutside(31337)
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(0)
      expect(c.stops).toEqual(['31337'])
      expect(c.outside.pid).toBeNull()
      expect(c.fake.state().pid).toBe(4242)
    })

    it('does nothing when it already runs under the platform from this definition', async () => {
      await serviceCommand(['install'], c.deps)
      const before = c.fake.calls().length
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(0)
      expect(c.out.at(-1)).toBe(`harnessd already runs under ${platform} (pid 4242); nothing to change.`)
      expect(c.fake.calls().slice(before).map((call) => call.join(' '))).not.toContainEqual(expect.stringMatching(/bootstrap|enable/))
      expect(c.stops).toEqual([])
    })

    it('moves the platform\'s master onto a definition that changed', async () => {
      await serviceCommand(['install'], c.deps)
      const definition = c.deps.definition
      c.deps.definition = () => ({ ...definition(), nodePath: '/opt/newer-node/bin/node' })
      c.fake.set({ nextPid: 4343 })
      c.deps.stopDaemon = async () => { c.stops.push('platform'); c.service.stop(); return { pid: 4242, stopped: true } }
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(0)
      expect(c.stops).toEqual(['platform'])
      expect(readFileSync(c.service.file, 'utf8')).toContain('/opt/newer-node/bin/node')
      expect(c.fake.state().pid).toBe(4343)
    })

    it('refuses without the installed bundle, and touches nothing', async () => {
      rmSync(c.script)
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(1)
      expect(c.err[0]).toBe(`✗ No installed CLI at ~/cli/cli.js. ${platform} runs the installed bundle: install it first, then run this again.`)
      expect(existsSync(c.service.file)).toBe(false)
      expect(c.fake.calls()).toEqual([])
    })

    it('leaves a computer the platform cannot serve as it was', async () => {
      c.runOutside(31337)
      c.fake.set(platform === 'launchd' ? { guiDomain: false } : { fail: { 'systemctl daemon-reload': { status: 1, stderr: 'Failed to connect to bus' } } })
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(1)
      expect(c.err[0]).toMatch(new RegExp(`^✗ ${platform} cannot run harnessd here: `))
      expect(existsSync(c.service.file)).toBe(false)
      expect(c.stops).toEqual([])
      expect(c.outside.pid).toBe(31337)
    })

    it('discards a definition the platform would not take, and says the daemon it stopped needs a start', async () => {
      c.runOutside(31337)
      c.fake.set({ fail: { [platform === 'launchd' ? 'launchctl bootstrap' : 'systemctl enable']: { status: 5, stderr: 'refused' } } })
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(1)
      expect(existsSync(c.service.file)).toBe(false)
      expect(c.err).toEqual([
        expect.stringMatching(new RegExp(`^✗ ${platform} would not take harnessd: .*refused$`)),
        '  The daemon was stopped to hand it over; `harness start` starts it again, as before.',
      ])
    })

    it('says so when the master does not come up', async () => {
      c.fake.set({ pidFile: null })
      await expect(serviceCommand(['install'], c.deps)).resolves.toBe(1)
      expect(c.err[0]).toMatch(new RegExp(`^✗ ${platform} has harnessd, but it did not come up \\(.*pid 4242\\)\\.$`))
      expect(c.err[1]).toBe('  logs ~/data/harness.log   ·   harness service status')
    })
  })

  describe('uninstall', () => {
    it('has nothing to remove when nothing is installed', async () => {
      await expect(serviceCommand(['uninstall'], c.deps)).resolves.toBe(0)
      expect(c.out).toEqual([`harnessd is not installed with ${platform}; nothing to remove.`])
    })

    it('unregisters, removes the definition, and starts the daemon the usual way', async () => {
      await serviceCommand(['install'], c.deps)
      c.out.length = 0
      await expect(serviceCommand(['uninstall'], c.deps)).resolves.toBe(0)
      expect(existsSync(c.service.file)).toBe(false)
      expect(c.fake.state()).toMatchObject({ pid: null })
      expect(c.out).toEqual([`✓ removed ~/home/${platform === 'launchd' ? 'Library/LaunchAgents/ai.autonomous.harness.harnessd.plist' : '.config/systemd/user/harnessd.service'}: ${platform} no longer runs harnessd.`, '  starting it the usual way…'])
      expect(c.relaunches).toHaveLength(1)
      expect(c.stops).toEqual([])
    })

    it('stops a master the platform let outlive its unregistering, before starting one the usual way', async () => {
      await serviceCommand(['install'], c.deps)
      const isAlive = c.deps.isAlive
      c.deps.isAlive = (pid) => pid === 4242 || isAlive(pid) // it does not go when the platform lets it
      await expect(serviceCommand(['uninstall'], c.deps)).resolves.toBe(0)
      expect(c.clock.now).toBeGreaterThanOrEqual(12_000)
      expect(c.stops).toHaveLength(1)
      expect(c.relaunches).toHaveLength(1)
    })

    it('starts nothing when the daemon was not running under the platform', async () => {
      await serviceCommand(['install'], c.deps)
      c.service.stop()
      c.runOutside(31337)
      await expect(serviceCommand(['uninstall'], c.deps)).resolves.toBe(0)
      expect(existsSync(c.service.file)).toBe(false)
      expect(c.relaunches).toEqual([])
      expect(c.outside.pid).toBe(31337)
    })

    it('keeps the definition and says why when the platform will not let it go', async () => {
      await serviceCommand(['install'], c.deps)
      c.fake.set({ fail: { [platform === 'launchd' ? 'launchctl bootout' : 'systemctl disable']: { status: 1, stderr: 'not now' } } })
      await expect(serviceCommand(['uninstall'], c.deps)).resolves.toBe(1)
      expect(c.err[0]).toMatch(/^✗ .*not now$/)
      expect(existsSync(c.service.file)).toBe(true)
      expect(c.relaunches).toEqual([])
    })
  })

  describe('status', () => {
    const status = async (...flags: string[]) => {
      c.out.length = 0
      await expect(serviceCommand(['status', ...flags], c.deps)).resolves.toBe(0)
      return c.out
    }

    it('says when it is not installed, and how to opt in', async () => {
      expect(await status()).toEqual([
        `harnessd · ${platform}`,
        `  status      ○ not installed · \`harness start\` runs the daemon; \`harness service install\` hands it to ${platform}`,
      ])
    })

    it('says when the platform runs it, where its definition is, and what the platform calls it', async () => {
      await serviceCommand(['install'], c.deps)
      const lines = await status()
      expect(lines[1]).toBe('  status      ● running (pid 4242) · starts at login, comes back if it dies')
      expect(lines[2]).toMatch(new RegExp(`^  (agent |unit  )      ~/home/`))
      expect(lines[3]).toBe(`  target      ${c.service.target}`)
      expect(lines).toHaveLength(4)
      expect(JSON.parse((await status('--json'))[0])).toEqual({
        supported: true, platform, file: c.service.file, target: c.service.target, installed: true, current: true, registered: true,
        running: true, pid: 4242, state: platform === 'launchd' ? 'running' : 'active (running)', lastExit: platform === 'launchd' ? '(never exited)' : null,
        failed: false, linger: platform === 'launchd' ? null : true, unreachable: null,
      })
    })

    it('says when it is installed but stopped, and when the definition is out of date', async () => {
      await serviceCommand(['install'], c.deps)
      c.service.stop()
      expect((await status())[1]).toBe(platform === 'launchd'
        ? '  status      ◍ installed, not loaded · it starts at your next login, or now with `harness start`'
        : `  status      ◍ registered, not running (inactive (dead)) · \`harness start\` starts it`)
      c.deps.definition = () => ({ ...serviceDefinition({ logFile: c.deps.logFile, source: {}, nodePath: '/moved/node', scriptPath: c.script, home: c.home }) })
      expect(await status()).toContain('  ! the definition is not the one this install would write (another Node, bundle or setting): `harness service install` rewrites it')
    })

    it('says when the platform has it but not its file, or cannot be asked', async () => {
      if (platform === 'launchd') {
        await serviceCommand(['install'], c.deps)
        c.fake.set({ pid: null })
        expect((await status())[1]).toBe('  status      ◍ registered, not running (not running · last exit 1) · `harness start` starts it')
        rmSync(c.service.file)
        expect((await status())[1]).toBe('  status      ◍ registered without its file · `harness service uninstall` clears it')
        c.fake.set({ fail: { 'launchctl print': { status: 1, stderr: 'x' } } })
        expect((await status())[1]).toBe('  status      ○ not installed · `harness start` runs the daemon; `harness service install` hands it to launchd')
      } else {
        c.fake.set({ loaded: true })
        c.service.write(c.deps.definition())
        expect((await status())[1]).toBe('  status      ◍ installed, not enabled · `harness service install` enables it')
        c.fake.set({ fail: { 'systemctl show': { status: 1, stderr: 'Failed to connect to bus' } } })
        expect((await status())[1]).toMatch(/^  status      \? could not ask systemd: systemctl --user show .*Failed to connect to bus$/)
      }
    })

    it('warns when systemd gave up, and when a logout would end the user manager', async () => {
      if (platform === 'launchd') return
      await serviceCommand(['install'], c.deps)
      c.fake.set({ failed: true, pid: null, linger: 'no' })
      const lines = await status()
      expect(lines).toContain('  ! systemd gave up after repeated failures (start-limit-hit): `harness start` tries again · logs ~/data/harness.log')
      expect(lines).toContain('  ! lingering is off: logging out of your last session ends your user manager, and with it the daemon')
      c.out.length = 0
      c.fake.set({ linger: 'no', failed: false })
      rmSync(c.service.file)
      await serviceCommand(['install'], c.deps)
      expect(c.out).toContain('    and a tmux server it started. `loginctl enable-linger` keeps them running.')
    })
  })
})

describe('harness service with Task Scheduler', () => {
  /** What schtasks and whoami answer, by the start of the call; the rest succeed. */
  type Answers = Record<string, CommandResult>
  function windows(over: { registered?: boolean; pid?: number | null; carried?: Record<string, string>; answers?: Answers; userEnvironment?: ServiceCommandDeps['userEnvironment']; lockHeld?: () => boolean; startWaitMs?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'service-task-'))
    const data = join(dir, 'data')
    const launcher = join(dir, 'bin', 'harness-launch.exe')
    const script = join(dir, 'cli', '0.5.0', 'cli.js')
    for (const file of [launcher, script]) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '') }
    const calls: string[] = []
    let registered = over.registered ?? false
    let pid = over.pid ?? null
    const service = new PlatformService('taskscheduler', {
      ...defaultPlatformDeps({ env: { USERNAME: 'demo' }, home: dir, dataDir: data }),
      run: (command, args) => {
        const call = [command, ...args].join(' ')
        const answer = Object.entries(over.answers ?? {}).find(([start]) => call.startsWith(start))?.[1]
        // whoami names the user by SID for the logon trigger (harnessd/platform.ts); only schtasks's calls are recorded.
        if (command === 'whoami') return answer ?? { status: 0, stdout: '"DESKTOP\\demo","S-1-5-21-1-2-3-1001"\r\n', stderr: '' }
        calls.push(call)
        if (answer) return answer
        if (call.startsWith('schtasks /Create')) registered = true
        if (call.startsWith('schtasks /Delete')) registered = false
        if (call.startsWith('schtasks /Run')) pid = 4343
        if (call.startsWith('schtasks /Query')) return registered ? { status: 0, stdout: '<Settings><Enabled>true</Enabled></Settings>', stderr: '' } : { status: 1, stdout: '', stderr: 'ERROR' }
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    const out: string[] = []
    const err: string[] = []
    const locks: string[] = []
    const clock = { now: 0 }
    const deps: ServiceCommandDeps = {
      service, logFile: 'C:\\d\\harness.log', readPid: () => pid, isAlive: (p) => p === pid, masterPlatform: () => null,
      now: () => clock.now, sleep: async (ms) => { clock.now += ms },
      definition: () => ({ nodePath: 'C:\\n\\node.exe', scriptPath: script, logFile: 'C:\\d\\harness.log', home: 'C:\\Users\\demo', env: over.carried ?? {}, launcherPath: launcher }),
      bundleExists: (path) => existsSync(path), ensureDir: () => {},
      stopDaemon: async () => { throw new Error('the task never stops the daemon') },
      withLock: async (purpose, fn) => { locks.push(purpose); const result = await fn(); locks.push(`${purpose} released`); return result },
      relaunch: async () => {}, out: (line) => out.push(line), err: (line) => err.push(line), tildify: (path) => path, startWaitMs: over.startWaitMs ?? 1_000,
      lockHeld: over.lockHeld ?? (() => false),
      ...(over.userEnvironment ? { userEnvironment: over.userEnvironment } : {}),
    }
    return { dir, data, calls, out, err, locks, deps, clock, setPid: (next: number | null) => { pid = next } }
  }
  /** What the command did to Task Scheduler: its calls but the queries. */
  const schtasks = (calls: string[]) => calls.filter((call) => !call.startsWith('schtasks /Query'))

  it('says what the task does on Windows: no tmux there, and it starts the daemon again within 5 minutes', async () => {
    const w = windows()
    try {
      await expect(serviceCommand(['--help'], w.deps)).resolves.toBe(0)
      expect(w.out).toEqual([WINDOWS_SERVICE_USAGE])
      expect(WINDOWS_SERVICE_USAGE).toContain('again within 5 minutes if it stops')
      expect(WINDOWS_SERVICE_USAGE).not.toMatch(/tmux|comes back if it dies|launchd|systemd/)
      await expect(serviceCommand(['restart'], w.deps)).resolves.toBe(2)
      expect(w.err[0]).toBe(`Unknown command: harness service restart\n\n${WINDOWS_SERVICE_USAGE}`)
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('registers the task under the lock, then runs it outside, never stopping the daemon that runs', async () => {
    const w = windows()
    try {
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(0)
      const name = taskName('demo')
      expect(schtasks(w.calls)).toEqual([expect.stringMatching(/harnessd-task\.xml \/F$/), expect.stringMatching(/harnessd-logon-task\.xml \/F$/), `schtasks /Run /TN ${name}`])
      expect(w.calls.find((call) => call.startsWith('schtasks /Create'))!.startsWith(`schtasks /Create /TN ${name} /XML `)).toBe(true)
      expect(w.locks).toEqual(['start', 'start released'])
      expect(w.out[0]).toBe('✓ Task Scheduler starts the Harness daemon when you sign in to Windows, and again within 5 minutes if it stops (pid 4343 runs now).')
      expect(w.err).toEqual([])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('leaves a registered task and a running daemon as they are, and says what a shell setting will not reach', async () => {
    const w = windows({ registered: true, pid: 4040, carried: { ADAPTER_DATA_DIR: 'C:\\elsewhere' } })
    try {
      await serviceCommand(['install'], w.deps)
      await serviceCommand(['install'], w.deps)
      expect(w.calls.some((call) => call.startsWith('schtasks /Run'))).toBe(false)
      expect(w.out).toContain(`harnessd is registered with Task Scheduler already (${taskName('demo')}); nothing to change.`)
      expect(w.out).toContain('  ! the task starts harness with your Windows user environment, not this shell\'s: ADAPTER_DATA_DIR set only here does not reach it')
      expect(w.out).toContain('    so the daemon it starts uses your user settings. Set these for your Windows user, or run this from a shell without them.')
      const two = windows({ registered: true, pid: 4040, carried: { ADAPTER_DATA_DIR: 'C:\\elsewhere', PORT: '18613' } })
      try {
        await serviceCommand(['install'], two.deps)
        expect(two.out).toContain('  ! the task starts harness with your Windows user environment, not this shell\'s: ADAPTER_DATA_DIR, PORT set only here do not reach it')
      } finally { rmSync(two.dir, { recursive: true, force: true }) }
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('says nothing of a PORT the Windows user has set to the same (setx), and still of one that differs or is not set', async () => {
    const WARNED = (names: string, verb: string) => `  ! the task starts harness with your Windows user environment, not this shell's: ${names} set only here ${verb} not reach it`
    const install = async (carried: Record<string, string>, user: string | null) => {
      const asked: string[] = []
      const w = windows({ registered: true, pid: 4040, carried, userEnvironment: async (name) => { asked.push(name); return user } })
      try {
        await serviceCommand(['install'], w.deps)
        return { out: w.out, asked }
      } finally { rmSync(w.dir, { recursive: true, force: true }) }
    }
    // The same as the user's: it reaches the task. Nothing to say at all.
    const same = await install({ PORT: '18621' }, '18621')
    expect(same.asked).toEqual(['PORT'])
    expect(same.out.some((line) => line.includes('! the task starts harness'))).toBe(false)
    // Another value, or none for the user (or none that could be read): the warning, as before.
    expect((await install({ PORT: '18621' }, '18473')).out).toContain(WARNED('PORT', 'does'))
    expect((await install({ PORT: '18621' }, null)).out).toContain(WARNED('PORT', 'does'))
    // PORT the user's, the data folder this shell's alone: only that one is said.
    expect((await install({ ADAPTER_DATA_DIR: 'C:\\elsewhere', PORT: '18621' }, '18621')).out).toContain(WARNED('ADAPTER_DATA_DIR', 'does'))
    // No PORT in this shell: the user's is not asked for.
    expect((await install({ ADAPTER_DATA_DIR: 'C:\\elsewhere' }, '18621')).asked).toEqual([])
  })

  it('registers a task someone turned off in Task Scheduler again, turned on, and says it is off in status', async () => {
    const off = { 'schtasks /Query': { status: 0, stdout: '<Settings><Enabled>false</Enabled></Settings>', stderr: '' } }
    const w = windows({ registered: true, pid: 4040, answers: off })
    try {
      w.deps.service!.write(w.deps.definition())
      await serviceCommand(['status'], w.deps)
      expect(w.out[1]).toBe('  status      ◍ registered, but turned off in Task Scheduler · `harness service install` turns it back on')
      w.out.length = 0
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(0)
      // The same file, registered again: its <Enabled>true</Enabled> is what turns the task back on (harnessd/platform.ts).
      expect(schtasks(w.calls)).toEqual([expect.stringMatching(/harnessd-task\.xml \/F$/), expect.stringMatching(/harnessd-logon-task\.xml \/F$/)])
      expect(w.out[0]).toBe('✓ Task Scheduler starts the Harness daemon when you sign in to Windows, and again within 5 minutes if it stops (pid 4040 runs now).')
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('refuses without the launcher, and unregisters without touching the daemon', async () => {
    const w = windows({ registered: true, pid: 4040 })
    try {
      rmSync(join(w.dir, 'bin'), { recursive: true })
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(1)
      expect(w.err[0]).toMatch(/^✗ No installed CLI at .*harness-launch\.exe/)
      await expect(serviceCommand(['uninstall'], w.deps)).resolves.toBe(0)
      expect(w.calls).toContain(`schtasks /Delete /TN ${taskName('demo')} /F`)
      expect(w.out.at(-1)).toMatch(/Task Scheduler no longer runs harnessd/)
      expect(w.locks).toEqual(['stop', 'stop released'])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('refuses without the installed build the launcher starts', async () => {
    const w = windows()
    try {
      rmSync(join(w.dir, 'cli'), { recursive: true })
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(1)
      expect(w.err[0]).toMatch(/^✗ No installed CLI at .*cli\.js\. Task Scheduler runs the installed CLI through bin\\harness-launch\.exe/)
      expect(w.calls).toEqual([])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('says in one plain sentence when the task cannot be written, with what Windows said below it, and changes nothing', async () => {
    const w = windows({ answers: { whoami: { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' } } })
    try {
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(1)
      expect(w.err).toEqual([
        '✗ Harness could not set up the task that starts harnessd when you sign in to Windows; nothing was changed.',
        '  Harness could not tell which Windows user this is: whoami /user /fo csv /nh failed (exit 1): ERROR: Access is denied.',
      ])
      expect(schtasks(w.calls)).toEqual([])
      expect(w.locks).toEqual(['start', 'start released'])
      expect(existsSync(join(w.data, 'harnessd-task.xml'))).toBe(false)
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('says in plain words when Task Scheduler cannot be asked, refuses the task or will not run it', async () => {
    const gone = windows({ answers: { 'schtasks /Query': { status: null, stdout: '', stderr: '', error: 'spawn schtasks ENOENT' } } })
    const refused = windows({ answers: { 'schtasks /Create': { status: 1, stdout: '', stderr: 'ERROR: The task XML is malformed.' } } })
    const idle = windows({ answers: { 'schtasks /Run': { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' } } })
    try {
      await expect(serviceCommand(['install'], gone.deps)).resolves.toBe(1)
      expect(gone.err).toEqual([
        '✗ Harness could not reach Task Scheduler, so it cannot start harnessd when you sign in to Windows.',
        `  schtasks /Query /TN ${taskName('demo')} could not be run: spawn schtasks ENOENT — Task Scheduler could not be asked`,
      ])
      await expect(serviceCommand(['install'], refused.deps)).resolves.toBe(1)
      expect(refused.err).toEqual([
        '✗ Task Scheduler did not accept the task that starts harnessd; nothing was changed.',
        expect.stringMatching(/^ {2}schtasks \/Create .* failed \(exit 1\): ERROR: The task XML is malformed\.$/),
      ])
      expect(existsSync(join(refused.data, 'harnessd-task.xml'))).toBe(false)
      // Over a task registered before, the five-minute task taken and the logon task refused: the one there before was
      // replaced and then removed (re-review N4), and it says so. A refused five-minute task leaves the old one.
      const over = windows({ registered: true, answers: { 'schtasks /Create /TN Harness harnessd at sign-in': { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' } } })
      const kept = windows({ registered: true, answers: { 'schtasks /Create': { status: 1, stdout: '', stderr: 'ERROR: The task XML is malformed.' } } })
      try {
        await expect(serviceCommand(['install'], kept.deps)).resolves.toBe(1)
        expect(kept.err[0]).toBe('✗ Task Scheduler did not accept the task that starts harnessd; nothing was changed.')
        await expect(serviceCommand(['install'], over.deps)).resolves.toBe(1)
        expect(over.calls).toContain(`schtasks /Delete /TN ${taskName('demo')} /F`)
        expect(over.err[0]).toBe('✗ Task Scheduler did not accept the new task that starts harnessd, and no longer has the old one: `harness start` still starts harnessd, and `harness service install` tries again.')
      } finally { for (const w of [over, kept]) rmSync(w.dir, { recursive: true, force: true }) }
      // Registered all the same: the task starts harnessd at the next sign-in, which install.ps1 reads from the code.
      await expect(serviceCommand(['install'], idle.deps)).resolves.toBe(SERVICE_REGISTERED_NOT_RUNNING)
      expect(idle.deps.service!.inspect().registered).toBe(true)
      expect(idle.err).toEqual([
        '✗ Task Scheduler has the task that starts harnessd, but would not run it now: `harness start` starts harnessd.',
        `  schtasks /Run /TN ${taskName('demo')} failed (exit 1): ERROR: Access is denied.`,
      ])
    } finally { for (const w of [gone, refused, idle]) rmSync(w.dir, { recursive: true, force: true }) }
  })

  // G4 / final review R1b-3: over SSH it waited the whole minute, then printed a ✗ for what is not a failure. It waits as
  // `harness start` does (TASK_RUN_WAIT_MS), and longer only while the task's own start holds the spawn lock.
  it('says plainly, without a ✗ and after a short wait, when the task ran but started nothing, as in a session no one signed in to', async () => {
    const w = windows({ answers: { 'schtasks /Run': { status: 0, stdout: 'SUCCESS', stderr: '' } }, startWaitMs: 60_000 })
    try {
      // Not a failure: the task is registered and starts harnessd at the next sign-in (SERVICE_REGISTERED_NOT_RUNNING).
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(SERVICE_REGISTERED_NOT_RUNNING)
      expect(SERVICE_REGISTERED_NOT_RUNNING).toBe(5)
      expect(w.clock.now).toBeLessThanOrEqual(TASK_RUN_WAIT_MS + 1_000)
      expect(w.err).toEqual([])
      expect(w.out.slice(0, 2)).toEqual([
        'Task Scheduler will start Harness when you sign in to Windows. It did not start it now: it runs the task only in a session at the Windows desktop, not over SSH.',
        '  start it now: harness start',
      ])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('waits the full time while the task\'s own start holds the spawn lock, and says when it still did not come up', async () => {
    const w = windows({ answers: { 'schtasks /Run': { status: 0, stdout: 'SUCCESS', stderr: '' } }, startWaitMs: 60_000, lockHeld: () => true })
    try {
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(SERVICE_REGISTERED_NOT_RUNNING)
      expect(w.clock.now).toBeGreaterThanOrEqual(60_000)
      expect(w.err).toEqual([
        '✗ Task Scheduler started harnessd, but it did not come up: `harness start` starts it now.',
        '  logs C:\\d\\harness.log   ·   harness service status',
      ])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('removes nothing and says so when Task Scheduler cannot be asked whether it still has the task', async () => {
    const w = windows({ registered: true, answers: { 'schtasks /Query': { status: null, stdout: '', stderr: '', error: 'spawnSync schtasks ETIMEDOUT' } } })
    try {
      w.deps.service!.write(w.deps.definition())
      await expect(serviceCommand(['uninstall'], w.deps)).resolves.toBe(1)
      expect(w.err).toEqual([
        '✗ Harness could not remove the task that starts harnessd: Task Scheduler may still start it when you sign in.',
        `  schtasks /Query /TN ${taskName('demo')} /XML could not be run: spawnSync schtasks ETIMEDOUT`,
      ])
      expect(existsSync(join(w.data, 'harnessd-task.xml'))).toBe(true)
      const bare = windows({ answers: { 'schtasks /Query': { status: null, stdout: '', stderr: '', error: 'spawnSync schtasks ETIMEDOUT' } } })
      try {
        // No file here, but Task Scheduler could not say it has no task either.
        await expect(serviceCommand(['uninstall'], bare.deps)).resolves.toBe(1)
        expect(bare.err[0]).toMatch(/^✗ Harness could not remove the task/)
      } finally { rmSync(bare.dir, { recursive: true, force: true }) }
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('says when Task Scheduler would not delete the task', async () => {
    const w = windows({ registered: true, answers: { 'schtasks /Delete': { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' } } })
    try {
      await expect(serviceCommand(['uninstall'], w.deps)).resolves.toBe(1)
      expect(w.err).toEqual([
        '✗ Harness could not remove the task that starts harnessd: Task Scheduler may still start it when you sign in.',
        `  schtasks /Delete /TN ${taskName('demo')} /F failed (exit 1): ERROR: Access is denied.`,
      ])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  // Re-review N9: `registered` means both tasks, so a five-minute task left on its own, its files gone, was "nothing to
  // remove". It is this data folder's by the log its description names, as `harness uninstall` finds it.
  it('removes a five-minute task left without its logon task and its files', async () => {
    const mine = { status: 0, stdout: '<Description>Its log: C:\\d\\harness.log</Description><Settings><Enabled>true</Enabled></Settings>', stderr: '' }
    const absent = { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }
    const w = windows({ answers: { [`schtasks /Query /TN ${logonTaskName('demo')}`]: absent, [`schtasks /Query /TN ${taskName('demo')}`]: mine } })
    try {
      await expect(serviceCommand(['uninstall'], w.deps)).resolves.toBe(0)
      expect(w.out).not.toContain('harnessd is not installed with Task Scheduler; nothing to remove.')
      expect(w.calls).toContain(`schtasks /Delete /TN ${taskName('demo')} /F`)
      expect(w.calls).not.toContain(`schtasks /Delete /TN ${logonTaskName('demo')} /F`)
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  // Re-review N8: over a five-minute task whose logon task was deleted by hand, a refused logon task removes the
  // five-minute task the install had just replaced; that is not "nothing was changed".
  it('says the old task is gone when it stood without its logon task and the new logon task is refused', async () => {
    const absent = { status: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }
    const refused = { status: 1, stdout: '', stderr: 'ERROR: Access is denied.' }
    const w = windows({ registered: true, answers: { [`schtasks /Query /TN ${logonTaskName('demo')}`]: absent, [`schtasks /Create /TN ${logonTaskName('demo')}`]: refused } })
    try {
      w.deps.service!.write(w.deps.definition())
      await expect(serviceCommand(['install'], w.deps)).resolves.toBe(1)
      expect(w.err[0]).toBe('✗ Task Scheduler did not accept the new task that starts harnessd, and no longer has the old one: `harness start` still starts harnessd, and `harness service install` tries again.')
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('says what is registered', async () => {
    const w = windows({ registered: true })
    try {
      w.deps.service!.write(w.deps.definition())
      await serviceCommand(['status'], w.deps)
      expect(w.out).toEqual(['harnessd · Task Scheduler', '  status      ● registered (enabled) · starts the daemon when you sign in to Windows, and again within 5 minutes if it stops', expect.stringMatching(/^  task        /), `  target      ${taskName('demo')}`])
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })

  it('says what is written but not registered, and what it cannot compare', async () => {
    const w = windows()
    try {
      w.deps.service!.write(w.deps.definition())
      await serviceCommand(['status'], w.deps)
      expect(w.out[1]).toBe('  status      ◍ written, not registered · `harness service install` registers it')
      const lost = windows({ answers: { whoami: { status: null, stdout: '', stderr: '', error: 'spawn whoami ENOENT' } } })
      try {
        mkdirSync(lost.data, { recursive: true })
        writeFileSync(join(lost.data, 'harnessd-task.xml'), 'an older task')
        await expect(serviceCommand(['status'], lost.deps)).resolves.toBe(0)
        expect(lost.out).toContain('  ! Harness could not check the task against this install: Harness could not tell which Windows user this is: whoami /user /fo csv /nh could not be run: spawn whoami ENOENT')
        expect(lost.out.some((line) => line.includes('is not the one this install would write'))).toBe(false)
      } finally { rmSync(lost.dir, { recursive: true, force: true }) }
    } finally { rmSync(w.dir, { recursive: true, force: true }) }
  })
})

describe('readUserEnvironment', () => {
  /** A `reg` that answers [stdout], or fails with [error]; recording what it was asked. */
  const reg = (stdout: string, error: Error | null = null) => vi.fn<RegRun>((_file, _args, _options, done) => { done(error, stdout) })

  it('reads a value from HKCU\\Environment with reg query, bounded and with no window', async () => {
    const run = reg('\r\nHKEY_CURRENT_USER\\Environment\r\n    PORT    REG_SZ    18621\r\n\r\n')
    await expect(readUserEnvironment('PORT', run)).resolves.toBe('18621')
    expect(run).toHaveBeenCalledWith('reg', ['query', 'HKCU\\Environment', '/v', 'PORT'], { timeout: USER_ENVIRONMENT_TIMEOUT_MS, windowsHide: true }, expect.any(Function))
    expect(USER_ENVIRONMENT_TIMEOUT_MS).toBe(3_000)
    // Its name in any case, as Windows reads names; an expandable string as it is written.
    await expect(readUserEnvironment('PORT', reg('    Port    REG_EXPAND_SZ    18622\n'))).resolves.toBe('18622')
  })

  it('is null for a value that is not there, a read that failed or timed out, and a reg that could not run', async () => {
    await expect(readUserEnvironment('PORT', reg('', new Error('ERROR: The system was unable to find the specified registry key or value.')))).resolves.toBeNull()
    await expect(readUserEnvironment('PORT', reg('HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\x\r\n'))).resolves.toBeNull()
    await expect(readUserEnvironment('PORT', reg('    PORT    REG_DWORD    0x4945\r\n'))).resolves.toBeNull()
    await expect(readUserEnvironment('PORT', () => { throw new Error('spawn reg ENOENT') })).resolves.toBeNull()
  })
})

describe('this computer\'s command dependencies', () => {
  it('build the definition from this install, make folders, hold the spawn lock and print to the console', async () => {
    const deps = serviceCommandDeps({ relaunch: async () => {}, tildify: (path) => path })
    expect(deps.definition().logFile).toBe(join(process.env.ADAPTER_DATA_DIR!, 'harness.log'))
    const dir = mkdtempSync(join(tmpdir(), 'service-deps-'))
    try {
      deps.ensureDir(join(dir, 'a', 'b'))
      expect(existsSync(join(dir, 'a', 'b'))).toBe(true)
      expect(deps.bundleExists(join(dir, 'a'))).toBe(true)
      expect(deps.bundleExists(join(dir, 'none'))).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
    await expect(deps.withLock('start', async () => 'held')).resolves.toBe('held')
    // A name nobody sets: null, from reg on Windows, and from a reg that is not there elsewhere.
    await expect(deps.userEnvironment!('HARNESS_SERVICE_SPEC_NEVER_SET')).resolves.toBeNull()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      deps.out('o')
      deps.err('e')
      expect(log).toHaveBeenCalledWith('o')
      expect(error).toHaveBeenCalledWith('e')
    } finally { log.mockRestore(); error.mockRestore() }
  })
})
