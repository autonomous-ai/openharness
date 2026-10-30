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
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
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

/** The purges still to finish, by agent id, kept in [file] across restarts. One that cannot be read is never written over,
 *  which would forget the purges it names: it is kept aside at `<file>.unreadable` (`.1`, `.2`… when one already is), and while any is there the record is
 *  `unknown` and the account stays held, as it fails closed (inCore/teamApps.ts), until a person clears it (security
 *  re-check 2 of 9e49723b8). */
export function purgeRecord(file: string) {
  const aside = `${file}.unreadable`
  const load = (): Map<string, PurgeTarget> => {
    if (!existsSync(file)) return new Map()
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
      // One of another shape is set aside as well, never read as fewer purges than it names (security review 2 of #2142).
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not a record')
      const held = new Map<string, PurgeTarget>()
      for (const [id, entry] of Object.entries(saved)) {
        if (!isTarget(id, entry)) throw new Error('not a purge')
        held.set(id, entry)
      }
      return held
    } catch {
      let free = aside
      for (let n = 1; existsSync(free); n++) free = `${aside}.${n}`
      renameSync(file, free)
      return new Map()
    }
  }
  /** The records kept aside, in the order they were. No folder yet: no record was ever kept here, let alone kept aside. */
  const keptAsideFiles = (): string[] => existsSync(dirname(file)) ? readdirSync(dirname(file))
    .filter(name => name === basename(aside) || name.startsWith(`${basename(aside)}.`))
    .map(name => [Number(name.slice(basename(aside).length + 1)) || 0, join(dirname(file), name)] as const)
    .sort(([a], [b]) => a - b).map(([, path]) => path) : []
  const keptAside = (): boolean => existsSync(aside) || keptAsideFiles().length > 0
  const state = { held: load() }
  // Said once per start, where each is kept, path only: the refusal points here, and its owner clears it by hand (the PR's
  // risk note; security review 2 of #2142).
  const kept = keptAsideFiles()
  if (kept.length) console.warn(`[super-tabs] the record of purges still to finish could not be read; kept aside at ${kept.join(', ')} until its owner clears it`)
  const save = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.next`, JSON.stringify(Object.fromEntries(state.held)), { mode: 0o600 })
    renameSync(`${file}.next`, file)
  }
  return {
    pending: (): PurgeTarget[] => [...state.held.values()],
    get: (agentId: string): PurgeTarget | undefined => state.held.get(agentId),
    unknown: keptAside,
    put(target: PurgeTarget): void { state.held.set(target.agentId, target); save() },
    drop(agentId: string): void { if (state.held.delete(agentId)) save() },
  }
}
export type PurgeRecord = ReturnType<typeof purgeRecord>

const nameOrNull = (value: unknown) => value === null || typeof value === 'string'
/** An entry as `put` writes it; `codexHome` absent in records from before Codex PMs had homes of their own. */
function isTarget(id: string, entry: unknown): entry is PurgeTarget {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const target = entry as Record<string, unknown>
  return target.agentId === id && nameOrNull(target.sessionId) && nameOrNull(target.cwd) && typeof target.engine === 'string'
    && (target.codexHome === undefined || nameOrNull(target.codexHome))
    && (target.pastes === undefined || (Array.isArray(target.pastes) && target.pastes.every(paste => typeof paste === 'string')))
}

/** Claude Code's folder name for a project folder: every character but a letter or digit made a dash. */
const claudeSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const SESSION = /^[A-Za-z0-9_-]{1,160}$/
/** Its folder, when it names one that is no root: an empty or root key would match every other session's. */
const folderOf = (target: PurgeTarget) => target.cwd && target.cwd.startsWith('/') && target.cwd.length > 1 ? target.cwd : null

/**
 * Rewrites [path] through [transform], unless it changed while being rewritten: another agent of the account may write the
 * same file (Claude Code's history, its config) at any moment, and a rewrite from an older copy would lose that write. Then
 * it reads it again and tries again; false when it never stood still. A missing file has nothing to rewrite.
 *
 * What it cannot close without a lock the engines do not take: a write landing between its last check and the rename, one
 * system call wide, is lost to that other agent. It leaves nothing of the session behind: the sweep reads the file again
 * afterwards and fails the purge, closed, while anything still names it.
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

/** Whether the transcript [file] records a working folder other than [folder] or one inside it: Claude Code writes the cwd
 *  on every turn, and its folder name makes every '/' and '.' a dash, so a removed worktree `<worktrees>/old/notes` shares its
 *  transcript folder with an unrelated `~/harnesses/worktrees-old/notes` (security review 2 of #2375). */
export async function recordsOtherFolder(file: string, folder: string): Promise<boolean> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue
      let cwd: unknown
      try { cwd = (JSON.parse(line) as { cwd?: unknown }).cwd } catch { continue }
      if (typeof cwd === 'string' && cwd !== folder && !cwd.startsWith(`${folder}/`)) return true
    }
    return false
  } finally { lines.close() }
}

/** Whether the transcript [file] records [folder] or a folder inside it as its working folder (`own`), and another (`other`). */
async function foldersOf(file: string, folder: string): Promise<{ own: boolean; other: boolean }> {
  const found = { own: false, other: false }
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue
      let cwd: unknown
      try { cwd = (JSON.parse(line) as { cwd?: unknown } | null)?.cwd } catch { continue }
      if (typeof cwd === 'string') found[cwd === folder || cwd.startsWith(`${folder}/`) ? 'own' : 'other'] = true
    }
  } finally { lines.close() }
  return found
}

/**
 * [dir], the transcript folder Claude Code names for [folder]: whole when no transcript in it is another folder's; else only
 * the transcripts that record [folder] and no other, each with its folder of subagents and tool results, and [onShared] is
 * told. Its memory folder then stays whole: which of its files are the session's no transcript proves (security reviews 1
 * and 2 of #2385: a Bash append, a subagent, a transcript Claude Code pruned, `Notes.md` on a Mac), and the Team purge's
 * sweep holds the account while one is there. A transcript that records no folder, or both, stays too, for the sweep to refuse.
 */
async function removeTranscripts(dir: string, folder: string, onShared?: () => void): Promise<void> {
  const transcripts = new Map<string, { own: boolean; other: boolean }>()
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'))) {
    transcripts.set(name, await foldersOf(join(dir, name), folder))
  }
  if (![...transcripts.values()].some(transcript => transcript.other)) { await rm(dir, { recursive: true, force: true }); return }
  onShared?.()
  for (const [name, { own, other }] of transcripts) {
    if (!own || other) continue
    await rm(join(dir, name), { force: true })
    await rm(join(dir, name.slice(0, -'.jsonl'.length)), { recursive: true, force: true })
  }
}

/** What in [dir], the transcript folder Claude Code names for [folder], may still be the session's, by its kind only: a path
 *  would name another folder's file (security review 1 of #2385). Null when it holds only transcripts that record other
 *  folders and never [folder], their own folders, and an empty memory folder or none; anything else, a memory file above all,
 *  or the folder itself once no other folder's transcript is left, fails it, closed. */
async function leftInSharedFolder(dir: string, folder: string): Promise<string | null> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
  const transcripts = new Set<string>()
  for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))) {
    const { own, other } = await foldersOf(join(dir, entry.name), folder)
    if (own || !other) return SHARED_LEFT.transcript
    transcripts.add(entry.name.slice(0, -'.jsonl'.length))
  }
  if (!transcripts.size) return SHARED_LEFT.folder
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) continue
    if (entry.isDirectory() && entry.name === 'memory') {
      // One that cannot be read fails it too, by its kind: the read's own error named its path (security review of #2385).
      const memory = await readdir(join(dir, entry.name)).catch(() => null)
      if (!memory) return SHARED_LEFT.unreadMemory
      if (memory.length) return SHARED_LEFT.memory
    } else if (!entry.isDirectory() || !transcripts.has(entry.name)) return SHARED_LEFT.other
  }
  return null
}
/** What a failed sweep says of its shared transcript folder, in place of a path. */
export const SHARED_LEFT = {
  transcript: 'a transcript in its transcript folder, which another folder shares, that records its folder or none',
  memory: 'a memory file in its transcript folder, which another folder shares: its owner checks it and removes what is not the other folder\'s',
  unreadMemory: 'a memory folder in its transcript folder, which another folder shares, that could not be read: its owner checks its permissions',
  other: 'something in its transcript folder, which another folder shares, that is not another folder\'s transcript',
  folder: 'its transcript folder',
}

/**
 * Removes from the Team user's shared Claude Code home ([home]/.claude, [home]/.claude.json and its backups) what Claude
 * Code keeps of the session: its prompt history lines and the pastes they kept ([pastes] from an earlier attempt too), its
 * project folder with its transcripts and memory (only the transcripts that record its folder alone when another folder's
 * share it, [onShared]),
 * its file history, todos, session environment and debug log, and its folder's entry and repository paths in the config
 * and in every backup of it. The pastes its history named, for the record.
 */
export async function scrubClaudeSession(home: string, target: PurgeTarget, pastes: readonly string[] = [],
  onPastes?: (pastes: string[]) => void, onShared?: () => void): Promise<string[]> {
  const sessionId = target.sessionId && SESSION.test(target.sessionId) ? target.sessionId : null
  const folder = folderOf(target)
  if (!sessionId && !folder) return []
  const claude = join(home, '.claude'), history = join(claude, 'history.jsonl')
  /** Its history's lines kept, and the pastes its own lines named. */
  const split = (text: string) => {
    const named: string[] = []
    const kept = text.split('\n').filter(line => {
      if (!line.trim()) return false
      let row: { sessionId?: unknown; project?: unknown; pastedContents?: Record<string, { contentHash?: unknown } | null> }
      try { row = JSON.parse(line) } catch { return !(sessionId && line.includes(sessionId)) && !(folder && line.includes(folder)) }
      const ours = (!!sessionId && row.sessionId === sessionId) || (!!folder && row.project === folder)
      if (ours) for (const paste of Object.values(row.pastedContents ?? {})) if (typeof paste?.contentHash === 'string' && SESSION.test(paste.contentHash)) named.push(paste.contentHash)
      return !ours
    })
    return { kept, named }
  }
  // Its pastes are handed on before the lines naming them go: a scrub that dies after the rewrite would otherwise lose them,
  // and a paste left behind would pass the sweep (security re-check 2 of 9e49723b8).
  const found = split(await readFile(history, 'utf8').catch(() => '')).named
  if (found.length) onPastes?.([...new Set(found)])
  await rewriteIfUnchanged(history, text => {
    const { kept, named } = split(text)
    found.push(...named)
    return kept.length ? `${kept.join('\n')}\n` : ''
  })
  for (const hash of new Set([...pastes, ...found])) if (SESSION.test(hash)) await rm(join(claude, 'paste-cache', `${hash}.txt`), { force: true })
  if (folder) await removeTranscripts(join(claude, 'projects', claudeSlug(folder)), folder, onShared)
  if (sessionId) {
    for (const sub of ['file-history', 'session-env']) await rm(join(claude, sub, sessionId), { recursive: true, force: true })
    await rm(join(claude, 'debug', `${sessionId}.txt`), { force: true })
    const todos = await readdir(join(claude, 'todos')).catch(() => [] as string[])
    // `<session>-agent-<agent>.json`: by prefix alone, a one-character id took every todo starting with it (security review 2 of #2375).
    for (const name of todos) if (name.startsWith(`${sessionId}-agent-`)) await rm(join(claude, 'todos', name), { force: true })
  }
  if (folder) {
    await rewriteIfUnchanged(join(home, '.claude.json'), text => withoutFolder(text, folder))
    const backups = await readdir(join(claude, 'backups')).catch(() => [] as string[])
    for (const name of backups) await rewriteIfUnchanged(join(claude, 'backups', name), text => withoutFolder(text, folder))
  }
  return [...new Set(found)]
}

/**
 * What still names the session where Claude Code and Codex write its own data, or null: a line of the shared prompt history
 * (Claude Code's or Codex's) naming its session or folder; a paste it kept; its folder in the config or a backup of it; and
 * anywhere under their homes, a file or folder named for its session or its folder. Never the contents of other sessions'
 * transcripts: another agent that read the Product Manager's status names both there, and is not its to delete. Its transcript
 * folder, when another folder's transcripts share it, only by the working folders they record.
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
  const slug = folder ? claudeSlug(folder) : null, projects = join(claude, 'projects')
  const walk = async (path: string): Promise<string | null> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      if (sessionId && entry.name.includes(sessionId)) return child
      if (entry.name === slug) {
        // Its transcript folder outlives the scrub when another folder's transcripts share it ('/' and '.' both become '-'),
        // and its name alone held the account for good (follow-up to security review 2 of #2375).
        const left = path === projects && entry.isDirectory() ? await leftInSharedFolder(child, folder!) : child
        if (left) return left
      }
      if (entry.isDirectory()) { const found = await walk(child); if (found) return found }
    }
    return null
  }
  for (const root of [claude, codex]) { const found = await walk(root); if (found) return found }
  return null
}

/** A purge refused while the record is kept aside; the close that gets it does not say so again (inCore/agents.ts). */
export const PURGE_RECORD_UNREADABLE = 'PURGE_RECORD_UNREADABLE'
export const UNREADABLE_DETAIL = "This machine's record of purges still to finish could not be read and was kept aside, as the daemon's log says at "
  + "each start. The account stays held until its owner clears it as #2142's risk note says, by file names only."

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
    // With its record unreadable, which purges are still to finish is not known: none is answered, not even a 'skipped' for a
    // session already gone, so the close fails and the backend keeps the account held until a person clears the record. Its
    // path was logged once, when it was kept aside; this answer, logged on every retry, names neither it nor the agent.
    if (deps.record.unknown()) return { error: PURGE_RECORD_UNREADABLE, detail: UNREADABLE_DETAIL }
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
      const keep = (found: readonly string[]) => {
        const pastes = [...new Set([...target!.pastes ?? [], ...found])]
        if (pastes.length !== (target!.pastes ?? []).length) { target = { ...target!, pastes }; deps.record.put(target) }
      }
      keep(await scrubClaudeSession(deps.home, target, target.pastes, keep))
    }
    const left = await sweepForSession(deps.home, target, target.pastes ?? [])
    if (left) return { error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${left}` }
    deps.record.drop(agentId)
    return { ok: true }
  }
}

