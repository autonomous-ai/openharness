/**
 * One snapshot of everything the Memories pane shows: every agent's memories, your About You, and what
 * the session index says about how you work. The viewer and the `mem` command both build it here, so a
 * row in the pane and a line from `mem list` can never disagree.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homes } from './agents.mjs'
import { readAbout } from './about.mjs'
import { collect } from './sources.mjs'
import { openIndex, overview } from './sessions.mjs'
import { encodePath, tilde } from './text.mjs'

/** The index handle is opened once per process and reused; a failed open is retried on the next call. */
let cached = null
export async function sessionIndex(h, { reopen = false } = {}) {
  if (cached?.db && !reopen && cached.dir === h.harnessData) return cached
  try { cached?.db?.close() } catch { /* already closed */ }
  cached = { dir: h.harnessData, ...(await openIndex(h.harnessData)) }
  return cached
}

export function closeIndex() {
  try { cached?.db?.close() } catch { /* already closed */ }
  cached = null
}

/** Projects: the folders memories are about, with what the session index knows of each. */
function projects(memories, folders, home) {
  const byKey = new Map()
  for (const row of memories) {
    if (!row.project) continue
    const key = row.project.path || `name:${row.project.name}`
    const entry = byKey.get(key) ?? { key, name: row.project.name, path: row.project.path ? tilde(row.project.path, home) : null, memories: [], sessions: 0, asks: 0, engines: {}, lastAt: null }
    entry.memories.push(row.id)
    byKey.set(key, entry)
  }
  for (const entry of byKey.values()) {
    const real = entry.path?.startsWith('~') ? home + entry.path.slice(1) : entry.path
    if (!real) continue
    // A repository's worktrees are separate folders in the index; count them with their repository.
    // Claude Code keys memory by repository, so its worktrees share these memories too. A worktree is
    // a folder inside the repository (`.claude/worktrees/x`) or one under `…/worktrees/<repo name>/`.
    const worktrees = `/worktrees/${basename(real)}/`
    for (const folder of folders) {
      if (!(folder.cwd === real || folder.cwd.startsWith(real + '/') || folder.cwd.includes(worktrees))) continue
      entry.sessions += folder.sessions
      entry.asks += folder.asks
      entry.lastAt = Math.max(entry.lastAt ?? 0, folder.lastAt ?? 0) || null
      for (const [engine, count] of Object.entries(folder.engines)) entry.engines[engine] = (entry.engines[engine] ?? 0) + count
    }
  }
  return [...byKey.values()].sort((a, b) => b.memories.length - a.memories.length || (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

export async function snapshot({ env = process.env, home, now = Date.now() } = {}) {
  const h = homes(env, home)
  const index = await sessionIndex(h)
  let sessions = null
  let sessionsError = index.error ?? null
  if (index.db) {
    try { sessions = overview(index.db, { now }) } catch (error) {
      sessionsError = `The session index could not be read: ${error instanceof Error ? error.message : String(error)}`
      closeIndex()
    }
  }
  const folderKeys = new Map((sessions?.folders ?? []).map((folder) => [encodePath(folder.cwd), folder.cwd]))
  const counts = Object.fromEntries((sessions?.engines ?? []).map((row) => [row.engine, row.sessions]))
  const { memories, agents, problems } = collect({ env, home: h.home, folders: folderKeys, sessions: counts })
  const about = readAbout(h.memory)
  return {
    spec: 1,
    observedAt: now,
    memories,
    agents,
    about,
    aboutPath: tilde(join(h.memory, 'about-you.md'), h.home),
    projects: projects(memories, sessions?.folders ?? [], h.home),
    sessions: sessions && {
      sessions: sessions.sessions,
      asks: sessions.asks,
      firstAt: sessions.firstAt,
      engines: sessions.engines,
      activity: sessions.activity,
      folders: sessions.folders.slice(0, 60).map((folder) => ({ ...folder, cwd: tilde(folder.cwd, h.home) })),
    },
    sessionsError,
    problems,
  }
}

/** What changed between two snapshots, cheaply: the pane reloads only when this differs. */
export function fingerprint(snap) {
  const parts = [snap.about?.modified ?? 0, snap.sessions?.asks ?? 0, snap.sessions?.sessions ?? 0]
  for (const row of snap.memories) parts.push(row.id, row.modified ?? 0, row.size)
  return parts.join('|')
}

/** The pane header's line. Always ready: there is nothing to finish, only more to read. */
export function verdict(snap) {
  const memories = snap.memories.filter((row) => row.kind !== 'instructions').length
  const agents = snap.agents.filter((agent) => agent.memories > 0).length
  const about = snap.about?.lines.length ?? 0
  const parts = [`${memories} ${memories === 1 ? 'memory' : 'memories'} from ${agents} ${agents === 1 ? 'agent' : 'agents'}`]
  parts.push(about ? `About You: ${about} lines` : 'About You not built yet')
  return { spec: 1, ready: true, summary: parts.join(' · '), updatedAt: new Date(snap.observedAt).toISOString() }
}

export function writeVerdict(workspace, snap) {
  const dir = join(workspace, '.harness')
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.verdict.${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify(verdict(snap), null, 2) + '\n')
  renameSync(temporary, join(dir, 'verdict.json'))
}
