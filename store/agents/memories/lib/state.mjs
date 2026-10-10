/**
 * One snapshot of everything the Memories pane shows: every agent's memories, your About You, and what
 * the session index says about how you work. The viewer and the `mem` command both build it here, so a
 * row in the pane and a line from `mem list` can never disagree.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homes } from './agents.mjs'
import { readAbout } from './about.mjs'
import { status as deliveryStatus } from './deliver.mjs'
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
export function projectsFor(memories, folders, home) {
  const byKey = new Map()
  for (const row of memories) {
    if (!row.project) continue
    const key = row.project.path || `name:${row.project.name}`
    const entry = byKey.get(key) ?? { key, name: row.project.name, path: row.project.path ? tilde(row.project.path, home) : null, memories: [], sessions: 0, asks: 0, engines: {}, lastAt: null }
    entry.memories.push(row.id)
    byKey.set(key, entry)
  }
  // Each folder in the index counts toward one project: the one whose path matches it most closely.
  // A repository's worktrees are folders of their own; Claude Code keys memory by repository, so they
  // share its memories and count with it — a folder inside it (`.claude/worktrees/x`) or one under
  // `…/worktrees/<repo name>/`. A project at the home folder itself counts only sessions started there.
  const real = (entry) => (entry.path?.startsWith('~') ? home + entry.path.slice(1) : entry.path)
  const claims = (path, cwd) => cwd === path || (path !== home && (cwd.startsWith(path + '/') || cwd.includes(`/worktrees/${basename(path)}/`)))
  const owners = new Map()
  for (const folder of folders) {
    let best = null
    for (const entry of byKey.values()) {
      const path = real(entry)
      if (!path || !claims(path, folder.cwd)) continue
      // Closest wins: an exact folder, else the match reaching furthest into the folder's path — for a
      // worktree, the end of its `/worktrees/<repo>/` part, so it beats a project in a parent folder.
      const worktree = `/worktrees/${basename(path)}/`
      const score = folder.cwd === path ? Infinity : folder.cwd.startsWith(path + '/') ? path.length : folder.cwd.indexOf(worktree) + worktree.length
      if (!best || score > best.score) best = { entry, score }
    }
    if (best) owners.set(folder, best.entry)
  }
  for (const [folder, entry] of owners) {
    entry.sessions += folder.sessions
    entry.asks += folder.asks
    entry.lastAt = Math.max(entry.lastAt ?? 0, folder.lastAt ?? 0) || null
    for (const [engine, count] of Object.entries(folder.engines)) entry.engines[engine] = (entry.engines[engine] ?? 0) + count
  }
  return [...byKey.values()].sort((a, b) => b.memories.length - a.memories.length || (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

/**
 * The session overview scans every turn; it is recomputed only when the index file changed, and at
 * most every `OVERVIEW_MIN_MS` while it keeps changing (the daemon writes as you work).
 */
const OVERVIEW_MIN_MS = 30_000
let overviewCache = null
function indexStamp(h) {
  const stamp = (name) => { try { const info = statSync(join(h.harnessData, name)); return `${info.size}:${info.mtimeMs}` } catch { return '-' } }
  return `${h.harnessData}|${stamp('session-search.db')}|${stamp('session-search.db-wal')}`
}

export async function snapshot({ env = process.env, home, now = Date.now() } = {}) {
  const h = homes(env, home)
  const index = await sessionIndex(h)
  let sessions = null
  let sessionsError = index.error ?? null
  if (index.db) {
    const stamp = indexStamp(h)
    const fresh = overviewCache && overviewCache.dir === h.harnessData && (overviewCache.stamp === stamp || now - overviewCache.at < OVERVIEW_MIN_MS)
    try {
      sessions = fresh ? overviewCache.value : overview(index.db, { now })
      if (!fresh) overviewCache = { dir: h.harnessData, stamp, at: now, value: sessions }
    } catch (error) {
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
    delivery: (() => { try { return deliveryStatus({ env, home: h.home }) } catch { return { on: false, agents: [] } } })(),
    projects: projectsFor(memories, sessions?.folders ?? [], h.home),
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
  const parts = [snap.about?.modified ?? 0, snap.sessions?.asks ?? 0, snap.sessions?.sessions ?? 0, JSON.stringify(snap.delivery ?? null)]
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

/** Written only when the header's line changes, not on every look. */
export function writeVerdict(workspace, snap) {
  const dir = join(workspace, '.harness')
  const next = verdict(snap)
  try {
    const current = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'))
    if (current.summary === next.summary && current.ready === next.ready) return false
  } catch { /* no verdict yet */ }
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.verdict.${process.pid}.tmp`)
  rmSync(temporary, { force: true })
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' })
  renameSync(temporary, join(dir, 'verdict.json'))
  return true
}
