/**
 * `harness device claude …`: the menu-bar app's status, enable and disable, and two words the harness-device plugin runs
 * that a person never types: `asked` (its PermissionRequest hook) and `link` (its mod, for the daemon's socket and the
 * devices' listener's). This runs only in the `harness` command's own process; nothing the core or a service loads imports this folder.
 */
import { devicesListenerPath } from '../devices/listenerPath.js'
import { localSocketRoute, socketIsPrivate } from '../lib/localTransport.js'
import { daemonPost, runAsked } from './asked.js'
import { claudeDisable, claudeEnable, claudePluginOn, claudeSettingsPath, claudeStatus, type ClaudeRun } from './plugin.js'

/** `asked` and `link` are left out: they are the plugin's, and typed by hand they only wait on stdin or print a path. */
export const DEVICE_USAGE = `Harness device (the dial shows Claude Code's waiting prompts in any terminal, and takes a spoken prompt):
  harness device claude status [--json]  whether Claude Code has the harness-device plugin, and its version
  harness device claude enable           install the plugin, or turn it on (Claude Code 2.1.287 or later)
  harness device claude disable          uninstall the plugin`

export interface DeviceDeps {
  dataDir: string
  port: number
  platform: NodeJS.Platform
  stdin: AsyncIterable<Buffer | string>
  /** Looked for only by the words that run Claude Code: the hook's `asked` runs on every prompt and needs none. */
  claude(): ClaudeRun | null
  out(line: string): void
  err(line: string): void
}

export async function runDeviceCommand(argv: string[], deps: DeviceDeps): Promise<number> {
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const json = argv.includes('--json')
  const verb = words.length === 2 && words[0] === 'claude' ? words[1] : null
  switch (verb) {
    case 'status': {
      const status = await claudeStatus({ run: deps.claude(), platform: deps.platform })
      deps.out(json ? JSON.stringify(status) : JSON.stringify(status, null, 2))
      return 0
    }
    case 'enable':
    case 'disable': {
      const change = verb === 'enable' ? claudeEnable : claudeDisable
      const result = await change({ run: deps.claude(), platform: deps.platform })
      if (result.ok) return 0
      deps.err(result.error)
      return 1
    }
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
      // one another account made or can reach. None there (Windows, no dial yet): left out, and the mod sends nothing.
      const devicesSocket = devicesListenerPath(deps.dataDir, deps.platform)
      deps.out(JSON.stringify(devicesSocket && socketIsPrivate(devicesSocket) ? { socketPath, devicesSocket } : { socketPath }))
      return 0
    }
    default:
      deps.err(DEVICE_USAGE)
      return 1
  }
}
