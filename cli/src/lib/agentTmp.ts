/**
 * The folder Harness keeps for its agents' files (`harness browser`'s screenshots and long output where nothing sets a TMPDIR,
 * agentClient/browserOutput.ts), made this account's alone, and swept of what nothing changed in for a week.
 */
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from '../config/env.js'

/** Nothing changed in this long, and a top-level entry is deleted: longer than a task runs, as /tmp's own cleaners are. */
const KEEP_MS = 7 * 24 * 60 * 60_000
const SWEEP_EVERY_MS = 24 * 60 * 60_000
/** An empty folder in it is kept this long. */
const KEEP_EMPTY_MS = 30 * 24 * 60 * 60_000

export interface AgentTmpDeps {
  platform: NodeJS.Platform
  dataDir: string
  log(line: string): void
  now(): number
}

const realDeps: AgentTmpDeps = {
  platform: process.platform, dataDir: env.ADAPTER_DATA_DIR,
  log: (line) => console.log(`[agent-tmp] ${line}`), now: () => Date.now(),
}

export const agentTmpFolder = (dataDir: string = env.ADAPTER_DATA_DIR): string => join(dataDir, 'agent-tmp')

/** Makes [folder] this account's alone. False when it is not: a link, a file, or another account's, which is left as it is. */
export function prepareAgentTmp(folder: string, uid: number | undefined = process.geteuid?.()): boolean {
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const stat = lstatSync(folder)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) return false
    if ((stat.mode & 0o777) !== 0o700) chmodSync(folder, 0o700)
    return true
  } catch { return false }
}

/** Whether anything at [path] changed since [cutoff]. Stops at the first that did. What cannot be read counts as changed. The
 *  newer of the two times: `tar`, `cp -p` and `rsync -t` keep an old mtime, so a tool unpacked a minute ago looked 7 days idle
 *  by mtime alone (review of #2546). */
async function changedSince(path: string, cutoff: number): Promise<boolean> {
  try {
    const stat = await lstat(path)
    if (Math.max(stat.mtimeMs, stat.ctimeMs) >= cutoff) return true
    if (!stat.isDirectory()) return false
    for (const name of await readdir(path)) if (await changedSince(join(path, name), cutoff)) return true
    return false
  } catch { return true }
}

/** Deletes the top-level entries of [folder] with nothing changed for 7 days, and says how many went. A link goes, never what
 *  it points at (`rm` does not follow one). Only ever this folder: /tmp is not touched. */
export async function sweepAgentTmp(folder: string, now: number): Promise<number> {
  let names: string[]
  try {
    // Never through a link in its place, which would delete what it points at, or in a folder that is not this account's.
    const stat = await lstat(folder)
    if (!stat.isDirectory() || stat.uid !== process.geteuid?.()) return 0
    names = await readdir(folder)
  } catch { return 0 }
  let removed = 0
  for (const name of names) {
    const path = join(folder, name)
    if (await changedSince(path, now - KEEP_MS)) continue
    try { await rm(path, { recursive: true, force: true }); removed++ } catch { /* the next sweep tries again */ }
  }
  return removed
}

/** Each folder in [parent] swept as `sweepAgentTmp` sweeps one, and gone once it has been empty and idle for 30 days. Anything
 *  else at the top goes when idle, a link without what it points at. */
export async function sweepTmpFolders(parent: string, now: number): Promise<number> {
  let names: string[]
  try {
    const stat = await lstat(parent)
    if (!stat.isDirectory() || stat.uid !== process.geteuid?.()) return 0
    names = await readdir(parent)
  } catch { return 0 }
  let removed = 0
  for (const name of names) {
    const path = join(parent, name)
    try {
      if (!(await lstat(path)).isDirectory()) {
        if (!(await changedSince(path, now - KEEP_MS))) { await rm(path, { force: true }); removed++ }
        continue
      }
      removed += await sweepAgentTmp(path, now)
      // Fails, as it should, on a folder with anything in it.
      if (!(await changedSince(path, now - KEEP_EMPTY_MS))) await rmdir(path)
    } catch { /* not empty, or gone: the next sweep looks again */ }
  }
  return removed
}

let lastSweep: number | null = null
export function resetAgentTmpSweep(): void { lastSweep = null }

function sweepWhenDue(folder: string, deps: AgentTmpDeps): void {
  const now = deps.now()
  if (lastSweep !== null && now >= lastSweep && now - lastSweep < SWEEP_EVERY_MS) return
  lastSweep = now
  // Never in the launch's way: an agent's start does not wait on a walk of old files.
  void sweepTmpFolders(folder, now).then(removed => { if (removed) deps.log(`removed ${removed} entries nothing had changed in for 7 days`) })
}

/** Sweeps the folder, at most once a day, as an agent is launched: never in the launch's way. */
export function sweepAgentTmpWhenDue(deps: AgentTmpDeps = realDeps): void {
  if (deps.platform !== 'win32') sweepWhenDue(agentTmpFolder(deps.dataDir), deps)
}

/** The folder agents here are given: a place they drop files that a person may then open
 *  (./pathContainment.ts). None on Windows, whose temporary folder is the account's own. */
export function agentTmpRoot(deps: AgentTmpDeps = realDeps): string | null {
  return deps.platform === 'win32' ? null : agentTmpFolder(deps.dataDir)
}
