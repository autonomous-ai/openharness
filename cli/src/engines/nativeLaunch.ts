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
import { OPENCODE_VERSION } from './opencode/contract.js'
import { type AgentEngine, isTerminalEngine } from './types.js'

export interface NativeLaunchSource extends PermissionLaunchChoice {
  codexHome?: string | null
  hermesHome?: string | null
  claudeHome?: string | null
}
export interface NativeLaunch {
  token?: string
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
/** What a probe's child said, once it exited by itself. A deadline, a signal, an output limit or a
 *  child that never started is no answer at all: null. */
interface ProbeOutput { code: number; stdout: string; stderr: string }
/** Slots follow actual subprocess settlement, including deadline and output-limit kills. */
async function read(executable: string, args: readonly string[], environment: Readonly<Record<string, string>>): Promise<ProbeOutput | null> {
  if (probes >= 8) return null
  probes++
  return new Promise(done => {
    let settled = false, expired = false, answered = false
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
        // limit leaves a string or null there, and says nothing about the executable itself.
        const code = !error ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
        answer(expired || code === null ? null : { code, stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    } catch { probes--; answer(null); return }
    if (!settled) cancelDeadline = patientDeadline(5_000, () => {
      expired = true
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
  if (!executable.current()) return waiting('Waiting for the selected engine executable to stop changing.')
  // Windows: the startup probe a launch script makes before every run elsewhere (engines/kit/launchStartup.ts), made
  // once here, of the executable this launch holds. No answer holds the launch, as the script ends one.
  const owned = process.platform === 'win32' ? startupOwnedFlag(launchContract(engine)) : null
  let startupArgs: readonly string[] | undefined
  if (owned) {
    const help = await read(executable.command, ['--help'], environment)
    if (help && help.code !== 0 && executable.current()) return cannotRun(engine, failureReason(`${help.stderr}\n${help.stdout}`, `it exited with status ${help.code}`))
    if (!help || help.code !== 0 || !`${help.stdout}${help.stderr}`.trim()) return waiting('Waiting to confirm the selected executable’s startup options.')
    startupArgs = Object.freeze(helpLists(`${help.stdout}\n${help.stderr}`, owned.flag) ? [owned.flag] : [])
  }
  let proofs: readonly HookPreparationProof[] = [], selectedEnvironment = environment
  const dependencies: HookPreparationProof[] = []
  const dependenciesCurrent = () => dependencies.every(proof => proof.current())
  let preparing = false, valid = true, prepared = false, revision = 0
  const current = () => valid && !preparing && executable.current() && [...dependencies, ...proofs].every(proof => proof.current())
  const permissions = new Map<string, 'supported' | 'unsupported'>()
  /** Why the latest help probe's executable failed, when it ran and exited non-zero. */
  let failed: string | null = null
  const launch: NativeLaunch = {
    token: randomUUID(), executable, opencodeMajor, current, ready: () => prepared && current(), ...(startupArgs ? { startupArgs } : {}),
    get environment() { return selectedEnvironment },
    get proofs() { return [...dependencies, ...proofs] },
    retain(proof) {
      if (!current() || dependencies.length >= 16 || !proof.current()) return false
      dependencies.push(proof); return true
    },
    get clearEnvironment() { return LAUNCH_LOCATION_VARIABLES.filter(key => !(key in selectedEnvironment)) },
    async prepareHooks(port, owner, overrides = {}, clear = []) {
      if (preparing || !executable.current() || !owner() || !dependenciesCurrent()) return false
      preparing = true; valid = false; const attemptRevision = ++revision
      permissions.clear()
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
      const flag = permissionFlagToVerify(engine, choice)
      if (!flag) return 'supported'
      if (!current()) return 'unknown'
      const known = permissions.get(flag)
      if (known) return known
      const observedRevision = revision
      failed = null
      const probe = await read(executable.command, ['--help'], selectedEnvironment)
      if (!probe || !current() || observedRevision !== revision) return 'unknown'
      if (probe.code !== 0) { failed = failureReason(`${probe.stderr}\n${probe.stdout}`, `it exited with status ${probe.code}`); return 'unknown' }
      // Help on either stream, as the shell probe reads it (`2>&1`, lib/engineLaunch.ts). OpenCode
      // 1.19.0 prints its help to standard error and exits 0 (stdout 0 bytes, stderr 4,285, measured
      // in clean macOS and Ubuntu VMs, 2026-10-11): read from stdout alone, every launch of it held
      // for good, waiting to confirm its permission flags.
      const help = `${probe.stdout}\n${probe.stderr}`
      if (!help.trim()) return 'unknown'
      const answer = helpLists(help, flag) ? 'supported' : 'unsupported'
      permissions.set(flag, answer)
      return answer
    },
  }
  if (await launch.permission(source) === 'unknown') {
    return failed ? cannotRun(engine, failed) : waiting('Waiting to confirm the selected executable’s permission flags.')
  }
  return { ok: true, launch }
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
