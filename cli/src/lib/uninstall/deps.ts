/** This computer's side of `harness uninstall` (command.ts): every module it needs, loaded only when it runs. */
import { existsSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { env } from '../../config/env.js'
import { openDaemon, whereFor } from '../../agentClient/daemon.js'
import { AUTH_DIR } from '../authSession.js'
import { daemonPort, isAlive, readPid } from '../daemonState.js'
import { SpawnLockBusyError, withSpawnLock } from '../daemonSpawnLock.js'
import { stopDaemonProcess } from '../daemonStop.js'
import { gridCredentialsPath, gridCredentialsExist } from '../gridCredentials.js'
import { ownedBinEntries } from '../launchers.js'
import { platformDaemonDeps } from '../platformDaemon.js'
import { runPowershell } from '../windows/powershell.js'
import { stopEveryAgent } from './agents.js'
import { labelHookRemoval, lockHolder, UninstallLockBusy, type UninstallDeps } from './command.js'
import { endPtyHosts, ptyHostsDeps } from './ptyHosts.js'
import { filesWithHarnessPathLines, removeHarnessPathLines } from './rcFiles.js'
import { checkRemovable, finalRemovalDeps, listEntries, removeNow, scheduleFinalRemoval, UNINSTALL_MARKER } from './removal.js'
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
  const marker = join(root, UNINSTALL_MARKER)
  return {
    platform: process.platform, cwd: process.cwd(), home, root,
    cliDir: env.ADAPTER_CLI_DIR, dataDir: env.ADAPTER_DATA_DIR, authDir: AUTH_DIR,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    harnessOs: service?.os === true,
    // messages/command.ts `sendPane` reads the same two: a Windows terminal's pane is HARNESS_PANE, a tmux one TMUX_PANE.
    pane: process.env.HARNESS_PANE || process.env.TMUX_PANE || null,
    // Best effort: an uninstall that cannot write it still runs, as it did before the marker. A root that is gone has
    // no files left for a daemon to hold.
    markUninstalling: () => { try { writeFileSync(marker, `${Math.floor(Date.now() / 1000)}\n`) } catch { /* see above */ } },
    unmarkUninstalling: () => { rmSync(marker, { force: true }) },
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
        // A task whose file is gone (a half install) is still found, by the log its registered XML names (B5.9 review, I3).
        if (!service.installed() && service.registeredFor(platform.logFile)) return true
        const pid = platform.readPid()
        return pid !== null && platform.isAlive(pid) && platform.masterPlatform(pid) === service.platform
      },
      unregister: () => service.unregister(),
    } : null,
    withLock: async (fn) => {
      try {
        return await withSpawnLock('stop', fn, { onWaiting: (owner) => out(`  ${lockHolder(owner)}: waiting for it to finish…`) })
      } catch (error) {
        // Unlike `harness stop`, no going ahead: an update or a start in the middle would put back what this removes.
        if (error instanceof SpawnLockBusyError) {
          if (error.reason) throw new UninstallLockBusy('foreign', error.reason)
          throw new UninstallLockBusy('busy', error.owner ? lockHolder(error.owner) : 'Harness could not tell which one')
        }
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
        claudeSettings: new Set(targets.claude.homes.map((claudeHome) => join(claudeHome, hookContracts.claude.settings.file))),
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
      // Said to be kept only when there is a line of Harness's to keep (B5.9 review, M8).
      const others = listEntries(join(home, '.local', 'bin')).map((entry) => entry.name).filter((name) => !name.startsWith('.'))
      if (!others.length) return { kind: 'rc', edits: removeHarnessPathLines(home), keptFor: [] }
      return { kind: 'rc', edits: [], keptFor: filesWithHarnessPathLines(home).length ? others : [] }
    },
    listEntries,
    exists: existsSync,
    // On Windows with the temp folder the last step runs from, which must not be in the root.
    checkRemovable: (plan) => { checkRemovable(plan, process.platform === 'win32' ? { tempDir: finalRemovalDeps().tempDir } : {}) },
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
