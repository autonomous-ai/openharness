/**
 * Gives this Vitest run a temporary folder of its own, which cli/vitest.tmpdir.ts gives each of the run's workers a folder in.
 * The folder goes when the run's process exits, and a later run removes what a killed run left.
 *
 * Runs going at once shared $TMPDIR/vw1, vw2… before: each run's mkdtemp and rm there changed an ancestor of the others'
 * fixtures, which is the change the native evidence readers hold a listing for (vitest.tmpdir.ts). Three core gates ran at once
 * on one Mac on 2026-11-10, and nothing removed what the runs left: vw1 held 24,592 entries.
 */
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** In each run's folder: the id of the process running the run, which tells a later run whether it ended. */
export const RUN_FILE = '.harness-test-run'
/** The variable that hands the run's folder to its workers. */
export const RUN_DIR = 'HARNESS_VITEST_RUN_DIR'
const DAY_MS = 24 * 60 * 60 * 1000

/** Where runs' folders go. On macOS /tmp, not the 48-byte $TMPDIR: specs put Unix sockets in folders of their own in a
 *  worker's folder, a socket's path has 96 bytes (lib/localSocket.ts), and in $TMPDIR one more folder level took
 *  localCredential.port.spec past it. Specs that need a short home already use /tmp. */
export const runsBase = (): string => process.platform === 'darwin' ? '/tmp' : tmpdir()

/** A new folder for one run. mkdtemp names it, so no other run gets it, not even a run with the same process id in another
 *  container. */
export function createRun(base: string): string {
  const root = mkdtempSync(join(base, 'v'))
  writeFileSync(join(root, RUN_FILE), String(process.pid))
  return root
}

/** This user's own folder or file, of that kind and not a link: a shared /tmp holds other users' too. */
const own = (path: string, kind: 'directory' | 'file') => {
  const info = lstatSync(path)
  return (kind === 'directory' ? info.isDirectory() : info.isFile()) && (!process.getuid || info.uid === process.getuid()) ? info : null
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Removes the folders of runs that ended without removing them: killed, or ended by a signal. Only this user's folder with a
 *  run's file, more than a day old and whose process is gone: a run in another container sharing /tmp looks gone from here.
 *  A process that took a killed run's id keeps its folder until it ends too. */
export function sweepEndedRuns(base: string, now: number = Date.now()): void {
  for (const name of readdirSync(base)) {
    if (!/^v[A-Za-z0-9]{6}$/.test(name)) continue
    const root = join(base, name)
    try {
      const file = own(root, 'directory') && own(join(root, RUN_FILE), 'file')
      if (!file || now - file.mtimeMs <= DAY_MS || file.size > 16) continue
      const pid = Number(readFileSync(join(root, RUN_FILE), 'utf8'))
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue
    } catch { continue }
    removeRun(root)
  }
}

/** The folders every run shared before (vw1, vw2… in $TMPDIR). Until 2026-12-10, when no checkout from before 2026-11-10 should
 *  still run: one may still use them, so only a folder no run has changed for a day goes. */
export function sweepSharedFolders(base: string, now: number = Date.now()): void {
  for (const name of readdirSync(base)) {
    if (!/^vw\d+$/.test(name)) continue
    try {
      const folder = own(join(base, name), 'directory')
      if (!folder || now - folder.mtimeMs <= DAY_MS) continue
    } catch { continue }
    removeRun(join(base, name))
  }
}

/** Says which folder it could not remove. */
export function removeRun(root: string): void {
  try { rmSync(root, { recursive: true, force: true }) }
  catch (error) { console.warn(`vitestRun.ts could not remove ${root}: ${(error as NodeJS.ErrnoException).code ?? error}`) }
}

/** Starts a run in `runs`, after clearing what ended runs left there and in `shared`. The folder goes when the run's process
 *  exits, after the workers: Vitest runs a globalSetup's teardown before it closes them. A run ended by a signal may still have
 *  workers writing in it, so its folder waits for a later run's sweep. */
export function beginRun(runs: string, shared: string): string {
  sweepEndedRuns(runs)
  sweepSharedFolders(shared)
  const root = createRun(runs)
  // The workers start after this, and inherit it.
  process.env[RUN_DIR] = root
  process.once('exit', code => { if (code < 128) removeRun(root) })
  return root
}

/** The run's globalSetup. */
export default function startRun(): void {
  beginRun(runsBase(), tmpdir())
}
