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
import { buddyTmpFolder, realOfFolder } from '../../lib/agentTmp.js'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, type Dirent } from 'node:fs'
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import nodePath, { basename, dirname, isAbsolute, join, relative, sep, type PlatformPath } from 'node:path'
import { createInterface } from 'node:readline'
import { PM_HOMES, PM_START_ID } from '../teamDaemon.js'

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

/** What a scrub tells its caller: another folder's transcripts share its transcript folder, or what it could not read and
 *  left, by kind alone. */
export type ScrubTold = 'shared' | 'unread' | 'unreadTodos' | 'unreadBackups'
/** [dir]'s names; null when it is there but cannot be listed. Only a folder that is not there is empty: read as empty, an
 *  unlistable todos or backups folder let a Buddy's cleanup, which no sweep follows, finish and leave its todo file and its
 *  folder in the backups (re-check of 8c0b019). The error itself is dropped, as its message names the path. */
const listed = (dir: string) => readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] as string[] : null)

/**
 * Whether [codexHome] is a Product Manager's own Codex home in the Team user's [home], `<home>/.harness-pm-homes/<id>/codex`
 * as superTabs/teamDaemon.ts pmEngineHome makes it, by [paths]' own rules: purge deletes its parent whole. A check for
 * `${homes}/` never matched Windows' `\`, so a purged Codex PM's home stayed for the account's next agent to read, and it took
 * a home one level under the PM homes folder, whose parent is every PM's homes (Windows audit, task #2022).
 */
export function isPmCodexHome(home: string, codexHome: string, paths: Pick<PlatformPath, 'join' | 'relative' | 'isAbsolute' | 'sep'> =
  { join, relative, isAbsolute, sep }): boolean {
  if (!codexHome) return false
  const inside = paths.relative(paths.join(home, PM_HOMES), codexHome)
  if (paths.isAbsolute(inside)) return false
  const [id, last, ...more] = inside.split(paths.sep)
  // pmEngineHome's own rule for the id: `.. ` passed a check for `..`, and Windows reads it as `..`, the whole Team home
  // (security review 1 of #2568).
  return !!id && PM_START_ID.test(id) && last === 'codex' && more.length === 0
}

/** Claude Code's folder name for a project folder: every character but a letter or digit made a dash. */
const claudeSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const SESSION = /^[A-Za-z0-9_-]{1,160}$/
/** What purge asks of a platform's paths: the host's, or `path.win32` in a test. */
type FolderPaths = Pick<PlatformPath, 'isAbsolute' | 'normalize' | 'parse' | 'sep'>
const onWindows = (paths: FolderPaths) => paths.sep === '\\'
/** [path] as it compares. On Windows any separator names the same folder, in any case, as Claude Code compares them there. Its
 *  forms differ too: a config key has `/` (2.1.316's `U3`), history and transcripts `\` (Windows audit W3). */
const folderKey = (path: string, paths: FolderPaths) =>
  onWindows(paths) ? paths.normalize(path).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : path
/** Whether [cwd], as its key, is [key] or inside it: past a separator, so `C:\a\b-evil` is not inside `C:\a\b`. */
const inFolder = (cwd: string, key: string, paths: FolderPaths) => {
  const candidate = folderKey(cwd, paths)
  return candidate === key || candidate.startsWith(`${key}/`)
}
/** [text] of a file, as folder keys read in it: JSON doubles a `\`. */
const foldedText = (text: string, paths: FolderPaths) =>
  onWindows(paths) ? text.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase() : text
/** Its folder, when it names one that is no root: an empty or root key would match every other session's. On Windows a folder
 *  has a drive or a share: `\Users` and `/Users` are relative to whichever drive is current, so which folder they name is not known. */
function folderOf(target: PurgeTarget, paths: FolderPaths): string | null {
  const cwd = target.cwd
  if (!cwd || !paths.isAbsolute(cwd) || (onWindows(paths) && !/^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(cwd))) return null
  const bare = (path: string) => path.replace(/[\\/]+$/, '')
  const normal = paths.normalize(cwd)
  return bare(normal) === bare(paths.parse(normal).root) ? null : cwd
}

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
function withoutFolder(text: string, folder: string, paths: FolderPaths): string {
  let config: { projects?: Record<string, unknown>; githubRepoPaths?: Record<string, unknown> }
  try { config = JSON.parse(text) } catch { return text }
  if (!config || typeof config !== 'object') return text
  let changed = false
  const key = folderKey(folder, paths)
  const same = (path: unknown) => typeof path === 'string' && folderKey(path, paths) === key
  for (const name of Object.keys(config.projects ?? {})) if (same(name)) { delete config.projects![name]; changed = true }
  for (const [repository, listed] of Object.entries(config.githubRepoPaths ?? {})) {
    if (!Array.isArray(listed) || !listed.some(same)) continue
    const kept = listed.filter(path => !same(path))
    if (kept.length) config.githubRepoPaths![repository] = kept
    else delete config.githubRepoPaths![repository]
    changed = true
  }
  return changed ? JSON.stringify(config, null, 2) : text
}

/** Whether the transcript [file] records a working folder other than [folder] or one inside it: Claude Code writes the cwd
 *  on every turn, and its folder name makes every '/' and '.' a dash, so a removed worktree `<worktrees>/old/notes` shares its
 *  transcript folder with an unrelated `~/harnesses/worktrees-old/notes` (security review 2 of #2375). */
export async function recordsOtherFolder(file: string, folder: string, paths: FolderPaths = nodePath): Promise<boolean> {
  const key = folderKey(folder, paths)
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue
      let cwd: unknown
      try { cwd = (JSON.parse(line) as { cwd?: unknown }).cwd } catch { continue }
      if (typeof cwd === 'string' && !inFolder(cwd, key, paths)) return true
    }
    return false
  } finally { lines.close() }
}

/** Whether the transcript [file] records [folder] or a folder inside it as its working folder (`own`), and another (`other`);
 *  `unread` when it could not be read, whose error would name its path (review of #2389). */
async function foldersOf(file: string, folder: string, paths: FolderPaths): Promise<{ own: boolean; other: boolean; unread?: true }> {
  const found = { own: false, other: false }, key = folderKey(folder, paths)
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.includes('"cwd"')) continue
      let cwd: unknown
      try { cwd = (JSON.parse(line) as { cwd?: unknown } | null)?.cwd } catch { continue }
      if (typeof cwd === 'string') found[inFolder(cwd, key, paths) ? 'own' : 'other'] = true
    }
  } catch { return { own: false, other: false, unread: true } } finally { lines.close() }
  return found
}

/**
 * [dir], the transcript folder Claude Code names for [folder]: whole when no transcript in it is another folder's; else only
 * the transcripts that record [folder] and no other, each with its folder of subagents and tool results, and [onShared] is
 * told. Its memory folder then stays whole: which of its files are the session's no transcript proves (security reviews 1
 * and 2 of #2385: a Bash append, a subagent, a transcript Claude Code pruned, `Notes.md` on a Mac), and the Team purge's
 * sweep holds the account while one is there. A transcript that records no folder, or both, stays too, for the sweep to refuse.
 */
async function removeTranscripts(dir: string, folder: string, paths: FolderPaths, told?: (what: ScrubTold) => void): Promise<void> {
  // Only a folder that is not there is empty. One that cannot be listed stays whole, and its caller is told, by that word
  // alone: read as empty it went whole, its error's path into the log, or another folder's transcripts unread on a passing
  // error such as too many open files (security reviews 1 and 2 of 58b035e). The Team purge's sweep then holds the account;
  // a Buddy's cleanup, which has no sweep, fails and is tried again (host.ts endSession).
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : null)
  if (!names) { told?.('unread'); return }
  const transcripts = new Map<string, Awaited<ReturnType<typeof foldersOf>>>()
  for (const name of names.filter(name => name.endsWith('.jsonl'))) {
    transcripts.set(name, await foldersOf(join(dir, name), folder, paths))
  }
  // One that could not be read may be another folder's: it and the folder stay, and its caller is told.
  const values = [...transcripts.values()]
  if (values.some(transcript => transcript.unread)) told?.('unread')
  if (!values.some(transcript => transcript.other || transcript.unread)) { await rm(dir, { recursive: true, force: true }); return }
  if (values.some(transcript => transcript.other)) told?.('shared')
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
async function leftInSharedFolder(dir: string, folder: string, paths: FolderPaths): Promise<string | null> {
  // One that cannot be listed holds it by its kind; one gone since its parent was listed holds nothing.
  let entries: Dirent[]
  try { entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : SHARED_LEFT.unreadFolder
  }
  const read = new Map<string, Awaited<ReturnType<typeof foldersOf>>>()
  for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))) read.set(entry.name, await foldersOf(join(dir, entry.name), folder, paths))
  // Said to be shared only when another folder's transcript is there (re-check 2 of 68ec6f0).
  const kinds = [...read.values()].some(transcript => transcript.other) ? SHARED_LEFT : OWN_LEFT
  const transcripts = new Set<string>()
  for (const [name, { own, other, unread }] of read) {
    if (unread) return kinds.unreadTranscript
    if (own || !other) return kinds.transcript
    transcripts.add(name.slice(0, -'.jsonl'.length))
  }
  if (!transcripts.size) return SHARED_LEFT.folder
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) continue
    if (entry.isDirectory() && entry.name === 'memory') {
      // One that cannot be read fails it too, by its kind: the read's own error named its path (security review of #2385). One
      // gone since the listing is none.
      const memory = await readdir(join(dir, entry.name)).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : null)
      if (!memory) return SHARED_LEFT.unreadMemory
      if (memory.length) return SHARED_LEFT.memory
    } else if (!entry.isDirectory() || !transcripts.has(entry.name)) return SHARED_LEFT.other
  }
  return null
}
/** What a held account's owner does about what could not be read: nothing names its path, and the host tries the purge again
 *  by itself (host.ts endSession), so fixing it is the whole of it (security review 1 of 58b035e). [find]: where to look, when
 *  its kind alone does not say (re-check of 8c0b019). */
const makeReadable = (find?: string) =>
  `could not be read: its owner ${find ? `finds it (${find}) and ` : ''}makes it readable for the Team account, and the purge finishes on its next try`
const MAKE_READABLE = makeReadable()
/** What a failed sweep says of its shared transcript folder, in place of a path. */
export const SHARED_LEFT = {
  transcript: 'a transcript in its transcript folder, which another folder shares, that records its folder or none',
  memory: 'a memory file in its transcript folder, which another folder shares: its owner checks it and removes what is not the other folder\'s',
  unreadFolder: `its transcript folder, which ${MAKE_READABLE}`,
  unreadMemory: `a memory folder in its transcript folder, which another folder shares, that ${MAKE_READABLE}`,
  unreadTranscript: `a transcript in its transcript folder, which another folder shares, that ${MAKE_READABLE}`,
  other: 'something in its transcript folder, which another folder shares, that is not another folder\'s transcript',
  folder: 'its transcript folder',
}
/** The same, for a transcript folder no other folder's transcript is in. */
export const OWN_LEFT = {
  transcript: 'a transcript in its transcript folder that records its folder or none',
  unreadTranscript: `a transcript in its transcript folder that ${MAKE_READABLE}`,
}
/** What the sweep names of what it found or could not read, in place of a path: one held the Team home's, and could name another
 *  folder (re-check 2 of 68ec6f0). */
export const SWEEP_LEFT = {
  claudeHistory: 'a line of Claude Code\'s prompt history that names its session or its folder',
  codexHistory: 'a line of Codex\'s prompt history that names its session or its folder',
  paste: 'a paste Claude Code kept from one of its prompts',
  config: 'its folder in Claude Code\'s config, or in a backup of it',
  claudeNamed: 'a file or folder in Claude Code\'s home named for its session or its folder',
  codexNamed: 'a file or folder in Codex\'s home named for its session or its folder',
  unreadFile: `a file in the Team account's Claude Code or Codex home that ${makeReadable('search the Team account\'s Claude Code and Codex homes for files it can\'t read')}`,
  unlistedFolder: `a folder in the Team account's Claude Code or Codex home that ${makeReadable('search the Team account\'s Claude Code and Codex homes for folders it can\'t read')}`,
}

/** The names in [projects] Claude Code uses for [folder]. On Windows that is by any case, as `c:\a` and `C:\a` are one folder there
 *  and their names differ only by it. Elsewhere it is the one name, listed or not, for the caller to find what is there. */
async function transcriptFolders(projects: string, folder: string, paths: FolderPaths): Promise<string[]> {
  const slug = claudeSlug(folderOnDisk(folder, paths))
  if (!onWindows(paths)) return [slug]
  const names = await listed(projects)
  // A listing that failed names only what the slug says: the removal reports it, unread, by its kind.
  return names ? names.filter(name => name.toLowerCase() === slug.toLowerCase()) : [slug]
}
/** [folder] as Claude Code names its project folder from it, by its working folder: no `..` and no trailing separator. */
const folderOnDisk = (folder: string, paths: FolderPaths) => onWindows(paths) ? paths.normalize(folder).replace(/[\\/]+$/, '') : folder

/**
 * Removes from the Team user's shared Claude Code home ([home]/.claude, [home]/.claude.json and its backups) what Claude
 * Code keeps of the session: its prompt history lines and the pastes they kept ([pastes] from an earlier attempt too), its
 * project folder with its transcripts and memory (only the transcripts that record its folder alone when another folder's
 * share it, and [told] 'shared'; [told] 'unread' when its transcript folder or one of its transcripts could not be read, and
 * stays),
 * its file history, todos, session environment and debug log, and its folder's entry and repository paths in the config
 * and in every backup of it ([told] 'unreadTodos' or 'unreadBackups' when that folder could not be listed). The pastes its
 * history named, for the record.
 */
export async function scrubClaudeSession(home: string, target: PurgeTarget, pastes: readonly string[] = [],
  onPastes?: (pastes: string[]) => void, told?: (what: ScrubTold) => void, paths: FolderPaths = nodePath): Promise<string[]> {
  const sessionId = target.sessionId && SESSION.test(target.sessionId) ? target.sessionId : null
  const folder = folderOf(target, paths)
  const key = folder && folderKey(folder, paths)
  if (!sessionId && !folder) return []
  const claude = join(home, '.claude'), history = join(claude, 'history.jsonl')
  /** Its history's lines kept, and the pastes its own lines named. */
  const split = (text: string) => {
    const named: string[] = []
    const kept = text.split('\n').filter(line => {
      if (!line.trim()) return false
      let row: { sessionId?: unknown; project?: unknown; pastedContents?: Record<string, { contentHash?: unknown } | null> }
      try { row = JSON.parse(line) } catch { return !(sessionId && line.includes(sessionId)) && !(key && foldedText(line, paths).includes(key)) }
      const ours = (!!sessionId && row.sessionId === sessionId) || (!!key && typeof row.project === 'string' && folderKey(row.project, paths) === key)
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
  if (folder) for (const name of await transcriptFolders(join(claude, 'projects'), folder, paths)) await removeTranscripts(join(claude, 'projects', name), folder, paths, told)
  // Its private temporary folder beside a Team account: command output from its person's private work (lib/agentTmp.ts). A plain
  // session shares its Buddy's folder, and this one's TMPDIR with it, so the whole folder goes only once that folder has; the
  // sweep takes what a tool left meanwhile (review of #2563).
  if (folder) {
    const temp = buddyTmpFolder(folder)
    if (!existsSync(folder)) await rm(temp, { recursive: true, force: true })
    else if (sessionId) await rm(join(temp, `claude-${process.getuid?.() ?? 0}`, claudeSlug(realOfFolder(folder)), sessionId), { recursive: true, force: true })
  }
  if (sessionId) {
    for (const sub of ['file-history', 'session-env']) await rm(join(claude, sub, sessionId), { recursive: true, force: true })
    await rm(join(claude, 'debug', `${sessionId}.txt`), { force: true })
    const todos = await listed(join(claude, 'todos'))
    if (!todos) told?.('unreadTodos')
    // `<session>-agent-<agent>.json`: by prefix alone, a one-character id took every todo starting with it (security review 2 of #2375).
    for (const name of todos ?? []) if (name.startsWith(`${sessionId}-agent-`)) await rm(join(claude, 'todos', name), { force: true })
  }
  if (folder) {
    await rewriteIfUnchanged(join(home, '.claude.json'), text => withoutFolder(text, folder, paths))
    const backups = await listed(join(claude, 'backups'))
    if (!backups) told?.('unreadBackups')
    for (const name of backups ?? []) await rewriteIfUnchanged(join(claude, 'backups', name), text => withoutFolder(text, folder, paths))
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
export async function sweepForSession(home: string, target: PurgeTarget, pastes: readonly string[], paths: FolderPaths = nodePath): Promise<string | null> {
  const sessionId = target.sessionId && SESSION.test(target.sessionId) ? target.sessionId : null
  const folder = folderOf(target, paths), key = folder && folderKey(folder, paths)
  const claude = join(home, '.claude'), codex = join(home, '.codex')
  const names = (text: string) => (!!sessionId && text.includes(`"${sessionId}"`))
    || (!!key && [`"${key}"`, `"${key}/`].some(quoted => foldedText(text, paths).includes(quoted)))
  // Only what is not there is empty: anything else that cannot be read holds the account, by its kind. Read as empty, an
  // unreadable projects folder let the account go with the session's transcript in it (re-checks 1 and 2 of 68ec6f0).
  const gone = (error: NodeJS.ErrnoException) => error.code === 'ENOENT'
  const read = (path: string) => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => gone(error) ? '' : null)
  for (const [history, kind] of [[join(claude, 'history.jsonl'), SWEEP_LEFT.claudeHistory], [join(codex, 'history.jsonl'), SWEEP_LEFT.codexHistory]]) {
    const text = await read(history)
    if (text === null) return SWEEP_LEFT.unreadFile
    if (names(text)) return kind
  }
  for (const hash of pastes) if (SESSION.test(hash) && existsSync(join(claude, 'paste-cache', `${hash}.txt`))) return SWEEP_LEFT.paste
  if (folder) {
    const backups = await readdir(join(claude, 'backups')).catch((error: NodeJS.ErrnoException) => gone(error) ? [] : null)
    if (!backups) return SWEEP_LEFT.unlistedFolder
    for (const config of [join(home, '.claude.json'), ...backups.map(name => join(claude, 'backups', name))]) {
      const text = await read(config)
      if (text === null) return SWEEP_LEFT.unreadFile
      if (foldedText(text, paths).includes(`"${key}"`)) return SWEEP_LEFT.config
    }
  }
  const slug = folder ? claudeSlug(folderOnDisk(folder, paths)) : null, projects = join(claude, 'projects')
  const isSlug = (name: string) => slug !== null && (onWindows(paths) ? name.toLowerCase() === slug.toLowerCase() : name === slug)
  const walk = async (path: string, named: string): Promise<string | null> => {
    let entries: Dirent[]
    try { entries = await readdir(path, { withFileTypes: true }) } catch (error) { return gone(error as NodeJS.ErrnoException) ? null : SWEEP_LEFT.unlistedFolder }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      if (sessionId && entry.name.includes(sessionId)) return named
      if (isSlug(entry.name)) {
        // Its transcript folder outlives the scrub when another folder's transcripts share it ('/' and '.' both become '-'),
        // and its name alone held the account for good (follow-up to security review 2 of #2375).
        const left = path === projects && entry.isDirectory() ? await leftInSharedFolder(child, folder!, paths) : named
        if (left) return left
      }
      if (entry.isDirectory()) { const found = await walk(child, named); if (found) return found }
    }
    return null
  }
  for (const [root, named] of [[claude, SWEEP_LEFT.claudeNamed], [codex, SWEEP_LEFT.codexNamed]]) { const found = await walk(root, named); if (found) return found }
  return null
}

/** A purge refused while the record is kept aside; the close that gets it does not say so again (inCore/agents.ts). */
export const PURGE_RECORD_UNREADABLE = 'PURGE_RECORD_UNREADABLE'
export const UNREADABLE_DETAIL = "This machine's record of purges still to finish could not be read and was kept aside, as the daemon's log says at "
  + "each start. The account stays held until its owner clears it as #2142's risk note says, by file names only."

/** The folder of an agent's own engine home `<homes>/<creation>/codex`, to delete whole; null for any other path. Either separator,
 *  as a Windows path has `\\` (Windows pass, task #2022), and never a path that climbs out. */
export function ownHomeFolder(homes: string, codexHome: string | null | undefined): string | null {
  if (!codexHome || !codexHome.startsWith(homes)) return null
  const [first, creation, name, ...rest] = codexHome.slice(homes.length).split(/[\\/]/)
  // pmEngineHome's own rule for the id: `.. ` passed a check for `..`, and Windows reads it as `..`, the whole Team home (#2568).
  if (first !== '' || !creation || !PM_START_ID.test(creation) || name !== 'codex' || rest.length) return null
  return codexHome.slice(0, homes.length + 1 + creation.length)
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
  /** The platform's paths; a test's `path.win32`. */
  paths?: FolderPaths
}): (agentId: string) => Promise<Record<string, unknown>> {
  return async agentId => {
    // With its record unreadable, which purges are still to finish is not known: none is answered, not even a 'skipped' for a
    // session already gone, so the close fails and the backend keeps the account held until a person clears the record. Its
    // path was logged once, when it was kept aside; this answer, logged on every retry, names neither it nor the agent.
    if (deps.record.unknown()) return { error: PURGE_RECORD_UNREADABLE, detail: UNREADABLE_DETAIL }
    const session = deps.session(agentId)
    let target = deps.record.get(agentId)
    if (!target) {
      // Team-written Codex work has an engine home of its own too (superTabs/start.ts): it goes with the agent, confidential or not.
      if (session && !deps.confidential(agentId)) {
        const own = ownHomeFolder(join(deps.home, PM_HOMES), session.codexHome)
        if (own) await rm(own, { recursive: true, force: true })
        return { skipped: true }
      }
      if (!session) return { skipped: true }
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
    if (target.codexHome && isPmCodexHome(deps.home, target.codexHome)) await rm(dirname(target.codexHome), { recursive: true, force: true })
    if (target.engine === 'claude') {
      const keep = (found: readonly string[]) => {
        const pastes = [...new Set([...target!.pastes ?? [], ...found])]
        if (pastes.length !== (target!.pastes ?? []).length) { target = { ...target!, pastes }; deps.record.put(target) }
      }
      keep(await scrubClaudeSession(deps.home, target, target.pastes, keep, undefined, deps.paths))
    }
    const left = await sweepForSession(deps.home, target, target.pastes ?? [], deps.paths)
    if (left) return { error: 'SCRUB_INCOMPLETE', detail: `Something still names the session: ${left}` }
    deps.record.drop(agentId)
    return { ok: true }
  }
}

/** How long a purge that did not finish waits for its next try, each try the next, and the last from then on. */
const PURGE_RETRY_MS = [1, 2, 5, 15, 30].map(minutes => minutes * 60_000)

/** What the owner's `harness team status` reads of the purges still to finish (team/privacy.ts). A count: the status file is
 *  the owner's to read, and never names a session of someone else's project. */
export interface PurgeStatus { pending: number; unreadable: boolean; at: number }

/**
 * Tries again what the record still holds (Echo and Reed on #2675): a host's close gives up after a few tries, and one that
 * ended nothing leaves no host trying at all, while the account stays held. At its start, so a restart picks up the record, and
 * after any purge that leaves one, on a growing wait until none is left. Through [purge] alone, with its reviewed delete and its
 * refusals: a session that came back is refused and stays recorded. A record that can't be read names nothing to run, and waits
 * for a person, as it always has. Calls for one agent share a run, so a retry and a host's close never scrub at once.
 */
export function withPurgeRetries(purge: (agentId: string) => Promise<Record<string, unknown>>, deps: {
  record: PurgeRecord
  report: (status: PurgeStatus) => void
  log: (line: string) => void
  now?: () => number
}): ((agentId: string) => Promise<Record<string, unknown>>) & { stop(): void } {
  const running = new Map<string, Promise<Record<string, unknown>>>()
  let timer: ReturnType<typeof setTimeout> | null = null, tries = 0, passing = false, stopped = false
  const run = (agentId: string) => {
    const known = running.get(agentId)
    if (known) return known
    const started = purge(agentId).finally(() => running.delete(agentId))
    running.set(agentId, started)
    return started
  }
  const settle = () => {
    if (!deps.record.pending().length) tries = 0
    try { deps.report({ pending: deps.record.pending().length, unreadable: deps.record.unknown(), at: (deps.now ?? Date.now)() }) }
    catch (error) { deps.log(`could not report the purges still to finish: ${kindOf(error)}`) }
    if (stopped || timer || passing || !deps.record.pending().length) return
    timer = setTimeout(() => void pass(), PURGE_RETRY_MS[Math.min(tries, PURGE_RETRY_MS.length - 1)]!)
    timer.unref?.()
  }
  const pass = async () => {
    timer = null
    passing = true
    for (const { agentId } of deps.record.pending()) {
      if (stopped) break
      // By its kind alone: a detail can name a path, and this goes in the daemon's log.
      const said = await run(agentId).catch((error: unknown) => ({ error: kindOf(error) }))
      if (typeof said.error === 'string') deps.log(`a purge did not finish, and is tried again: ${said.error}`)
    }
    passing = false
    tries++
    settle()
  }
  const retried = async (agentId: string) => {
    try { return await run(agentId) } finally { settle() }
  }
  settle()
  return Object.assign(retried, { stop: () => { stopped = true; if (timer) clearTimeout(timer); timer = null } })
}

const kindOf = (error: unknown): string => error instanceof Error
  ? typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code! : error.name
  : 'unknown failure'
