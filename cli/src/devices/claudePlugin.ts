/**
 * Claude Code's harness-device plugin: whether it is installed and on, and installing, turning on, updating or
 * uninstalling it, all through Claude Code's own `claude plugin` commands. Harness never writes Claude Code's settings
 * itself. It runs in the `harness` command's own process (`harness device claude …`) and in the devices' process, which
 * sets the plugin up once a dial has attached. On Windows that is the core's process, where the devices run through the
 * inline door (services/inline.ts `startDevices`) until Windows services run in their own process; elsewhere never the
 * core's.
 */
import { type ChildProcess, execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { agentCommandOwnershipSnapshotAsync, ENGINE_CLI_ALIASES, enginePathOverride, executableFileIdentity, installedEngineBin } from '../lib/engineBin.js'
import { ENGINE_INSTALL, engineInstallPaths } from '../lib/engineInstall.js'
import { windowsProgram } from '../lib/windows/program.js'
import { DIAL_PLUGIN_ID } from './dialSkill.js'

export const MARKETPLACE = 'openharness'
export const MIN_CLAUDE = '2.1.287'

/** A call's exit code (null: it did not exit, as at a kill) and what it wrote. [refused]: on Windows a batch file
 *  Harness does not run (claudeRunner), so nothing ran. */
export interface ClaudeAnswer { code: number | null; stdout: string; stderr: string; refused?: true }
export type ClaudeRun = (args: string[], timeoutMs: number) => Promise<ClaudeAnswer>

export interface ClaudeDeps {
  run: ClaudeRun | null
  platform: NodeJS.Platform
}

export interface ClaudeStatus {
  supported: boolean
  installed: boolean
  enabled: boolean
  claudeVersion: string | null
}

/** Which call failed: a fixed word the devices count, where Claude Code's own line could name a path. */
export type ClaudeStep = 'unsupported' | 'launcher' | 'list' | 'marketplace' | 'install' | 'enable' | 'disable' | 'uninstall' | 'update'
export type ClaudeResult = { ok: true } | { ok: false; error: string; step: ClaudeStep }
/** What the devices' setup did: installed or updated the plugin; found it current, on as it should be; or found it absent,
 *  not on as the person left it, and ran nothing for it. */
export type ClaudeSetup = { ok: true; outcome: 'installed' | 'updated' | 'current' | 'absent' } | { ok: false; error: string; step: ClaudeStep }
type ClaudeFailure = Extract<ClaudeResult, { ok: false }>

/** The marketplace add, its update, the install and the plugin's update fetch the repository; every other call only
 *  reads or writes local settings. */
const FETCH_MS = 60_000
const LOCAL_MS = 15_000
/** `claude plugin list --json` grows with every installed plugin; past this the output is not ours to read. */
const MAX_OUTPUT_BYTES = 1024 * 1024
const UNSUPPORTED: ClaudeFailure = { ok: false, error: `Claude Code ${MIN_CLAUDE} or later is needed.`, step: 'unsupported' }
const LAUNCHER: ClaudeFailure = { ok: false, error: 'Harness cannot run this claude launcher.', step: 'launcher' }
const NO_ANSWER = 'Claude Code did not answer.'
const UNLISTED = 'Claude Code did not list its plugins.'

/** [bin] run with no shell, its stdin closed; [env] the child's environment, the process's own by default. Its time
 *  ends it with SIGKILL, as the engine lookup's shell: a `claude` that does not end on TERM would hold the pass. On
 *  Windows an npm install's `claude.cmd` is started as the program it runs, hidden; a batch file that is not such a
 *  shim only cmd.exe could run, and is refused. */
export function claudeRunner(bin: string, env?: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): ClaudeRun {
  return (args, timeoutMs) => new Promise((resolve) => {
    let program
    try {
      program = windowsProgram(bin, args, { platform, environment: env ?? process.env })
    } catch {
      resolve({ code: null, stdout: '', stderr: '', refused: true })
      return
    }
    let answered = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    const answer = (result: ClaudeAnswer): void => {
      if (answered) return
      answered = true
      clearTimeout(deadline)
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = execFile(program.file, program.args,
        { encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, env: program.env ?? env, windowsHide: true },
        (error, stdout, stderr) => {
          // A missing file or output past the bound has no exit code: it is no answer.
          const code = !error ? 0 : typeof error.code === 'number' ? error.code : null
          answer({ code, stdout, stderr })
        })
    } catch {
      // A start the system refuses at once (ENOTDIR, EINVAL) throws rather than emits: no answer, and no time to end.
      answer({ code: null, stdout: '', stderr: '' })
      return
    }
    // Killed, and answered by itself, as orcaHomes' run: a child stuck where even SIGKILL waits never closes, and
    // execFile answers only at its close.
    if (!answered) deadline = setTimeout(() => {
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
      answer({ code: null, stdout: '', stderr: '' })
    }, timeoutMs)
    // Nothing is asked on stdin: a `claude` that waits for it would only run out its time.
    child.stdin?.end()
  })
}

/** The Claude Code binary as Harness finds it for its own agents, run with no shell; null when it is not installed. */
export function claudeRun(): ClaudeRun | null {
  const bin = claudeInstalled()
  return bin ? claudeRunner(bin) : null
}

/** Claude Code as claudeRun() finds it, pointed at [home] on this child alone. null: no `claude`. */
export function claudeRunIn(home: string): ClaudeRun | null {
  const bin = claudeInstalled()
  return bin ? claudeRunner(bin, pointedAt(home, process.env)) : null
}

/** engineBin's lookup names a file as it is spelled, and on Windows `claude` is `claude.exe` or an npm `claude.cmd`:
 *  there the nearby lookup, which tries Windows' extensions, finds it on PATH and where the installers put it. */
function claudeInstalled(): string | null {
  return process.platform === 'win32' ? claudeNearby() : installedEngineBin('claude')
}

/** [env] for a child pointed at [home]: ~/.claude is Claude Code's own default, which it reads with no CLAUDE_CONFIG_DIR. */
function pointedAt(home: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const pointed = { ...env }
  if (home === join(homedir(), '.claude')) delete pointed.CLAUDE_CONFIG_DIR
  else pointed.CLAUDE_CONFIG_DIR = home
  return pointed
}

/**
 * Claude Code where the daemon's lookup looks with no shell started: its override, the devices' own PATH and the folders
 * its installer uses. Not engineBin's synchronous lookup: once its last read of the login shell failed, it starts the
 * shell again.
 */
function claudeNearby(): string | null {
  for (const command of [enginePathOverride('claude'), ...ENGINE_CLI_ALIASES.claude, ...engineInstallPaths(ENGINE_INSTALL.claude)]) {
    const bin = command && resolveBinaryOnPath(command, process.env, (path) => executableFileIdentity(path) !== null)
    if (bin) return bin
  }
  return null
}

/**
 * Claude Code as the daemon finds it for its own agents; null when it is not on this computer or the lookup failed.
 * With [shell] the lookup reads the person's interactive PATH, which the devices' own (launchd's bare one) may lack, by
 * starting their login shell; without it, it looks only where no shell is started. Windows has no login shell to read,
 * and the devices there have the person's own PATH: both look where no shell is started (claudeInstalled). The child
 * gets the folder `claude` is in first, so an npm install's `#!/usr/bin/env node` finds the node beside it. It is
 * pointed at [home] whatever CLAUDE_CONFIG_DIR the daemon was started with (an Orca profile's shell), so the plugin goes
 * into the home whose settings the devices read; ~/.claude is Claude Code's own default and needs none.
 */
export async function claudeFound(home: string, shell: boolean): Promise<ClaudeRun | null> {
  let bin: string | null
  try {
    bin = shell && process.platform !== 'win32' ? installedEngineBin('claude', await agentCommandOwnershipSnapshotAsync()) : claudeNearby()
  } catch {
    return null
  }
  if (!bin) return null
  return claudeRunner(bin, pointedAt(home, { ...process.env, PATH: [dirname(bin), process.env.PATH].filter(Boolean).join(delimiter) }))
}

const VERSION = /(\d+)\.(\d+)\.(\d+)/

/** By number, part by part: 2.10.0 is after 2.9.0. */
function atLeast(version: string, min: string): boolean {
  const [a, b] = [VERSION.exec(version)!, VERSION.exec(min)!].map((match) => match.slice(1).map(Number))
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

const askVersion = (run: ClaudeRun): Promise<ClaudeAnswer> => run(['--version'], LOCAL_MS)

/** On Windows `claude` on PATH can be the Claude desktop app's `Claude.exe`, whose `--version` names no Claude Code and
 *  whose every other call opens its window: an answer there without "Claude Code" is the app's, and it is asked nothing
 *  more. No answer (a kill, a failed start, an exit not 0) is not the app's: it says nothing of what runs. */
function desktopApp({ code, stdout }: ClaudeAnswer, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && code === 0 && !stdout.includes('Claude Code')
}

/** Claude Code's version in its `--version` [answer]; null for no answer, none in it, or the desktop app's. */
function versionIn(answer: ClaudeAnswer, platform: NodeJS.Platform): string | null {
  return answer.code !== 0 || desktopApp(answer, platform) ? null : VERSION.exec(answer.stdout)?.[0] ?? null
}

function supports(platform: NodeJS.Platform, claudeVersion: string | null): boolean {
  return (platform === 'darwin' || platform === 'linux' || platform === 'win32') && !!claudeVersion && atLeast(claudeVersion, MIN_CLAUDE)
}

/** [run] when its Claude Code can take the plugin, asked with one `--version`: an old one is asked nothing more, nor a
 *  launcher Harness does not run. */
async function supportedRun({ run, platform }: ClaudeDeps): Promise<ClaudeRun | ClaudeFailure> {
  if (!run) return UNSUPPORTED
  const answer = await askVersion(run)
  if (answer.refused) return LAUNCHER
  return supports(platform, versionIn(answer, platform)) ? run : UNSUPPORTED
}

/** [run], and on Windows only once its `--version` answered: the desktop app's answer has nothing of Claude Code's to
 *  take out (null), and no answer is a failure, as a list that cannot be read is, so an undo owed stays owed. */
async function claudeCodeRun({ run, platform }: ClaudeDeps): Promise<ClaudeRun | ClaudeFailure | null> {
  if (!run || platform !== 'win32') return run
  const answer = await askVersion(run)
  if (answer.refused) return LAUNCHER
  if (answer.code !== 0) return failure(answer.stderr, 'list')
  return desktopApp(answer, platform) ? null : run
}

/** A call's failure: the first line Claude Code wrote about it, or [none] when it wrote nothing. */
function failure(stderr: string, step: ClaudeStep, none = NO_ANSWER): ClaudeFailure {
  return { ok: false, error: stderr.split('\n').map((line) => line.trim()).find(Boolean) ?? none, step }
}

/** A list that failed, ran out of time or is not JSON says nothing of what is there: a failure, never an empty list. */
async function jsonList(run: ClaudeRun, args: string[]): Promise<Record<string, unknown>[] | ClaudeFailure> {
  const { code, stdout, stderr } = await run(args, LOCAL_MS)
  if (code === 0) {
    try {
      const value: unknown = JSON.parse(stdout)
      if (Array.isArray(value)) return value.filter((entry) => !!entry && typeof entry === 'object')
    } catch { /* not JSON: the failure below */ }
  }
  return failure(stderr, 'list', UNLISTED)
}

/** A project-scope entry turns the plugin on for one repository only; the dial needs it in every session. */
async function userEntry(run: ClaudeRun): Promise<{ ok: true; entry?: Record<string, unknown> } | ClaudeFailure> {
  const plugins = await jsonList(run, ['plugin', 'list', '--json'])
  if (!Array.isArray(plugins)) return plugins
  return { ok: true, entry: plugins.find((plugin) => plugin.id === DIAL_PLUGIN_ID && plugin.scope === 'user') }
}

/** A list that cannot be read shows the plugin as not installed: the status has no failure to give. */
export async function claudeStatus({ run, platform }: ClaudeDeps): Promise<ClaudeStatus> {
  const none: ClaudeStatus = { supported: false, installed: false, enabled: false, claudeVersion: null }
  if (!run) return none
  const answer = await askVersion(run)
  if (desktopApp(answer, platform)) return none
  const claudeVersion = versionIn(answer, platform)
  const listed = await userEntry(run)
  const entry = listed.ok ? listed.entry : undefined
  return { supported: supports(platform, claudeVersion), installed: !!entry, enabled: entry?.enabled === true, claudeVersion }
}

/** Runs one call that changes something; a failure is the first line Claude Code wrote about it, and the call's step. */
async function change(run: ClaudeRun, args: string[], timeoutMs: number, step: ClaudeStep): Promise<ClaudeFailure | null> {
  const { code, stderr } = await run(args, timeoutMs)
  return code === 0 ? null : failure(stderr, step)
}

/** Adds the marketplace when it is not there, then installs the plugin. */
async function install(run: ClaudeRun): Promise<ClaudeFailure | null> {
  // Marketplaces that cannot be read are taken as none: at worst the add runs again, and its own failure is counted.
  const marketplaces = await jsonList(run, ['plugin', 'marketplace', 'list', '--json'])
  const cloned = Array.isArray(marketplaces) && marketplaces.some((marketplace) => marketplace.name === MARKETPLACE)
  if (!cloned) {
    // Only the two folders the plugin lives in: the rest of the repository is never cloned onto the person's computer.
    const failed = await change(run, ['plugin', 'marketplace', 'add', 'autonomous-ai/openharness', '--sparse', '.claude-plugin', 'plugins'], FETCH_MS, 'marketplace')
    if (failed) return failed
  }
  const tryInstall = () => change(run, ['plugin', 'install', DIAL_PLUGIN_ID, '--scope', 'user'], FETCH_MS, 'install')
  let failed = await tryInstall()
  // A clone made before harness-device was in the marketplace does not list it: pulled once, the install is tried again.
  if (failed && cloned) failed = await change(run, ['plugin', 'marketplace', 'update', MARKETPLACE], FETCH_MS, 'marketplace') ?? await tryInstall()
  return failed
}

export async function claudeEnable(deps: ClaudeDeps): Promise<ClaudeResult> {
  const run = await supportedRun(deps)
  if (typeof run !== 'function') return run
  const listed = await userEntry(run)
  if (!listed.ok) return listed
  if (!listed.entry) return await install(run) ?? { ok: true }
  if (listed.entry.enabled === true) return { ok: true }
  return await change(run, ['plugin', 'enable', DIAL_PLUGIN_ID, '--scope', 'user'], LOCAL_MS, 'enable') ?? { ok: true }
}

/** The devices' first setup: the plugin installed as enable installs it, and one already there left as it is. One the
 *  person turned off is theirs: only `harness device claude enable` turns it back on. */
export async function claudeSetUp(deps: ClaudeDeps): Promise<ClaudeSetup> {
  const run = await supportedRun(deps)
  if (typeof run !== 'function') return run
  const listed = await userEntry(run)
  if (!listed.ok) return listed
  if (listed.entry) return { ok: true, outcome: listed.entry.enabled === true ? 'current' : 'absent' }
  return await install(run) ?? { ok: true, outcome: 'installed' }
}

/** Uninstalls the plugin and keeps the marketplace, which the harness plugin may come from too. */
export async function claudeDisable(deps: ClaudeDeps): Promise<ClaudeResult> {
  const run = await claudeCodeRun(deps)
  if (!run) return { ok: true }
  if (typeof run !== 'function') return run
  const listed = await userEntry(run)
  if (!listed.ok) return listed
  if (!listed.entry) return { ok: true }
  return await change(run, ['plugin', 'uninstall', DIAL_PLUGIN_ID, '--scope', 'user'], LOCAL_MS, 'uninstall') ?? { ok: true }
}

/*
 * A home that shares `plugins/` with the default home (an Orca account's) only ever has the plugin turned on or off:
 * an uninstall there removes the files every home names, and the other homes' entries then stay on with nothing to
 * turn off (check 8). Installs, updates and the uninstall are the default home's alone.
 */

/** Turns the plugin on in a home that shares `plugins/` with the default home (an Orca account's): its files are
 *  there already, so only this home's settings change. One already on there runs nothing more. */
export async function claudeHomeEnable(deps: ClaudeDeps): Promise<ClaudeResult> {
  const run = await supportedRun(deps)
  if (typeof run !== 'function') return run
  const listed = await userEntry(run)
  if (!listed.ok) return listed
  if (listed.entry?.enabled === true) return { ok: true }
  return await change(run, ['plugin', 'enable', DIAL_PLUGIN_ID, '--scope', 'user'], LOCAL_MS, 'enable') ?? { ok: true }
}

/** Turns it off in such a home's settings and leaves its files: an uninstall here would remove what every home names. */
export async function claudeHomeDisable(deps: ClaudeDeps): Promise<ClaudeResult> {
  const run = await claudeCodeRun(deps)
  if (!run) return { ok: true }
  if (typeof run !== 'function') return run
  const listed = await userEntry(run)
  if (!listed.ok) return listed
  if (listed.entry?.enabled !== true) return { ok: true }
  return await change(run, ['plugin', 'disable', DIAL_PLUGIN_ID, '--scope', 'user'], LOCAL_MS, 'disable') ?? { ok: true }
}

/**
 * Brings the plugin to what the marketplace holds now. Its manifest carries no version, so the one `plugin list` gives
 * changes with what was pulled: a new one is an update. A plugin the person uninstalled or turned off is theirs, and
 * nothing is run for it.
 */
export async function claudeUpdate(deps: ClaudeDeps): Promise<ClaudeSetup> {
  const run = await supportedRun(deps)
  if (typeof run !== 'function') return run
  const before = await userEntry(run)
  if (!before.ok) return before
  if (before.entry?.enabled !== true) return { ok: true, outcome: 'absent' }
  const failed = await change(run, ['plugin', 'marketplace', 'update', MARKETPLACE], FETCH_MS, 'marketplace')
    ?? await change(run, ['plugin', 'update', DIAL_PLUGIN_ID, '--scope', 'user'], FETCH_MS, 'update')
  if (failed) return failed
  const after = await userEntry(run)
  if (!after.ok) return after
  return { ok: true, outcome: after.entry !== undefined && after.entry.version !== before.entry.version ? 'updated' : 'current' }
}
