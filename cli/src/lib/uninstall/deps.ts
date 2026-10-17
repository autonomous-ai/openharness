/** This computer's side of `harness uninstall` (command.ts): every module it needs, loaded only when it runs. */
import { existsSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { env } from '../../config/env.js'
import { openDaemon, whereFor } from '../../agentClient/daemon.js'
import { AUTH_DIR } from '../authSession.js'
import { daemonPort, isAlive, readPid } from '../daemonState.js'
import { describeSpawnLockBusyPlainly, describeSpawnLockOwner, SpawnLockBusyError, withSpawnLock } from '../daemonSpawnLock.js'
import { stopDaemonProcess } from '../daemonStop.js'
import { gridCredentialsPath, gridCredentialsExist } from '../gridCredentials.js'
import { ownedBinEntries } from '../launchers.js'
import { platformDaemonDeps } from '../platformDaemon.js'
import { runPowershell } from '../windows/powershell.js'
import { stopEveryAgent } from './agents.js'
import { labelHookRemoval, type UninstallDeps } from './command.js'
import { endPtyHosts, ptyHostsDeps } from './ptyHosts.js'
import { removeHarnessPathLines } from './rcFiles.js'
import { finalRemovalDeps, listEntries, removeNow, scheduleFinalRemoval } from './removal.js'
import { removeUserPathEntry } from './windowsPath.js'

const SERVICE_NAMES: Record<string, string> = { launchd: 'launchd', systemd: 'systemd', taskscheduler: 'Task Scheduler' }

/**
 * Written at once: the command ends in process.exit, and on macOS stdout and stderr into a pipe are asynchronous, so
 * console.log's last lines (the summary) could be dropped when a script captures them (gridCredentials.ts says the same).
 */
function line(fd: 1 | 2, text: string): void {
  try { writeSync(fd, `${text}\n`) } catch { /* no stream to write to */ }
}

export async function uninstallDeps(options: { tildify: (path: string) => string; ask: (question: string) => Promise<string> }): Promise<UninstallDeps> {
  const home = homedir()
  // config/env.ts adapterRootDir: the product root, which no setting moves.
  const root = join(home, '.harness')
  const platform = platformDaemonDeps()
  const service = platform.service
  const out = (text: string) => line(1, text)
  return {
    platform: process.platform, cwd: process.cwd(), home, root,
    cliDir: env.ADAPTER_CLI_DIR, dataDir: env.ADAPTER_DATA_DIR, authDir: AUTH_DIR,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    harnessOs: service?.os === true,
    ask: options.ask,
    daemonPid: () => { const pid = readPid(); return pid !== null && isAlive(pid) ? pid : null },
    alive: isAlive,
    // The port the daemon saved when it started (lib/daemonRecord.ts): another user's daemon may have had the configured
    // one, and this daemon then runs on another. The configured port still names the Unix socket, tried first when they agree.
    stopAgents: () => stopEveryAgent(() => openDaemon({ ...whereFor(undefined), port: daemonPort() })),
    service: service && !service.os ? {
      name: SERVICE_NAMES[service.platform] ?? service.platform,
      // Only this data folder's (the test stopUnderPlatform applies): a launchd job of the same label loaded from another
      // home, the person's real one when this runs with a throwaway HOME, is not this install's to remove.
      present: () => {
        if (service.ownedBy(platform.logFile)) return true
        const pid = platform.readPid()
        return pid !== null && platform.isAlive(pid) && platform.masterPlatform(pid) === service.platform
      },
      unregister: () => service.unregister(),
    } : null,
    withLock: async (fn) => {
      try {
        return await withSpawnLock('stop', fn, { onWaiting: (owner) => out(`  the Harness daemon is ${describeSpawnLockOwner(owner)}, waiting for it to finish…`) })
      } catch (error) {
        // Unlike `harness stop`, no going ahead: an update or a start in the middle would put back what this removes.
        if (error instanceof SpawnLockBusyError) throw new Error(error.reason ?? describeSpawnLockBusyPlainly(error))
        throw error
      }
    },
    stopDaemon: () => stopDaemonProcess(),
    // The home string exactly as the daemon passed it to `harness-pty serve --home` (ptyHostBackend.ts): the host's
    // command line is matched against it as written, never resolved.
    endPtyHosts: () => endPtyHosts(ptyHostsDeps(env.HARNESS_PTY_DIR)),
    removeHooks: async () => {
      const { ADOPTED_HOMES, defaultHookTargets, removeEngineHooks } = await import('../../engines/removeHooks.js')
      const { hookContracts } = await import('../../engines/hooks.js')
      const { YAML_HOOKS_KEPT } = await import('../../engines/kit/nativeHookYaml.js')
      const targets = defaultHookTargets()
      const codex = hookContracts.codex.settings
      const inCodex = (file: string | undefined) => (file ? targets.codex.homes.map((codexHome) => join(codexHome, file)) : [])
      const labels = {
        codexSettings: new Set(inCodex(codex.file)),
        reviews: new Set(inCodex(codex.reviewed?.file)),
        whole: new Set([...targets.plugins.map((plugin) => plugin.file), ...inCodex(codex.allow && 'file' in codex.allow ? codex.allow.file : undefined)]),
        adopted: ADOPTED_HOMES,
        hooksLeft: YAML_HOOKS_KEPT,
      }
      return (await removeEngineHooks(targets)).map((hook) => labelHookRemoval(hook, labels))
    },
    removeLaunchers: () => ownedBinEntries(env.HARNESS_BIN_DIR, join(env.ADAPTER_CLI_DIR, 'cli.js'), root).map((path) => {
      // Unlinked, never followed (ownedBinEntries): rmSync without recursive removes a link, not what it names.
      try { rmSync(path, { force: true }); return path } catch (error) {
        return { path, failed: error instanceof Error ? error.message : String(error) }
      }
    }),
    removePathEntry: () => {
      if (process.platform === 'win32') return { kind: 'windows', result: removeUserPathEntry(win32.join(root, 'bin'), runPowershell) }
      // The lines put ~/.local/bin on PATH, which other installers share (Claude Code's, uv, pipx): kept while it holds their commands.
      const others = listEntries(join(home, '.local', 'bin')).map((entry) => entry.name).filter((name) => !name.startsWith('.'))
      return others.length ? { kind: 'rc', edits: [], keptFor: others } : { kind: 'rc', edits: removeHarnessPathLines(home), keptFor: [] }
    },
    listEntries,
    exists: existsSync,
    removeNow: (plan) => removeNow(plan),
    scheduleFinalRemoval: (plan) => scheduleFinalRemoval(plan, finalRemovalDeps()),
    // Not `warnIfGridSignInRemains`: its `harness grid logout` is a command this one has just removed.
    afterword: () => {
      if (gridCredentialsExist()) out(`· left your Grid sign-in in ${options.tildify(gridCredentialsPath())}: it is Grid's, not Harness's. Delete it if you no longer use Grid.`)
    },
    out,
    err: (text) => line(2, text),
    tildify: options.tildify,
  }
}
