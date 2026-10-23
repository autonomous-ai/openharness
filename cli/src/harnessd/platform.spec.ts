import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, uptime, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakePlatform, type FakePlatform } from '../testing/fakePlatform.js'
import {
  COMMAND_TIMEOUT_MS, LAUNCHD_LABEL, OS_SYSTEMD_UNIT, OS_UNIT_FILE, PLATFORM_ENV, PLATFORM_LABEL, PlatformService, RESTART_THROTTLE_S, STOP_TIMEOUT_S, SYSTEMD_UNIT,
  TASK_REPEAT, WHOAMI_ARGS, currentUid, defaultPlatformDeps, launchdPlist, logonTaskName, platformFor, platformFromEnv, stoppedThisBoot, systemdUnit, taskName, taskSchedulerXml, whoamiSid,
  type CommandResult, type PlatformDeps, type ServiceDefinition,
} from './platform.js'

const definition = (over: Partial<ServiceDefinition> = {}): ServiceDefinition => ({
  nodePath: '/Users/demo/.harness/runtime/node-v22.12.0-darwin-arm64/bin/node',
  scriptPath: '/Users/demo/.harness/cli/cli.js',
  logFile: '/Users/demo/.harness/cli/data/harness.log',
  home: '/Users/demo',
  env: {},
  ...over,
})

/** An in-memory PlatformDeps whose commands answer from a table, for what the fakes do not say. */
function stubDeps(answers: Record<string, CommandResult>, files: Record<string, string> = {}, over: Partial<PlatformDeps> = {}) {
  const calls: string[] = []
  /** The encoding each file was asked to be written in, where one was. */
  const encodings: Record<string, string> = {}
  const deps: PlatformDeps = {
    run: (command, args) => {
      const call = [command, ...args].join(' ')
      calls.push(call)
      const key = Object.keys(answers).find((prefix) => call.startsWith(prefix))
      return key ? answers[key] : { status: 0, stdout: '', stderr: '' }
    },
    readFile: (path) => files[path] ?? null,
    writeFile: (path, content, encoding) => {
      files[path] = content
      if (encoding) encodings[path] = encoding
    },
    removeFile: (path) => { delete files[path] },
    uid: 501,
    home: '/Users/demo',
    ...over,
  }
  return { deps, calls, files, encodings }
}

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' })
const fail = (status: number | null, stderr = '', stdout = ''): CommandResult => ({ status, stdout, stderr })

describe('which platform', () => {
  it('is launchd on macOS, systemd on Linux, Task Scheduler on Windows, and none elsewhere', () => {
    expect(platformFor('darwin')).toBe('launchd')
    expect(platformFor('linux')).toBe('systemd')
    expect(platformFor('win32')).toBe('taskscheduler')
    expect(platformFor('freebsd')).toBeNull()
  })

  it('runs the master only when its definition says so', () => {
    expect(platformFromEnv({ [PLATFORM_ENV]: 'launchd' })).toBe('launchd')
    expect(platformFromEnv({ [PLATFORM_ENV]: 'systemd' })).toBe('systemd')
    expect(platformFromEnv({ [PLATFORM_ENV]: 'cron' })).toBeNull()
    expect(platformFromEnv({})).toBeNull()
  })

  it('knows this process\'s user, and copes without one', () => {
    expect(currentUid({ getuid: () => 501 })).toBe(501)
    expect(currentUid({})).toBe(0)
    expect(currentUid()).toBe(process.getuid!())
  })
})

describe('the launchd agent', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-plist-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs the master in the foreground, keeps it alive after a crash, logs to the daemon log and lets tmux outlive it', () => {
    const plist = launchdPlist(definition({ env: { ADAPTER_DATA_DIR: '/Users/demo/data' } }))
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(plist).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/demo\/\.harness\/runtime\/node-v22\.12\.0-darwin-arm64\/bin\/node<\/string>\s*<string>\/Users\/demo\/\.harness\/cli\/cli\.js<\/string>\s*<string>__harnessd<\/string>\s*<\/array>/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<key>Crashed<\/key>\s*<true\/>\s*<\/dict>/)
    expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/)
    expect(plist).toMatch(new RegExp(`<key>ThrottleInterval</key>\\s*<integer>${RESTART_THROTTLE_S}</integer>`))
    expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/Users\/demo\/\.harness\/cli\/data\/harness\.log<\/string>\s*<key>StandardErrorPath<\/key>\s*<string>\/Users\/demo\/\.harness\/cli\/data\/harness\.log<\/string>/)
    expect(plist).toMatch(/<key>HARNESSD_PLATFORM<\/key>\s*<string>launchd<\/string>/)
    expect(plist).toMatch(/<key>ADAPTER_DATA_DIR<\/key>\s*<string>\/Users\/demo\/data<\/string>/)
  })

  it('escapes what XML would misread', () => {
    const plist = launchdPlist(definition({ home: '/Users/d&<m>"o\'', env: { WEIRD: '<&>' } }))
    expect(plist).toContain('<string>/Users/d&amp;&lt;m&gt;&quot;o&apos;</string>')
    expect(plist).toContain('<string>&lt;&amp;&gt;</string>')
  })

  // plutil reads it exactly as launchd will: the dictionary below is what launchd is given.
  it.skipIf(!existsSync('/usr/bin/plutil'))('is a property list plutil accepts, holding exactly what it means to', () => {
    const file = join(dir, `${LAUNCHD_LABEL}.plist`)
    writeFileSync(file, launchdPlist(definition({ home: '/Users/d&mo', env: { PORT: '18474' } })))
    const lint = spawnSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })
    expect(lint.status, lint.stdout + lint.stderr).toBe(0)
    const parsed = JSON.parse(spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }).stdout)
    expect(parsed).toEqual({
      Label: LAUNCHD_LABEL,
      ProgramArguments: [definition().nodePath, definition().scriptPath, '__harnessd'],
      EnvironmentVariables: { PORT: '18474', HARNESSD_PLATFORM: 'launchd' },
      WorkingDirectory: '/Users/d&mo',
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false, Crashed: true },
      ThrottleInterval: RESTART_THROTTLE_S,
      ExitTimeOut: STOP_TIMEOUT_S,
      AbandonProcessGroup: true,
      ProcessType: 'Interactive',
      StandardOutPath: definition().logFile,
      StandardErrorPath: definition().logFile,
    })
  })

  it('refuses a relative path, a path across lines, and a variable it cannot carry', () => {
    expect(() => launchdPlist(definition({ nodePath: 'node' }))).toThrow(/node path/)
    expect(() => launchdPlist(definition({ logFile: '/tmp/a\nb.log' }))).toThrow(/log path/)
    expect(() => launchdPlist(definition({ env: { 'NOT A NAME': '1' } }))).toThrow(/cannot carry/)
    expect(() => systemdUnit(definition({ env: { OK: 'two\nlines' } }))).toThrow(/cannot carry/)
  })
})

describe('the systemd unit', () => {
  it('runs the master in the foreground, restarts it on failure, logs to the daemon log and stops only the master', () => {
    const unit = systemdUnit(definition({ nodePath: '/home/demo/.harness/runtime/node/bin/node', scriptPath: '/home/demo/.harness/cli/cli.js', logFile: '/home/demo/.harness/cli/data/harness.log', home: '/home/demo' }))
    const lines = unit.split('\n')
    expect(lines).toContain('ExecStart="/home/demo/.harness/runtime/node/bin/node" "/home/demo/.harness/cli/cli.js" "__harnessd"')
    expect(lines).toContain('Environment="HARNESSD_PLATFORM=systemd"')
    expect(lines).toContain('Restart=on-failure')
    expect(lines).toContain('KillMode=process')
    expect(lines).toContain(`TimeoutStopSec=${STOP_TIMEOUT_S}`)
    expect(lines).toContain('StandardOutput=append:/home/demo/.harness/cli/data/harness.log')
    expect(lines).toContain('StandardError=append:/home/demo/.harness/cli/data/harness.log')
    expect(lines).toContain('WorkingDirectory=/home/demo')
    expect(lines).toContain('WantedBy=default.target')
    expect(lines.indexOf('[Unit]')).toBeLessThan(lines.indexOf('[Service]'))
    expect(lines.indexOf('[Service]')).toBeLessThan(lines.indexOf('[Install]'))
    // Every setting line belongs to a section and is a key=value pair; the rest are comments.
    for (const line of lines.filter((line) => line && !line.startsWith('#') && !line.startsWith('['))) expect(line).toMatch(/^[A-Za-z]+=/)
  })

  it('escapes systemd\'s specifiers, its variables and its quotes', () => {
    const unit = systemdUnit(definition({ nodePath: '/opt/my node/100%/$HOME/"q"\\b/node', scriptPath: '/opt/$cli/cli.js', home: '/home/50%', logFile: '/logs/50%.log', env: { A: 'x"y%z$w\\v' } }))
    // The program is substituted for no variable, so its `$` stays single; an argument's is doubled.
    expect(unit).toContain('ExecStart="/opt/my node/100%%/$HOME/\\"q\\"\\\\b/node" "/opt/$$cli/cli.js" "__harnessd"')
    expect(unit).toContain('Environment="A=x\\"y%%z$w\\\\v"')
    expect(unit).toContain('WorkingDirectory=/home/50%%')
    expect(unit).toContain('StandardOutput=append:/logs/50%%.log')
  })

  const analyze = ['/usr/bin/systemd-analyze', '/bin/systemd-analyze'].find((path) => existsSync(path))
  it.skipIf(!analyze)('passes systemd-analyze verify', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessd-unit-'))
    try {
      const script = join(dir, 'cli.js')
      writeFileSync(script, '')
      const unit = join(dir, SYSTEMD_UNIT)
      writeFileSync(unit, systemdUnit(definition({ nodePath: process.execPath, scriptPath: script, logFile: join(dir, 'harness.log'), home: dir })))
      const verify = spawnSync(analyze!, ['verify', unit], { encoding: 'utf8' })
      expect(verify.status, verify.stdout + verify.stderr).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// Each command the code under test runs here is a fake launchctl, systemctl or loginctl: a Node process
// (../testing/fakePlatform.ts) that starts in about 50 ms on a quiet machine and takes over half a
// second at a load of 50 to 60. A test runs up to 22 of them in a row, past vitest's 5 s for a test.
const FAKE_COMMANDS_TIMEOUT_MS = 60_000

describe('the default dependencies', { timeout: FAKE_COMMANDS_TIMEOUT_MS }, () => {
  let dir: string
  let fake: FakePlatform
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnessd-deps-'))
    fake = fakePlatform(join(dir, 'bin'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('run commands from the PATH they are given, and say when one is not there', () => {
    const deps = defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home: join(dir, 'home') })
    expect(deps.run('loginctl', ['show-user', '501', '--property=Linger'])).toEqual({ status: 0, stdout: 'Linger=yes\n', stderr: '' })
    expect(fake.calls()).toEqual([['loginctl', 'show-user', '501', '--property=Linger']])
    const missing = deps.run('plutil', ['-lint', 'x'])
    expect(missing.status).toBeNull()
    expect(missing.stdout).toBe('')
    expect(missing.error).toMatch(/ENOENT/)
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(STOP_TIMEOUT_S * 1000)
  })

  it('write whole, into a folder they make, readable by launchd and by nobody else to write', () => {
    const deps = defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home: join(dir, 'home') })
    const file = join(dir, 'home', 'Library', 'LaunchAgents', 'x.plist')
    expect(deps.readFile(file)).toBeNull()
    deps.writeFile(file, 'one')
    deps.writeFile(file, 'two')
    expect(deps.readFile(file)).toBe('two')
    expect(statSync(file).mode & 0o022).toBe(0)
    deps.removeFile(file)
    deps.removeFile(file)
    expect(existsSync(file)).toBe(false)
  })

  it('write UTF-16 with its byte order mark when asked, as schtasks takes a task, and read either back as text', () => {
    const deps = defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home: join(dir, 'home') })
    const file = join(dir, 'home', 'data', 'task.xml')
    deps.writeFile(file, '<Task>Nguy\u1ec5n</Task>', 'utf16le')
    expect(readFileSync(file)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<Task>Nguy\u1ec5n</Task>', 'utf16le')]))
    expect(deps.readFile(file)).toBe('<Task>Nguy\u1ec5n</Task>')
    deps.writeFile(file, 'plain \u00e9')
    expect(readFileSync(file, 'utf8')).toBe('plain \u00e9')
    expect(deps.readFile(file)).toBe('plain \u00e9')
  })

  it('take this process\'s user, home and environment unless told otherwise, and an absolute XDG_CONFIG_HOME only', () => {
    const own = defaultPlatformDeps()
    expect(own.uid).toBe(process.getuid!())
    expect(own.home).toBe(homedir())
    expect(defaultPlatformDeps({ env: { XDG_CONFIG_HOME: '/x/config' }, uid: 1, home: '/h' }).configHome).toBe('/x/config')
    expect(defaultPlatformDeps({ env: { XDG_CONFIG_HOME: 'relative' }, uid: 1, home: '/h' }).configHome).toBeUndefined()
    expect(defaultPlatformDeps({ env: {}, uid: 1, home: '/h' }).configHome).toBeUndefined()
    // The bare name, whatever USERDOMAIN says: OpenSSH sets it to WORKGROUP, and `WORKGROUP\admin` is no account.
    const windows = defaultPlatformDeps({ env: { USERDOMAIN: 'WORKGROUP', USERNAME: 'Demo' }, home: '/h', dataDir: '/h/data' })
    expect(windows.user).toBe('Demo')
    expect(windows.dataDir).toBe('/h/data')
    expect(defaultPlatformDeps({ env: { USERNAME: 'Demo' } }).user).toBe('Demo')
    expect(defaultPlatformDeps({ env: {} }).user).toBeUndefined()
    expect(Math.abs(windows.bootTime!() - (Date.now() - uptime() * 1000))).toBeLessThan(2_000)
  })
})

describe('PlatformService over fake launchctl', { timeout: FAKE_COMMANDS_TIMEOUT_MS }, () => {
  let dir: string
  let home: string
  let fake: FakePlatform
  let service: PlatformService
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnessd-launchd-'))
    home = join(dir, 'home')
    fake = fakePlatform(join(dir, 'bin'))
    service = new PlatformService('launchd', defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 501, home }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const verbs = () => fake.calls().map((call) => call.slice(0, 2).join(' '))

  it('lives in ~/Library/LaunchAgents under its label, in the user\'s GUI domain', () => {
    expect(service.file).toBe(join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`))
    expect(service.target).toBe(`gui/501/${LAUNCHD_LABEL}`)
  })

  it('writes its definition once, knows it as this data folder\'s, and rewrites it only when it changes', () => {
    const def = definition({ home })
    expect(service.installed()).toBe(false)
    expect(service.ownedBy(def.logFile)).toBe(false)
    expect(service.write(def)).toBe(true)
    expect(service.write(def)).toBe(false)
    expect(service.installed()).toBe(true)
    expect(service.current(def)).toBe(true)
    expect(service.ownedBy(def.logFile)).toBe(true)
    expect(service.ownedBy('/elsewhere/harness.log')).toBe(false)
    expect(service.current({ ...def, nodePath: '/other/node' })).toBe(false)
    expect(service.write({ ...def, nodePath: '/other/node' })).toBe(true)
    expect(readFileSync(service.file, 'utf8')).toContain('<string>/other/node</string>')
  })

  it('registers, starts, stops and unregisters through bootstrap, kickstart and bootout', () => {
    const def = definition({ home })
    expect(service.preflight()).toEqual({ ok: true })
    expect(service.inspect()).toMatchObject({ registered: false, pid: null, installed: false, unreachable: null })
    service.write(def)
    expect(service.register()).toEqual({ ok: true })
    expect(service.inspect()).toMatchObject({ installed: true, registered: true, pid: 4242, state: 'running', lastExit: '(never exited)', failed: false, linger: null })
    expect(service.stop()).toEqual({ ok: true })
    expect(service.inspect()).toMatchObject({ registered: false, pid: null })
    expect(service.stop()).toEqual({ ok: true }) // nothing loaded: nothing to boot out
    expect(service.start(false)).toEqual({ ok: true }) // not loaded: loaded again, which starts it
    fake.set({ pid: null, nextPid: 4343 })
    expect(service.inspect()).toMatchObject({ registered: true, pid: null, state: 'not running', lastExit: '1' })
    expect(service.start(false)).toEqual({ ok: true }) // loaded: kickstarted
    expect(service.inspect().pid).toBe(4343)
    expect(service.start(true)).toEqual({ ok: true }) // rewritten: booted out and loaded from the new file
    expect(service.unregister()).toEqual({ ok: true })
    expect(existsSync(service.file)).toBe(false)
    expect(verbs()).toEqual([
      'launchctl print', 'launchctl print', 'launchctl enable', 'launchctl bootstrap', 'launchctl print',
      'launchctl print', 'launchctl bootout', 'launchctl print', 'launchctl print',
      'launchctl print', 'launchctl bootstrap', 'launchctl print',
      'launchctl print', 'launchctl kickstart', 'launchctl print',
      'launchctl print', 'launchctl bootout', 'launchctl bootstrap',
      'launchctl print', 'launchctl bootout',
    ])
    expect(fake.calls()).toContainEqual(['launchctl', 'bootstrap', 'gui/501', service.file])
    expect(fake.calls()).toContainEqual(['launchctl', 'enable', `gui/501/${LAUNCHD_LABEL}`])
  })

  it('says why when launchd will not take it', () => {
    fake.set({ guiDomain: false })
    expect(service.preflight()).toEqual({ ok: false, detail: expect.stringMatching(/^launchctl print gui\/501 failed \(exit 113\): Could not find domain.* logged in at the screen$/) })
    service.write(definition({ home }))
    expect(service.register()).toEqual({ ok: false, detail: expect.stringContaining('Bootstrap failed: 125') })
    fake.set({ guiDomain: true, fail: { 'launchctl enable': { status: 1, stderr: 'not permitted' } } })
    expect(service.register()).toEqual({ ok: false, detail: 'launchctl enable gui/501/ai.autonomous.harness.harnessd failed (exit 1): not permitted' })
    fake.set({ fail: { 'launchctl bootout': { status: 5, stderr: 'Boot-out failed: 5: Input/output error' } }, loaded: true })
    expect(service.start(true)).toEqual({ ok: false, detail: expect.stringContaining('Boot-out failed: 5') })
    expect(service.unregister()).toEqual({ ok: false, detail: expect.stringContaining('Boot-out failed: 5') })
    expect(existsSync(service.file)).toBe(true)
  })

  it('reports launchd unreachable when launchctl cannot be run at all', () => {
    const lost = new PlatformService('launchd', defaultPlatformDeps({ env: { PATH: join(dir, 'empty') }, uid: 501, home }))
    expect(lost.inspect()).toMatchObject({ registered: false, unreachable: expect.stringMatching(/^launchctl print gui\/501\/ai\.autonomous\.harness\.harnessd could not be run: .*ENOENT/) })
    expect(lost.start(false)).toEqual({ ok: false, detail: expect.stringContaining('could not be run') })
  })
})

describe('PlatformService over fake systemctl', { timeout: FAKE_COMMANDS_TIMEOUT_MS }, () => {
  let dir: string
  let home: string
  let fake: FakePlatform
  let service: PlatformService
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnessd-systemd-'))
    home = join(dir, 'home')
    fake = fakePlatform(join(dir, 'bin'))
    service = new PlatformService('systemd', defaultPlatformDeps({ env: { PATH: fake.bin }, uid: 1000, home }))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const verbs = () => fake.calls().map((call) => (call[0] === 'systemctl' ? [call[0], call[2]] : call.slice(0, 2)).join(' '))

  it('lives in ~/.config/systemd/user, or under XDG_CONFIG_HOME', () => {
    expect(service.file).toBe(join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT))
    expect(service.target).toBe(SYSTEMD_UNIT)
    const xdg = new PlatformService('systemd', defaultPlatformDeps({ env: { PATH: fake.bin, XDG_CONFIG_HOME: join(dir, 'xdg') }, uid: 1000, home }))
    expect(xdg.file).toBe(join(dir, 'xdg', 'systemd', 'user', SYSTEMD_UNIT))
  })

  it('knows a unit as this data folder\'s by its log', () => {
    const def = definition({ home })
    service.write(def)
    expect(service.ownedBy(def.logFile)).toBe(true)
    expect(service.ownedBy('/elsewhere/harness.log')).toBe(false)
  })

  it('registers with enable --now, starts, and stops and unregisters without a stop job', () => {
    const def = definition({ home })
    expect(service.preflight()).toEqual({ ok: true })
    expect(service.inspect()).toMatchObject({ registered: false, pid: null, state: 'inactive (dead)', failed: false, lastExit: null, linger: true })
    service.write(def)
    expect(service.register()).toEqual({ ok: true })
    expect(service.inspect()).toMatchObject({ installed: true, registered: true, pid: 4242, state: 'active (running)' })
    expect(service.stop()).toEqual({ ok: true })
    expect(service.inspect()).toMatchObject({ registered: true, pid: null })
    expect(service.start(false)).toEqual({ ok: true })
    expect(service.start(true)).toEqual({ ok: true })
    fake.set({ failed: true, pid: null, linger: 'no' })
    expect(service.inspect()).toMatchObject({ failed: true, state: 'failed (failed)', lastExit: 'start-limit-hit', linger: false })
    expect(service.unregister()).toEqual({ ok: true })
    expect(existsSync(service.file)).toBe(false)
    expect(verbs()).toEqual([
      'systemctl daemon-reload', 'systemctl show', 'loginctl show-user',
      'systemctl daemon-reload', 'systemctl enable', 'systemctl show', 'loginctl show-user',
      'systemctl show', 'systemctl kill', 'systemctl show', 'loginctl show-user',
      'systemctl reset-failed', 'systemctl start',
      'systemctl daemon-reload', 'systemctl reset-failed', 'systemctl start',
      'systemctl show', 'loginctl show-user',
      'systemctl disable', 'systemctl show', 'systemctl daemon-reload', 'systemctl reset-failed',
    ])
    expect(fake.calls()).toContainEqual(['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT])
    expect(fake.calls()).toContainEqual(['systemctl', '--user', 'kill', '--kill-who=main', '--signal=SIGTERM', SYSTEMD_UNIT])
    expect(fake.calls()).toContainEqual(['systemctl', '--user', 'disable', SYSTEMD_UNIT])
    // A stop job would be passed to every pane scope PartOf this unit: none is ever sent.
    for (const call of fake.calls()) expect(call.filter((word) => ['stop', 'restart', '--now'].includes(word) && call[2] !== 'enable')).toEqual([])
  })

  it('stops a unit whose file is already gone, and says why when systemd will not take it', () => {
    expect(service.unregister()).toEqual({ ok: true })
    expect(fake.calls()[0]).toEqual(['systemctl', '--user', 'show', SYSTEMD_UNIT, '--property=MainPID'])
    fake.set({ pid: 4242 })
    expect(service.unregister()).toEqual({ ok: true })
    expect(fake.calls()).toContainEqual(['systemctl', '--user', 'kill', '--kill-who=main', '--signal=SIGTERM', SYSTEMD_UNIT])
    fake.set({ pid: 4242, fail: { 'systemctl kill': { status: 1, stderr: 'Access denied' } } })
    expect(service.unregister()).toEqual({ ok: false, detail: expect.stringContaining('Access denied') })
    fake.set({ pid: null, fail: {} })
    fake.set({ fail: { 'systemctl daemon-reload': { status: 1, stderr: 'Failed to connect to bus: No medium found' } } })
    expect(service.preflight()).toEqual({ ok: false, detail: 'systemctl --user daemon-reload failed (exit 1): Failed to connect to bus: No medium found' })
    expect(service.register()).toMatchObject({ ok: false })
    expect(service.start(true)).toMatchObject({ ok: false })
    service.write(definition({ home }))
    fake.set({ fail: { 'systemctl disable': { status: 1, stderr: 'Access denied' } } })
    expect(service.unregister()).toEqual({ ok: false, detail: expect.stringContaining('Access denied') })
    expect(existsSync(service.file)).toBe(true)
    fake.set({ fail: { 'systemctl show': { status: 1, stderr: 'Failed to connect to bus' } }, linger: null })
    expect(service.inspect()).toMatchObject({ registered: false, linger: null, unreachable: expect.stringContaining('Failed to connect to bus') })
  })
})

describe('Harness OS\'s own unit', () => {
  const unitFile = { [OS_UNIT_FILE]: '[Service]\nExecStart=/usr/bin/harness start --foreground\n' }

  it('is the package\'s harness-daemon.service, and only under systemd', () => {
    const { deps } = stubDeps({}, { ...unitFile })
    const service = new PlatformService('systemd', deps, true)
    expect(service.file).toBe(OS_UNIT_FILE)
    expect(service.target).toBe(OS_SYSTEMD_UNIT)
    expect(() => new PlatformService('launchd', deps, true)).toThrow('Harness OS runs harnessd under systemd')
  })

  it('is never written, registered or removed from here, and counts as this daemon\'s while it is on disk', () => {
    const { deps, calls, files } = stubDeps({}, { ...unitFile })
    const service = new PlatformService('systemd', deps, true)
    expect(service.write(definition())).toBe(false)
    expect(service.current(definition())).toBe(true)
    expect(service.ownedBy('/anything/harness.log')).toBe(true)
    expect(service.register()).toEqual({ ok: false, detail: `Harness OS runs harnessd under ${OS_SYSTEMD_UNIT}` })
    expect(service.unregister()).toEqual({ ok: false, detail: `Harness OS runs harnessd under ${OS_SYSTEMD_UNIT}` })
    service.discard()
    expect(files).toEqual(unitFile)
    expect(calls).toEqual([])
    expect(new PlatformService('systemd', stubDeps({}).deps, true).ownedBy('/anything/harness.log')).toBe(false)
  })

  it('starts the unit without waiting on its readiness check, and stops its main process with a signal, never a stop job', () => {
    const { deps, calls } = stubDeps({ 'systemctl --user show harness-daemon.service --property=MainPID': ok('MainPID=1347\n') }, { ...unitFile })
    const service = new PlatformService('systemd', deps, true)
    expect(service.start(false)).toEqual({ ok: true })
    expect(service.stop()).toEqual({ ok: true })
    expect(calls).toEqual([
      `systemctl --user reset-failed ${OS_SYSTEMD_UNIT}`,
      `systemctl --user start --no-block ${OS_SYSTEMD_UNIT}`,
      `systemctl --user show ${OS_SYSTEMD_UNIT} --property=MainPID`,
      `systemctl --user kill --kill-who=main --signal=SIGTERM ${OS_SYSTEMD_UNIT}`,
    ])
  })

  it('counts as registered once systemd has loaded it: the OS pulls it in with the screen rather than enabling it', () => {
    const { deps } = stubDeps({ 'systemctl --user show': ok('LoadState=loaded\nUnitFileState=disabled\nActiveState=active\nSubState=running\nMainPID=1347\nResult=success\n') }, { ...unitFile })
    expect(new PlatformService('systemd', deps, true).inspect()).toMatchObject({ installed: true, registered: true, pid: 1347, state: 'active (running)', target: OS_SYSTEMD_UNIT })
    const { deps: gone } = stubDeps({ 'systemctl --user show': ok('LoadState=not-found\nActiveState=inactive\nMainPID=0\n') })
    expect(new PlatformService('systemd', gone, true).inspect()).toMatchObject({ installed: false, registered: false, pid: null })
  })
})

describe('discarding a definition that could not be registered', () => {
  it('removes the file alone, and has systemd forget it', () => {
    for (const platform of ['launchd', 'systemd'] as const) {
      const { deps, calls, files } = stubDeps({})
      const service = new PlatformService(platform, deps)
      service.write(definition())
      service.discard()
      expect(files).toEqual({})
      expect(calls).toEqual(platform === 'systemd' ? ['systemctl --user daemon-reload'] : [])
    }
  })
})

describe('reading what the platform says', () => {
  it('takes launchd\'s listing as it comes: no state, no pid, no last exit', () => {
    const { deps } = stubDeps({ 'launchctl print': ok('gui/501/x = {\n\tactive count = 0\n}\n') })
    expect(new PlatformService('launchd', deps).inspect()).toMatchObject({ registered: true, pid: null, state: null, lastExit: null })
  })

  it('takes systemctl show as it comes: no active state, no sub-state, odd lines, an unknown linger', () => {
    const { deps } = stubDeps({
      'systemctl --user show': ok('=orphan\nnot a property\nUnitFileState=disabled\nMainPID=0\n'),
      'loginctl': ok('Linger=maybe\n'),
    })
    expect(new PlatformService('systemd', deps).inspect()).toMatchObject({ registered: false, pid: null, state: null, lastExit: null, linger: null })
    const { deps: active } = stubDeps({ 'systemctl --user show': ok('ActiveState=active\nResult=\n') })
    expect(new PlatformService('systemd', active).inspect()).toMatchObject({ state: 'active', lastExit: null })
  })

  it('says how a command failed: killed with no status, silent, or speaking only on stdout', () => {
    const { deps } = stubDeps({ 'launchctl kickstart': fail(null), 'launchctl print gui/501/': ok('state = running\n'), 'launchctl bootstrap': fail(5, '', 'on stdout\nmore') })
    const service = new PlatformService('launchd', deps)
    expect(service.start(false)).toEqual({ ok: false, detail: 'launchctl kickstart gui/501/ai.autonomous.harness.harnessd failed (exit none)' })
    const { deps: unloaded } = stubDeps({ 'launchctl print': fail(113), 'launchctl bootstrap': fail(5, '', 'on stdout\nmore') })
    expect(new PlatformService('launchd', unloaded).start(false)).toEqual({ ok: false, detail: 'launchctl bootstrap gui/501 /Users/demo/Library/LaunchAgents/ai.autonomous.harness.harnessd.plist failed (exit 5): on stdout' })
  })
})

const task = {
  launcherPath: 'C:\\Users\\Demo User\\.harness\\bin\\harness-launch.exe',
  root: 'C:\\Users\\Demo User\\.harness',
  home: 'C:\\Users\\Demo User',
  logFile: 'C:\\Users\\Demo User\\.harness\\cli\\data\\harness.log',
  sid: 'S-1-5-21-1000000001-1000000002-1000000003-1001',
}
/** What `whoami /user /fo csv /nh` printed on the Windows 11 VM (2026-10-16). */
const WHOAMI = '"win-testvm\\admin","S-1-5-21-1000000001-1000000002-1000000003-1001"\r\n'

describe('the scheduled task', () => {
  // Task names are machine-wide, and a task folder one user creates can refuse another standard user: a fixed
  // `\Harness\harnessd` would let only the first user on a computer install (Review Focus 1).
  it('is named per user, in the root folder', () => {
    expect(taskName('alice')).toBe('Harness harnessd (alice)')
    expect(taskName('DESKTOP-1\\Demo User')).toBe('Harness harnessd (Demo User)')
    expect(taskName('Nguy\u1ec5n V\u0103n A')).toBe('Harness harnessd (Nguy\u1ec5n V\u0103n A)')
    expect(taskName('bob')).not.toBe(taskName('alice'))
    expect(taskName('DESKTOP-1\\alice')).not.toContain('\\')
    // The logon task beside it, named the same way.
    expect(logonTaskName('DESKTOP-1\\Demo User')).toBe('Harness harnessd at sign-in (Demo User)')
    expect(logonTaskName('alice')).not.toBe(taskName('alice'))
  })

  it('starts `harness start --if-down` every five minutes, once at a time, with no time limit', () => {
    const text = taskSchedulerXml(task)
    // schtasks /Create /XML takes UTF-16 only: a UTF-8 file, with or without a BOM, is "malformed" (Windows 11, 2026-10-16).
    expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-16"\?>/)
    // The logon start is the other task's: Task Scheduler runs a task's action whatever trigger fired.
    expect(text).not.toContain('<LogonTrigger>')
    // The principal names nobody: schtasks registers it for the user who creates it, exactly (Principal, task-B3.12-report.md).
    expect(text).toMatch(/<Principal id="Author">\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>\s*<\/Principal>/)
    expect(text).not.toContain('<UserId>')
    expect(text).toMatch(new RegExp(`<TimeTrigger>[\\s\\S]*<Repetition>\\s*<Interval>${TASK_REPEAT}</Interval>\\s*<StopAtDurationEnd>false</StopAtDurationEnd>\\s*</Repetition>[\\s\\S]*</TimeTrigger>`))
    expect(text).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(text).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    // Normal priority: Task Scheduler's default, 7, starts the task below normal, and the daemon and every agent it
    // starts inherit that class (R1b-1, final review).
    expect(text).toMatch(/<Settings>[\s\S]*<Priority>4<\/Priority>[\s\S]*<\/Settings>/)
    expect(text).toMatch(/<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/)
    expect(text).toContain('<Command>C:\\Users\\Demo User\\.harness\\bin\\harness-launch.exe</Command>')
    expect(text).toContain('<Arguments>--root &quot;C:\\Users\\Demo User\\.harness&quot; -- start --if-down</Arguments>')
    expect(text).toContain('<WorkingDirectory>C:\\Users\\Demo User</WorkingDirectory>')
    expect(text).toContain('<Description>harnessd, the Harness daemon. Its log: C:\\Users\\Demo User\\.harness\\cli\\data\\harness.log</Description>')
    // An XML comment may not hold two hyphens in a row: the whole text must parse as one.
    expect(text.match(/<!--([\s\S]*?)-->/g)!.every((comment) => !comment.slice(4, -3).includes('--'))).toBe(true)
    expect(taskSchedulerXml(task)).toBe(text)
  })

  // Final review R1b-2: with Fast Startup a Shut down keeps the uptime, so a stop read against the boot time outlived
  // the next power-on. The logon task's own argument forgets it, as launchd loads an agent booted out at the next login.
  it('starts `harness start --if-down --at-logon` at this user\'s logon, from the logon task, and nothing else differs', () => {
    const text = taskSchedulerXml({ ...task, atLogon: true })
    // The logon trigger names this user by SID; without one it would fire at anyone's logon.
    expect(text).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-1000000001-1000000002-1000000003-1001<\/UserId>\s*<\/LogonTrigger>/)
    expect(text.match(/<UserId>/g)).toHaveLength(1)
    expect(text).not.toContain('<TimeTrigger>')
    expect(text).toContain('<Arguments>--root &quot;C:\\Users\\Demo User\\.harness&quot; -- start --if-down --at-logon</Arguments>')
    expect(text).toContain('<Description>harnessd, the Harness daemon, at sign-in. Its log: C:\\Users\\Demo User\\.harness\\cli\\data\\harness.log</Description>')
    expect(text).toMatch(/<Settings>[\s\S]*<Priority>4<\/Priority>[\s\S]*<\/Settings>/)
    expect(text).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(text.match(/<!--([\s\S]*?)-->/g)!.every((comment) => !comment.slice(4, -3).includes('--'))).toBe(true)
    const strip = (xml: string) => xml.replace(/<Triggers>[\s\S]*<\/Triggers>/, '').replace(/<Description>.*<\/Description>/, '').replace(/<Arguments>.*<\/Arguments>/, '')
    expect(strip(text)).toBe(strip(taskSchedulerXml(task)))
  })

  it('escapes what XML would misread, and refuses a relative path, a path across lines or no user', () => {
    expect(taskSchedulerXml({ ...task, home: 'C:\\A&B <x>' })).toContain('<WorkingDirectory>C:\\A&amp;B &lt;x&gt;</WorkingDirectory>')
    expect(() => taskSchedulerXml({ ...task, launcherPath: 'bin\\harness-launch.exe' })).toThrow(/must be absolute/)
    expect(() => taskSchedulerXml({ ...task, home: 'C:\\a\nb' })).toThrow(/must be absolute/)
    expect(() => taskSchedulerXml({ ...task, root: 'C:\\a"b' })).toThrow(/cannot hold a quote/)
    expect(() => taskSchedulerXml({ ...task, sid: '' })).toThrow(/the user it runs for/)
    expect(() => taskSchedulerXml({ ...task, sid: 'admin' })).toThrow(/the user it runs for/)
    expect(() => taskSchedulerXml({ ...task, sid: `${task.sid}\nS-1-5-18` })).toThrow(/the user it runs for/)
  })

  it('reads this user\'s SID from what whoami prints, whatever the name before it holds', () => {
    expect(WHOAMI_ARGS).toEqual(['/user', '/fo', 'csv', '/nh'])
    expect(whoamiSid(WHOAMI)).toBe(task.sid)
    expect(whoamiSid('"CORP\\Smith, Jo","S-1-5-21-1-2-3-1104"\n')).toBe('S-1-5-21-1-2-3-1104')
    expect(whoamiSid('"WORKGROUP\\admin","not a sid"\r\n')).toBeNull()
    expect(whoamiSid('')).toBeNull()
  })

  it('remembers a stop for as long as this computer runs, and not past its next start', () => {
    const boot = Date.parse('2026-10-16T08:00:00Z')
    expect(stoppedThisBoot(JSON.stringify({ boot: boot + 3_000 }), boot)).toBe(true)
    expect(stoppedThisBoot(JSON.stringify({ boot: boot - 86_400_000 }), boot)).toBe(false)
    expect(stoppedThisBoot('not json', boot)).toBe(false)
    expect(stoppedThisBoot(JSON.stringify({}), boot)).toBe(false)
    expect(stoppedThisBoot(null, boot)).toBe(false)
  })
})

describe('PlatformService over schtasks', () => {
  const data = '/home/demo/.harness/cli/data'
  const definition = (): ServiceDefinition => ({
    nodePath: 'C:\\h\\runtime\\node\\node.exe', scriptPath: 'C:\\h\\cli\\0.5.0\\cli.js', logFile: task.logFile, home: task.home,
    env: {}, launcherPath: task.launcherPath,
  })
  const make = (answers: Record<string, CommandResult> = {}, files: Record<string, string> = {}) => {
    const made = stubDeps({ whoami: ok(WHOAMI), ...answers }, files, { user: 'Demo User', dataDir: data, bootTime: () => 1_000 })
    return { ...made, service: new PlatformService('taskscheduler', made.deps) }
  }
  // The name as stubDeps records it: its arguments joined by spaces, unquoted, as spawnSync passes them.
  const NAME = taskName('Demo User')
  const LOGON = logonTaskName('Demo User')
  const WHOAMI_CALL = `whoami ${WHOAMI_ARGS.join(' ')}`

  it('keeps its definition in the data folder, registers it under this user\'s name, and knows it as this data folder\'s by its log', () => {
    const made = make()
    const { service, files, calls } = made
    expect(service.file).toBe(join(data, 'harnessd-task.xml'))
    expect(service.target).toBe(NAME)
    expect(NAME).toBe('Harness harnessd (Demo User)')
    expect(PLATFORM_LABEL[service.platform]).toBe('Task Scheduler')
    expect(service.write(definition())).toBe(true)
    expect(service.write(definition())).toBe(false)
    expect(service.ownedBy(task.logFile)).toBe(true)
    expect(service.ownedBy('C:\\other\\harness.log')).toBe(false)
    expect(service.current(definition())).toBe(true)
    expect(files[service.file]).toBe(taskSchedulerXml(task))
    expect(made.encodings[service.file]).toBe('utf16le')
    // The logon task beside it, written and registered with it.
    expect(service.logonFile).toBe(join(data, 'harnessd-logon-task.xml'))
    expect(service.logonTarget).toBe(LOGON)
    expect(files[service.logonFile]).toBe(taskSchedulerXml({ ...task, atLogon: true }))
    expect(made.encodings[service.logonFile]).toBe('utf16le')
    expect(service.register()).toEqual({ ok: true })
    // whoami once: the SID is this process's for as long as it runs.
    expect(calls).toEqual([WHOAMI_CALL, `schtasks /Create /TN ${NAME} /XML ${service.file} /F`, `schtasks /Create /TN ${LOGON} /XML ${service.logonFile} /F`])
  })

  it('takes an install from before the logon task for one to rewrite, and writes both again when either differs', () => {
    // The single task of before: its file alone, as it was written.
    const older = taskSchedulerXml(task).replace('<Triggers>', '<Triggers>\n    <LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>')
    const { service, files } = make({}, { [join(data, 'harnessd-task.xml')]: older })
    expect(service.current(definition())).toBe(false)
    expect(service.write(definition())).toBe(true)
    expect(files[service.file]).toBe(taskSchedulerXml(task))
    expect(files[service.logonFile]).toBe(taskSchedulerXml({ ...task, atLogon: true }))
    expect(service.current(definition())).toBe(true)
    delete files[service.logonFile]
    expect(service.current(definition())).toBe(false)
    expect(service.write(definition())).toBe(true)
    expect(service.current(definition())).toBe(true)
    // The logon task is refused: the five-minute one just registered goes again, so a refusal leaves no half (re-review
    // N4), and what schtasks said of the logon task is the outcome.
    const refused = make({ [`schtasks /Create /TN ${LOGON}`]: fail(1, 'ERROR: Access is denied.') })
    expect(refused.service.register()).toEqual({ ok: false, detail: `schtasks /Create /TN ${LOGON} /XML ${refused.service.logonFile} /F failed (exit 1): ERROR: Access is denied.` })
    expect(refused.calls.slice(-1)).toEqual([`schtasks /Delete /TN ${NAME} /F`])
  })

  it('finds this data folder\'s task by what schtasks has registered, when its file is gone', () => {
    const query = `schtasks /Query /TN ${NAME} /XML`
    // As schtasks prints it into a pipe: UTF-16, so NULs between the characters.
    const registered = taskSchedulerXml(task).split('').join('\u0000')
    const found = make({ [query]: ok(registered) })
    expect(found.service.installed()).toBe(false)
    expect(found.service.registeredFor(task.logFile)).toBe(true)
    expect(found.calls).toEqual([query])
    // Another data folder's task under the same user's name is not this one's.
    expect(found.service.registeredFor('C:\\other\\harness.log')).toBe(false)
    // schtasks may print an apostrophe in a path as it is, where Harness wrote &apos;.
    const quoted = "C:\\Users\\O'Neil & Co\\.harness\\cli\\data\\harness.log"
    expect(make({ [query]: ok(`<Description>harnessd, the Harness daemon. Its log: C:\\Users\\O'Neil &amp; Co\\.harness\\cli\\data\\harness.log</Description>`) }).service.registeredFor(quoted)).toBe(true)
    // No task, or schtasks could not be asked: no.
    expect(make({ [query]: fail(1, 'ERROR: The system cannot find the file specified.') }).service.registeredFor(task.logFile)).toBe(false)
    expect(make({ [query]: { status: null, stdout: '', stderr: '', error: 'spawn schtasks ENOENT' } }).service.registeredFor(task.logFile)).toBe(false)
    // launchd and systemd have no registration without the file.
    expect(new PlatformService('launchd', stubDeps({}).deps).registeredFor(task.logFile)).toBe(false)
  })

  it('cannot render a task when whoami cannot say who this is', () => {
    const gone = make({ whoami: { status: null, stdout: '', stderr: '', error: 'spawn whoami ENOENT' } })
    expect(() => gone.service.render(definition())).toThrow(`Harness could not tell which Windows user this is: whoami /user /fo csv /nh could not be run: spawn whoami ENOENT`)
    const odd = make({ whoami: ok('"WORKGROUP\\admin"\r\n') })
    expect(() => odd.service.render(definition())).toThrow(/could not tell which Windows user this is: whoami \/user \/fo csv \/nh printed no SID/)
    const refused = make({ whoami: fail(1, 'ERROR: Access is denied.') })
    expect(() => refused.service.render(definition())).toThrow(/whoami \/user \/fo csv \/nh failed \(exit 1\): ERROR: Access is denied\./)
  })

  it('runs the task to start, rewriting it first when it changed, and forgets a stop', () => {
    const { service, calls, files } = make({}, { [join(data, 'harnessd-stopped.json')]: '{"boot":1000}\n' })
    expect(service.start(true)).toEqual({ ok: true })
    expect(calls).toEqual([`schtasks /Create /TN ${NAME} /XML ${service.file} /F`, `schtasks /Create /TN ${LOGON} /XML ${service.logonFile} /F`, `schtasks /Run /TN ${NAME}`])
    expect(files[join(data, 'harnessd-stopped.json')]).toBeUndefined()
    calls.length = 0
    expect(service.start(false)).toEqual({ ok: true })
    expect(calls).toEqual([`schtasks /Run /TN ${NAME}`])
    const refused = make({ 'schtasks /Create': fail(1, 'ERROR: The task XML is malformed.') })
    expect(refused.service.start(true)).toEqual({ ok: false, detail: `schtasks /Create /TN ${NAME} /XML ${refused.service.file} /F failed (exit 1): ERROR: The task XML is malformed.` })
    expect(refused.calls).toHaveLength(1)
  })

  it('stops by writing the stop down — the task does not run the master, it starts it — and asks nothing', () => {
    const made = make()
    const { service, calls, files } = made
    expect(service.stop()).toEqual({ ok: true })
    expect(calls).toEqual([])
    expect(JSON.parse(files[join(data, 'harnessd-stopped.json')]!)).toEqual({ boot: 1_000 })
    expect(made.encodings).toEqual({})
  })

  it('says what Task Scheduler has: registered and enabled, disabled, not there, or unreachable', () => {
    const enabled = make({ 'schtasks /Query': ok('<Task><Settings><Enabled>true</Enabled></Settings></Task>') })
    expect(enabled.service.inspect()).toMatchObject({ registered: true, state: 'enabled', pid: null, failed: false, unreachable: null })
    // schtasks may write its XML as UTF-16 into a pipe.
    const utf16 = make({ 'schtasks /Query': ok('<\u0000S\u0000e\u0000t\u0000t\u0000i\u0000n\u0000g\u0000s\u0000>\u0000<Enabled>false</Enabled></Settings>') })
    expect(utf16.service.inspect()).toMatchObject({ registered: true, state: 'disabled' })
    expect(make({ 'schtasks /Query': fail(1, 'ERROR: The system cannot find the file specified.') }).service.inspect()).toMatchObject({ registered: false, unreachable: null })
    const gone = make({ 'schtasks /Query': { status: null, stdout: '', stderr: '', error: 'spawn schtasks ENOENT' } })
    expect(gone.service.inspect().unreachable).toBe(`schtasks /Query /TN ${NAME} /XML could not be run: spawn schtasks ENOENT`)
    expect(gone.service.preflight()).toEqual({ ok: false, detail: `schtasks /Query /TN ${NAME} could not be run: spawn schtasks ENOENT — Task Scheduler could not be asked` })
    expect(enabled.service.preflight()).toEqual({ ok: true })
    expect(make({ 'schtasks /Query': fail(1) }).service.preflight()).toEqual({ ok: true })
  })

  // Re-review N5: registered means both tasks, so a logon task deleted by hand is registered again, and status says so.
  it('counts the tasks as registered only when the logon task is there too', () => {
    const main = ok('<Task><Settings><Enabled>true</Enabled></Settings></Task>')
    const alone = make({ [`schtasks /Query /TN ${NAME} /XML`]: main, [`schtasks /Query /TN ${LOGON}`]: fail(1, 'ERROR: The system cannot find the file specified.') })
    expect(alone.service.inspect()).toMatchObject({ registered: false, state: 'enabled', unreachable: null })
    expect(alone.calls).toEqual([`schtasks /Query /TN ${NAME} /XML`, `schtasks /Query /TN ${LOGON}`])
    const both = make({ [`schtasks /Query /TN ${NAME} /XML`]: main, [`schtasks /Query /TN ${LOGON}`]: ok() })
    expect(both.service.inspect()).toMatchObject({ registered: true, state: 'enabled' })
    const unknown = make({ [`schtasks /Query /TN ${NAME} /XML`]: main, [`schtasks /Query /TN ${LOGON}`]: { status: null, stdout: '', stderr: '', error: 'spawnSync schtasks ETIMEDOUT' } })
    expect(unknown.service.inspect()).toMatchObject({ registered: false, unreachable: `schtasks /Query /TN ${LOGON} could not be run: spawnSync schtasks ETIMEDOUT` })
  })

  it('finds this data folder\'s logon task left alone, when the five-minute task and both files are gone', () => {
    const description = `<Description>harnessd, the Harness daemon, at sign-in. Its log: ${task.logFile}</Description>`
    const found = make({ [`schtasks /Query /TN ${NAME} /XML`]: fail(1), [`schtasks /Query /TN ${LOGON} /XML`]: ok(description) })
    expect(found.service.registeredFor(task.logFile)).toBe(true)
    expect(found.service.registeredFor('C:\\other\\harness.log')).toBe(false)
  })

  it('unregisters by deleting the tasks and their files, and leaves the running daemon alone', () => {
    const { service, calls, files } = make({ 'schtasks /Query': ok('<Task/>') }, {
      [join(data, 'harnessd-task.xml')]: 'x', [join(data, 'harnessd-logon-task.xml')]: 'z', [join(data, 'harnessd-stopped.json')]: 'y',
    })
    expect(service.unregister()).toEqual({ ok: true })
    expect(calls).toEqual([`schtasks /Query /TN ${NAME} /XML`, `schtasks /Delete /TN ${NAME} /F`, `schtasks /Query /TN ${LOGON}`, `schtasks /Delete /TN ${LOGON} /F`])
    expect(files).toEqual({})
    const absent = make({ 'schtasks /Query': fail(1) }, { [join(data, 'harnessd-task.xml')]: 'x' })
    expect(absent.service.unregister()).toEqual({ ok: true })
    expect(absent.calls).toEqual([`schtasks /Query /TN ${NAME} /XML`, `schtasks /Query /TN ${LOGON}`])
    // An install from before the logon task: only the five-minute task is there, and it goes.
    const single = make({ [`schtasks /Query /TN ${NAME}`]: ok('<Task/>'), [`schtasks /Query /TN ${LOGON}`]: fail(1) })
    expect(single.service.unregister()).toEqual({ ok: true })
    expect(single.calls).toEqual([`schtasks /Query /TN ${NAME} /XML`, `schtasks /Delete /TN ${NAME} /F`, `schtasks /Query /TN ${LOGON}`])
    // The logon task left by an install that stopped half way goes too, and one schtasks cannot ask about keeps the files.
    const half = make({ [`schtasks /Query /TN ${NAME}`]: fail(1), [`schtasks /Query /TN ${LOGON}`]: ok() }, { [join(data, 'harnessd-logon-task.xml')]: 'z' })
    expect(half.service.unregister()).toEqual({ ok: true })
    expect(half.calls).toContain(`schtasks /Delete /TN ${LOGON} /F`)
    expect(half.files).toEqual({})
    const logonUnknown = make({ [`schtasks /Query /TN ${NAME}`]: fail(1), [`schtasks /Query /TN ${LOGON}`]: { status: null, stdout: '', stderr: '', error: 'spawnSync schtasks ETIMEDOUT' } }, { [join(data, 'harnessd-logon-task.xml')]: 'z' })
    expect(logonUnknown.service.unregister()).toEqual({ ok: false, detail: `schtasks /Query /TN ${LOGON} could not be run: spawnSync schtasks ETIMEDOUT` })
    expect(logonUnknown.files).toEqual({ [join(data, 'harnessd-logon-task.xml')]: 'z' })
    const logonRefused = make({ [`schtasks /Query /TN ${NAME}`]: fail(1), [`schtasks /Query /TN ${LOGON}`]: ok(), [`schtasks /Delete /TN ${LOGON}`]: fail(1, 'ERROR: Access is denied.') })
    expect(logonRefused.service.unregister()).toEqual({ ok: false, detail: `schtasks /Delete /TN ${LOGON} /F failed (exit 1): ERROR: Access is denied.` })
    const refused = make({ 'schtasks /Query': ok('<Task/>'), 'schtasks /Delete': fail(1, 'ERROR: Access is denied.') })
    expect(refused.service.unregister()).toEqual({ ok: false, detail: `schtasks /Delete /TN ${NAME} /F failed (exit 1): ERROR: Access is denied.` })
    // schtasks could not be asked (gone, or past its timeout): the task may still be there, so nothing is removed.
    const unknown = make({ 'schtasks /Query': { status: null, stdout: '', stderr: '', error: 'spawnSync schtasks ETIMEDOUT' } }, { [join(data, 'harnessd-task.xml')]: 'x' })
    expect(unknown.service.unregister()).toEqual({ ok: false, detail: `schtasks /Query /TN ${NAME} /XML could not be run: spawnSync schtasks ETIMEDOUT` })
    expect(unknown.files).toEqual({ [join(data, 'harnessd-task.xml')]: 'x' })
    expect(unknown.calls).toEqual([`schtasks /Query /TN ${NAME} /XML`])
    const discarded = make({}, { [join(data, 'harnessd-task.xml')]: 'x', [join(data, 'harnessd-logon-task.xml')]: 'z' })
    discarded.service.discard()
    expect(discarded.files).toEqual({})
    expect(discarded.calls).toEqual([])
  })

  it('cannot render a task without a launcher, and takes this process\'s user and the home\'s data folder by default', () => {
    const { service } = make()
    expect(() => service.render({ ...definition(), launcherPath: undefined })).toThrow(/must be absolute/)
    const stub = stubDeps({ whoami: ok(WHOAMI) })
    const plain = new PlatformService('taskscheduler', stub.deps)
    expect(plain.file).toBe(join('/Users/demo', '.harness', 'cli', 'data', 'harnessd-task.xml'))
    // No user given: the name is this process's user's; the XML names the user by the SID whoami gives.
    expect(plain.target).toBe(taskName(userInfo().username))
    expect(plain.render(definition())).toContain('<TimeTrigger>')
    plain.write(definition())
    expect(plain.logonTarget).toBe(logonTaskName(userInfo().username))
    expect(stub.files[plain.logonFile]).toContain(`<UserId>${task.sid}</UserId>`)
    // Without a clock of its own, the stop is written against this computer's boot.
    expect(plain.stop()).toEqual({ ok: true })
  })
})
