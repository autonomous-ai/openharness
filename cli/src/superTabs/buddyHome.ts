/**
 * A person's one Buddy's folder (docs/specs/2026-10-31-one-buddy-per-swarm.md, Folder; Dee, 10-31). The Buddy reads every
 * project its person reads, so its folder is no project's checkout: it holds `projects/<name>`, one detached worktree per
 * project whose checkout is already on this machine, each made from that project's own checkout, so no two projects' files
 * ever mix. Nothing is cloned for it. Each copy follows its project's default branch (refreshBuddyHome): a worktree made once
 * and kept read days-old code, and the Buddy kept telling its person so (Scholes, 11-02). A Buddy works in it as its owner
 * would, with full access on their own machine (task #2832): a copy it changed is left where it is. A project its person no
 * longer reads leaves the folder before the Buddy's next turn (pruneBuddyHome).
 */
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launchEnvironment } from '../engines/kit/launchExecutable.js'
import { folderTrust } from '../engines/launchPrep.js'
import { gitEnv, insideGitCheckout, originDefaultRef, remoteBranch } from '../lib/gitProject.js'

const run = promisify(execFile)
/** A project as the backend lists it in a Swarm-wide Buddy's start (AgentStartRequest.buddyProjects). */
export interface BuddyProject { id: string; name: string; cwd: string }
/** Each worktree's project, so a later pass knows which folder is whose. */
interface Listed { id: string; name: string; dir: string }
/** The folder's list of its worktrees' projects: a person's one Buddy's folder is the one that holds it. */
export const BUDDY_HOME_MANIFEST = '.buddy-projects.json'
const MANIFEST = BUDDY_HOME_MANIFEST
/** The folder in Harness's worktrees folder that holds the one Buddies' folders, one per start (start.ts). */
export const BUDDY_HOMES = 'buddy-home'
/** At most this many, as the backend lists (machines.ts MAX_BUDDY_PROJECTS). */
export const MAX_BUDDY_PROJECTS = 50
const ID = /^[A-Za-z0-9_-]{1,64}$/
/** What the Buddy reads to learn where each copy is. A file, as a copy moves while it runs and its prompt is fixed at its start,
 *  and the main Buddy's shell has no repository to run git in (spec 2026-10-31, Folder). Its age also says when the last pass
 *  was, so "at most hourly" holds across a daemon restart. */
export const BUDDY_COPIES_FILE = 'project-copies.txt'
const REFRESH_EVERY_MS = 60 * 60_000
/** All of one pass's fetches share this: 50 projects offline must not hold a Buddy's start for 50 timeouts. */
const FETCH_BUDGET_MS = 30_000
const FETCH_TIMEOUT_MS = 20_000
const FETCHES_AT_ONCE = 4

/** The projects a start lists, as far as they are well formed: an id, a name and an absolute folder. */
export function buddyProjectsOf(request: Record<string, unknown>): BuddyProject[] {
  const listed = Array.isArray(request.buddyProjects) ? request.buddyProjects : []
  return listed.flatMap(entry => {
    const p = entry as Record<string, unknown>
    return typeof p?.id === 'string' && ID.test(p.id) && typeof p.name === 'string' && typeof p.cwd === 'string' && p.cwd.startsWith('/')
      ? [{ id: p.id, name: p.name, cwd: p.cwd }] : []
  }).slice(0, MAX_BUDDY_PROJECTS)
}

/** A folder name for [name]: letters, digits, dots, dashes and underscores, never empty, `..` or a hidden name; [taken] keeps
 *  two projects of the same name apart. */
export function folderName(name: string, taken: ReadonlySet<string>): string {
  const base = name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|-+$/g, '').slice(0, 60) || 'project'
  let dir = base
  for (let n = 2; taken.has(dir); n++) dir = `${base}-${n}`
  return dir
}

/** A folder name this file could have made (folderName): never a path, `..` or a hidden name, so a changed list can never
 *  point a removal outside `projects/` (security review 1 of #2436). */
const SAFE_DIR = /^[\p{L}\p{N}_][\p{L}\p{N}._-]{0,79}$/u
const listed = (home: string): Listed[] => {
  try {
    const rows = JSON.parse(readFileSync(join(home, MANIFEST), 'utf8')) as unknown
    return Array.isArray(rows) ? rows.filter((r): r is Listed => !!r && typeof r.id === 'string' && ID.test(r.id) && typeof r.dir === 'string'
      && SAFE_DIR.test(r.dir) && typeof r.name === 'string') : []
  } catch { return [] }
}
function writeListed(home: string, rows: Listed[]): void {
  const path = join(home, MANIFEST), next = `${path}.next`
  rmSync(next, { force: true })
  writeFileSync(next, `${JSON.stringify(rows)}\n`, { mode: 0o600 })
  renameSync(next, path)
}

/**
 * Makes [home] with a worktree of each of [projects] whose checkout is on this machine, and says which are there and which
 * are not (their code is not on this machine; the Buddy still reads their chats and tasks). A worktree made before is kept and
 * brought to its project's default branch, as a new one is (refreshBuddyHome); one that cannot be made is left out, never
 * retried in a loop. The person's own working files and branches are never touched.
 */
export async function prepareBuddyHome(home: string, projects: readonly BuddyProject[]): Promise<{ ready: string[]; missing: string[] }> {
  await refreshing.get(home)?.done
  ownFolders(home, true)
  mkdirSync(join(home, 'projects'), { recursive: true, mode: 0o700 })
  ownFolders(home)
  // A project its person no longer reads leaves before the Buddy's first turn, not only before a delivery (security review 1
  // of #2436): a relaunch starts from the list the start names now.
  await pruneBuddyHome(home, new Set(projects.map(p => p.id)))
  const rows = listed(home), ready: string[] = [], missing: string[] = []
  const taken = new Set(rows.map(r => r.dir))
  for (const project of projects) {
    const known = rows.find(r => r.id === project.id)
    // Kept only while it is still the folder made here: a link in its place is taken out and the worktree made again.
    const kept = known && lstatSync(join(home, 'projects', known.dir), { throwIfNoEntry: false })
    if (kept && kept.isDirectory()) { ready.push(project.name); continue }
    if (kept) await removeWorktree(home, known!.dir)
    if (!(await insideGitCheckout(project.cwd).catch(() => false))) { missing.push(project.name); continue }
    const dir = known?.dir ?? folderName(project.name, taken)
    taken.add(dir)
    try {
      // A folder of this name removed before (a link taken out, a folder deleted) may still be listed by its checkout.
      await run('git', ['-C', project.cwd, 'worktree', 'prune'], { timeout: 60_000 }).catch(() => undefined)
      await run('git', ['-C', project.cwd, 'worktree', 'add', '--detach', '--', join(home, 'projects', dir), 'HEAD'], { timeout: 120_000 })
      if (!known) rows.push({ id: project.id, name: project.name, dir })
      ready.push(project.name)
    } catch { missing.push(project.name) }
  }
  writeListed(home, rows)
  await refreshBuddyHome(home)
  return { ready, missing }
}

/** The folder of project [id] in a one Buddy's [home], when its code is there: where a file for that project's PM may come from,
 *  so no file of another project in the same home goes with it. */
export function buddyProjectFolder(home: string, id: string): string | null {
  const row = listed(home).find(r => r.id === id)
  return row ? join(home, 'projects', row.dir) : null
}

/** Where one copy stands after a pass, for the Buddy's file and the pass's one log line. */
type CopyState = { name: string; revision: string | null; state: 'latest' | 'noRemote' | 'changed' | 'failed' }
const refreshing = new Map<string, { stop: AbortController; done: Promise<void> }>()

/**
 * Brings each of [home]'s copies to its project's default branch and writes what the Buddy reads about them. Only one pass runs
 * per folder; a second call joins it. It never throws: a copy that cannot move stays as it is, says so in the file, and the pass
 * logs one line, with no retry before the next start or the next due delivery. Offline is ordinary.
 */
export function refreshBuddyHome(home: string): Promise<void> {
  const running = refreshing.get(home)
  if (running) return running.done
  const stop = new AbortController()
  const done = refreshPass(home, stop.signal)
    .catch((error: unknown) => { console.warn(`[super-tabs] a Buddy's project copies were not refreshed: ${(error as NodeJS.ErrnoException).code ?? 'error'}`) })
    .finally(() => { refreshing.delete(home) })
  refreshing.set(home, { stop, done })
  return done
}

/** Whether the last pass was an hour ago. Read at a delivery, not on a timer, as only then does anything read the copies: an idle
 *  Buddy costs its person no fetches. */
export function buddyHomeDue(home: string, now = Date.now()): boolean {
  const last = lstatSync(join(home, BUDDY_COPIES_FILE), { throwIfNoEntry: false })?.mtimeMs
  return last === undefined || now < last || now - last >= REFRESH_EVERY_MS
}

/** The pass running in [home], if any. */
export const buddyHomeRefreshing = (home: string): Promise<void> | undefined => refreshing.get(home)?.done

/** Whether [home] holds a project outside [readable], so that it must be pruned before its Buddy's next turn. */
export const buddyHomeHoldsLost = (home: string, readable: ReadonlySet<string>): boolean => listed(home).some(row => !readable.has(row.id))

/** Tells a running pass to stop, without waiting for it: the delivery loop serves every agent on the machine (review of #2524). */
export function stopBuddyHomeRefresh(home: string): void { refreshing.get(home)?.stop.abort() }

async function refreshPass(home: string, signal: AbortSignal): Promise<void> {
  ownFolders(home)
  const rows = listed(home), states: CopyState[] = [], deadline = Date.now() + FETCH_BUDGET_MS
  let next = 0
  const worker = async () => {
    while (next < rows.length && !signal.aborted) {
      const at = next++, row = rows[at]!
      states[at] = await refreshCopy(join(home, 'projects', row.dir), row.name, deadline, signal)
    }
  }
  await Promise.all(Array.from({ length: FETCHES_AT_ONCE }, worker))
  // Stopped because a project is leaving: its name must not go back in the file, and the next pass writes a whole one.
  if (signal.aborted) return
  writeCopies(home, states)
  const failed = states.filter(state => state.state === 'failed' || state.state === 'changed').length
  // A count alone: git's own words can hold a remote's address, and an address can hold a token.
  if (failed) console.warn(`[super-tabs] ${failed} of ${states.length} of a Buddy's project copies were left where they are.`)
}

/** One copy. The fetch runs in the Buddy's own worktree: git keeps FETCH_HEAD per worktree, so of the person's checkout it moves
 *  only the one remote-tracking ref named. Their hooks do not run: a post-checkout hook is written for their own work. */
async function refreshCopy(path: string, name: string, deadline: number, signal: AbortSignal): Promise<CopyState> {
  const state = (next: CopyState['state'], revision: string | null = null): CopyState => ({ name, revision, state: next })
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry || !entry.isDirectory()) return state('failed')
  const words = (args: string[]) => ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', path, ...args]
  const git = async (args: string[], options: { timeout?: number; signal?: AbortSignal } = {}) => (await run('git', words(args),
    { timeout: options.timeout ?? 60_000, maxBuffer: 64 * 1024 * 1024, env: gitEnv(process.env), ...(options.signal ? { signal: options.signal } : {}) })).stdout.trim()
  let at: string | null = null
  const here = async () => await git(['log', '-1', '--no-show-signature', '--format=%h %cs']).catch(() => null)
  try {
    // A folder that lost its .git would otherwise find whichever repository is above it, and move that one.
    if (realpathSync(await git(['rev-parse', '--show-toplevel'])) !== realpathSync(path)) return state('failed')
    at = await here()
    const detached = await git(['symbolic-ref', '--quiet', 'HEAD']).then(() => false, () => true)
    if (!detached || await git(['status', '--porcelain'])) return state('changed', at)
    const remote = remoteBranch(await originDefaultRef(path) ?? undefined)
    if (!remote) return state('noRemote', at)
    const left = deadline - Date.now()
    if (left <= 0 || signal.aborted) return state('failed', at)
    await git(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--quiet', '--no-tags', '--no-prune', '--no-recurse-submodules', remote.remote, remote.refspec],
      { timeout: Math.min(left, FETCH_TIMEOUT_MS), signal })
    const [from, to] = [await git(['rev-parse', 'HEAD']), await git(['rev-parse', `refs/remotes/${remote.remote}/${remote.branch}^{commit}`])]
    if (from !== to && !signal.aborted) await git(['checkout', '--quiet', '--detach', '--no-recurse-submodules', to], { timeout: 120_000 })
    return state(await git(['rev-parse', 'HEAD']) === to ? 'latest' : 'failed', await here())
  } catch { return state('failed', at) }
}

function writeCopies(home: string, states: readonly CopyState[]): void {
  const line = (copy: CopyState) => {
    const name = copy.name.replace(/\s+/g, ' ')
    const at = copy.revision ? `at ${copy.revision}` : 'revision not known'
    if (copy.state === 'latest') return `${name}: ${at}. This is the latest default branch.`
    if (copy.state === 'noRemote') return `${name}: ${at}. This checkout has no remote default branch to follow.`
    return `${name}: ${at}. It could not be updated at the last refresh, so it may be behind the default branch.`
  }
  const path = join(home, BUDDY_COPIES_FILE), next = `${path}.next`
  rmSync(next, { force: true })
  writeFileSync(next, `Your copy of each project's code, refreshed ${new Date().toISOString()}:\n${states.map(line).join('\n')}\n`, { mode: 0o444 })
  // Windows will not rename over a read-only file (EPERM), and the last pass left this one read-only, so every later pass failed.
  if (existsSync(path)) chmodSync(path, 0o644)
  renameSync(next, path)
}

/** A running pass stops before any more fetches or moves, and its running move finishes: a move killed part way would leave a
 *  half-moved copy that every later pass reads as changed. */
async function stopRefresh(home: string): Promise<void> {
  const running = refreshing.get(home)
  if (!running) return
  running.stop.abort()
  await running.done
}

/** Takes out of [home] each worktree whose project is not in [readable] (ids): its person lost it, or it was deleted. */
export async function pruneBuddyHome(home: string, readable: ReadonlySet<string>): Promise<string[]> {
  const rows = listed(home)
  const gone = rows.filter(r => !readable.has(r.id))
  if (!gone.length) return []
  ownFolders(home)
  // No pass may be working in, or naming, a project on its way out.
  await stopRefresh(home)
  for (const row of gone) await removeWorktree(home, row.dir)
  writeListed(home, rows.filter(r => readable.has(r.id)))
  // It names the lost project. Gone, the next pass is due and writes a whole one.
  rmSync(join(home, BUDDY_COPIES_FILE), { force: true })
  return gone.map(r => r.name)
}

/**
 * Answers Claude Code's question about [home], in the file it reads, as its launch would otherwise wait on it. That question
 * is asked in a terminal no Swarm view shows, so the Buddy sat at it until its start timed out (MacBookPro2021, 2026-11-02).
 * This is an exception to "never a folder with content" (engines/kit/folderTrust.ts): the folder is Harness's, made for the
 * start its person pressed, and what the question guards against cannot happen in it: its own root holds no project's settings,
 * hooks or MCP servers (each project's copy is a folder below it), and the folder goes with the Buddy. Claude Code and Codex
 * alike, as both run a Buddy (task #2832). A failure here only leaves the question.
 */
export async function trustBuddyHome(home: string, engine: unknown): Promise<void> {
  if (engine !== 'claude' && engine !== 'codex') return
  try { folderTrust(engine, undefined, await launchEnvironment() ?? undefined)?.record(home) }
  catch (error) { console.warn(`[super-tabs] could not answer the folder question for a Buddy: ${(error as Error).message}`) }
}

/** Takes every worktree out of [home] and removes it: its Buddy ended. */
export async function removeBuddyHome(home: string): Promise<void> {
  await stopRefresh(home)
  // Through a link nothing is removed but the link itself (rm never follows one inside the folder it removes).
  const own = (() => { try { ownFolders(home); return true } catch { return false } })()
  if (own) for (const row of listed(home)) await removeWorktree(home, row.dir)
  rmSync(home, { recursive: true, force: true })
}

/** Refuses a Buddy folder, or its `projects/`, that is not a folder of its own: a link there would lead the worktrees made
 *  and removed in it somewhere else (security review 1 re-check of #2436). [mayBeMissing]: before the folder is made. */
function ownFolders(home: string, mayBeMissing = false): void {
  for (const path of [home, join(home, 'projects')]) {
    const entry = lstatSync(path, { throwIfNoEntry: false })
    if (!entry && mayBeMissing) return
    if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`BUDDY_FOLDER_NOT_OWN: ${path} is not a folder of its own; it is left as it is.`)
  }
}

/** Removes one worktree, read-only files included, and its checkout's record of it. A folder git no longer knows is removed.
 *  Only a folder directly in a Buddy folder's `projects/`, by a name this file makes. */
async function removeWorktree(home: string, dir: string): Promise<void> {
  if (!SAFE_DIR.test(dir)) return
  ownFolders(home)
  const path = join(home, 'projects', dir)
  // A link is never followed: a project folder that became a link to another worktree loses the link alone, and git is never
  // asked to remove what it points at (security re-check 2 of #2436).
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (!entry) return
  if (!entry.isDirectory()) { rmSync(path, { force: true }); return }
  await run('git', ['-C', path, 'worktree', 'remove', '--force', '--force', '--', path], { timeout: 60_000 }).catch(() => undefined)
  rmSync(path, { recursive: true, force: true })
}
