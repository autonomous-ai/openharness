/**
 * `harness device claude …` and `harness device codex …`: status, enable and disable, the way to take away or bring back
 * what the devices service sets up by itself once a dial has attached here, and two words the harness-device plugin runs
 * that a person never types: `asked` (its PermissionRequest hook) and `link` (its mod, for the daemon's socket and the
 * devices' listener's). `disable` marks the engine removed in dial-skill.json, which the devices service then leaves
 * alone, and removes Harness's skill from the engine's default home, from each folder an enable wrote and from each the
 * service recorded in dial-setup.json. `enable` clears the mark and writes the skill back into those homes. `harness
 * device orca link` is Orca's plugin's word, never typed either: whether the daemon is up and where the devices' socket
 * is, so the plugin builds no path. `harness device notify` is an agent's, from the dial skill (devices/notice.ts). This
 * runs only in the `harness` command's own process; nothing the core or a service loads imports this folder.
 */
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { claudeDisable, claudeEnable, claudeStatus, type ClaudeResult, type ClaudeRun } from '../devices/claudePlugin.js'
import { ownDirectory, removeSkill, skillsFolderOf, skillWanted, writeSkill } from '../devices/dialSkill.js'
import { listable, MAX_HOMES, readRemoved, readSetup, readWritten, writeRemoved, type DialEngine } from '../devices/dialSkillFiles.js'
import { devicesListenerPath } from '../devices/listenerPath.js'
import { NOTICE_USAGE, runNotice } from '../devices/notice.js'
import { localSocketRoute, socketIsPrivate } from '../lib/localTransport.js'
import { daemonPost, runAsked } from './asked.js'
import { claudePluginOn, claudeSettingsPath } from './plugin.js'

/** `asked`, `link` and `orca link` are left out: they are the plugins', and typed by hand they only wait on stdin or print a path. */
export const DEVICE_USAGE = `Harness device (with a dial plugged in, Claude Code and Codex are set up to ring it; these take that away or bring it back):
  harness device claude status [--json]  whether the dial is on for Claude Code (its harness-device plugin on, and not removed), and its version
  harness device claude enable           set Claude Code up again: the plugin and the dial skill (Claude Code 2.1.287 or later)
  harness device claude disable          remove the plugin and the dial skill; Harness leaves them removed
  harness device codex status [--json]   whether the dial is on for Codex
  harness device codex enable            set Codex up again: the dial skill in its homes
  harness device codex disable           remove the dial skill Harness wrote; Harness leaves it removed
  ${NOTICE_USAGE}`

export interface DeviceDeps {
  dataDir: string
  port: number
  platform: NodeJS.Platform
  stdin: AsyncIterable<Buffer | string>
  /** Looked for only by the words that run Claude Code: the hook's `asked` runs on every prompt and needs none. */
  claude(): ClaudeRun | null
  /** The Codex home the person's Codex reads. */
  codexHome: string
  /** Whether Codex is on this computer: looked for only by `codex status` and `codex enable`. */
  codex(): boolean
  /** The command's own environment and folder: `notify` reads its caller from them. */
  env: NodeJS.ProcessEnv
  cwd: string
  out(line: string): void
  err(line: string): void
}

export async function runDeviceCommand(argv: string[], deps: DeviceDeps): Promise<number> {
  // Before the words that start with `-` are dropped: they are part of the agent's line.
  if (argv[0] === 'notify') return runNotice(argv.slice(1), deps)
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const json = argv.includes('--json')
  if (words.length === 2 && words[0] === 'orca' && words[1] === 'link') return orcaLink(deps)
  if (words.length === 2 && words[0] === 'codex') return codexCommand(words[1], json, deps)
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
      if (result.ok) return turnOn('claude', claudeHome(), deps)
      deps.err(result.error)
      return 1
    }
    case 'disable':
      return turnOff('claude', claudeHome(), deps, () => claudeDisable({ run: deps.claude(), platform: deps.platform }))
    case 'asked': {
      // A session started before `disable` still runs the hook: with the plugin off, its stdin is read and nothing told.
      const post = claudePluginOn(claudeSettingsPath()) ? daemonPost(deps.dataDir, deps.port) : async () => {}
      // Prints nothing, ever: what the hook prints, Claude Code reads as its decision.
      return runAsked({ stdin: deps.stdin, post })
    }
    case 'link': {
      // The socket alone: a request over it is trusted by the filesystem, so the mod is handed no credential. Where
      // there is none (Windows), or the plugin is off, no answer, and the mod tries again later.
      const socketPath = localSocketRoute(deps.dataDir, deps.port, deps.platform)
      if (!socketPath || !claudePluginOn(claudeSettingsPath())) return 1
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

const ENGINE_NAMES: Record<DialEngine, string> = { claude: 'Claude Code', codex: 'Codex' }
const OTHER: Record<DialEngine, DialEngine> = { claude: 'codex', codex: 'claude' }
const SAVE_FAILED = 'Could not save the dial setting.'

/** The command's own Claude Code home, where Claude Code's user settings are. */
function claudeHome(): string {
  return dirname(claudeSettingsPath())
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
 * devices service recorded gets the skill again, since the service leaves alone one the person removed; a folder gone
 * since is not made.
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
  for (const folder of readSetup(deps.dataDir).homes[engine]) {
    if (ownDirectory(folder) === 'ok' && writeSkill(folder) === 'failed') failed = true
  }
  if (!failed) return 0
  deps.err(`Could not write the ${ENGINE_NAMES[engine]} skill.`)
  return 1
}

/**
 * The removal is marked first, so the devices service writes no new copy while these are removed, and leaves the engine
 * alone after: the default home, each folder an enable wrote and each one the devices service recorded. Each step runs
 * whatever the one before did, so a failed one leaves no more behind than it must; the first error is the one printed.
 * A folder the other engine holds its skill in (~/.codex/skills linked to ~/.claude/skills) keeps it. The command's
 * record then keeps only the folders whose removal failed, for the next disable. The service's record is only read: its
 * one writer is the devices service, which empties that engine's folders once it reads the mark.
 */
async function turnOff(engine: DialEngine, home: string, deps: DeviceDeps, plugin?: () => Promise<ClaudeResult>): Promise<number> {
  let error = writeRemoved(deps.dataDir, engine, true) === undefined ? undefined : SAVE_FAILED
  const uninstalled = await plugin?.()
  if (uninstalled && !uninstalled.ok) error ??= uninstalled.error
  const written = readWritten(deps.dataDir)
  const listed = readSetup(deps.dataDir).homes
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
 * Orca's plugin asks this before each pass. `daemon` connects only to a socket that is this account's own, since a socket
 * a crashed daemon left behind is still there and still private. `devicesReady` does not connect: a connection there
 * counts against that listener's own, and the plugin's open finds a stale socket itself.
 */
async function orcaLink(deps: DeviceDeps): Promise<number> {
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
