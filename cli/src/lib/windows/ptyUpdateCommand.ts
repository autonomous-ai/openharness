/**
 * `harness update`'s half for the terminal host on Windows (spec §5): the command a person runs to take an update now
 * also installs a newer promoted PTY payload, under the same spawn lock and before the CLI, and with the CLI already
 * current it installs the host alone and restarts the daemon (../updateCommand.ts `runUpdateSteps`, from cli.ts).
 *
 * The same download, canary and install as the background updater's (./ptyPayload.ts, ./ptyInstall.ts), with the
 * differences a person asking by name makes, as for the CLI: the versions this machine rolled back
 * (`pty-rejected.json`) are installed anyway, and nothing is backed off. What it does not override is a version still
 * on probation: its marker names the version to go back to, and only the master's probation may settle it. Nor the
 * pairing rule: a host of a protocol above this CLI's goes in only with the CLI build that needs it.
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { currentPtyVersion } from '../ptyHost/launch.js'
import { PTY_PROTOCOL } from '../ptyHost/protocol.js'
import { semverGt } from '../selfUpdate.js'
import { installPreparedPty, readPtyPending, type PtyPending } from './ptyInstall.js'
import { fetchPtyEntry, preparePtyPayload, type PreparedPty, type PtyEntry } from './ptyPayload.js'
import { takeBackPty } from './ptyUpdate.js'

export interface PtyUpdateCommandDeps {
  fetchEntry: (url: string, key: string) => Promise<PtyEntry | null>
  prepare: (entry: PtyEntry, runtimeDir: string) => Promise<PreparedPty>
  install: (prepared: PreparedPty, rootDir: string) => boolean
  log: (line: string) => void
}

const DEFAULT_DEPS: PtyUpdateCommandDeps = {
  fetchEntry: (url, key) => fetchPtyEntry(url, key),
  prepare: (entry, runtimeDir) => preparePtyPayload(entry, runtimeDir),
  install: (prepared, rootDir) => installPreparedPty(prepared, rootDir),
  log: (line) => console.log(line),
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const runtimeOf = (rootDir: string): string => join(rootDir, 'runtime')

const onProbation = (pending: PtyPending, entry: PtyEntry): string =>
  `  terminal host ${pending.version} is still on probation, so ${entry.version} is not installed now: run \`harness update\` again once the daemon has kept it or rolled it back`

/**
 * Asked before anything is stopped: the promoted payload when it is newer than the host `current-pty` names, or null.
 * Null too with no installed host (the first one is install.ps1's), a manifest that cannot be read (said: the CLI's
 * update goes on), and a version still on probation (said once, here).
 */
export async function newerPtyForUpdate(o: {
  url: string
  key: string
  /** The install root: `bin\` and `runtime\pty\` are in it. */
  rootDir: string
  deps?: Partial<PtyUpdateCommandDeps>
}): Promise<PtyEntry | null> {
  const d: PtyUpdateCommandDeps = { ...DEFAULT_DEPS, ...o.deps }
  let entry: PtyEntry | null
  try {
    entry = await d.fetchEntry(o.url, o.key)
  } catch (error) {
    d.log(`  could not check for a terminal host update (${message(error)}); continuing with the CLI`)
    return null
  }
  const installed = currentPtyVersion(runtimeOf(o.rootDir))
  if (!entry || installed === null || !semverGt(entry.version, installed)) return null
  const pending = readPtyPending(o.rootDir)
  if (pending) { d.log(onProbation(pending, entry)); return null }
  return entry
}

/**
 * Under the spawn lock the command holds, with the daemon stopped: download, verify and canary [entry], ready to
 * install. Null when it cannot be (said): a version on probation since the check, or a payload that failed. Never
 * throws: the CLI's update goes on.
 */
export async function preparePtyForUpdate(entry: PtyEntry, o: { rootDir: string; deps?: Partial<PtyUpdateCommandDeps> }): Promise<PreparedPty | null> {
  const d: PtyUpdateCommandDeps = { ...DEFAULT_DEPS, ...o.deps }
  // A marker that appeared since the check (an updater's install before the stop): refused before any download.
  const pending = readPtyPending(o.rootDir)
  if (pending) { d.log(onProbation(pending, entry)); return null }
  const installed = currentPtyVersion(runtimeOf(o.rootDir))
  d.log(`▸ Updating the terminal host ${installed} → ${entry.version}…`)
  try {
    return await d.prepare(entry, runtimeOf(o.rootDir))
  } catch (error) {
    d.log(`  ✗ terminal host ${entry.version} was not installed (${message(error)}) — keeping ${installed}`)
    return null
  }
}

/**
 * Install [prepared], or leave a paired one out unless the CLI build being installed needs exactly its protocol
 * ([cliPtyProtocol], null with none). `installed` is on probation for the next master to judge, as one the updater
 * staged; `paired` was left out (its staging folder removed). Never throws.
 */
export function installPtyForUpdate(
  prepared: PreparedPty,
  o: { rootDir: string; cliPtyProtocol: number | null; deps?: Partial<PtyUpdateCommandDeps> },
): 'installed' | 'paired' | 'failed' {
  const d: PtyUpdateCommandDeps = { ...DEFAULT_DEPS, ...o.deps }
  if (prepared.paired && o.cliPtyProtocol !== prepared.protocol) {
    // A just-run canary can hold a file a moment; what is left is the updater's start sweep's.
    try { rmSync(prepared.staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* swept later */ }
    d.log(`  terminal host ${prepared.version} speaks protocol ${prepared.protocol}, above this CLI's ${PTY_PROTOCOL} — it goes in only with a CLI build that needs it`)
    return 'paired'
  }
  const installed = currentPtyVersion(runtimeOf(o.rootDir))
  try {
    // False: another installer put this very version in since the check, which is as good.
    if (d.install(prepared, o.rootDir)) d.log(`  ✓ installed terminal host ${prepared.version}`)
    else d.log(`  terminal host ${prepared.version} is already installed`)
    return 'installed'
  } catch (error) {
    d.log(`  ✗ terminal host ${prepared.version} was not installed (${message(error)}) — keeping ${installed}`)
    return 'failed'
  }
}

/**
 * A paired host whose CLI build then failed to go in: taken back out before the old build is relaunched, which could
 * not open a pane on it, and not remembered as rolled back (./ptyUpdate.ts `takeBackPty`). Never throws.
 */
export function takeBackPtyForUpdate(rootDir: string, log: (line: string) => void): void {
  // What did not happen is marked ✗, as every other failure `harness update` reports.
  takeBackPty(rootDir, log, '  ', '  ✗ ')
}
