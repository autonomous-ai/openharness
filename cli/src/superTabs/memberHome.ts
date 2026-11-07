/**
 * A Member's task home on this machine (task #4543; spec #4489 section 2). A Member's chat session lives in its Buddy home
 * (buddyHome.ts), which can hold copies of every project its person reads; its task sessions, which outside text can steer,
 * never work there. Each works in the Member's own worktree of its one project, made at the Member's first set-up there from
 * this machine's clone of it and kept for every later task there, so what it learned and changed stays with that project.
 *
 * This record says which worktree is whose: a stopped task session leaves its worktree (machines.ts keeps these apart from the
 * worktrees a worker's stop removes), and the backend hears which projects each Member has set up (machines.ts memberSetUp).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { identifier, object } from './wire.js'

/** At most this many projects per Member: the backend asks for a sixth only with the one to drop (taskSessions.ts). */
const MAX_PER_MEMBER = 5

export const memberWorktreesFile = (dataDir: string, machineId: string) => join(dataDir, 'super-tabs', `member-worktrees-${machineId}.json`)
export type MemberWorktree = { tabId: string; memberId: string; projectId: string; startId: string; source: string; path: string }

export function readMemberWorktrees(file: string): MemberWorktree[] {
  let saved: unknown
  try { saved = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
  const rows = object(saved).worktrees
  return (Array.isArray(rows) ? rows.map(object) : []).filter(w => [w.tabId, w.memberId, w.projectId, w.startId].every(identifier)
    && typeof w.source === 'string' && isAbsolute(w.source) && typeof w.path === 'string' && isAbsolute(w.path))
    .map(w => ({ tabId: w.tabId, memberId: w.memberId, projectId: w.projectId, startId: w.startId, source: w.source, path: w.path }) as MemberWorktree)
}

export function writeMemberWorktrees(file: string, rows: MemberWorktree[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(`${file}.next`, JSON.stringify({ version: 1, worktrees: rows }), { mode: 0o600, flush: true })
  renameSync(`${file}.next`, file)
}

/** The branch a Member's first set-up in a project makes, and so its worktree's folder name: the project's id and the start's,
 *  eight characters each, so the folder stays short where Windows' path limit bites. */
export const memberBranch = (projectId: string, startId: string): string => `m/${projectId.slice(0, 8)}-${startId.slice(0, 8)}`

/** Per Member of [tabId], the projects whose worktree is still on disk: what its host reports set up. */
export function memberSetUp(rows: MemberWorktree[], tabId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const row of rows) {
    if (row.tabId !== tabId || !existsSync(row.path)) continue
    const projects = out[row.memberId] ??= []
    if (!projects.includes(row.projectId) && projects.length < MAX_PER_MEMBER) projects.push(row.projectId)
  }
  return out
}

/** Every project a Member's worktree on disk is of, in every Swarm on this machine. */
export const memberProjectIds = (rows: MemberWorktree[]): string[] => [...new Set(rows.filter(r => existsSync(r.path)).map(r => r.projectId))]
