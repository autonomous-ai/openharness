import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import {
  OS_SYSTEMD_UNIT, OS_UNIT_FILE, PlatformService, SYSTEMD_UNIT, TASK_STOPPED_FILE, bootTimeMs, defaultPlatformDeps, logonTaskName, platformFor, taskName,
  type CommandResult, type PlatformName, type PlatformState, type ServiceDefinition,
} from '../harnessd/platform.js'
import { fakePlatform, type FakePlatform } from '../testing/fakePlatform.js'
import { HARNESSD_STATUS_FILE } from './daemonState.js'
import {
  CARRIED_ENV, TASK_RUN_WAIT_MS, clearTaskStopped, launchMaster, describeState, installedPlatform, osDaemonUnit, platformDaemonDeps, serviceDefinition,
  startThroughTask, startUnderPlatform, stopUnderPlatform, supervisingPlatform, taskStoppedThisBoot, waitForMaster, waitGone, type PlatformDaemonDeps,
} from './platformDaemon.js'
import { currentCli, harnessLaunchPath } from './windows/installLayout.js'

/** A fake clock and a pid file the fake platform writes, over fake launchctl or systemctl. */
function world(platform: PlatformName) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-daemon-'))
  const home = join(dir, 'home')
  const pidFile = join(dir, 'adapter.pid')
  const fake = fakePlatform(join(dir, 'bin'), { pidFile })
  const clock = { now: 0 }
  const dead = new Set<number>()
  // In this process (`fake.run`), as serviceCommand.spec.ts runs them: as processes they timed out under load.
  const service = new PlatformService(platform, { ...defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home }), run: fake.run })
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
    expect(supervisingPlatform('win32', {})).toBe('taskscheduler')
    expect(supervisingPlatform('freebsd', {})).toBeNull()
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
    await expect(startUnderPlatform(w.definition, { ...w.deps, service: null })).resolves.toEqual({ ok: false, detail: 'this computer has no launchd, systemd or Task Scheduler to run harnessd' })
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

describe('on Harness OS', () => {
  const there = (path: string) => path === OS_UNIT_FILE

  it('runs its daemon under the package\'s unit, for the data folder and port that unit runs', () => {
    expect(osDaemonUnit('linux', {}, there)).toBe(true)
    expect(osDaemonUnit('linux', { PORT: '18473' }, there)).toBe(true)
    expect(osDaemonUnit('linux', {}, () => false)).toBe(false)
    expect(osDaemonUnit('linux', { ADAPTER_DATA_DIR: '/tmp/test-daemon' }, there)).toBe(false)
    expect(osDaemonUnit('linux', { PORT: '18474' }, there)).toBe(false)
    expect(osDaemonUnit('linux', { HARNESSD_TEST_PLATFORM: 'systemd' }, there)).toBe(false)
    expect(osDaemonUnit('darwin', {}, there)).toBe(false)
  })

  let w: ReturnType<typeof world>
  let os: PlatformDaemonDeps
  beforeEach(() => {
    w = world('systemd')
    const base = { ...defaultPlatformDeps({ env: { PATH: w.fake.bin }, uid: 1000, home: w.home }), run: w.fake.run }
    os = { ...w.deps, service: new PlatformService('systemd', { ...base, readFile: (path) => (there(path) ? '[Service]\n' : base.readFile(path)) }, true) }
  })
  afterEach(() => rmSync(w.dir, { recursive: true, force: true }))

  it('starts through the unit and waits for its core, writing no definition of its own', async () => {
    expect(installedPlatform(os)).toBe('systemd')
    await expect(startUnderPlatform(w.definition, os, 1_000)).resolves.toEqual({ ok: true, pid: 4242, refreshed: false })
    expect(existsSync(join(w.home, '.config', 'systemd', 'user', SYSTEMD_UNIT))).toBe(false)
    expect(w.fake.calls()).toEqual([
      ['systemctl', '--user', 'reset-failed', OS_SYSTEMD_UNIT],
      ['systemctl', '--user', 'start', '--no-block', OS_SYSTEMD_UNIT],
    ])
  })

  it('stops the unit\'s own core, and leaves a daemon started beside the unit to the signals', () => {
    w.fake.set({ pid: 4242 })
    expect(stopUnderPlatform(os)).toEqual({ ok: true, stopped: 4242 })
    expect(w.fake.calls()).toContainEqual(['systemctl', '--user', 'kill', '--kill-who=main', '--signal=SIGTERM', OS_SYSTEMD_UNIT])
    // A sign-in before this fix restarted the daemon outside the unit: the unit runs nothing, and
    // `harness stop` goes on to signal the pid on file, as it stops any daemon `harness start` spawned.
    writeFileSync(w.pidFile, '2288\n')
    expect(stopUnderPlatform(os)).toEqual({ ok: true, stopped: null })
    for (const call of w.fake.calls()) expect(call.filter((word) => ['stop', 'restart'].includes(word))).toEqual([])
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
    expect(deps.service?.platform).toBe(platformFor(process.platform) ?? undefined)
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

describe('Windows', () => {
  it('runs the scheduled task\'s launcher on the build cli\\current names', () => {
    const made = serviceDefinition({ logFile: 'C:\\h\\cli\\data\\harness.log', platform: 'win32', source: {}, nodePath: 'C:\\h\\runtime\\node\\node.exe', home: 'C:\\Users\\d', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', launcherPath: 'C:\\h\\bin\\harness-launch.exe' })
    expect(made).toEqual({ nodePath: 'C:\\h\\runtime\\node\\node.exe', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', logFile: 'C:\\h\\cli\\data\\harness.log', home: 'C:\\Users\\d', env: {}, launcherPath: 'C:\\h\\bin\\harness-launch.exe' })
    expect(serviceDefinition({ logFile: '/l', platform: 'darwin', source: {}, nodePath: '/n', scriptPath: '/s', home: '/h' })).not.toHaveProperty('launcherPath')
  })

  it('finds the launcher and the build in the install root when not told them, so the task can be written at all', () => {
    // B3.12's review: without a launcher, `harness service install` on Windows threw "the launcher path for the task must be absolute".
    const root = dirname(env.ADAPTER_CLI_DIR)
    const made = serviceDefinition({ logFile: '/l', platform: 'win32', source: {}, nodePath: '/n', home: '/h' })
    expect(made.launcherPath).toBe(harnessLaunchPath(root))
    expect(made.scriptPath).toBe(currentCli(root)?.cliJs ?? join(env.ADAPTER_CLI_DIR, 'cli.js'))
    expect(serviceDefinition({ logFile: '/l', platform: 'linux', source: {}, nodePath: '/n', home: '/h' }).scriptPath).toBe(join(env.ADAPTER_CLI_DIR, 'cli.js'))
  })

  const WHOAMI: CommandResult = { status: 0, stdout: '"D\\u","S-1-5-21-1-2-3-1001"\r\n', stderr: '' }
  function taskDeps(over: { pids?: Array<number | null>; lockHeld?: boolean; run?: CommandResult; whoami?: CommandResult } = {}) {
    const pids = [...(over.pids ?? [])]
    const clock = { now: 0 }
    const calls: string[] = []
    const files: Record<string, string> = {}
    const service = new PlatformService('taskscheduler', {
      // whoami gives the SID the task's logon trigger names (harnessd/platform.ts); the calls that matter here are schtasks's.
      run: (command, args) => {
        if (command === 'whoami') return over.whoami ?? WHOAMI
        calls.push([command, ...args].join(' '))
        return over.run ?? { status: 0, stdout: '', stderr: '' }
      },
      readFile: (path) => files[path] ?? null, writeFile: (path, content) => { files[path] = content }, removeFile: (path) => { delete files[path] },
      uid: 0, home: '/h', user: 'D\\u', dataDir: '/h/data',
    })
    return {
      calls,
      clock,
      deps: {
        service, logFile: 'C:\\h\\cli\\data\\harness.log', readPid: () => (pids.length > 1 ? pids.shift()! : pids[0] ?? null), isAlive: () => true,
        masterPlatform: () => null, now: () => clock.now, sleep: async (ms: number) => { clock.now += ms }, lockHeld: () => over.lockHeld ?? false,
      },
    }
  }
  const definition = (): ServiceDefinition => ({ nodePath: 'C:\\n.exe', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', logFile: 'C:\\h\\cli\\data\\harness.log', home: 'C:\\Users\\d', env: {}, launcherPath: 'C:\\h\\bin\\harness-launch.exe' })

  it('starts the master through harness-launch.exe with none of harnessd\'s variables, and the rest of this shell\'s', async () => {
    const launches: unknown[][] = []
    const shell = { PATH: 'C:\\Windows', ADAPTER_DATA_DIR: 'C:\\h\\cli\\data', HARNESSD_SERVICE_TOKEN: 'from-an-agent-pane', HARNESSD_RESUME: '{"handover":{}}' }
    const outcome = await launchMaster(join('/h', 'cli'), shell, async (...args) => { launches.push(args); return { ok: true } })
    expect(outcome).toEqual({ ok: true })
    expect(launches).toEqual([[harnessLaunchPath('/h'), '/h', ['__harnessd'], { PATH: 'C:\\Windows', ADAPTER_DATA_DIR: 'C:\\h\\cli\\data' }]])
    // A copy: this shell keeps its own.
    expect(shell.HARNESSD_SERVICE_TOKEN).toBe('from-an-agent-pane')
    // By default, this CLI's folder and this process's environment.
    const own: unknown[][] = []
    await launchMaster(undefined, undefined, async (...args) => { own.push(args); return { ok: false, detail: 'x' } })
    expect(own[0]!.slice(0, 2)).toEqual([harnessLaunchPath(dirname(env.ADAPTER_CLI_DIR)), dirname(env.ADAPTER_CLI_DIR)])
    expect(own[0]![3]).toEqual(Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('HARNESSD_'))))
  })

  it('starts through the task and waits for the master it starts', async () => {
    const { deps, calls } = taskDeps({ pids: [null, null, 700] })
    await expect(startThroughTask(definition(), deps)).resolves.toEqual({ ok: true, pid: 700 })
    expect(calls).toEqual([
      `schtasks /Create /TN ${taskName('D\\u')} /XML /h/data/harnessd-task.xml /F`,
      `schtasks /Create /TN ${logonTaskName('D\\u')} /XML /h/data/harnessd-logon-task.xml /F`,
      `schtasks /Run /TN ${taskName('D\\u')}`,
    ])
  })

  it('says to start it directly when the task did not run (no signed-in session) or could not be run', async () => {
    const quiet = taskDeps({ pids: [null] })
    await expect(startThroughTask(definition(), quiet.deps)).resolves.toMatchObject({ ok: false, direct: true })
    expect(quiet.clock.now).toBe(TASK_RUN_WAIT_MS)
    await expect(startThroughTask(definition(), taskDeps({ run: { status: 1, stdout: '', stderr: 'ERROR: denied' } }).deps)).resolves.toMatchObject({ ok: false, direct: true })
  })

  it('starts it directly when the task cannot even be written, and runs nothing', async () => {
    const lost = taskDeps({ whoami: { status: 1, stdout: '', stderr: 'ERROR: no' } })
    await expect(startThroughTask(definition(), lost.deps)).resolves.toEqual({ ok: false, direct: true, detail: expect.stringMatching(/^Harness could not tell which Windows user this is/) })
    expect(lost.calls).toEqual([])
  })

  it('keeps waiting while the task\'s own start holds the spawn lock, and reports one that never came up', async () => {
    await expect(startThroughTask(definition(), taskDeps({ pids: [null], lockHeld: true }).deps, 1_000)).resolves.toMatchObject({ ok: false, direct: false, detail: 'harnessd did not come up within 11s' })
    const slow = taskDeps({ pids: [...Array(60).fill(null), 701], lockHeld: true })
    await expect(startThroughTask(definition(), slow.deps)).resolves.toEqual({ ok: true, pid: 701 })
  })

  it('remembers a stop for as long as this computer runs, and any other start forgets it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-stopped-'))
    try {
      expect(taskStoppedThisBoot(dir)).toBe(false)
      writeFileSync(join(dir, TASK_STOPPED_FILE), `${JSON.stringify({ boot: bootTimeMs() })}\n`)
      expect(taskStoppedThisBoot(dir)).toBe(true)
      clearTaskStopped(dir)
      expect(existsSync(join(dir, TASK_STOPPED_FILE))).toBe(false)
      expect(taskStoppedThisBoot(dir)).toBe(false)
      clearTaskStopped(dir)
      // The default is this data folder's.
      expect(taskStoppedThisBoot()).toBe(false)
      clearTaskStopped()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('names the platform as a person would', () => {
    expect(describeState({ platform: 'taskscheduler', file: 'f', target: taskName('D\\u'), installed: true, registered: false, pid: null, state: null, failed: false, lastExit: null, linger: null, unreachable: null })).toBe('not registered')
  })
})
