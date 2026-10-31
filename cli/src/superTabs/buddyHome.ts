/**
 * A person's one Buddy's folder (docs/specs/2026-10-31-one-buddy-per-swarm.md, Folder; Dee, 10-31). The Buddy reads every
 * project its person reads, so its folder is no project's checkout: it holds `projects/<name>`, one detached worktree per
 * project whose checkout is already on this machine, each made from that project's own checkout, so no two projects' files
 * ever mix. Nothing is fetched or cloned for it. Its guard confines its reads to this folder, and the lock its launch applies
 * makes every file in it read-only (lib/swarmSkills.ts lockBuddyFolder). A project its person no longer reads leaves the
 * folder before the Buddy's next turn (pruneBuddyHome).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { insideGitCheckout } from '../lib/gitProject.js'

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

const listed = (home: string): Listed[] => {
  try {
    const rows = JSON.parse(readFileSync(join(home, MANIFEST), 'utf8')) as unknown
    return Array.isArray(rows) ? rows.filter((r): r is Listed => !!r && typeof r.id === 'string' && typeof r.dir === 'string' && typeof r.name === 'string') : []
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
 * are not (their code is not on this machine; the Buddy still reads their chats and tasks). A worktree made before is kept;
 * one that cannot be made is left out, never retried in a loop. The person's own checkouts are only read from.
 */
export async function prepareBuddyHome(home: string, projects: readonly BuddyProject[]): Promise<{ ready: string[]; missing: string[] }> {
  mkdirSync(join(home, 'projects'), { recursive: true, mode: 0o700 })
  const rows = listed(home), ready: string[] = [], missing: string[] = []
  const taken = new Set(rows.map(r => r.dir))
  for (const project of projects) {
    const known = rows.find(r => r.id === project.id)
    if (known && existsSync(join(home, 'projects', known.dir))) { ready.push(project.name); continue }
    if (!(await insideGitCheckout(project.cwd).catch(() => false))) { missing.push(project.name); continue }
    const dir = known?.dir ?? folderName(project.name, taken)
    taken.add(dir)
    try {
      await run('git', ['-C', project.cwd, 'worktree', 'add', '--detach', '--', join(home, 'projects', dir), 'HEAD'], { timeout: 120_000 })
      if (!known) rows.push({ id: project.id, name: project.name, dir })
      ready.push(project.name)
    } catch { missing.push(project.name) }
  }
  writeListed(home, rows)
  return { ready, missing }
}

/** Takes out of [home] each worktree whose project is not in [readable] (ids): its person lost it, or it was deleted. */
export async function pruneBuddyHome(home: string, readable: ReadonlySet<string>): Promise<string[]> {
  const rows = listed(home)
  const gone = rows.filter(r => !readable.has(r.id))
  if (!gone.length) return []
  for (const row of gone) await removeWorktree(join(home, 'projects', row.dir))
  writeListed(home, rows.filter(r => readable.has(r.id)))
  return gone.map(r => r.name)
}

/** Takes every worktree out of [home] and removes it: its Buddy ended. */
export async function removeBuddyHome(home: string): Promise<void> {
  for (const row of listed(home)) await removeWorktree(join(home, 'projects', row.dir))
  rmSync(home, { recursive: true, force: true })
}

/** Removes one worktree, read-only files included, and its checkout's record of it. A folder git no longer knows is removed. */
async function removeWorktree(path: string): Promise<void> {
  if (!existsSync(path)) return
  await run('git', ['-C', path, 'worktree', 'remove', '--force', '--force', '--', path], { timeout: 60_000 }).catch(() => undefined)
  rmSync(path, { recursive: true, force: true })
}
