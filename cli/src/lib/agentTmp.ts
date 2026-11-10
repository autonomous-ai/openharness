/**
 * The agents' private temporary folders. Each Swarm agent has its own (task #4395): since #4215 an agent starts in its owner's
 * own settings, which can block reads outside the working directories, so its folder is added to the engine's working
 * directories as well as given as its TMPDIR, which `mktemp` uses.
 *
 * In the data folder because a wide Buddy's guard already closes that folder (lib/buddyGuard.ts), so a Buddy cannot read other
 * agents' temporary files here. A Buddy's own folders, beside the data folder, were made only beside a Harness Team account,
 * which went (anh Dee, 2026-11-10): what is left there is swept as these are.
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import type { SwarmSkill } from './savedSkill.js'

/** Nothing changed in this long, and a top-level entry is deleted: longer than a task runs, as /tmp's own cleaners are. */
const KEEP_MS = 7 * 24 * 60 * 60_000
const SWEEP_EVERY_MS = 24 * 60 * 60_000
/** A Buddy's empty folder is kept this long: it is a live Buddy's TMPDIR while the Buddy runs, however quiet. */
const KEEP_EMPTY_BUDDY_MS = 30 * 24 * 60 * 60_000
/** These folders are under ~/.harness/cli, whose package.json says "type": "module": without one of their own, an extensionless
 *  script written here (a spec's fake grid) loaded as an ES module and died on require, as it never does in the system's (#4356). */
const PACKAGE = 'package.json'
const COMMONJS = '{"type":"commonjs"}\n'

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

/** Gives [folder] its own CommonJS package.json, keeping one already there. Exclusive create: a link in its place is not followed. */
function markCommonJs(folder: string, deps: AgentTmpDeps): void {
  try { writeFileSync(join(folder, PACKAGE), COMMONJS, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      deps.log(`could not write ${join(folder, PACKAGE)} (${(error as NodeJS.ErrnoException).code}); scripts there load as ES modules`)
    }
  }
}

/** The package.json markCommonJs wrote, which no sweep deletes however old. Another, a tool's, is swept like any file. */
function isMarker(folder: string, name: string): boolean {
  if (name !== PACKAGE) return false
  try { return readFileSync(join(folder, name), 'utf8') === COMMONJS } catch { return false }
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
    if (isMarker(folder, name) || await changedSince(path, now - KEEP_MS)) continue
    try { await rm(path, { recursive: true, force: true }); removed++ } catch { /* the next sweep tries again */ }
  }
  return removed
}

/** Each folder in [parent], each Buddy's or agent's, swept as `sweepAgentTmp` sweeps one. The folder stays, as it is a live
 *  Buddy's or agent's TMPDIR, until it has been empty and idle for 30 days; a relaunch makes it again. Anything else at the top
 *  goes when idle, a link without what it points at. */
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
        if (!isMarker(parent, name) && !(await changedSince(path, now - KEEP_MS))) { await rm(path, { force: true }); removed++ }
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
  void Promise.all([sweepTmpFolders(folder, now), sweepTmpFolders(buddyTmpParent(deps.dataDir), now)])
    .then(([agents, buddies]) => { if (agents + buddies) deps.log(`removed ${agents + buddies} entries nothing had changed in for 7 days`) })
}

/** How an engine is told of one more working directory, joined to its flag: Claude Code's `--add-dir` takes several values and
 *  would otherwise swallow what follows it. An engine not here gets the folder as its TMPDIR alone. */
const ADDED_FOLDER: Partial<Record<AgentEngine, (folder: string) => string[]>> = {
  claude: folder => [`--add-dir=${folder}`],
  codex: folder => [`--add-dir=${folder}`],
}

/** The private folder of the Swarm agent whose creation key is [key], made and closed, by its real path, or null when it cannot
 *  be, which the log says. Named by the key, which every relaunch carries, so a relaunch finds it; never by the workspace, as a
 *  person's Regular agents all start in that person's home folder. Claude Code reads an added folder's own skills and settings,
 *  so a folder two agents shared would let one plant them for the other. */
export function agentTmpOf(key: string, deps: AgentTmpDeps = realDeps): string | null {
  const parent = agentTmpFolder(deps.dataDir)
  const folder = join(parent, createHash('sha256').update(key).digest('hex').slice(0, 16))
  // The parent first: making the folder through a link in the parent's place would make it where that link points.
  // The marker in the parent covers every agent's folder, which stays free to empty out and go (#4356).
  try {
    if (prepareAgentTmp(parent) && prepareAgentTmp(folder)) {
      markCommonJs(parent, deps)
      return realpathSync(folder)
    }
  } catch { /* said below */ }
  deps.log(`the private temporary folder ${folder} could not be made private; this agent uses the system's`)
  return null
}

/**
 * What gives an agent its private folder: the variables, and the arguments that add the folder to the engine's working
 * directories, or none. A Swarm agent (not a Buddy) gets its own folder, both; nobody else gets one. A folder that cannot be
 * made private does not stop the agent: it starts on the system's folder, and the daemon's log says why.
 */
export function agentTmpLaunch(engine: AgentEngine, skill: Pick<SwarmSkill, 'role' | 'key'> | undefined,
  deps: AgentTmpDeps = realDeps): { env: Record<string, string>; args: string[] } {
  const none = { env: {}, args: [] }
  if (deps.platform === 'win32') return none
  const shared = agentTmpFolder(deps.dataDir)
  // Whoever launches: what is left here must still go.
  sweepWhenDue(shared, deps)
  if (!skill || skill.role === 'buddy' || isTerminalEngine(engine)) return none
  const folder = agentTmpOf(skill.key, deps)
  return folder ? { env: { TMPDIR: folder }, args: ADDED_FOLDER[engine]?.(folder) ?? [] } : none
}

/** The folder agents here are given (every Swarm agent's is in it): a place they drop files that a person may then open
 *  (./pathContainment.ts). None on Windows, whose temporary folder is the account's own. */
export function agentTmpRoot(deps: AgentTmpDeps = realDeps): string | null {
  return deps.platform === 'win32' ? null : agentTmpFolder(deps.dataDir)
}
