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
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export type PlatformName = 'launchd' | 'systemd'

/**
 * Set by the definition, so the master knows the platform runs it and says so in its status file. The
 * CLI does not read it from its own environment: a shell in a tmux pane the daemon started inherits it,
 * and would otherwise believe it was the platform.
 */
export const PLATFORM_ENV = 'HARNESSD_PLATFORM'

export const LAUNCHD_LABEL = 'ai.autonomous.harness.harnessd'
export const SYSTEMD_UNIT = 'harnessd.service'

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

/** The platform that would supervise harnessd on this operating system; null where neither runs. */
export function platformFor(os: NodeJS.Platform): PlatformName | null {
  return os === 'darwin' ? 'launchd' : os === 'linux' ? 'systemd' : null
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
  /** Write whole and rename into place, making the folder first. */
  writeFile(path: string, content: string): void
  removeFile(path: string): void
  uid: number
  home: string
  /** `$XDG_CONFIG_HOME`, where systemd looks for user units first; `~/.config` when unset. */
  configHome?: string
}

/** This process's user id; 0 where Node has no notion of one. */
export function currentUid(proc: { getuid?: () => number } = process): number {
  return typeof proc.getuid === 'function' ? proc.getuid() : 0
}

/**
 * The real thing: commands looked up on `env.PATH` (Node searches the PATH of the environment it is
 * given), files on disk. The tests hand it a PATH holding only fake binaries and a temporary home.
 */
export function defaultPlatformDeps(options: { env?: NodeJS.ProcessEnv; uid?: number; home?: string } = {}): PlatformDeps {
  const env = options.env ?? process.env
  const configHome = env.XDG_CONFIG_HOME
  return {
    run: (command, args) => {
      // `launchctl print` lists the whole job, and a domain's listing runs to hundreds of kilobytes.
      const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 })
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) }
    },
    readFile: (path) => { try { return readFileSync(path, 'utf8') } catch { return null } },
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.tmp`
      // Not writable by others: launchd skips a plist with "dubious permissions".
      writeFileSync(temp, content, { mode: 0o644 })
      renameSync(temp, path)
    },
    removeFile: (path) => rmSync(path, { force: true }),
    uid: options.uid ?? currentUid(),
    home: options.home ?? homedir(),
    ...(configHome && isAbsolute(configHome) ? { configHome } : {}),
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
  constructor(readonly platform: PlatformName, private readonly deps: PlatformDeps) {}

  /** Where the definition lives. */
  get file(): string {
    return this.platform === 'launchd'
      ? join(this.deps.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
      : join(this.deps.configHome ?? join(this.deps.home, '.config'), 'systemd', 'user', SYSTEMD_UNIT)
  }

  /** What launchctl or systemctl is told to act on. */
  get target(): string {
    return this.platform === 'launchd' ? `gui/${this.deps.uid}/${LAUNCHD_LABEL}` : SYSTEMD_UNIT
  }

  render(definition: ServiceDefinition): string {
    return this.platform === 'launchd' ? launchdPlist(definition) : systemdUnit(definition)
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
    const content = this.deps.readFile(this.file)
    if (content === null) return false
    return this.platform === 'launchd'
      ? content.includes(`<key>StandardOutPath</key>\n\t<string>${xml(logFile)}</string>\n`)
      : content.includes(`\nStandardOutput=append:${pathValue(logFile)}\n`)
  }

  /** The definition on disk is the one this install would write. */
  current(definition: ServiceDefinition): boolean {
    return this.deps.readFile(this.file) === this.render(definition)
  }

  /** Write the definition when it differs from the one on disk; says whether it did. */
  write(definition: ServiceDefinition): boolean {
    const content = this.render(definition)
    if (this.deps.readFile(this.file) === content) return false
    this.deps.writeFile(this.file, content)
    return true
  }

  inspect(): PlatformState {
    const base = { platform: this.platform, file: this.file, target: this.target, installed: this.installed(), linger: null, unreachable: null }
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
    const args = ['--user', 'show', SYSTEMD_UNIT, '--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,Result']
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
      registered: shown.UnitFileState === 'enabled',
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
    if (this.platform === 'launchd') {
      const result = this.launchctl('print', `gui/${this.deps.uid}`)
      return result.status === 0 ? { ok: true } : { ok: false, detail: `${failure('launchctl', ['print', `gui/${this.deps.uid}`], result)} — launchd runs a user agent only for a user logged in at the screen` }
    }
    return this.systemctl('daemon-reload')
  }

  /** Register the definition just written, which starts the master: launchd loads the job (RunAtLoad),
   *  systemd enables the unit and starts it. */
  register(): Outcome {
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
    this.deps.run('systemctl', ['--user', 'reset-failed', SYSTEMD_UNIT])
    return this.systemctl('start', SYSTEMD_UNIT)
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
    if (this.platform === 'launchd') {
      if (this.launchctl('print', this.target).status !== 0) return { ok: true }
      return this.checked('launchctl', ['bootout', this.target])
    }
    const main = Number(properties(this.deps.run('systemctl', ['--user', 'show', SYSTEMD_UNIT, '--property=MainPID']).stdout).MainPID)
    if (!(main > 0)) return { ok: true }
    // --kill-who: systemd 252 renamed it --kill-whom and kept this spelling, which older ones know.
    return this.systemctl('kill', '--kill-who=main', '--signal=SIGTERM', SYSTEMD_UNIT)
  }

  /** Stop the master, unregister it and remove the definition. A unit whose file is already gone is
   *  stopped all the same. */
  unregister(): Outcome {
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
    this.deps.removeFile(this.file)
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
