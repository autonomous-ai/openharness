/**
 * Gives this Vitest run a temporary folder of its own, which cli/vitest.tmpdir.ts gives each of the run's workers a folder in.
 * The folder goes when the run's process exits, and a later run removes what a killed run left.
 *
 * Runs going at once shared vw1, vw2… before: each run's mkdtemp and rm there changed an ancestor of the others' fixtures,
 * which is the change the native evidence readers hold a listing for (vitest.tmpdir.ts). Three core gates ran at once on one
 * Mac on 2026-11-10, and nothing removed what the runs left: vw1 held 24,592 entries.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** In each run's folder: the id of the process running the run, which tells a later run whether it ended. */
export const RUN_FILE = '.harness-test-run'
const DAY_MS = 24 * 60 * 60 * 1000

/** A new folder for one run. mkdtemp names it, so no other run gets it, not even a run with the same process id in another
 *  container. Short: the daemon's socket path in it has 96 bytes (vitest.tmpdir.ts). */
export function createRun(base: string = tmpdir()): string {
  const root = mkdtempSync(join(base, 'v'))
  writeFileSync(join(root, RUN_FILE), String(process.pid))
  return root
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Removes the folders of runs that ended without removing them: killed, or timed out. Only a folder with a run's file, whose
 *  process is gone and which is more than a day old: a run in another container sharing this folder looks gone from here. */
export function sweepEndedRuns(base: string = tmpdir(), now: number = Date.now()): void {
  for (const name of readdirSync(base)) {
    if (!/^v[A-Za-z0-9]{6}$/.test(name)) continue
    const file = join(base, name, RUN_FILE)
    let pid: number, written: number
    try { pid = Number(readFileSync(file, 'utf8')); written = statSync(file).mtimeMs } catch { continue }
    if (Number.isInteger(pid) && pid > 0 && now - written > DAY_MS && !alive(pid)) removeRun(join(base, name))
  }
}

/** Says which folder it could not remove. */
export function removeRun(root: string): void {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
  catch (error) { console.warn(`vitestRun.ts could not remove ${root}: ${(error as NodeJS.ErrnoException).code ?? error}`) }
}

/** The run's globalSetup. Vitest runs a globalSetup's teardown before it closes the workers (its close()), so the folder goes
 *  when the run's process exits instead, after them. */
export default function startRun(): void {
  sweepEndedRuns()
  const root = createRun()
  // The workers start after this, and inherit it.
  process.env.HARNESS_TEST_ROOT = root
  process.once('exit', () => removeRun(root))
}
