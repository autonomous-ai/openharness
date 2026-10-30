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
import { lstat, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { PM_HOMES } from '../teamDaemon.js'

/** What a purge needs of a session, kept until it finishes. `pastes`: the paste cache files its history lines kept.
 *  `sharedMemory`: the memory files of a transcript folder another folder shares that both folders' sessions wrote, kept for
 *  the other and known only here once its own transcripts are gone; the sweep fails while one is there. */
export interface PurgeTarget {
  agentId: string
  sessionId: string | null
  cwd: string | null
  engine: string
  codexHome: string | null
  pastes?: string[]
  sharedMemory?: string[]
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
const namesOrNone = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(name => typeof name === 'string'))
/** An entry as `put` writes it; `codexHome` absent in records from before Codex PMs had homes of their own. */
function isTarget(id: string, entry: unknown): entry is PurgeTarget {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const target = entry as Record<string, unknown>
  return target.agentId === id && nameOrNull(target.sessionId) && nameOrNull(target.cwd) && typeof target.engine === 'string'
    && (target.codexHome === undefined || nameOrNull(target.codexHome))
    && namesOrNone(target.pastes) && namesOrNone(target.sharedMemory)
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

/** The tools whose calls write the file they name: a read names one too, and makes it no session's. */
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const within = (cwd: string, folder: string) => cwd === folder || cwd.startsWith(`${folder}/`)

/** What the transcript [file] records, read once: whether a working folder of its is [folder] or one inside it, whether one
 *  is another, and which files under [memory] its tool calls wrote, by the exact path each call named. */
async function readTranscript(file: string, folder: string, memory: string): Promise<{ own: boolean; other: boolean; wrote: Set<string> }> {
  const found = { own: false, other: false, wrote: new Set<string>() }
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"') && !line.includes('"tool_use"')) continue
      let row: { cwd?: unknown; message?: { content?: unknown } } | null
      try { row = JSON.parse(line) } catch { continue }
      if (typeof row?.cwd === 'string') found[within(row.cwd, folder) ? 'own' : 'other'] = true
      const parts = row?.message?.content
      for (const part of Array.isArray(parts) ? parts as Array<{ type?: unknown; name?: unknown; input?: { file_path?: unknown; notebook_path?: unknown } }> : []) {
        if (part?.type !== 'tool_use' || !WRITERS.has(part.name as string)) continue
        const path = part.input?.file_path ?? part.input?.notebook_path
        if (typeof path === 'string' && path.startsWith(`${memory}/`)) found.wrote.add(path)
      }
    }
  } finally { lines.close() }
  return found
}

/** Every file under the folder [path], a link as itself and never followed; none when it is missing or no folder: a memory
 *  folder linked elsewhere would have the scrub remove files outside the transcript folder. One it cannot read fails it. */
async function filesUnder(path: string): Promise<string[]> {
  const files: string[] = []
  const entries = (await lstat(path).catch(() => null))?.isDirectory() ? await readdir(path, { withFileTypes: true }) : []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) files.push(...await filesUnder(join(path, entry.name)))
    else files.push(join(path, entry.name))
  }
  return files
}

/** [dir], the transcript folder Claude Code names for [folder]: whole when no transcript in it is another folder's; else only
 *  [folder]'s own transcripts, each with its folder of subagents and tool results, and the memory files only they wrote.
 *  [onShared] is told first, with the memory files both folders' sessions wrote, which stay: they are the other's too. A
 *  memory file no transcript wrote stays, as nothing shows whose it is (follow-up to security review 2 of #2375). */
async function removeTranscripts(dir: string, folder: string, onShared?: (both: string[]) => void): Promise<void> {
  const memory = join(dir, 'memory')
  const transcripts = new Map<string, Awaited<ReturnType<typeof readTranscript>>>()
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl'))) {
    transcripts.set(name, await readTranscript(join(dir, name), folder, memory))
  }
  if (![...transcripts.values()].some(transcript => transcript.other)) { await rm(dir, { recursive: true, force: true }); return }
  // A transcript that records another folder stays, as recordsOtherFolder decides for a Buddy's session id (host.ts); one that
  // records its folder too is the after-check's to refuse (sweepForSession).
  const ours = new Set<string>(), theirs = new Set<string>()
  for (const { other, wrote } of transcripts.values()) for (const path of wrote) (other ? theirs : ours).add(path)
  const memories = await filesUnder(memory)
  onShared?.(memories.filter(path => ours.has(path) && theirs.has(path)))
  for (const path of memories) if (ours.has(path) && !theirs.has(path)) await rm(path, { force: true })
  for (const [name, { other }] of transcripts) {
    if (other) continue
    await rm(join(dir, name), { force: true })
    await rm(join(dir, name.slice(0, -'.jsonl'.length)), { recursive: true, force: true })
  }
}

/** What in [dir], the transcript folder Claude Code names for [folder], may still be the session's, or null when it holds only
 *  other folders' transcripts, their own folders, and memory files one of them wrote that the session did not write too
 *  ([sharedMemory], kept in the record). A transcript that records [folder] or no folder, a memory file none of them wrote,
 *  anything else, or the folder itself once no other folder's transcript is left, fails it, closed. */
async function leftInSharedFolder(dir: string, folder: string, sharedMemory: readonly string[]): Promise<string | null> {
  const memory = join(dir, 'memory')
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
  const transcripts = new Set<string>(), wrote = new Set<string>()
  for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))) {
    const transcript = await readTranscript(join(dir, entry.name), folder, memory)
    if (transcript.own || !transcript.other) return join(dir, entry.name)
    transcripts.add(entry.name.slice(0, -'.jsonl'.length))
    for (const path of transcript.wrote) wrote.add(path)
  }
  if (!transcripts.size) return dir
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) continue
    if (entry.isDirectory() && entry.name === 'memory') {
      for (const path of await filesUnder(memory)) if (!wrote.has(path) || sharedMemory.includes(path)) return path
    } else if (!entry.isDirectory() || !transcripts.has(entry.name)) return join(dir, entry.name)
  }
  return null
}

/**
 * Removes from the Team user's shared Claude Code home ([home]/.claude, [home]/.claude.json and its backups) what Claude
 * Code keeps of the session: its prompt history lines and the pastes they kept ([pastes] from an earlier attempt too), its
 * project folder with its transcripts and memory (only its own transcripts and the memory files only they wrote when another
 * folder's share it, [onShared] told first which memory files both wrote),
 * its file history, todos, session environment and debug log, and its folder's entry and repository paths in the config
 * and in every backup of it. The pastes its history named, for the record.
 */
export async function scrubClaudeSession(home: string, target: PurgeTarget, pastes: readonly string[] = [],
  onPastes?: (pastes: string[]) => void, onShared?: (both: string[]) => void): Promise<string[]> {
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
 * folder, when another folder's transcripts share it, only by the working folders and memory writes they record.
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
        const left = path === projects && entry.isDirectory() ? await leftInSharedFolder(child, folder!, target.sharedMemory ?? []) : child
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
      // The memory files both folders' sessions wrote, kept before its own transcripts go: only the record knows them after.
      const share = (both: readonly string[]) => {
        const sharedMemory = [...new Set([...target!.sharedMemory ?? [], ...both])]
        if (sharedMemory.length !== (target!.sharedMemory ?? []).length) { target = { ...target!, sharedMemory }; deps.record.put(target) }
      }
      keep(await scrubClaudeSession(deps.home, target, target.pastes, keep, share))
    }
    const left = await sweepForSession(deps.home, target, target.pastes ?? [])
    if (left) return { error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${left}` }
    deps.record.drop(agentId)
    return { ok: true }
  }
}

