/**
 * `harness device claude …`: the menu-bar app's status, enable and disable, and two words the harness-device plugin runs
 * that a person never types: `asked` (its PermissionRequest hook) and `link` (its mod, for the daemon's socket and the
 * devices' listener's). `harness device codex …`: the menu-bar app's status, enable and disable for Codex. For both,
 * `enable` saves On in dial-skill.json and writes the dial skill into the engine's default home; `disable` saves Off,
 * then removes Harness's skill from that home and from every home the devices service listed, which writes the skill
 * into the other homes while the engine is On. `harness device orca link` is Orca's plugin's word, never typed either:
 * whether the daemon is up and where the devices' socket is, so the plugin builds no path. `harness device notify` is an
 * agent's, from the dial skill (devices/notice.ts). This runs only in the `harness` command's own process; nothing the
 * core or a service loads imports this folder.
 */
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { removeSkill, skillsFolderOf, writeSkill } from '../devices/dialSkill.js'
import { readAnswers, readHomes, writeAnswer, type DialEngine } from '../devices/dialSkillFiles.js'
import { devicesListenerPath } from '../devices/listenerPath.js'
import { NOTICE_USAGE, runNotice } from '../devices/notice.js'
import { localSocketRoute, socketIsPrivate } from '../lib/localTransport.js'
import { daemonPost, runAsked } from './asked.js'
import { claudeDisable, claudeEnable, claudePluginOn, claudeSettingsPath, claudeStatus, type ClaudeResult, type ClaudeRun } from './plugin.js'

/** `asked`, `link` and `orca link` are left out: they are the plugins', and typed by hand they only wait on stdin or print a path. */
export const DEVICE_USAGE = `Harness device (the dial shows Claude Code's waiting prompts in any terminal, takes a spoken prompt, and rings when an agent needs you):
  harness device claude status [--json]  whether Claude Code has the harness-device plugin, and its version
  harness device claude enable           install the plugin, or turn it on, and write the dial skill (Claude Code 2.1.287 or later)
  harness device claude disable          uninstall the plugin and remove the dial skill
  harness device codex status [--json]   whether the dial is on for Codex
  harness device codex enable            write the dial skill into Codex's home
  harness device codex disable           remove the dial skill from every Codex home
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
      // Off once Turn off saved it, even when the uninstall after it failed: the devices service writes no skill then.
      const status = { ...plugin, enabled: plugin.enabled && readAnswers(deps.dataDir).claude !== false }
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
      const status = { supported, installed: deps.codex(), enabled: readAnswers(deps.dataDir).codex === true }
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
const SAVE_FAILED = 'Could not save the dial setting.'

/** The command's own Claude Code home, where Claude Code's user settings are. */
function claudeHome(): string {
  return dirname(claudeSettingsPath())
}

/**
 * On is saved before the skill is written: the devices service writes the other homes from it. The default home is
 * made when missing, as a fresh install has none yet; a person's own dial skill there stays, and On still holds for
 * the other homes.
 */
function turnOn(engine: DialEngine, home: string, deps: DeviceDeps): number {
  if (writeAnswer(deps.dataDir, engine, true) !== undefined) {
    deps.err(SAVE_FAILED)
    return 1
  }
  const skills = skillsFolderOf(home, true)
  const result = skills === null ? 'failed' : writeSkill(skills)
  if (result === 'theirs') deps.err(`${ENGINE_NAMES[engine]} already has a skill named dial that Harness did not write; it stays.`)
  if (result !== 'failed') return 0
  deps.err(`Could not write the ${ENGINE_NAMES[engine]} skill.`)
  return 1
}

/**
 * Off is saved first, so the devices service writes no new copy while these are removed. Each step runs whatever the
 * one before did, so a failed one leaves no more behind than it must; the first error is the one printed. The homes
 * list is only read: its one writer is the devices service, which empties it once it reads Off.
 */
async function turnOff(engine: DialEngine, home: string, deps: DeviceDeps, plugin?: () => Promise<ClaudeResult>): Promise<number> {
  let error = writeAnswer(deps.dataDir, engine, false) === undefined ? undefined : SAVE_FAILED
  const uninstalled = await plugin?.()
  if (uninstalled && !uninstalled.ok) error ??= uninstalled.error
  // A home linked to a listed folder is one folder, cleared once.
  for (const skills of new Set([skillsFolderOf(home, false), ...readHomes(deps.dataDir)[engine]])) {
    if (skills !== null && removeSkill(skills) === 'failed') error ??= `Could not remove the ${ENGINE_NAMES[engine]} skill.`
  }
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
