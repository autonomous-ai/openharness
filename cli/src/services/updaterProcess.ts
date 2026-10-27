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
 *
 * On Windows it checks the terminal host's payload too (lib/windows/ptyUpdate.ts), under a master that judges one
 * (`HARNESSD_JUDGES_PTY`). A host alone is staged and told as `ptyVersion`; a host and a build found at one check go
 * in one lock hold and one message, the host first. Either staging ends this process the same way, and the next run
 * checks both again. A host of a protocol above this build's (a paired one) goes in only with the build that needs it;
 * if that build then fails to stage, the host is taken back out and nothing is told (lib/windows/ptyUpdate.ts
 * `takeBackPty`).
 */
import { userInfo } from 'node:os'
import { env } from '../config/env.js'
import { readTeamConfig } from '../team/config.js'
import { SERVICE_EXIT_RESTART, type StagedUpdate, type UpdaterMessage } from '../harnessd/protocol.js'
import { describeSpawnLockOwner, withSpawnLock } from '../lib/daemonSpawnLock.js'
import { DOWNLOAD_LIMITS, downloadVerified, isLocalDevBuild, retireCliVersions, startSelfUpdater } from '../lib/selfUpdate.js'
import { currentCli } from '../lib/windows/installLayout.js'
import { processRetireDeps } from '../lib/windows/cliVersions.js'
import { preparePtyPayload, ptyManifestUrl, ptyPlatformKey } from '../lib/windows/ptyPayload.js'
import { installedPtyProtocol, startPtyUpdater, sweepPtyLeftovers, takeBackPty, type StagedHost } from '../lib/windows/ptyUpdate.js'
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
  /** Windows: the terminal host's poller, and the install root it works in (`bin\`, `runtime\pty\`). Left out
   *  elsewhere. */
  startPty?: typeof startPtyUpdater
  ptyRootDir?: string
  /** Windows: the protocol of the installed host, which a CLI build must not need more than (lib/selfUpdate.ts
   *  `installedPtyProtocol`). Left out elsewhere. */
  installedPtyProtocol?: () => number | null
  /** Whether this daemon is a Mac's Harness Team account (team/config.ts names its user); real by default. */
  inTeamAccount?: () => boolean
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
    startPty: startPtyUpdater,
    ptyRootDir: dirname(cliDir),
    installedPtyProtocol: () => installedPtyProtocol(dirname(cliDir)),
  } : {}),
})

export function runUpdaterService(_options?: unknown, deps: UpdaterServiceDeps = processUpdaterDeps()): ServiceProcess {
  // What its master, or the core it runs beside, said: held out of process.env (lib/harnessdEnv.ts).
  const harnessd = harnessdEnv()
  const installed = deps.installedVersion?.() ?? VERSION
  const limits = { idleMs: env.ADAPTER_UPDATE_IDLE_MS, deadlineMs: env.ADAPTER_UPDATE_DEADLINE_MS, floorBytesPerSecond: DOWNLOAD_LIMITS.floorBytesPerSecond }
  // One lock section at a time in this process. The spawn lock is re-entrant, so it does not keep this process's two
  // pollers apart: a host installed while the CLI's handover is under way would be told in a second message.
  let section: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = section.then(fn, fn)
    section = run.catch(() => {})
    return run
  }
  // The lock spans the byte swap and the word to the master: a `harness start` or `harness update` that
  // lands between them would stage over the backup this one just made.
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => oneAtATime(() => withSpawnLock('handoff', fn, {
    onWaiting: (owner) => deps.log(`[update] waiting — the daemon is ${describeSpawnLockOwner(owner)}`),
  }))
  const handOver = (staged: StagedUpdate): Promise<void> => new Promise<void>((done) => {
    deps.tell({ type: 'harnessd:staged', ...staged }, () => {
      done()
      deps.exit(SERVICE_EXIT_RESTART)
    })
  })
  const pty = startPty(deps, harnessd, installed, limits, withLock, handOver)
  // Windows: what installs leave in bin\ and runtime\pty\ is swept at every start, under the lock; the poller does
  // that itself before its first check, and without one (a master from before, an unusable manifest URL) it is done
  // here. A bin file missing whose aside file holds its bytes is put back first, and while one is not, nothing goes.
  if (!pty && deps.ptyRootDir !== undefined) {
    const root = deps.ptyRootDir
    void withLock(async () => { sweepPtyLeftovers(root, deps.log) })
      .catch((error: unknown) => deps.log(`[update] could not sweep the terminal host's leftovers (${error instanceof Error ? error.message : String(error)}) — the next start tries again`))
  }
  // A host the CLI's handover took (`beforeStage`) and has not told yet: if that stage fails, a supported one is told on
  // its own, and a paired one taken back out.
  let ptyTaken: StagedHost | null = null
  const cli = deps.startCli({
    currentVersion: VERSION,
    // The Harness Team account takes releases even over the local build setup may have copied into it (selfUpdate.ts).
    ...((deps.inTeamAccount ?? inTeamAccount)() ? { followReleases: true } : {}),
    url: env.ADAPTER_UPDATE_URL,
    key: env.ADAPTER_UPDATE_KEY,
    dir: env.ADAPTER_CLI_DIR,
    intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
    slotSecond: env.ADAPTER_UPDATE_SLOT_SEC,
    withLock: (fn) => withLock(async () => {
      try {
        return await fn()
      } finally {
        // Installed for this handover and then the build's stage failed. A supported host is on disk, on probation, and
        // must still be handed over, or no master would judge it. A paired one would come up under this build, which
        // cannot open a pane on it, and a master judging it with this build's core would likely keep it: it is taken
        // back out, and nothing is handed over; its poller, finished by that install, checks again, backed off as a
        // refused payload is, and prepares it again for the build after.
        const taken = ptyTaken
        ptyTaken = null
        if (taken?.paired && deps.ptyRootDir !== undefined) {
          takeBackPty(deps.ptyRootDir, deps.log, '[update] ')
          pty?.takenBack()
        } else if (taken !== null) await handOver({ ptyVersion: taken.version })
      }
    }),
    // A paired host (one of a protocol above this build's) goes in only for the build that needs it: the poller is told
    // which protocol that is, and the CLI's protocol rule hears what is ready to go in first.
    ...(pty ? {
      beforeStage: async (ptyProtocol: number) => {
        ptyTaken = await pty.readyToStage(ptyProtocol)
        return ptyTaken && { version: ptyTaken.version, protocol: ptyTaken.protocol }
      },
      readyPtyProtocol: () => pty.readyProtocol(),
    } : {}),
    onStaged: (version, ptyVersion) => {
      ptyTaken = null
      return handOver({ version, ...(ptyVersion ? { ptyVersion } : {}) })
    },
    limits,
    // Under any master: a build that needs a host this machine does not have would open no pane, whoever judged it.
    ...(deps.installedPtyProtocol ? { installedPtyProtocol: deps.installedPtyProtocol } : {}),
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
  deps.log(isLocalDevBuild(installed)
    ? `[update] self-update off · v${installed} is a development build, which never takes an update`
    : `[update] self-update on · v${installed} · every ${Math.round(env.ADAPTER_UPDATE_CHECK_MS / 1000)}s`)
  return { stop: () => { cli.stop(); hn.stop(); pty?.stop() } }
}

/** Windows, under a master that judges a host: the terminal host's poller (lib/windows/ptyUpdate.ts). Null otherwise. */
function startPty(
  deps: UpdaterServiceDeps, harnessd: NodeJS.ProcessEnv, installed: string, limits: typeof DOWNLOAD_LIMITS,
  withLock: <T>(fn: () => Promise<T>) => Promise<T>, handOver: (staged: StagedUpdate) => Promise<void>,
): ReturnType<typeof startPtyUpdater> | null {
  if (!deps.startPty || deps.ptyRootDir === undefined) return null
  // Under a master from before, a host staged would be told to no one who rolls it back: it waits for the master to
  // be replaced by one that does (the next CLI update).
  if (harnessd.HARNESSD_JUDGES_PTY !== '1') return null
  const key = ptyPlatformKey()
  let url: string
  try {
    url = ptyManifestUrl(env.ADAPTER_UPDATE_URL)
  } catch (error) {
    deps.log(`[update] no terminal host updates: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (key === null) return null
  return deps.startPty({
    url, key, rootDir: deps.ptyRootDir,
    intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
    slotSecond: env.ADAPTER_UPDATE_SLOT_SEC,
    installedCli: () => deps.installedVersion?.() ?? installed,
    withLock,
    onStaged: (ptyVersion) => handOver({ ptyVersion }),
    deps: { prepare: (entry, runtimeDir, verified) => preparePtyPayload(entry, runtimeDir, { download: (ref) => downloadVerified(ref, limits) }, verified) },
  })
}

/** This process runs as the Harness Team account its Mac's root-owned config names. An account whose name cannot be read
 *  is not it. */
export function inTeamAccount(config = readTeamConfig, user = () => userInfo().username): boolean {
  try { return config()?.user === user() } catch { return false }
}
