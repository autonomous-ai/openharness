import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformService, defaultPlatformDeps, type PlatformName } from '../harnessd/platform.js'
import { fakePlatform, type FakePlatform } from '../testing/fakePlatform.js'
import { serviceDefinition } from './platformDaemon.js'
import { SERVICE_USAGE, serviceCommand, serviceCommandDeps, type ServiceCommandDeps } from './serviceCommand.js'

/**
 * A computer in a temporary folder: a home, a data folder, an installed bundle, a pid file, and fake
 * launchctl or systemctl that run a stand-in master (pid 4242) and write its pid as the real one does.
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
  const service = new PlatformService(platform, defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home }))
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
        'harness service runs harnessd under launchd (macOS) or systemd (Linux); this computer has neither.',
        'harness service runs harnessd under launchd (macOS) or systemd (Linux); this computer has neither.',
      ])
      await expect(serviceCommand(['status', '--json'], none)).resolves.toBe(0)
      expect(c.out).toEqual(['{"supported":false}'])
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
