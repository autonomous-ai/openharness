import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { PlatformService, defaultPlatformDeps, type PlatformName, type PlatformState } from '../harnessd/platform.js'
import { fakePlatform, type FakePlatform } from '../testing/fakePlatform.js'
import { HARNESSD_STATUS_FILE } from './daemonState.js'
import {
  CARRIED_ENV, describeState, installedPlatform, platformDaemonDeps, serviceDefinition, startUnderPlatform, stopUnderPlatform,
  supervisingPlatform, waitForMaster, waitGone, type PlatformDaemonDeps,
} from './platformDaemon.js'

/** A fake clock and a pid file the fake platform writes, over fake launchctl or systemctl. */
function world(platform: PlatformName) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-daemon-'))
  const home = join(dir, 'home')
  const pidFile = join(dir, 'adapter.pid')
  const fake = fakePlatform(join(dir, 'bin'), { pidFile })
  const clock = { now: 0 }
  const dead = new Set<number>()
  const service = new PlatformService(platform, defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home }))
  const deps: PlatformDaemonDeps = {
    service,
    logFile: join(dir, 'data', 'harness.log'),
    readPid: () => { try { return Number(readFileSync(pidFile, 'utf8')) || null } catch { return null } },
    // The platform's master lives while the fake runs it; any other pid lives unless a test kills it.
    isAlive: (pid) => !dead.has(pid) && (fake.state().pid === pid || pid !== fake.state().nextPid),
    masterPlatform: () => null,
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms },
  }
  const definition = serviceDefinition({ logFile: deps.logFile, source: {}, nodePath: '/opt/node/bin/node', scriptPath: join(dir, 'cli.js'), home })
  return { dir, home, pidFile, fake, clock, dead, service, deps, definition }
}

describe('the platform that supervises harnessd', () => {
  it('is this operating system\'s, unless the end-to-end suite names another', () => {
    expect(supervisingPlatform('darwin', {})).toBe('launchd')
    expect(supervisingPlatform('linux', {})).toBe('systemd')
    expect(supervisingPlatform('win32', {})).toBeNull()
    expect(supervisingPlatform('darwin', { HARNESSD_TEST_PLATFORM: 'systemd' })).toBe('systemd')
    expect(supervisingPlatform('win32', { HARNESSD_TEST_PLATFORM: 'launchd' })).toBe('launchd')
    expect(supervisingPlatform('linux', { HARNESSD_TEST_PLATFORM: 'upstart' })).toBe('systemd')
  })
})

describe('the definition for this install', () => {
  it('carries only the settings that decide which daemon this is, and only when set', () => {
    const definition = serviceDefinition({
      logFile: '/data/harness.log', nodePath: '/n', scriptPath: '/c.js', home: '/h',
      source: { ADAPTER_DATA_DIR: '/data', PORT: '18474', ADAPTER_UPDATE_DISABLE: 'true', HARNESS_ENV_FILE: '', SECRET_TOKEN: 'x', PATH: '/bin' },
    })
    expect(definition).toEqual({ nodePath: '/n', scriptPath: '/c.js', logFile: '/data/harness.log', home: '/h', env: { ADAPTER_DATA_DIR: '/data', PORT: '18474', ADAPTER_UPDATE_DISABLE: 'true' } })
    expect(CARRIED_ENV).toContain('HARNESS_AUTH_DIR')
  })

  it('runs the managed Node and the installed bundle from this home by default', () => {
    const definition = serviceDefinition({ logFile: '/data/harness.log' })
    expect(definition.scriptPath).toBe(join(env.ADAPTER_CLI_DIR, 'cli.js'))
    expect(definition.nodePath).toBe(process.execPath) // the test runtime folder has no managed Node
    expect(definition.home).toBe(homedir())
    expect(definition.env.ADAPTER_DATA_DIR).toBe(process.env.ADAPTER_DATA_DIR)
  })
})

describe.each(['launchd', 'systemd'] as const)('under %s', (platform) => {
  let w: ReturnType<typeof world>
  beforeEach(() => { w = world(platform) })
  afterEach(() => rmSync(w.dir, { recursive: true, force: true }))

  it('counts as installed only with a definition written for this data folder', () => {
    expect(installedPlatform(w.deps)).toBeNull()
    w.service.write({ ...w.definition, logFile: '/another/data/harness.log' })
    expect(installedPlatform(w.deps)).toBeNull()
    w.service.write(w.definition)
    expect(installedPlatform(w.deps)).toBe(platform)
    expect(installedPlatform({ ...w.deps, service: null })).toBeNull()
  })

  it('starts the master through the platform, rewriting a stale definition first, and waits for it', async () => {
    await expect(startUnderPlatform(w.definition, w.deps, 1_000)).resolves.toEqual({ ok: true, pid: 4242, refreshed: true })
    expect(readFileSync(w.service.file, 'utf8')).toBe(w.service.render(w.definition))
    w.fake.set({ pid: null, nextPid: 4343 })
    rmSync(w.pidFile)
    await expect(startUnderPlatform(w.definition, w.deps, 1_000)).resolves.toEqual({ ok: true, pid: 4343, refreshed: false })
  })

  it('says why when the platform will not start it, or it does not come up', async () => {
    await expect(startUnderPlatform(w.definition, { ...w.deps, service: null })).resolves.toEqual({ ok: false, detail: 'neither launchd nor systemd runs harnessd on this computer' })
    w.fake.set({ fail: { [platform === 'launchd' ? 'launchctl bootstrap' : 'systemctl start']: { status: 5, stderr: 'refused' } } })
    await expect(startUnderPlatform(w.definition, w.deps, 1_000)).resolves.toEqual({ ok: false, detail: expect.stringContaining('refused') })
    w.fake.set({ fail: {}, pidFile: null })
    const late = await startUnderPlatform(w.definition, w.deps, 1_000)
    expect(late).toEqual({ ok: false, detail: expect.stringMatching(new RegExp(`^${platform} did not bring harnessd up within 1s \\(.*pid 4242\\)$`)) })
  })

  it('stops the master through the platform when its definition is this folder\'s, or the master says the platform runs it', () => {
    expect(stopUnderPlatform({ ...w.deps, service: null })).toBeNull()
    expect(stopUnderPlatform(w.deps)).toBeNull()
    expect(w.fake.calls()).toEqual([])
    w.service.write(w.definition)
    w.service.register()
    expect(stopUnderPlatform(w.deps)).toEqual({ ok: true, stopped: 4242 })
    expect(w.fake.state().pid).toBeNull()
    // Its file removed by hand, the job still loaded: the master's status file is what says so.
    w.service.start(false)
    rmSync(w.service.file)
    expect(stopUnderPlatform({ ...w.deps, masterPlatform: () => (platform === 'launchd' ? 'systemd' : 'launchd') })).toBeNull()
    expect(stopUnderPlatform({ ...w.deps, masterPlatform: () => platform })).toEqual({ ok: true, stopped: 4242 })
    expect(stopUnderPlatform({ ...w.deps, masterPlatform: () => platform })).toBeNull()
    // Installed, and asked with nothing running: the platform ran no master to wait on.
    w.service.write(w.definition)
    expect(stopUnderPlatform(w.deps)).toEqual({ ok: true, stopped: null })
    w.fake.set(platform === 'launchd' ? { fail: { 'launchctl print': { status: 1, stderr: 'no' } } } : { pid: 4242, fail: { 'systemctl kill': { status: 1, stderr: 'no' } } })
    expect(stopUnderPlatform(w.deps)).toEqual(platform === 'launchd' ? { ok: true, stopped: null } : { ok: false, detail: expect.stringContaining('no') })
  })
})

describe('waiting', () => {
  const clocked = (alive: (pid: number, now: number) => boolean, pid: () => number | null = () => 7) => {
    const clock = { now: 0 }
    return { clock, deps: { readPid: pid, isAlive: (p: number) => alive(p, clock.now), now: () => clock.now, sleep: async (ms: number) => { clock.now += ms } } }
  }

  it('for the master to claim the pid file, until the deadline', async () => {
    let at = 0
    const { deps } = clocked((_, now) => now >= 500, () => (at++ > 0 ? 7 : null))
    await expect(waitForMaster(deps, 1_000)).resolves.toBe(7)
    const { deps: never } = clocked(() => false)
    await expect(waitForMaster(never, 1_000)).resolves.toBeNull()
  })

  it('for a master to go, until the deadline', async () => {
    const { deps } = clocked((_, now) => now < 300)
    await expect(waitGone(deps, 7, 1_000)).resolves.toBe(true)
    const { deps: stubborn } = clocked(() => true)
    await expect(waitGone(stubborn, 7, 1_000)).resolves.toBe(false)
  })
})

describe('describing what the platform says', () => {
  const state = (over: Partial<PlatformState>): PlatformState => ({
    platform: 'launchd', file: '/f', target: 't', installed: true, registered: true, pid: null, state: null, failed: false,
    lastExit: null, linger: null, unreachable: null, ...over,
  })

  it('in one line', () => {
    expect(describeState(state({ unreachable: 'launchctl print failed' }))).toBe('could not ask launchd: launchctl print failed')
    expect(describeState(state({ registered: false }))).toBe('not loaded')
    expect(describeState(state({ platform: 'systemd', registered: false }))).toBe('not enabled')
    expect(describeState(state({ platform: 'systemd', registered: false, state: 'active (running)', pid: 4 }))).toBe('not enabled · active (running) · pid 4')
    expect(describeState(state({ state: 'running', pid: 9, lastExit: '(never exited)' }))).toBe('running · pid 9')
    expect(describeState(state({ state: 'not running', lastExit: '1' }))).toBe('not running · last exit 1')
    expect(describeState(state({}))).toBe('registered')
  })
})

describe('this computer\'s dependencies', () => {
  it('read which platform runs the master from the status file it wrote', async () => {
    const deps = platformDaemonDeps()
    expect(deps.service?.platform).toBe(process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd' : undefined)
    expect(deps.logFile).toBe(join(process.env.ADAPTER_DATA_DIR!, 'harness.log'))
    writeFileSync(HARNESSD_STATUS_FILE, JSON.stringify({ state: 'running', masterPid: 77, platform: 'systemd' }))
    try {
      expect(deps.masterPlatform(77)).toBe('systemd')
      expect(deps.masterPlatform(78)).toBeNull()
      writeFileSync(HARNESSD_STATUS_FILE, JSON.stringify({ state: 'running', masterPid: 77 }))
      expect(deps.masterPlatform(77)).toBeNull()
    } finally { rmSync(HARNESSD_STATUS_FILE, { force: true }) }
    expect(deps.readPid()).toBeNull()
    expect(deps.isAlive(process.pid)).toBe(true)
    const before = deps.now()
    await deps.sleep(5)
    expect(deps.now()).toBeGreaterThanOrEqual(before)
    expect(platformDaemonDeps({ logFile: '/x.log' }).logFile).toBe('/x.log')
  })
})
