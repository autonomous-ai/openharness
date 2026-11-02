/**
 * The owner's agents' private temporary folder, on a computer with a Harness Team account (audit M1,
 * docs/plans/2026-11-02-team-private-temp-and-status-plan.md).
 *
 * The daemon runs with no TMPDIR on a Mac (launchd sets none here), so agents and their tools wrote to /private/tmp, which
 * every account shares: on the Mac Studio the Team account could read 654 of the owner's entries there, and could create a
 * file at a name an owner's agent later wrote to or ran. A 0700 folder closes both for whatever honours TMPDIR, and the
 * Swarm's skills tell agents not to name /tmp themselves.
 *
 * In the data folder because a wide Buddy's guard already closes that folder (lib/buddyGuard.ts), so a Buddy cannot read other
 * agents' temporary files here. A Buddy has its own folder beside the data folder, one per Buddy, since its files come from a
 * person's private work and must not reach another person's Buddy (buddyTmpOf; docs/plans/2026-11-02-buddy-private-temp-plan.md).
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import { readTeamConfig, type TeamConfig } from '../team/config.js'

/** Nothing changed in this long, and a top-level entry is deleted: longer than a task runs, as /tmp's own cleaners are. */
const KEEP_MS = 7 * 24 * 60 * 60_000
const SWEEP_EVERY_MS = 24 * 60 * 60_000
/** A Buddy's empty folder is kept this long: it is a live Buddy's TMPDIR while the Buddy runs, however quiet. */
const KEEP_EMPTY_BUDDY_MS = 30 * 24 * 60 * 60_000

export interface AgentTmpDeps {
  platform: NodeJS.Platform
  dataDir: string
  config(): TeamConfig | null
  /** The account this process runs as. */
  user(): string
  log(line: string): void
  now(): number
}

const realDeps: AgentTmpDeps = {
  platform: process.platform, dataDir: env.ADAPTER_DATA_DIR, config: () => readTeamConfig(), user: () => userInfo().username,
  log: (line) => console.log(`[agent-tmp] ${line}`), now: () => Date.now(),
}

export const agentTmpFolder = (dataDir: string = env.ADAPTER_DATA_DIR): string => join(dataDir, 'agent-tmp')

/** Where every Buddy's folder is: beside the data folder, which a wide Buddy's guard and sandbox close whole. */
export const buddyTmpParent = (dataDir: string = env.ADAPTER_DATA_DIR): string => `${dataDir}-buddy-tmp`

/** The folder of the Buddy that runs in [root], by its real path, so a relaunch finds it. Short: some tools make sockets in TMPDIR. */
export function buddyTmpFolder(root: string, dataDir: string = env.ADAPTER_DATA_DIR): string {
  return join(buddyTmpParent(dataDir), createHash('sha256').update(realOfFolder(root)).digest('hex').slice(0, 16))
}

/** [path]'s real path: of the nearest folder that exists, with the rest added, so a Buddy's folder removed before its cleanup
 *  still names the same temporary folder. */
export function realOfFolder(path: string): string {
  let at = path, rest = ''
  for (;;) {
    try { return join(realpathSync(at), rest) } catch { /* not there: its folder decides */ }
    if (dirname(at) === at) return path
    rest = join(basename(at), rest)
    at = dirname(at)
  }
}

/** This account is the owner of a computer with a Team account. Windows' temporary folder is already the account's own. */
function ownerOfTeamComputer(deps: AgentTmpDeps): boolean {
  if (deps.platform === 'win32') return false
  try {
    const config = deps.config()
    return !!config && config.user !== deps.user()
  } catch { return false }
}

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

/** Each Buddy's folder swept as `sweepAgentTmp` sweeps one. The folder stays, as it is a live Buddy's TMPDIR, until it has been
 *  empty and idle for 30 days; a relaunch makes it again. Anything else at the top goes when idle, a link without what it points at. */
export async function sweepBuddyTmp(parent: string, now: number): Promise<number> {
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
      if (!(await changedSince(path, now - KEEP_EMPTY_BUDDY_MS))) await rmdir(path)
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
  void Promise.all([sweepAgentTmp(folder, now), sweepBuddyTmp(buddyTmpParent(deps.dataDir), now)])
    .then(([agents, buddies]) => { if (agents + buddies) deps.log(`removed ${agents + buddies} entries nothing had changed in for 7 days`) })
}

/**
 * The variables that give an agent the private folder, or none. A folder that cannot be made private does not stop the agent:
 * it starts on the system's folder, the daemon's log says why, and `harness team status` shows ✗.
 */
export function agentTmpEnv(engine: AgentEngine, role: string | undefined, deps: AgentTmpDeps = realDeps): Record<string, string> {
  if (deps.platform === 'win32') return {}
  const folder = agentTmpFolder(deps.dataDir)
  // Whoever launches, and with the Team account gone too: what is left here must still go.
  sweepWhenDue(folder, deps)
  if (isTerminalEngine(engine) || role === 'buddy' || !ownerOfTeamComputer(deps)) return {}
  if (!prepareAgentTmp(folder)) {
    deps.log(`the private temporary folder ${folder} could not be made private; this agent uses the system's`)
    return {}
  }
  return { TMPDIR: folder }
}

/**
 * The private folder of the Buddy that runs in [root], made and closed, or null: on a computer with no Team account, in the
 * Team account itself, on Windows or Linux, or when it cannot be made private, which the log says. Null opens nothing in its guard.
 */
export function buddyTmpOf(root: string, deps: AgentTmpDeps = realDeps): string | null {
  if (deps.platform === 'win32') return null
  sweepWhenDue(agentTmpFolder(deps.dataDir), deps)
  // macOS alone until the sandbox has been tried with bubblewrap: a folder it would not open breaks every command of a Buddy.
  if (deps.platform !== 'darwin' || !ownerOfTeamComputer(deps)) return null
  const folder = buddyTmpFolder(root, deps.dataDir)
  // The parent first: making the folder through a link in the parent's place would make it where that link points.
  // By its real path, as the guard compares real paths: a data folder reached through a link would refuse its own reads.
  try { if (prepareAgentTmp(buddyTmpParent(deps.dataDir)) && prepareAgentTmp(folder)) return realpathSync(folder) } catch { /* said below */ }
  deps.log(`the private temporary folder ${folder} could not be made private; this Buddy uses the system's`)
  return null
}

/** A Buddy's launch variables for that folder. Claude Code keeps its own files in /tmp/claude-<uid> whatever TMPDIR says. */
export function buddyTmpEnv(engine: AgentEngine, root: string, deps: AgentTmpDeps = realDeps): Record<string, string> {
  const folder = buddyTmpOf(root, deps)
  return folder ? { TMPDIR: folder, ...(engine === 'claude' ? { CLAUDE_CODE_TMPDIR: folder } : {}) } : {}
}

/** The folder, where agents here are given it: a place they drop files that a person may then open (./pathContainment.ts). */
export function agentTmpRoot(deps: AgentTmpDeps = realDeps): string | null {
  return ownerOfTeamComputer(deps) ? agentTmpFolder(deps.dataDir) : null
}

export interface AgentTmpState { path: string; state: 'private' | 'open' | 'not-made'; mode: number | null }

/** What `harness team status` shows. A link, or another account's folder, is open whatever its mode says. */
export function agentTmpState(folder: string = agentTmpFolder(), uid: number | undefined = process.geteuid?.()): AgentTmpState {
  try {
    const stat = lstatSync(folder)
    if (!stat.isDirectory()) return { path: folder, state: 'open', mode: null }
    const mode = stat.mode & 0o777
    // Another account's 0700 folder is private from this one, not for it (prepareAgentTmp refuses it).
    if (uid !== undefined && stat.uid !== uid) return { path: folder, state: 'open', mode }
    return { path: folder, state: mode === 0o700 ? 'private' : 'open', mode }
  } catch (error) {
    return { path: folder, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-made' : 'open', mode: null }
  }
}
