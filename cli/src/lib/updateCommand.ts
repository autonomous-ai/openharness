/**
 * `harness update`'s steps once cli.ts has stopped the daemon, under the spawn lock it holds: the terminal host
 * (Windows) and the CLI build, in that order, and under the rules the background updater keeps (spec §5).
 *
 * - The host is downloaded and canaried first, then the CLI build, and only then is anything installed: a paired host
 *   (one of a protocol above this CLI's, ./windows/ptyPayload.ts `PreparedPty.paired`) goes in only when the build
 *   being installed needs exactly its protocol, which only that build's canary says.
 * - The protocol rule (Windows): a build that needs a host protocol above the one installed, read after the host step
 *   so a host that went in now counts, is refused. A person asking by name does not override it, as they do a
 *   rolled-back version: the build would come up with no host to open a pane on. A host that cannot be read counts as
 *   this CLI's own protocol.
 * - A pair is judged as one: the CLI build is left on probation beside the host (no `confirm`), so the next master
 *   keeps or rolls back both. A paired host whose build then fails to go in is taken back out before the relaunch.
 */
import { join } from 'node:path'
import { binaryVersion } from './ptyHost/launch.js'
import { PTY_PROTOCOL } from './ptyHost/protocol.js'
import { confirm, downloadVerified, runCanary, stage, type CanaryResult, type UpdateEntry } from './selfUpdate.js'
import type { PreparedPty, PtyEntry } from './windows/ptyPayload.js'
import { installedPtyProtocol } from './windows/ptyUpdate.js'
import {
  installPtyForUpdate, preparePtyForUpdate, takeBackPtyForUpdate, type PtyUpdateCommandDeps,
} from './windows/ptyUpdateCommand.js'

export interface UpdateStepsDeps {
  downloadCli: (entry: UpdateEntry) => Promise<{ cliBuf: Buffer; notifyBuf: Buffer }>
  canary: (cliBuf: Buffer, dir: string, version: string) => Promise<CanaryResult>
  stage: (dir: string, cliBuf: Buffer, notifyBuf: Buffer, version: string) => void
  /** Keep the build at once (drop its backups): for a build not paired with a host. */
  confirm: (dir: string) => void
  /** `harness-pty.exe version`'s protocol, or null when it cannot be read. */
  readHostProtocol: (binary: string) => number | null
  pty: Partial<PtyUpdateCommandDeps>
  log: (line: string) => void
}

const DEFAULT_DEPS: UpdateStepsDeps = {
  downloadCli: async (entry) => ({ cliBuf: await downloadVerified(entry.cli), notifyBuf: await downloadVerified(entry.notify) }),
  canary: (cliBuf, dir, version) => runCanary(cliBuf, dir, version),
  stage: (dir, cliBuf, notifyBuf, version) => stage(dir, cliBuf, notifyBuf, version),
  confirm: (dir) => confirm(dir),
  readHostProtocol: (binary) => binaryVersion(binary)?.protocol ?? null,
  pty: {},
  log: (line) => console.log(line),
}

export interface UpdateStepsResult {
  cli: 'installed' | 'failed' | 'none'
  /** `paired`: a host only a newer build could use, left out. */
  pty: 'installed' | 'paired' | 'failed' | 'none'
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export async function runUpdateSteps(o: {
  /** The newer CLI build, or null when the CLI is current. */
  cliEntry: UpdateEntry | null
  /** The newer host payload (Windows), or null. */
  pty: PtyEntry | null
  cliDir: string
  /** The install root on Windows (`bin\`, `runtime\pty\`); null elsewhere, where there is no host and no rule. */
  ptyRoot: string | null
  /** The build this command runs as, which a failure keeps. */
  currentVersion: string
  deps?: Partial<UpdateStepsDeps>
}): Promise<UpdateStepsResult> {
  const d: UpdateStepsDeps = { ...DEFAULT_DEPS, ...o.deps }
  const ptyDeps: Partial<PtyUpdateCommandDeps> = { ...d.pty, log: d.log }
  const result: UpdateStepsResult = { cli: o.cliEntry ? 'failed' : 'none', pty: 'none' }

  // 1. The host, downloaded and canaried: not installed yet, as a paired one waits for the build's canary.
  let prepared: PreparedPty | null = null
  if (o.pty && o.ptyRoot !== null) {
    prepared = await preparePtyForUpdate(o.pty, { rootDir: o.ptyRoot, deps: ptyDeps })
    if (!prepared) result.pty = 'failed'
  }

  // 2. The CLI build, downloaded and canaried: its canary says the host protocol it needs.
  let build: { entry: UpdateEntry; cliBuf: Buffer; notifyBuf: Buffer; ptyProtocol: number } | null = null
  if (o.cliEntry) {
    d.log(`▸ Updating v${o.currentVersion} → v${o.cliEntry.version}…`)
    try {
      const { cliBuf, notifyBuf } = await d.downloadCli(o.cliEntry)
      const canaried = await d.canary(cliBuf, o.cliDir, o.cliEntry.version)
      if (canaried.ok) build = { entry: o.cliEntry, cliBuf, notifyBuf, ptyProtocol: canaried.ptyProtocol }
      else d.log(`  ✗ the new build failed its self-check — keeping v${o.currentVersion}`)
    } catch (error) {
      d.log(`  ✗ Update failed: ${message(error)}`)
    }
  }

  // 3. The host goes in first; a paired one only for the build that needs it.
  if (prepared && o.ptyRoot !== null) {
    result.pty = installPtyForUpdate(prepared, { rootDir: o.ptyRoot, cliPtyProtocol: build?.ptyProtocol ?? null, deps: ptyDeps })
  }
  const pairedIn = result.pty === 'installed' && prepared?.paired === true

  // 4. The protocol rule, against the host this build would come up on.
  if (build && o.ptyRoot !== null) {
    const host = installedPtyProtocol(o.ptyRoot, (binary) => {
      const protocol = d.readHostProtocol(binary)
      return protocol === null ? null : { protocol }
    }) ?? PTY_PROTOCOL
    if (build.ptyProtocol > host) {
      d.log(`  ✗ v${build.entry.version} needs terminal host protocol ${build.ptyProtocol}; this machine's host speaks ${host} — keeping v${o.currentVersion}`)
      build = null
    }
  }

  // 5. The build. Asked for by name, so a version this machine once rolled back is installed and no longer rejected.
  if (build) {
    try {
      d.stage(o.cliDir, build.cliBuf, build.notifyBuf, build.entry.version)
      // Canary passed and bytes verified: drop the backups, unless it came with a host the next master must judge
      // with it, whose rollback needs them.
      if (!pairedIn) d.confirm(o.cliDir)
      d.log(`  ✓ installed v${build.entry.version}`)
      result.cli = 'installed'
    } catch (error) {
      d.log(`  ✗ Update failed: ${message(error)}`)
    }
  }

  // 6. A paired host whose build did not go in: the old build relaunched could not use it.
  if (result.cli === 'failed' && pairedIn && o.ptyRoot !== null) {
    takeBackPtyForUpdate(o.ptyRoot, d.log)
    result.pty = 'none'
  }
  return result
}
