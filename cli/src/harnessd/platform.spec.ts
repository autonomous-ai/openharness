import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakePlatform, type FakePlatform } from '../testing/fakePlatform.js'
import {
  COMMAND_TIMEOUT_MS, LAUNCHD_LABEL, PLATFORM_ENV, PlatformService, RESTART_THROTTLE_S, STOP_TIMEOUT_S, SYSTEMD_UNIT,
  currentUid, defaultPlatformDeps, launchdPlist, platformFor, platformFromEnv, systemdUnit,
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
  const deps: PlatformDeps = {
    run: (command, args) => {
      const call = [command, ...args].join(' ')
      calls.push(call)
      const key = Object.keys(answers).find((prefix) => call.startsWith(prefix))
      return key ? answers[key] : { status: 0, stdout: '', stderr: '' }
    },
    readFile: (path) => files[path] ?? null,
    writeFile: (path, content) => { files[path] = content },
    removeFile: (path) => { delete files[path] },
    uid: 501,
    home: '/Users/demo',
    ...over,
  }
  return { deps, calls, files }
}

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' })
const fail = (status: number | null, stderr = '', stdout = ''): CommandResult => ({ status, stdout, stderr })

describe('which platform', () => {
  it('is launchd on macOS, systemd on Linux, and none elsewhere', () => {
    expect(platformFor('darwin')).toBe('launchd')
    expect(platformFor('linux')).toBe('systemd')
    expect(platformFor('win32')).toBeNull()
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

  it('take this process\'s user, home and environment unless told otherwise, and an absolute XDG_CONFIG_HOME only', () => {
    const own = defaultPlatformDeps()
    expect(own.uid).toBe(process.getuid!())
    expect(own.home).toBe(homedir())
    expect(defaultPlatformDeps({ env: { XDG_CONFIG_HOME: '/x/config' }, uid: 1, home: '/h' }).configHome).toBe('/x/config')
    expect(defaultPlatformDeps({ env: { XDG_CONFIG_HOME: 'relative' }, uid: 1, home: '/h' }).configHome).toBeUndefined()
    expect(defaultPlatformDeps({ env: {}, uid: 1, home: '/h' }).configHome).toBeUndefined()
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
