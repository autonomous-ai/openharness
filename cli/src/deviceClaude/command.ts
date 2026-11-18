/**
 * `harness device claude …` and `harness device codex …`: status, enable and disable, the way to take away or bring back
 * what the devices service sets up by itself once a dial has attached here, and two words the harness-device plugin runs
 * that a person never types: `asked` (its PermissionRequest hook) and `link` (its mod, for the daemon's socket and the
 * devices' listener's). `disable` marks the engine removed in dial-skill.json, which the devices service then leaves
 * alone, and removes Harness's skill from the engine's default home, from each folder an enable wrote and from each the
 * service recorded in dial-setup.json. `enable` clears the mark and writes the skill into the engine's default home and
 * back into each folder the service recorded; a folder an earlier enable wrote with another home is not written again.
 * Claude Code's two cover each Orca account's Claude Code home as well, and the default home when the command runs with
 * another (in an Orca terminal), all sharing the command's `plugins/`: there the plugin is only turned on or off.
 * `disable` turns those off first and never uninstalls there: an uninstall takes the files every home names, and another
 * home's entry would then stay on with nothing left to turn off (check 8).
 * `harness device orca link` and `harness device vscode link` are Orca's plugin's word and Harness's VS Code extension's,
 * never typed either: whether the daemon is up and where the devices' socket is, so neither builds a path.
 * `harness device vscode enable|disable` and `harness device cursor enable|disable` are the person's way to turn
 * Harness's extension back on or off in VS Code or in Cursor, which the devices service installs by itself once a dial
 * has attached here (cable/vscodeExtensionSetup.ts): `disable` marks it removed for that editor in dial-skill.json, which
 * the service then leaves alone, before the editor's own uninstall, and `enable` clears the mark before its install
 * (devices/vscodeExtension.ts); `status` is support's. `harness device notify` is an agent's,
 * from the dial skill (devices/notice.ts). `harness device orca status|connect` are the Harness app's, never typed: what
 * Orca's plugin is in Orca, and its install, update or enable, from a folder in the home's .harness that holds what cli.js
 * carries (devices/orcaPlugin.ts); a `connect` Orca answered with success is recorded in dial-skill.json, and Harness
 * offers the plugin no more. This runs only in the `harness` command's own process; nothing the core or a service loads
 * imports this folder.
 */
import { mkdirSync, realpathSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { harnessPath } from '../config/harnessHome.js'
import { claudeDisable, claudeEnable, claudeHomeDisable, claudeHomeEnable, claudeStatus, type ClaudeResult, type ClaudeRun } from '../devices/claudePlugin.js'
import { claudePluginState, ownDirectory, removeSkill, skillsFolderOf, skillWanted, writeSkill } from '../devices/dialSkill.js'
import { listable, MAX_HOMES, readRemoved, readSetup, readWritten, writeOrcaConnected, writePluginHomes, writeRemoved, type DialEngine } from '../devices/dialSkillFiles.js'
import { devicesListenerPath } from '../devices/listenerPath.js'
import { NOTICE_USAGE, runNotice } from '../devices/notice.js'
import { ORCA_FINGERPRINT, orcaConnect, type OrcaPluginDeps, type OrcaPluginRun, orcaStatus } from '../devices/orcaPlugin.js'
import { vscodeDisable, vscodeEnable, vscodeStatus, type VscodeChange, type VscodeEditor, type VscodeExtensionDeps } from '../devices/vscodeExtension.js'
import { localSocketRoute, socketIsPrivate } from '../lib/localTransport.js'
import { daemonPost, runAsked } from './asked.js'
import { claudePluginOn, claudeSettingsPath } from './plugin.js'

/** `asked`, `link`, `orca link` and `vscode link` are left out: they are the plugins', and typed by hand they only wait on
 *  stdin or print a path. `vscode status` and `cursor status` are too: each editor's Extensions view shows whether the
 *  extension is on. So are `orca status` and `orca connect`: the Harness app's, whose window shows what Orca lists
 *  before a person connects. */
export const DEVICE_USAGE = `Harness device (with a dial plugged in, Claude Code and Codex are set up to ring it, and VS Code and Cursor to follow it; disable takes that away, enable brings it back):
  harness device claude status [--json]  whether the dial is on for Claude Code (its harness-device plugin on, and not removed), and its version
  harness device claude enable           set Claude Code up again: the plugin and the dial skill (Claude Code 2.1.287 or later), in each Orca account too
  harness device claude disable          remove the plugin and the dial skill, in each Orca account too; Harness leaves them removed
  harness device codex status [--json]   whether the dial is on for Codex
  harness device codex enable            set Codex up again: the dial skill in its homes
  harness device codex disable           remove the dial skill Harness wrote; Harness leaves it removed
  harness device vscode enable           set VS Code up again: Harness's extension in it
  harness device vscode disable          remove Harness's extension; Harness leaves it removed
  harness device cursor enable           set Cursor up again: Harness's extension in it
  harness device cursor disable          remove Harness's extension; Harness leaves it removed
  ${NOTICE_USAGE}`

export interface DeviceDeps {
  dataDir: string
  /** The account's home, whose .harness holds the Orca plugin's folder. */
  home: string
  port: number
  platform: NodeJS.Platform
  stdin: AsyncIterable<Buffer | string>
  /** Looked for only by the words that run Claude Code: the hook's `asked` runs on every prompt and needs none. */
  claude(): ClaudeRun | null
  /** Orca's Claude Code account homes; none when Orca is not here or could not be read. Asked only by claude enable and disable. */
  orcaHomes(): Promise<string[]>
  /** Claude Code pointed at [home], on that child alone. */
  claudeIn(home: string): ClaudeRun | null
  /** Claude Code's default home, dirname(env.CLAUDE_PROJECTS_DIR): the command's own, unless it runs with another
   *  CLAUDE_CONFIG_DIR (an Orca terminal's). */
  defaultClaudeHome: string
  /** The Codex home the person's Codex reads. */
  codexHome: string
  /** Whether Codex is on this computer: looked for only by `codex status` and `codex enable`. */
  codex(): boolean
  /** What an editor's words read and run: asked for only by `vscode|cursor status`, `enable` and `disable`. */
  vscode(editor: VscodeEditor): VscodeExtensionDeps
  /** Orca's CLI and the plugin's files cli.js carries: asked for only by `orca status` and `orca connect`. */
  orca(): OrcaPluginRun
  /** The command's own environment and folder: `notify` reads its caller from them. */
  env: NodeJS.ProcessEnv
  cwd: string
  out(line: string): void
  err(line: string): void
}

export async function runDeviceCommand(argv: string[], deps: DeviceDeps): Promise<number> {
  // Before the words that start with `-` are dropped: they are part of the agent's line.
  if (argv[0] === 'notify') return runNotice(argv.slice(1), deps)
  // `--approve` takes the word after it, whatever that word starts with.
  if (argv[0] === 'orca' && (argv[1] === 'status' || argv[1] === 'connect')) return orcaCommand(argv[1], argv.slice(2), deps)
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const json = argv.includes('--json')
  if (words.length === 2 && (words[0] === 'orca' || words[0] === 'vscode') && words[1] === 'link') return devicesLink(deps)
  if (words.length === 2 && words[0] === 'codex') return codexCommand(words[1], json, deps)
  if (words.length === 2 && (words[0] === 'vscode' || words[0] === 'cursor')) return vscodeCommand(words[0], words[1], json, deps)
  const verb = words.length === 2 && words[0] === 'claude' ? words[1] : null
  switch (verb) {
    case 'status': {
      const plugin = await claudeStatus({ run: deps.claude(), platform: deps.platform })
      // Off once disable marked it, even when the uninstall after it failed: the devices service sets nothing up then.
      const status = { ...plugin, enabled: plugin.enabled && readRemoved(deps.dataDir).claude !== true }
      deps.out(json ? JSON.stringify(status) : JSON.stringify(status, null, 2))
      return 0
    }
    case 'enable': {
      const result = await claudeEnable({ run: deps.claude(), platform: deps.platform })
      if (!result.ok) {
        deps.err(result.error)
        return 1
      }
      // The command's own home whole before the others: their plugin is its files, and their skills folder links to its.
      const code = turnOn('claude', claudeHome(), deps)
      return code === 0 ? turnOnShared(deps) : code
    }
    case 'disable': {
      let leftOn = false
      const code = await turnOff('claude', claudeHome(), deps, async () => {
        // Once the removal is saved, so the devices service turns no Orca home on again, and before the uninstall.
        leftOn = await turnOffShared(deps)
        // Installed while another home is on: the uninstall would take the shared files it names, and a later disable
        // could then never turn it off. The removal stays saved, and the next disable finishes.
        if (leftOn) return undefined
        const run = deps.claude()
        // With no `claude` to uninstall it, a plugin on in these settings stays installed: the person is told.
        if (!run && claudePluginState(claudeSettingsPath()) === 'on') return { ok: false, error: PLUGIN_LEFT_ON, step: 'uninstall' }
        return claudeDisable({ run, platform: deps.platform })
      })
      return leftOn ? 1 : code
    }
    case 'asked': {
      // A session started before `disable` still runs the hook: with the plugin off or removed, its stdin is read and
      // nothing told.
      const post = pluginActs(deps.dataDir) ? daemonPost(deps.dataDir, deps.port) : async () => {}
      // Prints nothing, ever: what the hook prints, Claude Code reads as its decision.
      return runAsked({ stdin: deps.stdin, post })
    }
    case 'link': {
      // The socket alone: a request over it is trusted by the filesystem, so the mod is handed no credential. Where
      // there is none (Windows), or the plugin is off or removed, no answer, and the mod tries again later.
      const socketPath = localSocketRoute(deps.dataDir, deps.port, deps.platform)
      if (!socketPath || !pluginActs(deps.dataDir)) return 1
      // The mod posts its session id to the devices' listener: handed only when that socket is this account's own, never
      // one another account made or can reach. None there, or not private (no dial yet): left out, and the mod asks
      // again at an attach.
      const devicesSocket = devicesListenerPath(deps.dataDir, deps.platform)
      deps.out(JSON.stringify(devicesSocket && socketIsPrivate(devicesSocket) ? { socketPath, devicesSocket } : { socketPath }))
      return 0
    }
    default:
      deps.err(DEVICE_USAGE)
      return 1
  }
}

async function codexCommand(verb: string, json: boolean, deps: DeviceDeps): Promise<number> {
  const supported = deps.platform === 'darwin' || deps.platform === 'linux'
  switch (verb) {
    case 'status': {
      const status = { supported, installed: deps.codex(), enabled: setUp('codex', deps.dataDir) }
      deps.out(json ? JSON.stringify(status) : JSON.stringify(status, null, 2))
      return 0
    }
    case 'enable': {
      const refused = !supported ? 'The dial reaches Codex on macOS and Linux.' : !deps.codex() ? 'Codex is not on this computer.' : null
      if (!refused) return turnOn('codex', deps.codexHome, deps)
      deps.err(refused)
      return 1
    }
    case 'disable':
      // Removing the skill looks for no Codex: it may be gone already.
      return turnOff('codex', deps.codexHome, deps)
    default:
      deps.err(DEVICE_USAGE)
      return 1
  }
}

/** An editor's answer as its command prints it: the state under the editor's own key, as `vscode`'s always was. */
const printed = (editor: VscodeEditor, { state, ...rest }: VscodeChange): Record<string, unknown> => ({ [editor]: state, ...rest })

/** Each answer of [editor]'s is one JSON line on stdout, failures too, with the word that says why. The removal's mark
 *  is Harness's own setting: one not saved is said on stderr, as the engines' words say it. */
async function vscodeCommand(editor: VscodeEditor, verb: string, json: boolean, deps: DeviceDeps): Promise<number> {
  switch (verb) {
    case 'status': {
      const status = printed(editor, vscodeStatus(deps.vscode(editor)))
      deps.out(json ? JSON.stringify(status) : JSON.stringify(status, null, 2))
      return 0
    }
    case 'enable': {
      // Cleared first: the devices service brings it current from then on, and a failed save installs nothing.
      if (writeRemoved(deps.dataDir, editor, false) !== undefined) {
        deps.err(SAVE_FAILED)
        return 1
      }
      const result = await vscodeEnable(deps.vscode(editor))
      deps.out(JSON.stringify(printed(editor, result)))
      return result.state === 'on' ? 0 : 1
    }
    case 'disable': {
      // Marked first, so a pass of the devices service that installs meanwhile takes it out again; the uninstall runs
      // whatever the save did.
      const saved = writeRemoved(deps.dataDir, editor, true) === undefined
      const result = await vscodeDisable(deps.vscode(editor))
      deps.out(JSON.stringify(printed(editor, result)))
      if (!saved) deps.err(SAVE_FAILED)
      return 'error' in result || !saved ? 1 : 0
    }
    default:
      deps.err(DEVICE_USAGE)
      return 1
  }
}

/**
 * The Harness app's two words for Orca's plugin. Its folder is the data folder's, beside dial-skill.json: Orca installs
 * from it and copies it again at each update, so it stays put. `--approve` is the one argument that carries consent, the
 * fingerprint of the access a person was shown: one off its pattern, a second, or any other argument is `failed` before
 * Orca is looked for. The record is written after Orca's success, as VS Code's mark is; one not saved is said on stderr,
 * and the line stays `done`, since Orca did connect.
 */
async function orcaCommand(verb: 'status' | 'connect', args: string[], deps: DeviceDeps): Promise<number> {
  const plugin = (): OrcaPluginDeps => ({ ...deps.orca(), folder: harnessPath('orca-plugin', deps.home), dataDir: deps.dataDir, err: deps.err })
  if (verb === 'status') {
    if (args.some((arg) => arg !== '--json')) {
      deps.err(DEVICE_USAGE)
      return 1
    }
    const status = await orcaStatus(plugin())
    deps.out(args.includes('--json') ? JSON.stringify(status) : JSON.stringify(status, null, 2))
    return 0
  }
  const at = args.indexOf('--approve')
  const approve = at === -1 ? undefined : args[at + 1] ?? ''
  const rest = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)]
  if ((approve !== undefined && !ORCA_FINGERPRINT.test(approve)) || rest.some((arg) => arg !== '--json')) {
    deps.out(JSON.stringify({ connect: 'failed', error: 'failed' }))
    return 1
  }
  const result = await orcaConnect(plugin(), approve)
  const saved = result.connect !== 'done' || writeOrcaConnected(deps.dataDir) === undefined
  deps.out(JSON.stringify(result))
  if (!saved) deps.err(SAVE_FAILED)
  return result.connect === 'failed' ? 1 : 0
}

const ENGINE_NAMES: Record<DialEngine, string> = { claude: 'Claude Code', codex: 'Codex' }
const OTHER: Record<DialEngine, DialEngine> = { claude: 'codex', codex: 'claude' }
const SAVE_FAILED = 'Could not save the dial setting.'
/** dial-setup.json is there but could not be read: the homes the devices service set up were passed by. */
const SETUP_UNREAD = 'Could not read the dial setup.'
const PLUGIN_LEFT_ON = 'Claude Code was not found, so its harness-device plugin is still on; /plugin in Claude Code removes it.'
/** Said once for each Orca home that failed, never its path: Claude Code's own line names the account's folder. */
const ORCA_ON_FAILED = 'Could not turn on Claude Code in one Orca account.'
const ORCA_OFF_FAILED = 'Could not turn off Claude Code in one Orca account.'
/** The default home's, from an Orca terminal: where Claude Code's sessions outside Orca run. */
const DEFAULT_ON_FAILED = 'Could not turn on Claude Code outside Orca.'
const DEFAULT_OFF_FAILED = 'Could not turn off Claude Code outside Orca.'

/**
 * Whether the plugin's hook and mod act: its entry on in this command's Claude Code settings, and `disable` has not
 * removed Claude Code. The devices service installs the plugin into the daemon's Claude Code home, which may not be the
 * one a `disable` ran with: the plugin stays on there, and the removal alone keeps the dial off it.
 */
function pluginActs(dataDir: string): boolean {
  return claudePluginOn(claudeSettingsPath()) && readRemoved(dataDir).claude !== true
}

/** The command's own Claude Code home, where Claude Code's user settings are. */
function claudeHome(): string {
  return dirname(claudeSettingsPath())
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The homes besides the command's own that share its `plugins/`: Claude Code's default home, as named, when the command
 * runs with another whose `plugins/` is the default home's (an Orca terminal's: a home the person moved holds its own),
 * and Orca's Claude Code homes by real path, each once (a home listed twice or through a link is one home). The command's
 * own home is left out, as one Orca lists when the command runs in an Orca terminal: it is set up or removed already. One
 * that does not resolve is not there to run in.
 */
async function sharedHomes(deps: DeviceDeps): Promise<{ defaultHome: string | null; orca: string[] }> {
  const own = realPath(claudeHome())
  const defaultReal = realPath(deps.defaultClaudeHome)
  const orca = new Set<string>()
  for (const home of await deps.orcaHomes()) {
    const real = realPath(home)
    if (real !== null && real !== own && real !== defaultReal) orca.add(real)
  }
  const plugins = realPath(join(deps.defaultClaudeHome, 'plugins'))
  const shared = defaultReal !== own && plugins !== null && plugins === realPath(join(claudeHome(), 'plugins'))
  return { defaultHome: shared ? deps.defaultClaudeHome : null, orca: [...orca] }
}

/**
 * The plugin turned on in the other homes, one after another; a failure is said and the next is still tried. The Orca
 * homes it is on in then replace the command's own list in dial-skill.json, so the devices service leaves them alone:
 * one the person turns off afterwards stays off. dial-setup.json is the service's, never written here. The default home
 * left off fails the command: sessions outside Orca would not ring, and the devices turn on no Orca home.
 */
async function turnOnShared(deps: DeviceDeps): Promise<number> {
  const { defaultHome, orca } = await sharedHomes(deps)
  const defaultOff = defaultHome !== null && !(await claudeHomeEnable({ run: deps.claudeIn(defaultHome), platform: deps.platform })).ok
  if (defaultOff) deps.err(DEFAULT_ON_FAILED)
  const on: string[] = []
  for (const home of orca) {
    if ((await claudeHomeEnable({ run: deps.claudeIn(home), platform: deps.platform })).ok) on.push(home)
    else deps.err(ORCA_ON_FAILED)
  }
  if (writePluginHomes(deps.dataDir, on) !== undefined) {
    deps.err(SAVE_FAILED)
    return 1
  }
  return defaultOff ? 1 : 0
}

/**
 * The plugin turned off in the other homes, one after another, each failure said; true when one was left on. With no
 * `claude` there, a home whose settings read it on is one left on, as the command's own is.
 */
async function turnOffShared(deps: DeviceDeps): Promise<boolean> {
  const { defaultHome, orca } = await sharedHomes(deps)
  let leftOn = false
  for (const home of defaultHome === null ? orca : [defaultHome, ...orca]) {
    const run = deps.claudeIn(home)
    const off = run
      ? (await claudeHomeDisable({ run, platform: deps.platform })).ok
      : claudePluginState(join(home, 'settings.json')) !== 'on'
    if (off) continue
    leftOn = true
    deps.err(home === defaultHome ? DEFAULT_OFF_FAILED : ORCA_OFF_FAILED)
  }
  return leftOn
}

/**
 * Whether Harness keeps [engine]'s skill on this computer: wanted (not removed, and for Claude Code its plugin on) and
 * set up, by a dial attached here once or an enable that wrote a folder. A copy found in a home sets nothing up: it may
 * be one the old menu left.
 */
function setUp(engine: DialEngine, dataDir: string): boolean {
  return skillWanted(engine, readRemoved(dataDir)[engine] === true, claudeSettingsPath())
    && (readSetup(dataDir).dial || readWritten(dataDir)[engine].length > 0)
}

/**
 * The removal is cleared before anything is made: the devices service sets the engine up again from then on, and a
 * failed save leaves nothing behind. The default home's skills folder is then recorded before the skill is written, so
 * a disable run with another home still finds it; a folder the record cannot hold gets no skill. The default home is
 * made when missing, as a fresh install has none yet; a person's own dial skill there stays. Last, each folder the
 * devices service recorded gets the skill again, since the service leaves alone one the person removed: a skills folder
 * deleted whole is made again while its home is there, and one whose home is gone is not. A record that cannot be read
 * names no folder, and is said.
 */
function turnOn(engine: DialEngine, home: string, deps: DeviceDeps): number {
  if (writeRemoved(deps.dataDir, engine, false) !== undefined) {
    deps.err(SAVE_FAILED)
    return 1
  }
  const skills = skillsFolderOf(home, true)
  const written = readWritten(deps.dataDir)[engine]
  const recorded = skills !== null && listable(skills) && (written.includes(skills) || written.length < MAX_HOMES)
  if (recorded && !written.includes(skills) && writeRemoved(deps.dataDir, engine, false, [...written, skills]) !== undefined) {
    deps.err(SAVE_FAILED)
    return 1
  }
  const result = recorded ? writeSkill(skills) : 'failed'
  if (result === 'theirs') deps.err(`${ENGINE_NAMES[engine]} already has a skill named dial that Harness did not write; it stays.`)
  let failed = result === 'failed'
  const setup = readSetup(deps.dataDir)
  for (const folder of setup.homes[engine]) {
    const there = ownDirectory(folder)
    const remade = there === 'missing' && ownDirectory(dirname(folder)) === 'ok'
    if (there !== 'ok' && !remade) continue
    if ((remade && !madeFolder(folder)) || writeSkill(folder) === 'failed') failed = true
  }
  const error = failed ? `Could not write the ${ENGINE_NAMES[engine]} skill.` : setup.unread ? SETUP_UNREAD : undefined
  if (error === undefined) return 0
  deps.err(error)
  return 1
}

/** Not recursive: the home above it was checked to be this account's own folder, and nothing is made past it. */
function madeFolder(folder: string): boolean {
  try {
    mkdirSync(folder, { mode: 0o700 })
    return true
  } catch {
    return false
  }
}

/**
 * The removal is marked first, so the devices service writes no new copy while these are removed, and leaves the engine
 * alone after: the default home, each folder an enable wrote and each one the devices service recorded, at most 129
 * folders (the default home and the 64 each record holds). Each step runs whatever the one before did, so a failed one
 * leaves no more behind than it must; the first error is the one printed. A folder the other engine holds its skill in
 * (~/.codex/skills linked to ~/.claude/skills) keeps it. The command's record then keeps only the folders whose removal
 * failed, for the next disable. The service's record is only read: its one writer is the devices service, which empties
 * that engine's folders once it reads the mark; one that cannot be read names no folder, and is said.
 */
async function turnOff(engine: DialEngine, home: string, deps: DeviceDeps, plugin?: () => Promise<ClaudeResult | undefined>): Promise<number> {
  let error = writeRemoved(deps.dataDir, engine, true) === undefined ? undefined : SAVE_FAILED
  const uninstalled = await plugin?.()
  if (uninstalled && !uninstalled.ok) error ??= uninstalled.error
  const written = readWritten(deps.dataDir)
  const setup = readSetup(deps.dataDir)
  if (setup.unread) error ??= SETUP_UNREAD
  const listed = setup.homes
  const other = OTHER[engine]
  const shared = setUp(other, deps.dataDir)
    ? new Set([skillsFolderOf(other === 'claude' ? claudeHome() : deps.codexHome, false), ...written[other], ...listed[other]])
    : new Set()
  const failed = new Set<string>()
  // A home linked to a listed folder is one folder, cleared once.
  for (const skills of new Set([skillsFolderOf(home, false), ...written[engine], ...listed[engine]])) {
    if (skills === null || shared.has(skills) || removeSkill(skills) !== 'failed') continue
    failed.add(skills)
    error ??= `Could not remove the ${ENGINE_NAMES[engine]} skill.`
  }
  const kept = written[engine].filter((skills) => failed.has(skills))
  if (kept.length !== written[engine].length && writeRemoved(deps.dataDir, engine, true, kept) !== undefined) error ??= SAVE_FAILED
  if (error === undefined) return 0
  deps.err(error)
  return 1
}

/**
 * Orca's plugin and the VS Code extension ask this before each pass. `daemon` connects only to a socket that is this account's own, since a socket
 * a crashed daemon left behind is still there and still private. `devicesReady` does not connect: a connection there
 * counts against that listener's own, and the plugin's open finds a stale socket itself.
 */
async function devicesLink(deps: DeviceDeps): Promise<number> {
  const daemonSocket = localSocketRoute(deps.dataDir, deps.port, deps.platform)
  const daemon = daemonSocket !== null && socketIsPrivate(daemonSocket) && await takesConnect(daemonSocket)
  const devicesSocket = devicesListenerPath(deps.dataDir, deps.platform)
  const devicesReady = devicesSocket !== null && socketIsPrivate(devicesSocket)
  deps.out(JSON.stringify(devicesSocket ? { daemon, devicesSocket, devicesReady } : { daemon, devicesReady }))
  return 0
}

/** Whether something listens on the Unix socket at `path`: it takes a connect within `ms`. Never throws. */
export function takesConnect(path: string, ms = 1_000, open: (path: string) => Socket = connect): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = open(path)
    let settled = false
    const settle = (taken: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(taken)
    }
    const timer = setTimeout(() => settle(false), ms)
    // Kept after it settles: a late error on a destroyed socket would otherwise be thrown.
    socket.on('error', () => settle(false))
    socket.once('connect', () => settle(true))
  })
}
