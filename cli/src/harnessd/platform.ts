/**
 * Something supervises the supervisor: on macOS a launchd user agent, on Linux a systemd user unit, runs
 * the master in the foreground and starts it again if it dies (docs/design/2026-10-03-harnessd.md,
 * "Supervision"). Before this, nothing restarted a master that died but the desktop app running
 * `harness start` again, up to a minute later, and on a computer without the app nothing did.
 *
 * Opt-in, through `harness service install` (src/lib/serviceCommand.ts). Nothing here runs for anyone
 * who has not asked for it, and the desktop app does not use it yet.
 *
 * This file writes and removes the definition (the agent's plist, the unit file) and registers it with
 * launchctl or systemctl. Everything it does to the operating system goes through `PlatformDeps`, so
 * the tests run it against a temporary home and fake launchctl and systemctl binaries, never against
 * this machine's.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, uptime, userInfo } from 'node:os'
import { dirname, isAbsolute, join, win32 } from 'node:path'

export type PlatformName = 'launchd' | 'systemd' | 'taskscheduler'

/** How each is named to a person. */
export const PLATFORM_LABEL: Record<PlatformName, string> = { launchd: 'launchd', systemd: 'systemd', taskscheduler: 'Task Scheduler' }

/**
 * Set by the definition, so the master knows the platform runs it and says so in its status file. The
 * CLI does not read it from its own environment: a shell in a tmux pane the daemon started inherits it,
 * and would otherwise believe it was the platform.
 */
export const PLATFORM_ENV = 'HARNESSD_PLATFORM'

export const LAUNCHD_LABEL = 'ai.autonomous.harness.harnessd'
export const SYSTEMD_UNIT = 'harnessd.service'

/**
 * Harness OS ships its own user unit for the daemon (os/root/usr/lib/systemd/user/harness-daemon.service):
 * the screen pulls it in, and the OS's updater restarts it to change the CLI. It runs `harness start
 * --foreground` with HARNESS_NO_MASTER=1, the core alone. A daemon this CLI spawned beside it (a sign-in
 * stops the unit's core and starts one again) runs where the OS cannot reach it: the updater's restart
 * then gives the unit a core that finds the port taken and fails until systemd gives up (2026-10-12).
 * The unit is the package's: this CLI starts and stops it, and never writes, enables or removes it.
 */
export const OS_SYSTEMD_UNIT = 'harness-daemon.service'
export const OS_UNIT_FILE = '/usr/lib/systemd/user/harness-daemon.service'
const OS_OWNS_IT = `Harness OS runs harnessd under ${OS_SYSTEMD_UNIT}`

/**
 * launchd starts the job at most once every this many seconds (its own default, written down so it
 * does not move under us); systemd waits this long before a restart. A master that dies after running
 * a while is started again at once; one that cannot start at all is tried every ten seconds by launchd,
 * and left failed by systemd after five tries in a minute rather than looped.
 */
export const RESTART_THROTTLE_S = 10
export const SYSTEMD_RESTART_S = 2
/** How long the platform gives the master to stop before it kills it: well past the master's own
 *  ordered stop (the core gets 2.5 s, the services 1.5 s beside it). */
export const STOP_TIMEOUT_S = 10
/** A launchctl or systemctl call that takes longer than this is reported as failed, never waited on. */
export const COMMAND_TIMEOUT_MS = 30_000

/** The platform that would supervise harnessd on this operating system; null where none runs. */
export function platformFor(os: NodeJS.Platform): PlatformName | null {
  return os === 'darwin' ? 'launchd' : os === 'linux' ? 'systemd' : os === 'win32' ? 'taskscheduler' : null
}

/** The platform running this master, as its definition says; null when `harness start` or the desktop
 *  app started it. */
export function platformFromEnv(env: NodeJS.ProcessEnv): PlatformName | null {
  const value = env[PLATFORM_ENV]
  return value === 'launchd' || value === 'systemd' ? value : null
}

/** What the platform runs: `<node> <cli.js> __harnessd`, its log, and the environment it is given. */
export interface ServiceDefinition {
  nodePath: string
  scriptPath: string
  /** stdout and stderr, appended: the log `harness start` gives the master, which it trims itself. */
  logFile: string
  /** The working directory, the user's home: what a systemd user unit gets by default. */
  home: string
  /** Variables the master needs beside `PLATFORM_ENV`, already chosen by the caller. */
  env: Record<string, string>
  /** Windows: `bin\harness-launch.exe`, what the scheduled task runs (lib/windows/installLayout.ts `harnessLaunchPath`). */
  launcherPath?: string
}

/** A path or value with a control character in it cannot be written into a unit file, and has no
 *  business in a plist either. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function checked(definition: ServiceDefinition): ServiceDefinition {
  for (const [what, path] of [['node', definition.nodePath], ['cli', definition.scriptPath], ['log', definition.logFile], ['home', definition.home]] as const) {
    if (!isAbsolute(path) || CONTROL.test(path)) throw new Error(`the ${what} path for the service must be absolute, on one line: ${JSON.stringify(path)}`)
  }
  for (const [name, value] of Object.entries(definition.env)) {
    if (!ENV_NAME.test(name) || CONTROL.test(value)) throw new Error(`the service cannot carry ${JSON.stringify(name)}=${JSON.stringify(value)}`)
  }
  return definition
}

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** The launchd agent: `~/Library/LaunchAgents/<label>.plist`. */
export function launchdPlist(definition: ServiceDefinition): string {
  const { nodePath, scriptPath, logFile, home, env } = checked(definition)
  const environment = Object.entries({ ...env, [PLATFORM_ENV]: 'launchd' })
    .map(([name, value]) => `\t\t<key>${xml(name)}</key>\n\t\t<string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- harnessd, the Harness daemon, under launchd. Written by "harness service install" and removed by
     "harness service uninstall"; "harness service status" says what launchd has registered. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<!-- The master in the foreground: a launchd job must not daemonize, or launchd thinks it died. -->
	<key>ProgramArguments</key>
	<array>
		<string>${xml(nodePath)}</string>
		<string>${xml(scriptPath)}</string>
		<string>__harnessd</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${environment}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xml(home)}</string>
	<!-- Started at login, and again after any exit but a clean one: a crash, a kill, an uncaught error.
	     A clean exit is a stop someone asked for, or this computer signed out for good, and stays stopped. -->
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
		<key>Crashed</key>
		<true/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>${RESTART_THROTTLE_S}</integer>
	<key>ExitTimeOut</key>
	<integer>${STOP_TIMEOUT_S}</integer>
	<!-- launchd kills a dead job's process group by default. The agents live in tmux and must outlive
	     the daemon: nothing outside the daemon decides what lives when it stops, as when "harness start"
	     runs it. Its core and services leave by themselves when the master's channel closes. -->
	<key>AbandonProcessGroup</key>
	<true/>
	<!-- A job without a ProcessType has its CPU and I/O throttled. The daemon serves panes someone is
	     typing into, and the tmux server it starts runs under the job's limits: an app's, which are none. -->
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>${xml(logFile)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logFile)}</string>
</dict>
</plist>
`
}

/**
 * One word of an ExecStart= line: quoted, with systemd's specifiers (%) escaped, and in an argument its
 * variables ($) too. Not in the program: systemd substitutes no variable there, so it would leave `$$`
 * as two dollars (systemd 259, checked with systemd-analyze verify).
 */
const execWord = (word: string, index: number): string => {
  const quoted = word.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${index === 0 ? quoted : quoted.replace(/\$/g, '$$$$')}"`
}
/** An Environment= assignment: quoted, specifiers escaped; `$` means nothing there. */
const environmentWord = (name: string, value: string): string => `"${`${name}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
/** A path in a setting that takes one path as its whole value: only the specifiers to escape. */
const pathValue = (path: string): string => path.replace(/%/g, '%%')

/** The systemd user unit: `~/.config/systemd/user/harnessd.service`. */
export function systemdUnit(definition: ServiceDefinition): string {
  const { nodePath, scriptPath, logFile, home, env } = checked(definition)
  const environment = Object.entries({ ...env, [PLATFORM_ENV]: 'systemd' })
    .map(([name, value]) => `Environment=${environmentWord(name, value)}`).join('\n')
  return `# harnessd, the Harness daemon, under systemd. Written by \`harness service install\` and removed by
# \`harness service uninstall\`; \`harness service status\` says what systemd has registered.
[Unit]
Description=Harness daemon (harnessd)
Documentation=https://github.com/autonomous-ai/openharness/blob/main/docs/design/2026-10-03-harnessd.md
# Five failed starts in a minute leave it failed rather than looping, as when its Node is gone.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
# The master in the foreground. It holds no sockets of its own, so no Type=notify: its core binds them.
Type=simple
ExecStart=${[nodePath, scriptPath, '__harnessd'].map(execWord).join(' ')}
${environment}
WorkingDirectory=${pathValue(home)}
# Started again after a crash or a kill. A clean exit is a stop someone asked for, or this computer
# signed out for good, and stays stopped.
Restart=on-failure
RestartSec=${SYSTEMD_RESTART_S}
# KillMode=process: a stop, a restart or the master's death signals the master alone. The default,
# control-group, kills every process in this unit's cgroup, and everything the daemon starts lands in
# it: a tmux server it starts, and with it every agent. The master stops its own core and services in
# order, inside TimeoutStopSec, and they leave by themselves if it dies. The cleaner split would be a
# scope of tmux's own (systemd-run --user --scope tmux ...), which this unit could then stop with
# control-group; it means changing how the core starts tmux, and a unit that only works with that
# change is a unit nobody can turn back. Consequences: a tmux server the daemon started is listed
# under this unit, and systemd notes it as left over on the next start; no MemoryMax= here, which
# would cover the agents too; and, where tmux is built with systemd support, each pane lives in a
# scope PartOf this unit, so a stop job (systemctl --user stop or restart) stops every agent all the
# same. \`harness stop\` signals the master instead, and its clean exit stops nothing else: use it.
KillMode=process
TimeoutStopSec=${STOP_TIMEOUT_S}
# Appended, as \`harness start\` opens it; the master keeps it under its cap. append: needs systemd 240.
StandardOutput=append:${pathValue(logFile)}
StandardError=append:${pathValue(logFile)}

[Install]
WantedBy=default.target
`
}

/**
 * Windows: the per-user tasks `Harness harnessd (<user name>)` and `Harness harnessd at sign-in (<user name>)` in Task
 * Scheduler's root folder (spec section 3, "Start and keep running"). Task names are machine-wide, and a task folder
 * one user creates can refuse another standard user, so the name carries the user and there is no `\Harness\` folder.
 * Task Scheduler does not run the master as launchd and systemd do; it starts `harness start --if-down` through the
 * windowless launcher every five minutes, and `harness start --if-down --at-logon` at logon, which start the master
 * when none runs (lib/startIfDown.ts) and do nothing otherwise. That is what stands in for KeepAlive and Restart=: a
 * master that dies is back within five minutes.
 *
 * Two tasks, because Task Scheduler runs a task's actions whatever trigger fired, and the logon start is the one that
 * forgets a `harness stop`, as launchd loads an agent booted out at the next login. The five-minute start honours it.
 * The boot time alone did not do: with Fast Startup, on by default, Shut down keeps the kernel's uptime, so a stop
 * outlived a Shut down and the next power-on (final review R1b-2).
 *
 * No administrator rights: InteractiveToken runs it as the user, only while they are signed in, with no password stored.
 * The principal names no user: schtasks registers it for the user who creates it, exactly. A name built from
 * USERDOMAIN is not that user over SSH, where OpenSSH sets USERDOMAIN to WORKGROUP and schtasks refuses
 * `WORKGROUP\admin` ("No mapping between account names and security IDs", Windows 11, 2026-10-16). The logon
 * trigger names the user by SID, as whoami gives it: without a user it would fire at anyone's logon.
 * IgnoreNew: a start still running when the next one is due is not doubled. No time limit, though each start lasts
 * seconds: the launcher exits once it has started the CLI, and the master it starts is outside the task's job.
 * Priority 4, normal: Task Scheduler's default, 7, starts the task below normal priority (and lower I/O and memory
 * priority), and a process Windows starts without a class of its own takes its parent's, so the daemon and every
 * agent it starts ran below normal (final review R1b-1). In the XML rather than in harness-launch: the text change
 * makes `current` false, so the next `harness start` or `harness service install` (which install.ps1 runs on every
 * install) registers the task again, and an install whose launcher is older is covered as well.
 * The time trigger's start is fixed, so the same install writes the same text and `current` can compare it.
 */
/** The task of [user], the bare user name (USERNAME): `Harness harnessd (<name>)`; a `DOMAIN\` before it is left out. */
export function taskName(user: string): string {
  return `Harness harnessd (${user.slice(user.lastIndexOf('\\') + 1)})`
}
/** The logon task of [user], named as `taskName` names the other: `Harness harnessd at sign-in (<name>)`. */
export function logonTaskName(user: string): string {
  return `Harness harnessd at sign-in (${user.slice(user.lastIndexOf('\\') + 1)})`
}
/** What the logon task adds to `harness start --if-down`: forget a `harness stop` made before this logon. */
export const AT_LOGON_FLAG = '--at-logon'
export const TASK_REPEAT = 'PT5M'
/** In the data folder: the definition as written (schtasks registers it from there), and a stop to honour. */
export const TASK_FILE = 'harnessd-task.xml'
export const LOGON_TASK_FILE = 'harnessd-logon-task.xml'
export const TASK_STOPPED_FILE = 'harnessd-stopped.json'

export interface TaskDefinition {
  launcherPath: string
  /** The `~\.harness` the launcher resolves its pointers in (`--root`). */
  root: string
  home: string
  logFile: string
  /** The SID of the user whose logon starts it (`whoamiSid`). */
  sid: string
  /** The logon task (`harness start --if-down --at-logon` at this user's logon), not the five-minute one. */
  atLogon?: boolean
}

const SID = /^S-1-\d+(-\d+)+$/
/** `whoami /user /fo csv /nh`: one line, `"<DOMAIN\name>","<SID>"`. */
export const WHOAMI_ARGS = ['/user', '/fo', 'csv', '/nh']

/** The SID in what `whoami /user /fo csv /nh` printed: its last column, as a name may hold a comma. */
export function whoamiSid(stdout: string): string | null {
  const sid = /"([^"]*)"\s*$/.exec(stdout.trim())?.[1]
  return sid && SID.test(sid) ? sid : null
}

export function taskSchedulerXml(opts: TaskDefinition): string {
  for (const [what, path] of [['launcher', opts.launcherPath], ['root', opts.root], ['home', opts.home], ['log', opts.logFile]] as const) {
    if (!win32.isAbsolute(path) || CONTROL.test(path)) throw new Error(`the ${what} path for the task must be absolute, on one line: ${JSON.stringify(path)}`)
  }
  // Quoted for the launcher's own command line: a quote inside cannot be.
  if (opts.root.includes('"')) throw new Error(`the root for the task cannot hold a quote: ${JSON.stringify(opts.root)}`)
  if (!SID.test(opts.sid)) throw new Error(`the task needs the user it runs for, as a SID: ${JSON.stringify(opts.sid)}`)
  // UTF-16, and written so (PlatformService.write): schtasks /Create /XML refused a UTF-8 file as malformed, with
  // a BOM ("incorrect document syntax") or without ("unable to switch the encoding"), and a UTF-16 file that
  // declares UTF-8; it took UTF-16LE with a BOM declaring UTF-16 (Windows 11 ARM64, 2026-10-16).
  const trigger = opts.atLogon
    ? `    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${opts.sid}</UserId>
    </LogonTrigger>`
    : `    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>${TASK_REPEAT}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>`
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- harnessd, the Harness daemon, under Task Scheduler. Written by "harness service install" and removed by
     "harness service uninstall"; "harness service status" says what Task Scheduler has registered. -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>harnessd, the Harness daemon${opts.atLogon ? ', at sign-in' : ''}. Its log: ${xml(opts.logFile)}</Description>
  </RegistrationInfo>
  <Triggers>
${trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(opts.launcherPath)}</Command>
      <Arguments>${xml(`--root "${opts.root}" -- start --if-down${opts.atLogon ? ` ${AT_LOGON_FLAG}` : ''}`)}</Arguments>
      <WorkingDirectory>${xml(opts.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** A stop written down since this computer last started (within two minutes of its boot time, which is read
 *  from the uptime and moves by a second or two). The logon task forgets a stop in any case (`AT_LOGON_FLAG`):
 *  with Fast Startup the uptime runs on through a Shut down. */
export function stoppedThisBoot(text: string | null, bootMs: number): boolean {
  if (text === null) return false
  try {
    const { boot } = JSON.parse(text) as { boot?: unknown }
    return typeof boot === 'number' && Math.abs(boot - bootMs) < 120_000
  } catch {
    return false
  }
}

/** When this computer started, ms since the epoch. */
export const bootTimeMs = (): number => Date.now() - uptime() * 1000

/** A launchctl, systemctl or loginctl run to its end. `error`: it could not be run at all. */
export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: string
}

/** Everything this file does to the operating system. */
export interface PlatformDeps {
  /** Run a command by name, without a shell, and wait for it. */
  run(command: string, args: string[]): CommandResult
  /** A file's text, or null when it cannot be read. */
  readFile(path: string): string | null
  /** Write whole and rename into place, making the folder first. `utf16le`: with its byte order mark, as
   *  schtasks takes a task's XML; UTF-8 otherwise. */
  writeFile(path: string, content: string, encoding?: 'utf16le'): void
  removeFile(path: string): void
  uid: number
  home: string
  /** `$XDG_CONFIG_HOME`, where systemd looks for user units first; `~/.config` when unset. */
  configHome?: string
  /** Windows: the user name (USERNAME, no domain), which names the task. */
  user?: string
  /** Windows: the data folder, where the task's definition and a stop are written. `~/.harness/cli/data` when unset. */
  dataDir?: string
  /** When this computer started (`bootTimeMs`). */
  bootTime?: () => number
}

/** This process's user id; 0 where Node has no notion of one. */
export function currentUid(proc: { getuid?: () => number } = process): number {
  return typeof proc.getuid === 'function' ? proc.getuid() : 0
}

/**
 * The real thing: commands looked up on `env.PATH` (Node searches the PATH of the environment it is
 * given), files on disk. The tests hand it a PATH holding only fake binaries and a temporary home.
 */
export function defaultPlatformDeps(options: { env?: NodeJS.ProcessEnv; uid?: number; home?: string; dataDir?: string } = {}): PlatformDeps {
  const env = options.env ?? process.env
  const configHome = env.XDG_CONFIG_HOME
  return {
    run: (command, args) => {
      // `launchctl print` lists the whole job, and a domain's listing runs to hundreds of kilobytes.
      const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) }
    },
    readFile: (path) => {
      try {
        const bytes = readFileSync(path)
        // A task's XML, written as UTF-16 with its byte order mark (below).
        return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, content, encoding) => {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      const bytes = encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]) : content
      // Not writable by others: launchd skips a plist with "dubious permissions".
      writeFileSync(temp, bytes, { mode: 0o644 })
      renameSync(temp, path)
    },
    removeFile: (path) => rmSync(path, { force: true }),
    uid: options.uid ?? currentUid(),
    home: options.home ?? homedir(),
    ...(configHome && isAbsolute(configHome) ? { configHome } : {}),
    // No USERDOMAIN: OpenSSH sets it to WORKGROUP (see taskSchedulerXml).
    ...(env.USERNAME ? { user: env.USERNAME } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    bootTime: bootTimeMs,
  }
}

/** What the platform says about harnessd. */
export interface PlatformState {
  platform: PlatformName
  /** The definition's path. */
  file: string
  /** `gui/<uid>/<label>`, or the unit's name. */
  target: string
  /** The definition is on disk. */
  installed: boolean
  /** launchd has the job loaded; systemd has the unit enabled. */
  registered: boolean
  /** The master's pid, as the platform knows it. */
  pid: number | null
  /** The platform's own words: `running`, `not running`; `active (running)`, `failed (failed)`… */
  state: string | null
  /** systemd gave up on it (its start limit). */
  failed: boolean
  /** How the master last ended, as the platform puts it, when it says. */
  lastExit: string | null
  /** systemd: the user manager lingers, so the unit runs without a login session. null: launchd, or
   *  unknown. */
  linger: boolean | null
  /** The platform could not be asked (no user manager, no launchctl), and why. */
  unreachable: string | null
}

export type Outcome = { ok: true } | { ok: false; detail: string }

const firstLine = (text: string): string => text.trim().split('\n')[0].trim()

function failure(command: string, args: string[], result: CommandResult): string {
  const what = `${command} ${args.join(' ')}`
  if (result.error) return `${what} could not be run: ${result.error}`
  const said = firstLine(result.stderr) || firstLine(result.stdout)
  return `${what} failed (exit ${result.status ?? 'none'})${said ? `: ${said}` : ''}`
}

/** `Key=Value` lines, as `systemctl show` prints them. */
function properties(text: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) found[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return found
}

/** harnessd's definition and registration on one platform. */
export class PlatformService {
  /** `os`: the unit is Harness OS's own (OS_SYSTEMD_UNIT), not the one `harness service install` writes. */
  constructor(readonly platform: PlatformName, private readonly deps: PlatformDeps, readonly os = false) {
    if (os && platform !== 'systemd') throw new Error('Harness OS runs harnessd under systemd')
  }

  private get unit(): string {
    return this.os ? OS_SYSTEMD_UNIT : SYSTEMD_UNIT
  }

  private get dataDir(): string {
    return this.deps.dataDir ?? join(this.deps.home, '.harness', 'cli', 'data')
  }

  private get stoppedFile(): string {
    return join(this.dataDir, TASK_STOPPED_FILE)
  }

  /** Windows: the logon task's definition, beside the five-minute task's (`file`). */
  get logonFile(): string {
    return join(this.dataDir, LOGON_TASK_FILE)
  }

  /** Windows: the logon task's name, beside the five-minute task's (`target`). */
  get logonTarget(): string {
    return logonTaskName(this.taskUser)
  }

  /** Windows: the user name that names the task, the one source for it: the deps' user, else this process's. */
  private get taskUser(): string {
    return this.deps.user ?? userInfo().username
  }

  private sidRead: string | undefined

  /** Windows: this user's SID, for the task's logon trigger. Asked once: it is this process's for as long as it runs. */
  private get sid(): string {
    if (this.sidRead) return this.sidRead
    const result = this.deps.run('whoami', WHOAMI_ARGS)
    const sid = result.status === 0 && !result.error ? whoamiSid(result.stdout) : null
    const what = `whoami ${WHOAMI_ARGS.join(' ')}`
    if (!sid) throw new Error(`Harness could not tell which Windows user this is: ${result.status === 0 && !result.error ? `${what} printed no SID` : failure('whoami', WHOAMI_ARGS, result)}`)
    this.sidRead = sid
    return sid
  }

  /** Where the definition lives. */
  get file(): string {
    if (this.os) return OS_UNIT_FILE
    if (this.platform === 'taskscheduler') return join(this.dataDir, TASK_FILE)
    return this.platform === 'launchd'
      ? join(this.deps.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
      : join(this.deps.configHome ?? join(this.deps.home, '.config'), 'systemd', 'user', SYSTEMD_UNIT)
  }

  /** What launchctl, systemctl or schtasks is told to act on. */
  get target(): string {
    if (this.platform === 'taskscheduler') return taskName(this.taskUser)
    return this.platform === 'launchd' ? `gui/${this.deps.uid}/${LAUNCHD_LABEL}` : this.unit
  }

  render(definition: ServiceDefinition): string {
    if (this.platform === 'taskscheduler') return this.renderTask(definition, false)
    return this.platform === 'launchd' ? launchdPlist(definition) : systemdUnit(definition)
  }

  private renderTask(definition: ServiceDefinition, atLogon: boolean): string {
    const launcherPath = definition.launcherPath ?? ''
    // The launcher is `<root>\bin\harness-launch.exe` (lib/windows/installLayout.ts `harnessLaunchPath`).
    return taskSchedulerXml({ launcherPath, root: win32.dirname(win32.dirname(launcherPath)), home: definition.home, logFile: definition.logFile, sid: this.sid, atLogon })
  }

  /** What is written where: the definition, and on Windows the logon task's beside it. */
  private definitions(definition: ServiceDefinition): Array<[path: string, content: string]> {
    if (this.platform !== 'taskscheduler') return [[this.file, this.render(definition)]]
    return [[this.file, this.renderTask(definition, false)], [this.logonFile, this.renderTask(definition, true)]]
  }

  installed(): boolean {
    return this.deps.readFile(this.file) !== null
  }

  /**
   * The definition on disk runs the daemon whose log is `logFile`, that is, the daemon of this data
   * folder. A definition written for another one (another ADAPTER_DATA_DIR) is not this CLI's to start
   * or stop, and a test with its own data folder never acts on the person's real registration.
   */
  ownedBy(logFile: string): boolean {
    // The OS's unit logs to the journal. It is only ever built for the data folder it runs
    // (lib/platformDaemon.ts osDaemonUnit), so its file on disk is enough.
    if (this.os) return this.installed()
    const content = this.deps.readFile(this.file)
    if (content === null) return false
    if (this.platform === 'taskscheduler') return content.includes(`Its log: ${xml(logFile)}</Description>`)
    return this.platform === 'launchd'
      ? content.includes(`<key>StandardOutPath</key>\n\t<string>${xml(logFile)}</string>\n`)
      : content.includes(`\nStandardOutput=append:${pathValue(logFile)}\n`)
  }

  /**
   * Task Scheduler only: the task registered under this user's name runs the daemon whose log is `logFile`, as schtasks
   * itself has it. For a definition file that is gone while its task is not (an install that stopped half way, or a data
   * folder emptied by hand): `harness uninstall` must still find that task, and still only this data folder's, by the
   * same description `ownedBy` reads (B5.9 review, I3). schtasks may print a quote or an apostrophe as it is. Anything
   * but a clear answer is no.
   */
  registeredFor(logFile: string): boolean {
    if (this.platform !== 'taskscheduler') return false
    const plain = logFile.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Either task: a logon task left when the five-minute one is gone is this data folder's too (re-review N5).
    return [this.target, this.logonTarget].some((name) => {
      const result = this.deps.run('schtasks', ['/Query', '/TN', name, '/XML'])
      if (result.error || result.status !== 0) return false
      // Written into a pipe, schtasks's XML may come as UTF-16: the text reads the same without the NULs.
      const text = result.stdout.replace(/\u0000/g, '')
      return [xml(logFile), plain].some((form) => text.includes(`Its log: ${form}</Description>`))
    })
  }

  /** The definition on disk is the one this install would write (on Windows, both tasks'). */
  current(definition: ServiceDefinition): boolean {
    if (this.os) return true // the package's, not this install's to compare
    return this.definitions(definition).every(([path, content]) => this.deps.readFile(path) === content)
  }

  /**
   * Write the definition when it differs from the one on disk; says whether it did. On Windows both tasks are written
   * when either differs, so an install from before the logon task had one of its own gets it with the next
   * registration (`start(true)`, `register`).
   */
  write(definition: ServiceDefinition): boolean {
    if (this.os) return false
    const wanted = this.definitions(definition)
    if (wanted.every(([path, content]) => this.deps.readFile(path) === content)) return false
    for (const [path, content] of wanted) {
      // schtasks takes a task's XML as UTF-16 only (taskSchedulerXml).
      if (this.platform === 'taskscheduler') this.deps.writeFile(path, content, 'utf16le')
      else this.deps.writeFile(path, content)
    }
    return true
  }

  inspect(): PlatformState {
    const base = { platform: this.platform, file: this.file, target: this.target, installed: this.installed(), linger: null, unreachable: null }
    if (this.platform === 'taskscheduler') {
      const args = ['/Query', '/TN', this.target, '/XML']
      const result = this.deps.run('schtasks', args)
      const none = { ...base, registered: false, pid: null, state: null, failed: false, lastExit: null }
      if (result.error) return { ...none, unreachable: failure('schtasks', args, result) }
      if (result.status !== 0) return none
      // Written into a pipe, schtasks's XML may come as UTF-16: the tags read the same without the NULs.
      const text = result.stdout.replace(/\u0000/g, '')
      const disabled = /<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/.test(text)
      // Registered means both tasks: with the logon task gone (deleted by hand), `harness service install` registers
      // them again rather than finding nothing to change (re-review N5).
      const logonArgs = ['/Query', '/TN', this.logonTarget]
      const logon = this.deps.run('schtasks', logonArgs)
      if (logon.error) return { ...none, unreachable: failure('schtasks', logonArgs, logon) }
      // No pid: the task starts the master and is done; the pid file names it.
      return { ...base, registered: logon.status === 0, pid: null, state: disabled ? 'disabled' : 'enabled', failed: false, lastExit: null }
    }
    if (this.platform === 'launchd') {
      const result = this.launchctl('print', this.target)
      if (result.error) return { ...base, registered: false, pid: null, state: null, failed: false, lastExit: null, unreachable: failure('launchctl', ['print', this.target], result) }
      if (result.status !== 0) return { ...base, registered: false, pid: null, state: null, failed: false, lastExit: null }
      const pid = /^[ \t]*pid = (\d+)[ \t]*$/m.exec(result.stdout)
      return {
        ...base,
        registered: true,
        pid: pid ? Number(pid[1]) : null,
        state: /^[ \t]*state = (.+?)[ \t]*$/m.exec(result.stdout)?.[1] ?? null,
        failed: false,
        lastExit: /^[ \t]*last exit code = (.+?)[ \t]*$/m.exec(result.stdout)?.[1] ?? null,
      }
    }
    const args = ['--user', 'show', this.unit, '--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,Result']
    const result = this.deps.run('systemctl', args)
    const linger = this.linger()
    if (result.error || result.status !== 0) {
      return { ...base, linger, registered: false, pid: null, state: null, failed: false, lastExit: null, unreachable: failure('systemctl', args, result) }
    }
    const shown = properties(result.stdout)
    const pid = Number(shown.MainPID)
    return {
      ...base,
      linger,
      // The OS pulls its unit in with the screen rather than enabling it: loaded is registered.
      registered: this.os ? shown.LoadState === 'loaded' : shown.UnitFileState === 'enabled',
      pid: pid > 0 ? pid : null,
      state: shown.ActiveState ? `${shown.ActiveState}${shown.SubState ? ` (${shown.SubState})` : ''}` : null,
      failed: shown.ActiveState === 'failed',
      lastExit: shown.Result && shown.Result !== 'success' ? shown.Result : null,
    }
  }

  /**
   * Whether the platform can take the job at all, asked before anything is stopped: launchd's GUI
   * domain exists only while the user is logged in at the screen (an SSH session alone has none), and
   * `systemctl --user` needs the user's manager.
   */
  preflight(): Outcome {
    if (this.platform === 'taskscheduler') {
      const args = ['/Query', '/TN', this.target]
      const result = this.deps.run('schtasks', args)
      return result.error ? { ok: false, detail: `${failure('schtasks', args, result)} — Task Scheduler could not be asked` } : { ok: true }
    }
    if (this.platform === 'launchd') {
      const result = this.launchctl('print', `gui/${this.deps.uid}`)
      return result.status === 0 ? { ok: true } : { ok: false, detail: `${failure('launchctl', ['print', `gui/${this.deps.uid}`], result)} — launchd runs a user agent only for a user logged in at the screen` }
    }
    return this.systemctl('daemon-reload')
  }

  /** Register the definition just written, which starts the master: launchd loads the job (RunAtLoad),
   *  systemd enables the unit and starts it. */
  register(): Outcome {
    if (this.os) return { ok: false, detail: OS_OWNS_IT }
    // Registered and nothing more: the caller runs it once it has let go of the spawn lock, which the task's own
    // `harness start --if-down` takes (lib/serviceCommand.ts).
    if (this.platform === 'taskscheduler') {
      // The five-minute task first: its file is the one `installed` and `ownedBy` read.
      const created = this.checked('schtasks', ['/Create', '/TN', this.target, '/XML', this.file, '/F'])
      if (!created.ok) return created
      const logon = this.checked('schtasks', ['/Create', '/TN', this.logonTarget, '/XML', this.logonFile, '/F'])
      // No half registration: the five-minute task goes again, so the caller's "nothing was changed" holds (re-review N4).
      if (!logon.ok) this.deps.run('schtasks', ['/Delete', '/TN', this.target, '/F'])
      return logon
    }
    if (this.platform === 'launchd') {
      // A job someone disabled stays disabled through a bootstrap; installing is asking for it.
      const enabled = this.launchctl('enable', this.target)
      if (enabled.status !== 0) return { ok: false, detail: failure('launchctl', ['enable', this.target], enabled) }
      return this.checked('launchctl', ['bootstrap', `gui/${this.deps.uid}`, this.file])
    }
    const reloaded = this.systemctl('daemon-reload')
    return reloaded.ok ? this.systemctl('enable', '--now', SYSTEMD_UNIT) : reloaded
  }

  /**
   * Start the master. `refreshed`: the definition was rewritten just now, so a job launchd still has
   * loaded is loaded again from the new file, and systemd rereads it.
   */
  start(refreshed: boolean): Outcome {
    if (this.platform === 'taskscheduler') {
      if (refreshed) {
        const created = this.register()
        if (!created.ok) return created
      }
      this.deps.removeFile(this.stoppedFile)
      return this.checked('schtasks', ['/Run', '/TN', this.target])
    }
    if (this.platform === 'launchd') {
      const loaded = this.launchctl('print', this.target).status === 0
      if (loaded && !refreshed) return this.checked('launchctl', ['kickstart', this.target])
      if (loaded) {
        const out = this.checked('launchctl', ['bootout', this.target])
        if (!out.ok) return out
      }
      return this.checked('launchctl', ['bootstrap', `gui/${this.deps.uid}`, this.file])
    }
    if (refreshed) {
      const reloaded = this.systemctl('daemon-reload')
      if (!reloaded.ok) return reloaded
    }
    // After five failed starts systemd refuses a start until it is told to forget them.
    this.deps.run('systemctl', ['--user', 'reset-failed', this.unit])
    // The OS's unit holds its start until the daemon answers (ExecStartPost), which can outlast
    // COMMAND_TIMEOUT_MS. Queued instead: the caller waits for the pid file, as for any master.
    return this.os ? this.systemctl('start', '--no-block', this.unit) : this.systemctl('start', SYSTEMD_UNIT)
  }

  /**
   * Stop the master and keep it stopped: launchd unloads the job until the next login or start; under
   * systemd the master is told to stop and exits cleanly, which Restart=on-failure leaves stopped, and
   * the unit stays enabled for the next login.
   *
   * Under systemd a signal, never a stop job (`systemctl stop`). tmux built with systemd support puts
   * every pane in a scope PartOf the unit that started its server, and a stop job on this unit is passed
   * to every one of them: each agent is stopped, whatever KillMode says. Seen with Fedora's tmux 3.7c
   * under systemd 259, where `systemctl --user stop` ended every pane and a clean exit of the master
   * ended none. The same goes for `restart` and `disable --now`, so nothing here uses them.
   */
  stop(): Outcome {
    if (this.platform === 'taskscheduler') {
      // The task does not run the master, so there is nothing of it to stop: `harness stop` stops the daemon itself
      // (lib/daemonStop.ts). Written down, so the five-minute starts leave it stopped until this computer starts again.
      this.deps.writeFile(this.stoppedFile, `${JSON.stringify({ boot: (this.deps.bootTime ?? bootTimeMs)() })}\n`)
      return { ok: true }
    }
    if (this.platform === 'launchd') {
      if (this.launchctl('print', this.target).status !== 0) return { ok: true }
      return this.checked('launchctl', ['bootout', this.target])
    }
    const main = Number(properties(this.deps.run('systemctl', ['--user', 'show', this.unit, '--property=MainPID']).stdout).MainPID)
    if (!(main > 0)) return { ok: true }
    // --kill-who: systemd 252 renamed it --kill-whom and kept this spelling, which older ones know.
    return this.systemctl('kill', '--kill-who=main', '--signal=SIGTERM', this.unit)
  }

  /** Stop the master, unregister it and remove the definition. A unit whose file is already gone is
   *  stopped all the same. */
  unregister(): Outcome {
    if (this.os) return { ok: false, detail: OS_OWNS_IT }
    if (this.platform === 'taskscheduler') {
      // The daemon keeps running: Task Scheduler only ever started it.
      // Each task asked on its own: `inspect` counts the pair, and either may be there alone.
      const mainArgs = ['/Query', '/TN', this.target, '/XML']
      const main = this.deps.run('schtasks', mainArgs)
      // schtasks could not be asked (not there, or past COMMAND_TIMEOUT_MS): the task may still be registered, and
      // removing its file would leave a task that starts harnessd at every logon with nothing on disk to say so.
      if (main.error) return { ok: false, detail: failure('schtasks', mainArgs, main) }
      if (main.status === 0) {
        const deleted = this.checked('schtasks', ['/Delete', '/TN', this.target, '/F'])
        if (!deleted.ok) return deleted
      }
      // The logon task: asked on its own, as an install from before it had none, and one that stopped half way may
      // have only one of the two.
      const logonArgs = ['/Query', '/TN', this.logonTarget]
      const logon = this.deps.run('schtasks', logonArgs)
      if (logon.error) return { ok: false, detail: failure('schtasks', logonArgs, logon) }
      if (logon.status === 0) {
        const deleted = this.checked('schtasks', ['/Delete', '/TN', this.logonTarget, '/F'])
        if (!deleted.ok) return deleted
      }
      this.deps.removeFile(this.file)
      this.deps.removeFile(this.logonFile)
      this.deps.removeFile(this.stoppedFile)
      return { ok: true }
    }
    if (this.platform === 'launchd') {
      const stopped = this.stop()
      if (!stopped.ok) return stopped
      this.deps.removeFile(this.file)
      return { ok: true }
    }
    // `disable` without --now, then the master stopped by a signal: no stop job reaches the panes (see stop).
    if (this.installed()) {
      const disabled = this.systemctl('disable', SYSTEMD_UNIT)
      if (!disabled.ok) return disabled
    }
    const stopped = this.stop()
    if (!stopped.ok) return stopped
    this.deps.removeFile(this.file)
    const reloaded = this.systemctl('daemon-reload')
    // Forgets a failed state the unit left, so `systemctl --user --failed` does not list a unit that is gone.
    this.deps.run('systemctl', ['--user', 'reset-failed', SYSTEMD_UNIT])
    return reloaded
  }

  /** Remove the definition and nothing else: an install that could not register leaves nothing half
   *  done, so `harness start` runs the daemon as it did before. */
  discard(): void {
    if (this.os) return
    this.deps.removeFile(this.file)
    if (this.platform === 'taskscheduler') this.deps.removeFile(this.logonFile)
    // Best effort: a manager that could not take the unit may not take a reload either.
    if (this.platform === 'systemd') this.deps.run('systemctl', ['--user', 'daemon-reload'])
  }

  /** systemd: whether the user manager lingers. Unknown when loginctl cannot say. */
  private linger(): boolean | null {
    const result = this.deps.run('loginctl', ['show-user', String(this.deps.uid), '--property=Linger'])
    if (result.status !== 0) return null
    const value = properties(result.stdout).Linger
    return value === 'yes' ? true : value === 'no' ? false : null
  }

  private launchctl(...args: string[]): CommandResult {
    return this.deps.run('launchctl', args)
  }

  private systemctl(...args: string[]): Outcome {
    return this.checked('systemctl', ['--user', ...args])
  }

  private checked(command: string, args: string[]): Outcome {
    const result = this.deps.run(command, args)
    return result.status === 0 && !result.error ? { ok: true } : { ok: false, detail: failure(command, args, result) }
  }
}
