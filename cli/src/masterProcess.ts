/**
 * harnessd's master as a process: what `harness start` runs (`__harnessd`), and the probe a master about
 * to re-execute on a new bundle asks first (`__harnessd-probe`, harnessd/reexec.ts).
 *
 * The master holds no feature code (harnessd/AGENTS.md), yet weighed what the whole CLI weighs: every
 * process evaluated the whole bundle, and Node parses all of the file a process is started on whatever
 * it runs. Measured from the bundle at idle (2026-10-05): the master 160 MiB resident, each service 115
 * to 160. So a master started on cli.js re-executes itself, same pid, on the lean bundle cli.js carries
 * (lib/leanBundle.ts), and starts the services from it too: each then parses its own code, under 1 MB,
 * and not the CLI's 4.4.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from './config/env.js'
import { processExecve, probeMaster, runMaster, type Execve } from './harnessd/master.js'
import { PROBE_ANSWER, PROBE_TIMEOUT_MS } from './harnessd/reexec.js'
import { ensureUtf8Locale } from './lib/childLocale.js'
import { DAEMON_LOG_FILE, HARNESSD_STATUS_FILE, PID_FILE } from './lib/daemonState.js'
import { readLeanBundle, writeLeanBundle, type LeanBundle } from './lib/leanBundle.js'
import { ts } from './lib/log.js'
import { confirm as confirmUpdate, restore as restoreUpdate, unjudgedUpdate } from './lib/selfUpdate.js'
import { VERSION } from './version.js'

/** Where a master re-executing on a new bundle leaves word of it, until that master's core is up. */
export const HARNESSD_REEXEC_FILE = join(env.ADAPTER_DATA_DIR, 'harnessd-reexec.json')
/** Where the lean bundle is written out for the master and the services to start from. */
export const LEAN_DIR = join(env.ADAPTER_DATA_DIR, 'lean')
/** Handed by a master started on cli.js to itself re-executed on the lean bundle: the bundle it read the
 *  lean bundle from, and that bundle's sha256. */
export const BUNDLE_ENV = 'HARNESSD_BUNDLE'
export const BUNDLE_SHA256_ENV = 'HARNESSD_BUNDLE_SHA256'

export interface MasterStart {
  /** What the core runs and an update replaces: cli.js, or src/cli.ts from the sources. */
  scriptPath: string
  /** What the services run, when not `scriptPath`: the lean bundle. */
  serviceScriptPath?: string
  /** The sha256 of the bundle the lean bundle was read from, for a master running on the lean bundle. */
  bundleFingerprint?: string
}

/** Run the master. */
export function startMaster(start: MasterStart): ReturnType<typeof runMaster> {
  // Before it starts anything: on Linux an absent locale makes tmux and ps mangle their output, and the
  // core and the services inherit this environment (lib/childLocale.ts). launchd and systemd start the
  // master with no `harness start` before it to have set it.
  ensureUtf8Locale()
  return runMaster({
    nodePath: process.execPath,
    execArgv: process.execArgv,
    ...start,
    pidFile: PID_FILE,
    statusFile: HARNESSD_STATUS_FILE,
    logFile: DAEMON_LOG_FILE,
    restoreUpdate: () => restoreUpdate(env.ADAPTER_CLI_DIR),
    confirmUpdate: () => confirmUpdate(env.ADAPTER_CLI_DIR),
    version: VERSION,
    reexecMarkerFile: HARNESSD_REEXEC_FILE,
    unjudgedUpdate: (bundle) => unjudgedUpdate(env.ADAPTER_CLI_DIR, bundle),
  })
}

/** Whether this bundle can run a master that takes over from the running one; the exit code. */
export function probeThisMaster(): number {
  return probeMaster({ env: process.env, execArgv: process.execArgv, version: VERSION })
}

export interface BundleMasterDeps {
  env: NodeJS.ProcessEnv
  read: (path: string) => Buffer
  /** Writes the lean bundle out and returns where (lib/leanBundle.ts `writeLeanBundle`). */
  write: (lean: LeanBundle) => string
  /** Runs `<lean> __harnessd-probe` as the re-executed master would start: whether it answered. */
  probe: (leanPath: string, env: NodeJS.ProcessEnv) => { ok: boolean; detail: string }
  execve: Execve | null
  start: (start: MasterStart) => unknown
  log: (line: string) => void
}

/** Run `<leanPath> __harnessd-probe` with this process's Node and flags, as the master would start on it. */
export function probeLean(leanPath: string, probeEnv: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS): { ok: boolean; detail: string } {
  const run = spawnSync(process.execPath, [...process.execArgv, leanPath, '__harnessd-probe'], {
    env: probeEnv, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Judged as the re-execution's own probe judges a bundle (harnessd/reexec.ts `runProbe`).
  const out = String(run.stdout ?? '')
  const lastLine = (text: string): string => text.trim().split('\n').pop()!.trim()
  return {
    ok: run.status === 0 && out.includes(PROBE_ANSWER),
    detail: run.error?.message ?? (lastLine(String(run.stderr ?? '')) || lastLine(out) || (run.signal ? `signal ${run.signal}` : `exit ${run.status}`)),
  }
}

export const processBundleDeps = (): BundleMasterDeps => ({
  env: process.env,
  read: (path) => readFileSync(path),
  write: (lean) => writeLeanBundle(LEAN_DIR, lean),
  probe: (leanPath, probeEnv) => probeLean(leanPath, probeEnv),
  execve: processExecve(),
  start: startMaster,
  log: (line) => console.log(`${ts()} ${line}`),
})

/**
 * The master, started on [bundlePath] (cli.js): re-executed on the lean bundle cli.js carries when this
 * Node can (22.15 and 23.11 on), with the services started from it; run here, from cli.js, with the
 * services still started from the lean bundle when it cannot; and as before, from cli.js alone, when
 * there is no lean bundle to use or `HARNESSD_LEAN=off`. A lean bundle is used only once it has answered
 * the probe a master about to re-execute asks (harnessd/reexec.ts): one that cannot start a master is
 * never handed the daemon.
 */
export function startMasterFromBundle(bundlePath: string, deps: BundleMasterDeps = processBundleDeps()): void {
  const fromBundle = (reason: string | null, serviceScriptPath?: string): void => {
    if (reason) deps.log(`[harnessd] ${reason}`)
    deps.start({ scriptPath: bundlePath, ...(serviceScriptPath ? { serviceScriptPath } : {}) })
  }
  if (deps.env.HARNESSD_LEAN === 'off') { fromBundle(null); return }
  let written: { lean: LeanBundle; path: string } | null
  try {
    const lean = readLeanBundle(deps.read(bundlePath))
    written = lean ? { lean, path: deps.write(lean) } : null
  } catch (error) {
    fromBundle(`the lean bundle could not be written out (${error instanceof Error ? error.message : String(error)}): the master and the services run from ${bundlePath}`)
    return
  }
  if (!written) { fromBundle(`no lean bundle in ${bundlePath}: the master and the services run from it`); return }
  const { lean, path: leanPath } = written
  const leanEnv = { ...deps.env, [BUNDLE_ENV]: bundlePath, [BUNDLE_SHA256_ENV]: lean.bundleSha256 }
  const probed = deps.probe(leanPath, leanEnv)
  if (!probed.ok) {
    fromBundle(`the lean bundle ${leanPath} did not answer its probe (${probed.detail}): the master and the services run from ${bundlePath}`)
    return
  }
  if (!deps.execve) {
    fromBundle(`this Node cannot re-execute the master: it runs from ${bundlePath}, the services from ${leanPath}`, leanPath)
    return
  }
  try {
    deps.execve(process.execPath, [process.execPath, ...process.execArgv, leanPath, '__harnessd'], leanEnv)
  } catch (error) {
    fromBundle(`the master could not re-execute on ${leanPath} (${error instanceof Error ? error.message : String(error)}): it runs from ${bundlePath}, the services from ${leanPath}`, leanPath)
  }
}
