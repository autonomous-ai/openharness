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
import { DOWNLOAD_LIMITS, startSelfUpdater } from '../lib/selfUpdate.js'
import { startTuiUpdater } from '../tui/update.js'
import { VERSION } from '../version.js'
import type { ServiceProcess } from './process.js'

export interface UpdaterServiceDeps {
  /** Tell the master; `sent` once the message has left (an exit before it would lose it). */
  tell(message: UpdaterMessage, sent: () => void): void
  exit(code: number): void
  startCli: typeof startSelfUpdater
  startHn: typeof startTuiUpdater
  log(line: string): void
}

export const processUpdaterDeps = (): UpdaterServiceDeps => ({
  tell: (message, sent) => {
    // Under its master, the spawn channel; started by hand, there is no one to tell, and nothing to wait on.
    if (!process.send) { sent(); return }
    process.send(message, () => sent())
  },
  exit: (code) => process.exit(code),
  startCli: startSelfUpdater,
  startHn: startTuiUpdater,
  log: (line) => console.log(line),
})

export function runUpdaterService(_options?: unknown, deps: UpdaterServiceDeps = processUpdaterDeps()): ServiceProcess {
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
    stageWhileJudged: process.env.HARNESSD_UPDATER_BESIDE_CORE !== '1' || process.env.HARNESSD_JUDGES_SUPERSEDED === '1',
  })
  // hn is an independent, optional download: its failure never holds up the CLI's fix.
  const hn = deps.startHn({
    currentVersion: VERSION,
    isInstalledCopy: true,
    disabled: env.ADAPTER_UPDATE_DISABLE,
    intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
    slotSecond: env.ADAPTER_UPDATE_SLOT_SEC,
  })
  deps.log(`[update] self-update on · v${VERSION} · every ${Math.round(env.ADAPTER_UPDATE_CHECK_MS / 1000)}s`)
  return { stop: () => { cli.stop(); hn.stop() } }
}
