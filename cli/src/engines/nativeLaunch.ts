/** Eager preparation shared by every way core starts a native engine. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { engineName } from '../lib/agentNames.js'
import { failureReason } from '../lib/failureReason.js'
import { permissionFlagToVerify, type PermissionLaunchChoice } from '../lib/engineLaunch.js'
import type { EngineInstallRecipe } from '../lib/engineInstall.js'
import { patientDeadline } from '../lib/patientExec.js'
import { windowsEngineArgv } from '../lib/windows/launch.js'
import { engineHooks } from './hooks.js'
import * as hooks from './nativeHooks.js'
import { captureLaunchExecutable, LAUNCH_LOCATION_VARIABLES } from './kit/launchExecutable.js'
import { homeIsNetworkOrDevice, networkHomeSentence } from './kit/homeAdoption.js'
import { startupOwnedFlag } from './kit/launchStartup.js'
import { launchContract } from './launches.js'
import type { HookPreparationProof } from './kit/nativeHookFiles.js'
import { nativeHookLocations, nativeProcessEnvironment, type NativeHookOptions } from './kit/nativeLocations.js'
import { parseMajor, type NativeExecutableSnapshot } from './kit/nativeVersion.js'
import { OPENCLAW_LAUNCH, OPENCLAW_RUNTIME_PROBE, openclawRuntimeState } from './openclaw/contract.js'
import { OPENCODE_VERSION } from './opencode/contract.js'
import { type AgentEngine, isTerminalEngine } from './types.js'

export interface NativeLaunchSource extends PermissionLaunchChoice {
  codexHome?: string | null
  hermesHome?: string | null
  claudeHome?: string | null
  /** An OpenClaw run's own `--local` state folder, an absolute path; ignored by every other engine. */
  openclawLocal?: string | null
}
export interface NativeLaunch {
  token?: string
  /** The `--local` folder this OpenClaw launch runs on: its argv gets `--local`, its pane this folder as its state. */
  readonly openclawLocal?: string
  executable?: NativeExecutableSnapshot
  opencodeMajor: number | null
  /** Set again after the pane's rc files, before the exact prepared executable. */
  readonly environment: Readonly<Record<string, string>>
  readonly clearEnvironment?: readonly string[]
  readonly proofs: readonly HookPreparationProof[]
  /**
   * Windows: what the engine's declared startup puts first in its argv (Codex's `--no-daemon` when its help lists it),
   * read from this executable's help at inspection, since no launch script probes it there (lib/windows/engineStart.ts).
   * Absent elsewhere, and for an engine that declares no startup probe.
   */
  readonly startupArgs?: readonly string[]
  retain?(proof: HookPreparationProof): boolean
  ready?(): boolean
  current(): boolean
  prepareHooks(port: number, current: () => boolean, environment?: Readonly<Record<string, string>>, clear?: readonly string[]): Promise<boolean>
  permission(choice: PermissionLaunchChoice): Promise<'supported' | 'unsupported' | 'unknown'>
}
export type NativeLaunchResult =
  | { ok: true; launch: NativeLaunch }
  | { ok: false; error: 'NATIVE_LAUNCH_HELD'; unavailable: 'native'; detail: string; install?: EngineInstallRecipe; environment?: Record<string, string>
      /** No wait ends this by itself: the selected executable ran and failed, or this request's own installer
       *  did. A creation is refused with this code rather than held (core/agents/create.ts); a relaunch,
       *  which nobody is waiting on, still holds. */
      refusal?: 'ENGINE_CANNOT_RUN' | 'ENGINE_INSTALL_FAILED' | 'ENGINE_LAUNCH_REFUSED'
      /** Harness is installing the engine for this launch (engines/prepareNativeLaunch.ts). */
      installing?: true }
const waiting = (detail: string): Extract<NativeLaunchResult, { ok: false }> => ({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail })
const cannotRun = (engine: AgentEngine, reason: string): Extract<NativeLaunchResult, { ok: false }> =>
  ({ ...waiting(`${engineName(engine)} is installed but cannot run: ${reason}`), refusal: 'ENGINE_CANNOT_RUN' })
const noNative: NativeLaunch = {
  opencodeMajor: null, environment: {}, proofs: [], current: () => true,
  prepareHooks: async () => true, permission: async () => 'supported',
}

let probes = 0
/** What a probe's child said, once it exited by itself. A kill at its deadline, a signal, an output limit or a
 *  child that never started is no answer at all: null. */
interface ProbeOutput { code: number; stdout: string; stderr: string }
/** Slots follow actual subprocess settlement, including deadline and output-limit kills. */
async function read(executable: string, args: readonly string[], environment: Readonly<Record<string, string>>): Promise<ProbeOutput | null> {
  if (probes >= 8) return null
  probes++
  return new Promise(done => {
    let settled = false, answered = false
    let cancelDeadline = () => {}
    let drain: ReturnType<typeof setTimeout> | undefined
    const answer = (output: ProbeOutput | null) => { if (!answered) { answered = true; done(output) } }
    let child: ReturnType<typeof execFile>
    try {
      // Windows starts an npm shim's script under node, never the shim through cmd.exe, which Node refuses to run
      // without a shell (lib/windows/launch.ts); elsewhere [executable] as it is.
      const [program, ...programArgs] = windowsEngineArgv('the engine', [executable, ...args], { environment: nativeProcessEnvironment(environment) })
      // Node's timeout can discard unread output after a core stall, then
      // report exit 0. Keep its pipes and use discovery's patient deadline.
      child = execFile(program!, programArgs, {
        env: nativeProcessEnvironment(environment), encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
      }, (error, stdout, stderr) => {
        settled = true; probes--; cancelDeadline(); clearTimeout(drain)
        // A numeric code is the child's own exit status. A spawn failure, a signal or the output
        // limit leaves a string or null there, and says nothing about the executable itself. A child that
        // exited by itself as its deadline passed answered all the same: only a live one is killed below.
        const code = !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
        answer(code === null ? null : { code, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    } catch { probes--; answer(null); return }
    if (!settled) cancelDeadline = patientDeadline(5_000, () => {
      // An exited wrapper may leave a descendant holding its pipes. Signal
      // only our still-live child, then close our pipe ends after a short drain.
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') } catch { /* The reply still holds. */ }
      drain = setTimeout(() => {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()
        // An uninterruptible child retains its slot until the actual callback.
        answer(null)
      }, 250)
    })
    child.stdin?.end()
  })
}

/** Each engine executable's help, by the file's identity (its path, inode, size and times: kit/nativeVersion.ts) and the
 *  PATH it runs under. Its help, and that it runs at all, are facts about the installed file, not one launch: launches that
 *  ask together share one probe, and a held pass of many agents (a restore, a Swarm's agents) never meets the probes' cap,
 *  nor does a relaunch or fork ask twice. Not keyed on the homes: help does not read them, and a Swarm agent's own home
 *  would bring the cap back. Only help the engine printed is kept, for a minute: an engine can break around its unchanged
 *  file (its Node uninstalled), and a launch after that is refused with its reason again. No answer or a failure is asked
 *  again. A new install, an upgrade or a finished download is a new identity, asked afresh. */
const helps = new Map<string, { help: Promise<ProbeOutput | null>; at: number }>()
const HELP_LIFE_MS = 60_000
/** At most this many installs, each under the PATH it runs with; beyond it the oldest goes. */
const HELP_LIMIT = 32
function helpOf(executable: NativeExecutableSnapshot, environment: Readonly<Record<string, string>>,
  args: readonly string[] = ['--help']): Promise<ProbeOutput | null> {
  const key = `${executable.identity}\0${environment.PATH ?? ''}\0${args.join(' ')}`, at = performance.now()
  const known = helps.get(key)
  if (known && at - known.at < HELP_LIFE_MS) return known.help
  helps.delete(key)
  const help = read(executable.command, args, environment)
  if (helps.size >= HELP_LIMIT) helps.delete(helps.keys().next().value!)
  helps.set(key, { help, at })
  void help.then(output => {
    const printed = output?.code === 0 && `${output.stdout}${output.stderr}`.trim() && executable.current()
    if (!printed && helps.get(key)?.help === help) helps.delete(key)
  })
  return help
}

/** The location variables every engine's homes derive from. */
const SHARED_LOCATIONS: ReadonlySet<string> = new Set(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'])
/** The variables `nativeHookLocations` derives each engine's own homes from (kit/nativeLocations.ts). */
const ENGINE_LOCATIONS: Partial<Record<string, readonly string[]>> = {
  claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR'],
  codex: ['CODEX_HOME'],
  opencode: ['OPENCODE_PLUGIN_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'OPENCODE_DATA_DIR', 'OPENCODE_DB'],
  kilo: ['KILO_PLUGIN_DIR'],
  pi: ['PI_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'],
  hermes: ['HERMES_HOME'],
  copilot: ['COPILOT_HOME'],
  commandcode: ['COMMANDCODE_HOME'],
  cursor: ['CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'CURSOR_HOME'],
  grok: ['GROK_HOME'],
  agy: ['AGY_HOME', 'AGY_CONFIG_DIR'],
  devin: ['DEVIN_HOME', 'DEVIN_CONFIG_PATH'],
  amp: ['AMP_PLUGIN_DIR'],
  openclaw: ['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME'],
}

/** Probe only. No settings, workspace, model or process mutation occurs here. */
export async function inspectNativeLaunch(engine: AgentEngine, source: NativeLaunchSource = {},
  deps: { confirmHome?: (engine: 'claude' | 'codex', home: string) => void } = {},
): Promise<NativeLaunchResult> {
  if (isTerminalEngine(engine)) return { ok: true, launch: { ...noNative, environment: {}, proofs: [] } }
  source = { ...source }
  const captured = await captureLaunchExecutable(engine)
  if (captured.state === 'held') return waiting(captured.detail)
  if (captured.state === 'install') return { ...waiting(`Waiting for ${engine} to be installed before preparing its launch.`), install: captured.recipe, environment: captured.environment }
  const { executable } = captured
  const selected: Record<string, string> = Object.fromEntries(Object.entries(captured.environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
  if (source.codexHome) selected.CODEX_HOME = source.codexHome
  if (source.claudeHome) selected.CLAUDE_CONFIG_DIR = source.claudeHome
  if (source.hermesHome) selected.HERMES_HOME = source.hermesHome
  const openclawLocal = engine === 'openclaw' && source.openclawLocal ? source.openclawLocal : undefined
  if (openclawLocal) selected.OPENCLAW_STATE_DIR = openclawLocal
  // Windows: a network or device path is no engine home. A creation is refused with the sentence naming the setting.
  // Only the variables this engine's homes come from count: another engine's setting is no reason to refuse this one.
  for (const [key, path] of Object.entries(selected)) {
    if (path && SHARED_LOCATIONS.has(key) || (path && (ENGINE_LOCATIONS[engine] ?? []).includes(key))) {
      if (homeIsNetworkOrDevice(path)) return { ...waiting(networkHomeSentence(key, homedir())), refusal: 'ENGINE_LAUNCH_REFUSED' }
    }
  }
  // Empty location variables use their native default. Relative locations cannot
  // be prepared independently of a changing pane cwd.
  if (Object.entries(selected).some(([key, path]) => key !== 'PATH' && path && (!isAbsolute(path) || path.includes('\0') || path.length > 4096))) {
    return waiting('Waiting for absolute native engine locations.')
  }
  try { nativeHookLocations(selected) } catch { return waiting('Waiting to confirm native engine locations.') }
  const environment = Object.freeze(selected)
  const initialHomes = nativeHookLocations(environment)
  const implicitHome = engine === 'claude' && !source.claudeHome
    && initialHomes.CLAUDE_PROJECTS_DIR === join(initialHomes.CLAUDE_HOME, 'projects') ? initialHomes.CLAUDE_HOME
    : engine === 'codex' && !source.codexHome ? initialHomes.CODEX_HOME : null
  const output = engine === 'opencode' ? await read(executable.command, OPENCODE_VERSION.args, environment) : null
  // The version is read from standard output only, as it always was; help below reads both streams.
  const opencodeMajor = output?.code !== 0 ? null : parseMajor(OPENCODE_VERSION, output.stdout)
  if (output && output.code !== 0 && executable.current()) return cannotRun(engine, failureReason(`${output.stderr}\n${output.stdout}`, `it exited with status ${output.code}`))
  // Unknown is an observation of this attempt, never a permanent installed-file answer.
  if (engine === 'opencode' && opencodeMajor === null) return waiting('Waiting to confirm the selected OpenCode executable’s version.')
  // OpenClaw moves itself onto another Node it can find; on none, its TUI refuses to start. A creation is refused with
  // the named state rather than opening a pane that says so and exits. No answer is no evidence: the launch goes on.
  const runtime = engine === 'openclaw' ? await read(executable.command, OPENCLAW_RUNTIME_PROBE, environment) : null
  const runtimeState = runtime ? openclawRuntimeState(`${runtime.stderr}\n${runtime.stdout}`) : null
  if (runtime && executable.current() && (runtimeState || runtime.code !== 0)) {
    if (!runtimeState) return cannotRun(engine, failureReason(`${runtime.stderr}\n${runtime.stdout}`, `it exited with status ${runtime.code}`))
    console.warn(`[launch] openclaw refused · ${runtimeState}`)
    return { ...waiting(runtimeState), refusal: 'ENGINE_CANNOT_RUN' }
  }
  if (!executable.current()) return waiting('Waiting for the selected engine executable to stop changing.')
  // Windows: a program named claude that is not Claude Code, asked its version before anything else. The Claude
  // desktop app's own Claude.exe (reached through CLAUDE_PATH, or an older app's `claude` alias on PATH) answers
  // `--version` with its bare version (5.1231.2) at once, and `--help` by opening its window on the person's screen and
  // never exiting: every launch then held at "permission flags" for good (a customer, 2026-11-10; reproduced on
  // Windows 11, 2026-11-11). Claude Code says `2.1.322 (Claude Code)`. No answer is no evidence: the launch goes on.
  if (engine === 'claude' && process.platform === 'win32') {
    const version = await helpOf(executable, environment, ['--version'])
    const said = `${version?.stdout ?? ''}\n${version?.stderr ?? ''}`
    if (version?.code === 0 && said.trim() && !said.includes('Claude Code') && executable.current()) {
      return { ...waiting(notClaudeCode(executable.command, said)), refusal: 'ENGINE_CANNOT_RUN' }
    }
  }
  // Windows: the startup probe a launch script makes before every run elsewhere (engines/kit/launchStartup.ts), made
  // once here, of the executable this launch holds. No answer holds the launch, as the script ends one.
  const owned = process.platform === 'win32' ? startupOwnedFlag(launchContract(engine)) : null
  let startupArgs: readonly string[] | undefined
  if (owned) {
    const help = await helpOf(executable, environment)
    if (help && help.code !== 0 && executable.current()) return cannotRun(engine, failureReason(`${help.stderr}\n${help.stdout}`, `it exited with status ${help.code}`))
    if (!help || help.code !== 0 || !`${help.stdout}${help.stderr}`.trim()) return waiting('Waiting to confirm the selected executable’s startup options.')
    startupArgs = Object.freeze(helpLists(`${help.stdout}\n${help.stderr}`, owned.flag) ? [owned.flag] : [])
  }
  let proofs: readonly HookPreparationProof[] = [], selectedEnvironment = environment
  const dependencies: HookPreparationProof[] = []
  const dependenciesCurrent = () => dependencies.every(proof => proof.current())
  let preparing = false, valid = true, prepared = false, revision = 0
  const current = () => valid && !preparing && executable.current() && [...dependencies, ...proofs].every(proof => proof.current())
  /** Why the latest help probe's executable failed, when it ran and exited non-zero. */
  let failed: string | null = null
  const launch: NativeLaunch = {
    token: randomUUID(), executable, opencodeMajor, current, ready: () => prepared && current(), ...(startupArgs ? { startupArgs } : {}),
    ...(openclawLocal ? { openclawLocal } : {}),
    get environment() { return selectedEnvironment },
    get proofs() { return [...dependencies, ...proofs] },
    retain(proof) {
      if (!current() || dependencies.length >= 16 || !proof.current()) return false
      dependencies.push(proof); return true
    },
    get clearEnvironment() {
      const unset: string[] = LAUNCH_LOCATION_VARIABLES.filter(key => !(key in selectedEnvironment))
      // A local run's config, login and sessions all come from its folder, never from the owner's own OpenClaw paths.
      return openclawLocal ? [...unset, ...OPENCLAW_LAUNCH.localClear] : unset
    },
    async prepareHooks(port, owner, overrides = {}, clear = []) {
      if (preparing || !executable.current() || !owner() || !dependenciesCurrent()) return false
      preparing = true; valid = false; const attemptRevision = ++revision
      try {
        const chosen = { ...selectedEnvironment }
        for (const key of clear) if (LAUNCH_LOCATION_VARIABLES.includes(key as typeof LAUNCH_LOCATION_VARIABLES[number])) delete chosen[key]
        for (const key of LAUNCH_LOCATION_VARIABLES) if (overrides[key] !== undefined) chosen[key] = overrides[key]
        if (Object.entries(chosen).some(([key, path]) => key !== 'PATH' && path && (!isAbsolute(path) || path.includes('\0') || path.length > 4096))) return false
        const homes = nativeHookLocations(chosen)
        const confirmed: HookPreparationProof[] = []
        const options: NativeHookOptions = { environment: chosen,
          current: () => preparing && revision === attemptRevision && executable.current() && owner() && dependenciesCurrent(),
          confirmed: proof => confirmed.push(proof) }
        const home = engine === 'codex' ? homes.CODEX_HOME : engine === 'claude' ? homes.CLAUDE_HOME : homes.HERMES_HOME
        const installed = port === 0 ? true : engine === 'claude' || engine === 'codex' ? await engineHooks[engine].installIn(port, home, options)
          : engine === 'hermes' ? await hooks.installHermesHooks(port, home, options)
          : engine === 'opencode' ? await hooks.installOpencodePlugin(port, { ...executable, major: opencodeMajor! }, options)
          : await installers[engine]?.(port, options) ?? true
        if (!installed || !executable.current() || !owner() || [...dependencies, ...confirmed].some(proof => !proof.current())) return false
        // A login shell can move the session store without an explicit profile.
        // Codex's explicit/generated profiles belong to their registry row;
        // adopting them globally would refresh a held package's hooks at boot
        // before its Store dependencies are ready.
        if ((engine === 'claude' || engine === 'codex') && home === implicitHome) deps.confirmHome?.(engine, home)
        // A Claude profile is adopted too, or its transcripts fall outside every root and the agent never binds.
        else if (engine === 'claude' && source.claudeHome === home) deps.confirmHome?.(engine, home)
        if (!executable.current() || !owner() || [...dependencies, ...confirmed].some(proof => !proof.current())) return false
        // The command locations and the proofs become dispatch authority together.
        // A failed or pending replacement can never expose B with A's proof set.
        selectedEnvironment = Object.freeze(chosen); proofs = Object.freeze(confirmed)
        valid = true; prepared = true
        return true
      } catch (error) {
        console.warn(`[launch] native hook preparation held · ${error instanceof Error ? error.message : error}`)
        return false
      } finally { preparing = false }
    },
    async permission(choice) {
      // A launch that names no mode (#3466: the owner's own) has no flag to confirm, and is still probed as auto mode's flag
      // would be: the engine's help is what tells one that cannot run, or that the Desktop is still downloading, from one
      // that can. Any help it prints will do. Asked once per install (helpOf), as auto mode's own flag is.
      const flag = permissionFlagToVerify(engine, choice)
      if (!flag && !permissionFlagToVerify(engine, { permissionMode: 'auto' })) return 'supported'
      if (!current()) return 'unknown'
      const observedRevision = revision
      failed = null
      const probe = await helpOf(executable, selectedEnvironment)
      if (!probe || !current() || observedRevision !== revision) return 'unknown'
      if (probe.code !== 0) { failed = failureReason(`${probe.stderr}\n${probe.stdout}`, `it exited with status ${probe.code}`); return 'unknown' }
      // Help on either stream, as the shell probe reads it (`2>&1`, lib/engineLaunch.ts). OpenCode
      // 1.19.0 prints its help to standard error and exits 0 (stdout 0 bytes, stderr 4,285, measured
      // in clean macOS and Ubuntu VMs, 2026-10-11): read from stdout alone, every launch of it held
      // for good, waiting to confirm its permission flags.
      const help = `${probe.stdout}\n${probe.stderr}`
      if (!help.trim()) return 'unknown'
      return !flag || helpLists(help, flag) ? 'supported' : 'unsupported'
    },
  }
  if (await launch.permission(source) === 'unknown') {
    // Which file, so a launch held this way says what it waits for (a customer saw this sentence alone for minutes).
    return failed ? cannotRun(engine, failed) : waiting(`Waiting to confirm the selected executable’s permission flags (${executable.command}).`)
  }
  return { ok: true, launch }
}

/** The sentence a creation is refused with when the selected `claude` is another program: which one, what it said, and
 *  the two ways out. */
export function notClaudeCode(path: string, said: string): string {
  const answer = said.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 80) ?? ''
  return `${path} is not Claude Code: asked its version, it answered "${answer}" (the Claude desktop app's own program answers this way). `
    + 'Install Claude Code (irm https://claude.ai/install.ps1 | iex), or set CLAUDE_PATH to its claude.exe, then start the harness again.'
}

/** Whether [help] lists [flag] as a whole option, not the start of a longer one (`--auto` is not `--auto-update`). */
function helpLists(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(help)
}

const installers: Partial<Record<AgentEngine, (port: number, options: NativeHookOptions) => Promise<boolean>>> = {
  cursor: hooks.installCursorHooks, commandcode: hooks.installCommandCodeHooks, devin: hooks.installDevinHooks,
  amp: hooks.installAmpPlugin, kilo: hooks.installKiloPlugin, grok: hooks.installGrokHooks, agy: hooks.installAgyHooks,
  copilot: hooks.installCopilotHooks, pi: hooks.installPiExtension,
}
