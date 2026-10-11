/** Eager preparation shared by every way core starts a native engine. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { permissionFlagToVerify, type PermissionLaunchChoice } from '../lib/engineLaunch.js'
import type { EngineInstallRecipe } from '../lib/engineInstall.js'
import { patientDeadline } from '../lib/patientExec.js'
import { engineHooks } from './hooks.js'
import * as hooks from './nativeHooks.js'
import { captureLaunchExecutable, LAUNCH_LOCATION_VARIABLES } from './kit/launchExecutable.js'
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
  retain?(proof: HookPreparationProof): boolean
  ready?(): boolean
  current(): boolean
  prepareHooks(port: number, current: () => boolean, environment?: Readonly<Record<string, string>>, clear?: readonly string[]): Promise<boolean>
  permission(choice: PermissionLaunchChoice): Promise<'supported' | 'unsupported' | 'unknown'>
}
export type NativeLaunchResult =
  | { ok: true; launch: NativeLaunch }
  | { ok: false; error: 'NATIVE_LAUNCH_HELD'; unavailable: 'native'; detail: string; install?: EngineInstallRecipe; environment?: Record<string, string> }
const waiting = (detail: string): Extract<NativeLaunchResult, { ok: false }> => ({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail })
const noNative: NativeLaunch = {
  opencodeMajor: null, environment: {}, proofs: [], current: () => true,
  prepareHooks: async () => true, permission: async () => 'supported',
}

let probes = 0
/** Slots follow actual subprocess settlement, including deadline and output-limit kills. */
async function read(executable: string, args: readonly string[], environment: Readonly<Record<string, string>>): Promise<string | null> {
  if (probes >= 8) return null
  probes++
  return new Promise(done => {
    let settled = false, expired = false, answered = false
    let cancelDeadline = () => {}
    let drain: ReturnType<typeof setTimeout> | undefined
    const answer = (output: string | null) => { if (!answered) { answered = true; done(output) } }
    let child: ReturnType<typeof execFile>
    try {
      // Node's timeout can discard unread output after a core stall, then
      // report exit 0. Keep its pipes and use discovery's patient deadline.
      child = execFile(executable, [...args], {
        env: nativeProcessEnvironment(environment), encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      }, (error, output) => {
        settled = true; probes--; cancelDeadline(); clearTimeout(drain)
        answer(error || expired ? null : output)
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
  const opencodeMajor = output === null ? null : parseMajor(OPENCODE_VERSION, output)
  // Unknown is an observation of this attempt, never a permanent installed-file answer.
  if (engine === 'opencode' && opencodeMajor === null) return waiting('Waiting to confirm the selected OpenCode executable’s version.')
  if (!executable.current()) return waiting('Waiting for the selected engine executable to stop changing.')
  let proofs: readonly HookPreparationProof[] = [], selectedEnvironment = environment
  const dependencies: HookPreparationProof[] = []
  const dependenciesCurrent = () => dependencies.every(proof => proof.current())
  let preparing = false, valid = true, prepared = false, revision = 0
  const current = () => valid && !preparing && executable.current() && [...dependencies, ...proofs].every(proof => proof.current())
  const permissions = new Map<string, 'supported' | 'unsupported'>()
  const launch: NativeLaunch = {
    token: randomUUID(), executable, opencodeMajor, current, ready: () => prepared && current(),
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
      const help = await read(executable.command, ['--help'], selectedEnvironment)
      if (!help?.trim() || !current() || observedRevision !== revision) return 'unknown'
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const answer = new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(help) ? 'supported' : 'unsupported'
      permissions.set(flag, answer)
      return answer
    },
  }
  if (await launch.permission(source) === 'unknown') return waiting('Waiting to confirm the selected executable’s permission flags.')
  return { ok: true, launch }
}

const installers: Partial<Record<AgentEngine, (port: number, options: NativeHookOptions) => Promise<boolean>>> = {
  cursor: hooks.installCursorHooks, commandcode: hooks.installCommandCodeHooks, devin: hooks.installDevinHooks,
  amp: hooks.installAmpPlugin, kilo: hooks.installKiloPlugin, grok: hooks.installGrokHooks, agy: hooks.installAgyHooks,
  copilot: hooks.installCopilotHooks, pi: hooks.installPiExtension,
}
