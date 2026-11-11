/**
 * Gives this Vitest run a temporary folder of its own, which cli/vitest.tmpdir.ts gives each of the run's workers a folder in.
 * The folder goes when the run's process exits, and a later run removes what a killed run left.
 *
 * Runs going at once shared $TMPDIR/vw1, vw2… before: each run's mkdtemp and rm there changed an ancestor of the others'
 * fixtures, which is the change the native evidence readers hold a listing for (vitest.tmpdir.ts). Three core gates ran at once
 * on one Mac on 2026-11-10, and nothing removed what the runs left: vw1 held 24,592 entries.
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { alive } from '../testing/spawnedRuns.js'

declare module 'vitest' {
  export interface ProvidedContext {
    /** The run's own folder, which the run's workers' folders go in (vitest.tmpdir.ts). */
    runFolder: string
  }
}

/** In each run's folder: the id of the process running the run, which tells a later run whether it ended. */
export const RUN_FILE = '.harness-test-run'
const DAY_MS = 24 * 60 * 60 * 1000
/** A run's folder, as mkdtemp names it. */
const RUN_NAME = /^v[A-Za-z0-9]{6}$/
/** A folder every run shared before (vw1, vw2…). Never a run's: those have seven characters. */
const SHARED_NAME = /^vw\d{1,3}$/

/** Where runs' folders go. On macOS /tmp, not the 48-byte $TMPDIR: specs put Unix sockets in folders of their own in a
 *  worker's folder, a socket's path has 96 bytes (lib/localSocket.ts), and in $TMPDIR one more folder level took
 *  localCredential.port.spec past it. Specs that need a short home already use /tmp. */
export const runsBase = (): string => process.platform === 'darwin' ? '/tmp' : tmpdir()

const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error)

/** A new folder for one run. mkdtemp names it, so no other run gets it, not even a run with the same process id in another
 *  container. */
export function createRun(base: string): string {
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'v'))
  writeFileSync(join(root, RUN_FILE), String(process.pid))
  return root
}

/** This user's own folder or plain file, never a link: a shared /tmp holds other users' too. Null when it is not, or is gone. */
const own = (path: string, kind: 'directory' | 'file') => {
  let info
  try { info = lstatSync(path) } catch { return null }
  return (kind === 'directory' ? info.isDirectory() : info.isFile()) && (!process.getuid || info.uid === process.getuid()) ? info : null
}

/** Whether a folder in `base` was left by a run that ended without removing it: a run's folder more than a day old whose process
 *  is gone (a run in another container sharing /tmp looks gone from here, and the day keeps its folder; a process that took a
 *  killed run's id keeps it until it ends too), or a folder every run shared before that no run has changed for a day. Those
 *  go until 2026-12-10, when no checkout from before 2026-11-10 should still run. */
function ended(base: string, name: string, now: number): boolean {
  if (!RUN_NAME.test(name) && !SHARED_NAME.test(name)) return false
  const folder = own(join(base, name), 'directory'), file = own(join(base, name, RUN_FILE), 'file')
  if (!folder) return false
  if (!file) return SHARED_NAME.test(name) && now - folder.mtimeMs > DAY_MS
  if (!RUN_NAME.test(name) || now - file.mtimeMs <= DAY_MS || file.size > 16) return false
  let pid: number
  try { pid = Number(readFileSync(join(base, name, RUN_FILE), 'utf8')) } catch { return false }
  return !(Number.isInteger(pid) && pid > 0 && alive(pid))
}

/** Removes what ended runs left in `base`. */
export function sweep(base: string, now: number = Date.now()): void {
  let names: string[]
  try { names = readdirSync(base) } catch (error) { console.warn(`vitestRun.ts could not read ${base}: ${code(error)}`); return }
  for (const name of names) if (ended(base, name, now)) removeRun(join(base, name))
}

/** Removes a run's folder, its run file last, so a folder that cannot be removed whole still tells a later run whose it was.
 *  Says which folder it could not remove. */
export function removeRun(root: string): void {
  try {
    for (const name of readdirSync(root)) if (name !== RUN_FILE) rmSync(join(root, name), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  } catch (error) { console.warn(`vitestRun.ts could not remove ${root}: ${code(error)}`) }
}

/** Starts a run in `runs`, after removing what ended runs left there and in `shared`. The folder goes when the run's process
 *  exits, after the workers: Vitest runs a globalSetup's teardown before it closes them. */
export function beginRun(runs: string, shared: string): string {
  for (const base of new Set([runs, shared])) sweep(base)
  const root = createRun(runs)
  process.once('exit', () => removeRun(root))
  return root
}

/** The run's globalSetup. */
export default function startRun(project: TestProject): void {
  project.provide('runFolder', beginRun(runsBase(), tmpdir()))
}
