/**
 * The data of a confidential session the Swarm ended for good in a Harness Team account (#895): a Product Manager removed
 * or replaced, a private chat's worker stopped (inCore/agents.ts closeMember and closeSwarm). The Swarm keeps its chats; its
 * files in the account, which the account's next agent could read, go. The account stays held until they have
 * (inCore/teamApps.ts, and the backend's `heldFor`).
 *
 * Through the reviewed purge (lib/purgeAgentService.ts), its worktree kept; then a Codex one's own engine home goes whole
 * (superTabs/teamDaemon.ts pmEngineHome), and a Claude Code one's traces are scrubbed from the Team user's shared home, whose
 * transcripts core reads only there. A sweep then looks where Claude Code and Codex write a session's own data, never at
 * other sessions' transcripts, which name the Product Manager when they read its status (security re-check 3 of #2089).
 *
 * The session is kept in a durable record before anything is deleted, and leaves it only once the sweep finds nothing: the
 * reviewed purge drops the session from the stopped catalog, so a retry after a failed sweep had nothing left to scrub from.
 * Everything here reads and writes asynchronously: a Team home holds gigabytes of transcripts, and this runs in the core.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PM_HOMES } from '../teamDaemon.js'

/** What a purge needs of a session, kept until it finishes. `pastes`: the paste cache files its history lines kept. */
export interface PurgeTarget {
  agentId: string
  sessionId: string | null
  cwd: string | null
  engine: string
  codexHome: string | null
  pastes?: string[]
}

/** The purges still to finish, by agent id, kept in [file] across restarts. One that cannot be read is `unknown`: the
 *  account then stays held, as it fails closed (inCore/teamApps.ts). */
export function purgeRecord(file: string) {
  const load = (): { held: Map<string, PurgeTarget>; unknown: boolean } => {
    if (!existsSync(file)) return { held: new Map(), unknown: false }
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const held = new Map<string, PurgeTarget>()
      for (const [id, entry] of Object.entries(saved)) if (entry && typeof entry === 'object' && (entry as PurgeTarget).agentId === id) held.set(id, entry as PurgeTarget)
      return { held, unknown: false }
    } catch { return { held: new Map(), unknown: true } }
  }
  const state = load()
  const save = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.next`, JSON.stringify(Object.fromEntries(state.held)), { mode: 0o600 })
    renameSync(`${file}.next`, file)
  }
  return {
    pending: (): PurgeTarget[] => [...state.held.values()],
    get: (agentId: string): PurgeTarget | undefined => state.held.get(agentId),
    unknown: (): boolean => state.unknown,
    put(target: PurgeTarget): void { state.held.set(target.agentId, target); save() },
    drop(agentId: string): void { if (state.held.delete(agentId)) save() },
  }
}
export type PurgeRecord = ReturnType<typeof purgeRecord>

/** Claude Code's folder name for a project folder: every character but a letter or digit made a dash. */
const claudeSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const SESSION = /^[A-Za-z0-9_-]{1,160}$/
/** Its folder, when it names one that is no root: an empty or root key would match every other session's. */
const folderOf = (target: PurgeTarget) => target.cwd && target.cwd.startsWith('/') && target.cwd.length > 1 ? target.cwd : null

/**
 * Rewrites [path] through [transform], unless it changed while being rewritten: another agent of the account may write the
 * same file (Claude Code's history, its config) at any moment, and a rewrite from an older copy would lose that write. Then
 * it reads it again and tries again; false when it never stood still. A missing file has nothing to rewrite.
 */
export async function rewriteIfUnchanged(path: string, transform: (text: string) => string, tries = 5): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    let before
    try { before = await stat(path) } catch { return true }
    const text = await readFile(path, 'utf8')
    const next = transform(text)
    if (next === text) return true
    const temporary = `${path}.harness-${process.pid}`
    await writeFile(temporary, next, { mode: 0o600 })
    const now = await stat(path)
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) { await unlink(temporary); continue }
    await rename(temporary, path)
    return true
  }
  return false
}

/** [config] (Claude Code's `.claude.json`, or a backup of it) without [folder]: its project entry and its repository paths. */
function withoutFolder(text: string, folder: string): string {
  let config: { projects?: Record<string, unknown>; githubRepoPaths?: Record<string, unknown> }
  try { config = JSON.parse(text) } catch { return text }
  if (!config || typeof config !== 'object') return text
  let changed = false
  if (config.projects && folder in config.projects) { delete config.projects[folder]; changed = true }
  for (const [repository, paths] of Object.entries(config.githubRepoPaths ?? {})) {
    if (!Array.isArray(paths) || !paths.includes(folder)) continue
    const kept = paths.filter(path => path !== folder)
    if (kept.length) config.githubRepoPaths![repository] = kept
    else delete config.githubRepoPaths![repository]
    changed = true
  }
  return changed ? JSON.stringify(config, null, 2) : text
}

/**
 * Removes from the Team user's shared Claude Code home ([home]/.claude, [home]/.claude.json and its backups) what Claude
 * Code keeps of the session: its prompt history lines and the pastes they kept ([pastes] from an earlier attempt too), its
 * project folder with its transcripts and memory, its file history, todos, session environment and debug log, and its
 * folder's entry and repository paths in the config and in every backup of it. The pastes its history named, for the record.
 */
export async function scrubClaudeSession(home: string, target: PurgeTarget, pastes: readonly string[] = []): Promise<string[]> {
  const sessionId = target.sessionId && SESSION.test(target.sessionId) ? target.sessionId : null
  const folder = folderOf(target)
  if (!sessionId && !folder) return []
  const claude = join(home, '.claude'), found: string[] = []
  await rewriteIfUnchanged(join(claude, 'history.jsonl'), text => {
    found.length = 0
    const kept = text.split('\n').filter(line => {
      if (!line.trim()) return false
      let row: { sessionId?: unknown; project?: unknown; pastedContents?: Record<string, { contentHash?: unknown } | null> }
      try { row = JSON.parse(line) } catch { return !(sessionId && line.includes(sessionId)) && !(folder && line.includes(folder)) }
      const ours = (!!sessionId && row.sessionId === sessionId) || (!!folder && row.project === folder)
      if (ours) for (const paste of Object.values(row.pastedContents ?? {})) if (typeof paste?.contentHash === 'string') found.push(paste.contentHash)
      return !ours
    })
    return kept.length ? `${kept.join('\n')}\n` : ''
  })
  for (const hash of new Set([...pastes, ...found])) if (SESSION.test(hash)) await rm(join(claude, 'paste-cache', `${hash}.txt`), { force: true })
  if (folder) await rm(join(claude, 'projects', claudeSlug(folder)), { recursive: true, force: true })
  if (sessionId) {
    for (const sub of ['file-history', 'session-env']) await rm(join(claude, sub, sessionId), { recursive: true, force: true })
    await rm(join(claude, 'debug', `${sessionId}.txt`), { force: true })
    const todos = await readdir(join(claude, 'todos')).catch(() => [] as string[])
    for (const name of todos) if (name.startsWith(sessionId)) await rm(join(claude, 'todos', name), { force: true })
  }
  if (folder) {
    await rewriteIfUnchanged(join(home, '.claude.json'), text => withoutFolder(text, folder))
    const backups = await readdir(join(claude, 'backups')).catch(() => [] as string[])
    for (const name of backups) await rewriteIfUnchanged(join(claude, 'backups', name), text => withoutFolder(text, folder))
  }
  return [...new Set(found)].filter(hash => SESSION.test(hash))
}

/**
 * What still names the session where Claude Code and Codex write its own data, or null: a line of the shared prompt history
 * (Claude Code's or Codex's) naming its session or folder; a paste it kept; its folder in the config or a backup of it; and
 * anywhere under their homes, a file or folder named for its session or its folder. Never the contents of other sessions'
 * transcripts: another agent that read the Product Manager's status names both there, and is not its to delete.
 */
export async function sweepForSession(home: string, target: PurgeTarget, pastes: readonly string[]): Promise<string | null> {
  const sessionId = target.sessionId && SESSION.test(target.sessionId) ? target.sessionId : null
  const folder = folderOf(target)
  const claude = join(home, '.claude'), codex = join(home, '.codex')
  const quoted = [...sessionId ? [`"${sessionId}"`] : [], ...folder ? [`"${folder}"`, `"${folder}/`] : []]
  const names = (path: string) => quoted.some(q => path.includes(q))
  for (const history of [join(claude, 'history.jsonl'), join(codex, 'history.jsonl')]) {
    const text = await readFile(history, 'utf8').catch(() => '')
    if (names(text)) return history
  }
  for (const hash of pastes) if (SESSION.test(hash) && existsSync(join(claude, 'paste-cache', `${hash}.txt`))) return join(claude, 'paste-cache', `${hash}.txt`)
  if (folder) {
    const configs = [join(home, '.claude.json'), ...(await readdir(join(claude, 'backups')).catch(() => [] as string[])).map(name => join(claude, 'backups', name))]
    for (const config of configs) if ((await readFile(config, 'utf8').catch(() => '')).includes(`"${folder}"`)) return config
  }
  const slug = folder ? claudeSlug(folder) : null
  const named = (name: string) => (!!sessionId && name.includes(sessionId)) || (!!slug && name === slug)
  const walk = async (path: string): Promise<string | null> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      if (named(entry.name)) return child
      if (entry.isDirectory()) { const found = await walk(child); if (found) return found }
    }
    return null
  }
  for (const root of [claude, codex]) { const found = await walk(root); if (found) return found }
  return null
}

/**
 * The purge of [agentId]'s data, once the Swarm ended it for good, when it was confidential: kept in [record] before the
 * first deletion and dropped once the sweep finds nothing. A retry finishes from the record, the session gone or not.
 */
export function createConfidentialPurge(deps: {
  confidential: (agentId: string) => boolean
  session: (agentId: string) => { agentId: string; sessionId?: string | null; registeredAt: number; engine: string; cwd: string | null; codexHome?: string | null } | null
  purge: (request: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** The Team user's home. */
  home: string
  record: PurgeRecord
}): (agentId: string) => Promise<Record<string, unknown>> {
  return async agentId => {
    const session = deps.session(agentId)
    let target = deps.record.get(agentId)
    if (!target) {
      if (!session || !deps.confidential(agentId)) return { skipped: true }
      target = { agentId: session.agentId, sessionId: session.sessionId ?? null, cwd: session.cwd, engine: session.engine, codexHome: session.codexHome ?? null }
      deps.record.put(target)
    }
    if (session) {
      const reference = { agentId: session.agentId, sessionId: session.sessionId ?? null, createdAt: session.registeredAt }
      const review = await deps.purge({ ...reference, mode: 'inspect' })
      if (typeof review.reviewId !== 'string') return review
      const deleted = await deps.purge({ ...reference, mode: 'delete', reviewId: review.reviewId, choices: { sessionData: true, worktreeData: false } })
      if (typeof deleted.error === 'string') return deleted
    }
    const homes = join(deps.home, PM_HOMES)
    if (target.codexHome && target.codexHome.startsWith(`${homes}/`)) await rm(dirname(target.codexHome), { recursive: true, force: true })
    if (target.engine === 'claude') {
      const pastes = [...new Set([...target.pastes ?? [], ...await scrubClaudeSession(deps.home, target, target.pastes)])]
      if (pastes.length !== (target.pastes ?? []).length) { target = { ...target, pastes }; deps.record.put(target) }
    }
    const left = await sweepForSession(deps.home, target, target.pastes ?? [])
    if (left) return { error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${left}` }
    deps.record.drop(agentId)
    return { ok: true }
  }
}

