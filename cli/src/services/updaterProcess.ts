/**
 * Harness's updater, in a process of its own that harnessd's master runs (`harness __service updater`,
 * harnessd/services.ts `UPDATER_HOST`), only for the installed copy with updates on (masterProcess.ts).
 *
 * It checks the release manifest for a newer CLI and a newer hn, downloads and verifies them, runs the new
 * CLI's canary and stages it (lib/selfUpdate.ts, tui/install.ts), then tells the master (`harnessd:staged`).
 * The master asks the core to hand over (`harnessd:update`) and judges the new build on probation, as when
 * the core staged it itself. That is what it was until now: the core's process downloaded builds, a 15 s
 * canary and minutes of downloads in a process that must never go down, and a core in safe mode ran on
 * only for its updater. Here a broken download or a hung check costs this process alone, and a core that
 * cannot start at all still gets its fix (docs/design/2026-10-06-core-boundary-next.md, "Updaters").
 *
 * Once it has staged a build it exits with `SERVICE_EXIT_RESTART`, and the master starts it again at once:
 * a staging is the updater's last act on the bundle it runs, and the next check is the new build's.
 */
import { env } from '../config/env.js'
import { SERVICE_EXIT_RESTART, type UpdaterMessage } from '../harnessd/protocol.js'
import { describeSpawnLockOwner, withSpawnLock } from '../lib/daemonSpawnLock.js'
import { DOWNLOAD_LIMITS, isLocalDevBuild, retireCliVersions, startSelfUpdater } from '../lib/selfUpdate.js'
import { currentCli } from '../lib/windows/installLayout.js'
import { processRetireDeps } from '../lib/windows/cliVersions.js'
import { startTuiUpdater } from '../tui/update.js'
import { VERSION } from '../version.js'
import { harnessdEnv } from '../lib/harnessdEnv.js'
import { dirname } from 'node:path'
import type { ServiceProcess } from './process.js'

export interface UpdaterServiceDeps {
  /** Tell the master; `sent` once the message has left (an exit before it would lose it). */
  tell(message: UpdaterMessage, sent: () => void): void
  exit(code: number): void
  startCli: typeof startSelfUpdater
  startHn: typeof startTuiUpdater
  log(line: string): void
  /** Windows: retire the older CLI builds (lib/selfUpdate.ts `retireCliVersions`), once as the updater starts — it
   *  starts again after every build it stages, and with every master. Left out elsewhere. */
  retire?: () => Promise<unknown>
  /** The build that is installed, which the start line names: on Windows the one `cli\current` points to, which after a
   *  rollback is not the build this process runs from. This process's VERSION when left out. */
  installedVersion?: () => string
}

/** [cliDir]: the CLI folder the retirement looks at, this user's own unless a test names one of its own. */
export const processUpdaterDeps = (platform: NodeJS.Platform = process.platform, cliDir: string = env.ADAPTER_CLI_DIR): UpdaterServiceDeps => ({
  tell: (message, sent) => {
    // Under its master, the spawn channel; started by hand, there is no one to tell, and nothing to wait on.
    if (!process.send) { sent(); return }
    process.send(message, () => sent())
  },
  exit: (code) => process.exit(code),
  startCli: startSelfUpdater,
  startHn: startTuiUpdater,
  log: (line) => console.log(line),
  // Under the lock every stage takes: a `harness update` that renames a build's folder into place and then moves the
  // pointer to it must not find the folder gone in between.
  ...(platform === 'win32' ? {
    retire: () => withSpawnLock('update', () => retireCliVersions(cliDir, processRetireDeps())),
    installedVersion: () => currentCli(dirname(cliDir))?.version ?? VERSION,
  } : {}),
})

export function runUpdaterService(_options?: unknown, deps: UpdaterServiceDeps = processUpdaterDeps()): ServiceProcess {
  // What its master, or the core it runs beside, said: held out of process.env (lib/harnessdEnv.ts).
  const harnessd = harnessdEnv()
  const cli = deps.startCli({
    currentVersion: VERSION,
    url: env.ADAPTER_UPDATE_URL,
    key: env.ADAPTER_UPDATE_KEY,
    dir: env.ADAPTER_CLI_DIR,
    intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
    slotSecond: env.ADAPTER_UPDATE_SLOT_SEC,
    // The lock spans the byte swap and the word to the master: a `harness start` or `harness update` that
    // lands between them would stage over the backup this one just made.
    withLock: (fn) => withSpawnLock('handoff', fn, {
      onWaiting: (owner) => deps.log(`[update] waiting — the daemon is ${describeSpawnLockOwner(owner)}`),
    }),
    onStaged: (version) => new Promise<void>((done) => {
      deps.tell({ type: 'harnessd:staged', version }, () => {
        done()
        deps.exit(SERVICE_EXIT_RESTART)
      })
    }),
    limits: { idleMs: env.ADAPTER_UPDATE_IDLE_MS, deadlineMs: env.ADAPTER_UPDATE_DEADLINE_MS, floorBytesPerSecond: DOWNLOAD_LIMITS.floorBytesPerSecond },
    // A master judges a build staged while the one before is on probation (#807). Beside a core, under a
    // master too old to run the updater (core/updaterBeside.ts), only one that says so: one from before
    // rolled the newer build back with the one it judged.
    stageWhileJudged: harnessd.HARNESSD_UPDATER_BESIDE_CORE !== '1' || harnessd.HARNESSD_JUDGES_SUPERSEDED === '1',
  })
  // hn is an independent, optional download: its failure never holds up the CLI's fix.
  const hn = deps.startHn({
    currentVersion: VERSION,
    isInstalledCopy: true,
    disabled: env.ADAPTER_UPDATE_DISABLE,
    intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
    slotSecond: env.ADAPTER_UPDATE_SLOT_SEC,
  })
  // Never in the way of the update itself: a pass that fails is the next start's to repeat.
  void deps.retire?.().catch((error: unknown) => deps.log(`[update] retiring older CLI builds failed: ${error instanceof Error ? error.message : String(error)}`))
  // A development build is never replaced (lib/selfUpdate.ts isLocalDevBuild): it said "on" and polled in silence (G5).
  const installed = deps.installedVersion?.() ?? VERSION
  deps.log(isLocalDevBuild(installed)
    ? `[update] self-update off · v${installed} is a development build, which never takes an update`
    : `[update] self-update on · v${installed} · every ${Math.round(env.ADAPTER_UPDATE_CHECK_MS / 1000)}s`)
  return { stop: () => { cli.stop(); hn.stop() } }
}
