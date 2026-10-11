/** Native hook installation is eager. Optional transcript and screen readers own no hook files. */
import { dirname, join } from 'node:path'
import { hookPreparationRoutes, runHookPreparation, type HookPreparationProof } from './kit/nativeHookFiles.js'
import { nativeHookLocations, type NativeHookOptions } from './kit/nativeLocations.js'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import { OPENCODE_LEGACY_PLUGIN, OPENCODE_TUI_PLUGIN, OPENCODE_LEGACY_REMOVAL, OPENCODE_VERSION } from './opencode/contract.js'
import { KILO_PLUGIN } from './kilo/contract.js'
import { PI_EXTENSION } from './pi/contract.js'
import { AMP_PLUGIN } from './amp/contract.js'
import { HERMES_HOOK_SETTINGS } from './hermes/contract.js'
import { opencodeMajorVersion, type OpencodeLaunchSnapshot } from './launchControl.js'
import { installNativePlugin, prepareNativePlugin, prepareNativePluginRemoval } from './kit/nativePlugin.js'
import { installNativeYamlHooks } from './kit/nativeHookYaml.js'
import { command } from './kit/notifyHooks.js'
import { GROK_HOOK_SETTINGS } from './grok/contract.js'
import { AGY_HOOK_SETTINGS } from './agy/contract.js'
import { COPILOT_HOOK_SETTINGS } from './copilot/contract.js'
import { CURSOR_HOOK_SETTINGS } from './cursor/contract.js'
import { COMMANDCODE_HOOK_SETTINGS } from './commandcode/contract.js'
import { DEVIN_HOOK_SETTINGS } from './devin/contract.js'
import { installNativeHookSettings } from './kit/nativeHookSettings.js'

export const installGrokHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...GROK_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).GROK_HOME, 'hooks', 'harness.json') } : GROK_HOOK_SETTINGS, port, options)
export const installAgyHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...AGY_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).AGY_CONFIG_DIR, 'hooks.json') } : AGY_HOOK_SETTINGS, port, options)
export const installCopilotHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...COPILOT_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).COPILOT_HOME, 'hooks', 'harness.json') } : COPILOT_HOOK_SETTINGS, port, options)
export const installCursorHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...CURSOR_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).CURSOR_CONFIG_DIR, 'hooks.json') } : CURSOR_HOOK_SETTINGS, port, options)
export const installCommandCodeHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...COMMANDCODE_HOOK_SETTINGS, file: join(nativeHookLocations(options.environment).COMMANDCODE_HOME, 'settings.json') } : COMMANDCODE_HOOK_SETTINGS, port, options)
export const installDevinHooks = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativeHookSettings(options?.environment ? { ...DEVIN_HOOK_SETTINGS, file: nativeHookLocations(options.environment).DEVIN_CONFIG_PATH } : DEVIN_HOOK_SETTINGS, port, options)

const pluginValues = (port: number) => ({
  port: String(port), credential: JSON.stringify(join(env.ADAPTER_DATA_DIR, 'hook-credential')), version: JSON.stringify(VERSION),
})
export const installKiloPlugin = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativePlugin(options?.environment ? { ...KILO_PLUGIN, file: join(nativeHookLocations(options.environment).KILO_PLUGIN_DIR, 'launcher-register.js') } : KILO_PLUGIN, pluginValues(port), options)
export const installPiExtension = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativePlugin(options?.environment ? { ...PI_EXTENSION, file: join(nativeHookLocations(options.environment).PI_AGENT_DIR, 'extensions', 'launcher-register.ts') } : PI_EXTENSION, pluginValues(port), options)
export const installAmpPlugin = (port: number, options?: NativeHookOptions): Promise<boolean> => installNativePlugin(options?.environment ? { ...AMP_PLUGIN, file: join(nativeHookLocations(options.environment).AMP_PLUGIN_DIR, 'launcher-register.ts') } : AMP_PLUGIN, pluginValues(port), options)
export const installHermesHooks = (port: number, selectedHome?: string, options?: NativeHookOptions): Promise<boolean> =>
  installNativeYamlHooks(HERMES_HOOK_SETTINGS, home => command(port, 'hermes', env.CODEX_HOME, home, options?.environment), selectedHome,
    { ...options, createMissing: !!selectedHome && !!options?.environment })

/** Install both discovery surfaces for v1; v2 must not load our incompatible v1 export. */
interface OpencodeInstallation { port: number; executable?: string; major?: number | null; settling?: boolean; done: Promise<boolean>; proofs: HookPreparationProof[] }
const opencodeInstallations = new Map<string, { current: OpencodeInstallation; users: number }>()
async function waitForInstallation(installation: OpencodeInstallation, deadline: number): Promise<boolean | null> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([installation.done, new Promise<null>(done => {
      timer = setTimeout(() => done(null), remaining)
    })])
  } finally { clearTimeout(timer) }
}
export async function installOpencodePlugin(port: number, snapshot?: OpencodeLaunchSnapshot, options: NativeHookOptions = {}): Promise<boolean> {
  const deadline = performance.now() + (options.timeoutMs ?? OPENCODE_VERSION.timeoutMs)
  const root = options.environment ? nativeHookLocations(options.environment).OPENCODE_PLUGIN_DIR : dirname(OPENCODE_LEGACY_PLUGIN.file)
  const legacyRule = { ...OPENCODE_LEGACY_PLUGIN, file: join(root, 'launcher-register.js') }
  const tuiRule = { ...OPENCODE_TUI_PLUGIN, file: join(dirname(root), 'plugins', 'launcher-register', 'tui.js') }
  const removalRule = { ...OPENCODE_LEGACY_REMOVAL, file: legacyRule.file }
  let routes: ReturnType<typeof hookPreparationRoutes>
  try { routes = hookPreparationRoutes([legacyRule.file, tuiRule.file]) } catch { return false }
  const installation: OpencodeInstallation = { port, executable: snapshot?.identity, done: Promise.resolve(false), proofs: [] }
  // Parent aliases can give startup and a captured launch different spellings
  // for the same pair. Each caller still retains its own original route proof.
  const reservation = JSON.stringify(routes.keys)
  if (opencodeInstallations.size >= 128 && !opencodeInstallations.has(reservation)) return false
  const previous = opencodeInstallations.get(reservation)?.current
  const group = opencodeInstallations.get(reservation) ?? { current: installation, users: 0 }
  // Include callers waiting before the lower-level disk reservation. Overflow
  // cannot supersede an admitted owner or grow an unbounded promise chain.
  if (group.users >= 16) return false
  group.current = installation; group.users++
  opencodeInstallations.set(reservation, group)
  try {
  installation.done = (async () => {
    const values = pluginValues(port)
    const major = snapshot ? snapshot.major : await opencodeMajorVersion()
    installation.major = major
    // A newer request may have installed an upgraded/downgraded engine's hooks
    // while this probe waited. Only the latest request can change those files.
    if (installation !== group.current || snapshot?.current() === false) return false
    // Readiness can precede the maintenance write. A launch has a captured
    // executable; maintenance does not, so their publications cannot be joined.
    // Revoke the older owner through group.current, let its disk work settle,
    // then inspect and prove this launch's own outputs within the same deadline.
    if (previous && (previous.settling || previous.major !== undefined
      && (previous.port !== port || previous.executable !== installation.executable || previous.major !== major))) {
      installation.settling = true
      const settled = await waitForInstallation(previous, deadline)
      installation.settling = false
      if (settled === null || installation !== group.current || snapshot?.current() === false || options.current?.() === false) return false
    }
    // Keep the existing first-install route until installer-only continuation
    // can return through launch preparation. A missing executable also gives
    // null here; refusing it would prevent create from reaching its installer.
    // Whole-launch preparation must confirm a version before native dispatch.
    try { routes.verify(); return await runHookPreparation([legacyRule.file, tuiRule.file], async attempt => {
      // Inspect both destinations before publishing. A foreign legacy plugin
      // cannot authorize even the first half of an upgrade's writes.
      const legacy = major === 1 ? prepareNativePlugin(legacyRule, values) : prepareNativePluginRemoval(removalRule)
      const tui = prepareNativePlugin(tuiRule, values)
      legacy.verify(); tui.verify()
      const removedOrInstalled = await legacy.commit(attempt), installed = await tui.commit(attempt)
      removedOrInstalled.verify(); installed.verify()
      return snapshot?.current() !== false
    }, { ...options, timeoutMs: Math.max(0, deadline - performance.now()), confirmed: proof => installation.proofs.push(proof), identity: JSON.stringify([port, snapshot?.identity, major]),
      current: () => group.current.port === port && group.current.executable === installation.executable
        && group.current.major === major && performance.now() < deadline && snapshot?.current() !== false && options.current?.() !== false }) } catch (error) {
      console.error('[hooks] OpenCode preparation held:', error)
      return false
    }
  })()
  let current = installation, installed = await current.done
  while (current !== group.current) {
    current = group.current
    // Two healthy creates must not fail merely because they overlap. Follow the
    // current installation without restoring an obsolete request's write rights.
    // A port change or continuing churn cannot make this caller wait forever.
    const remaining = deadline - performance.now()
    if (current.port !== port || current.executable !== installation.executable || snapshot?.current() === false || options.current?.() === false || remaining <= 0) return false
    const result = await waitForInstallation(current, deadline)
    if (result === null) return false
    installed = result
  }
  if (!installed || performance.now() >= deadline || options.current?.() === false || snapshot?.current() === false || current.proofs.some(proof => !proof.current())) return false
  if (performance.now() >= deadline) return false
  try { routes.verify() } catch { return false }
  if (performance.now() >= deadline || options.current?.() === false || snapshot?.current() === false) return false
  for (const proof of current.proofs) options.confirmed?.({ ...proof, current: () => {
    try { routes.verify(); return proof.current() } catch { return false }
  } })
  return true
  } finally { if (--group.users === 0) opencodeInstallations.delete(reservation) }
}
