/**
 * `harness update`'s half for the terminal host on Windows (spec §5): the command a person runs to take an update now
 * also installs a newer promoted PTY payload, under the same spawn lock and before the CLI, and with the CLI already
 * current it installs the host alone and restarts the daemon (cli.ts `updateCommand`).
 *
 * The same download, canary and install as the background updater's (./ptyPayload.ts, ./ptyInstall.ts), with the
 * differences a person asking by name makes, as for the CLI: the versions this machine rolled back
 * (`pty-rejected.json`) are installed anyway, and nothing is backed off. What it does not override is a version still
 * on probation: its marker names the version to go back to, and only the master's probation may settle it.
 */
import { join } from 'node:path'
import { currentPtyVersion } from '../ptyHost/launch.js'
import { semverGt } from '../selfUpdate.js'
import { installPreparedPty, readPtyPending, type PtyPending } from './ptyInstall.js'
import { fetchPtyEntry, preparePtyPayload, type PreparedPty, type PtyEntry } from './ptyPayload.js'

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
  const installed = currentPtyVersion(join(o.rootDir, 'runtime'))
  if (!entry || installed === null || !semverGt(entry.version, installed)) return null
  const pending = readPtyPending(o.rootDir)
  if (pending) { d.log(onProbation(pending, entry)); return null }
  return entry
}

/**
 * Under the spawn lock the command holds, with the daemon stopped: download, verify, canary and install [entry]. True
 * when it is installed, on probation for the next master to judge, as one the updater staged. Never throws: a payload
 * that fails is reported, the host in use stays, and the CLI's update goes on.
 */
export async function installPtyForUpdate(entry: PtyEntry, o: { rootDir: string; deps?: Partial<PtyUpdateCommandDeps> }): Promise<boolean> {
  const d: PtyUpdateCommandDeps = { ...DEFAULT_DEPS, ...o.deps }
  // A marker that appeared since the check (an updater's install before the stop): refused before any download.
  const pending = readPtyPending(o.rootDir)
  if (pending) { d.log(onProbation(pending, entry)); return false }
  const installed = currentPtyVersion(join(o.rootDir, 'runtime'))
  d.log(`▸ Updating the terminal host ${installed} → ${entry.version}…`)
  try {
    const prepared = await d.prepare(entry, join(o.rootDir, 'runtime'))
    // False: another installer put this very version in since the check, which is as good.
    if (d.install(prepared, o.rootDir)) d.log(`  ✓ installed terminal host ${entry.version}`)
    else d.log(`  terminal host ${entry.version} is already installed`)
    return true
  } catch (error) {
    d.log(`  ✗ terminal host ${entry.version} was not installed (${message(error)}) — keeping ${installed}`)
    return false
  }
}
