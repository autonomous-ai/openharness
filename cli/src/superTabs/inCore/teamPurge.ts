/**
 * What Claude Code keeps of a Buddy's session in the shared home, scrubbed when its host ends it (host.ts endSession): its
 * prompt history lines and pastes, its transcripts, its file history, todos, session environment and debug log, and its
 * folder in the config and its backups. Only what records its own folder: another folder's transcripts, which share its
 * transcript folder when '/' and '.' both become '-', stay. Everything here reads and writes asynchronously: a home holds
 * gigabytes of transcripts, and this runs in the core's process.
 */
import { buddyTmpFolder, realOfFolder } from '../../lib/agentTmp.js'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import nodePath, { join, type PlatformPath } from 'node:path'
import { createInterface } from 'node:readline'

/** What a scrub needs of a session, as the host's journal keeps it until the scrub finishes (host.ts endSession). */
export interface PurgeTarget {
  agentId: string
  sessionId: string | null
  cwd: string | null
  engine: string
  codexHome: string | null
}

/** What a scrub tells its caller: another folder's transcripts share its transcript folder, or what it could not read and
 *  left, by kind alone. */
export type ScrubTold = 'shared' | 'unread' | 'unreadTodos' | 'unreadBackups'
/** [dir]'s names; null when it is there but cannot be listed. Only a folder that is not there is empty: read as empty, an
 *  unlistable todos or backups folder let a Buddy's cleanup finish and leave its todo file and its folder in the backups
 *  (re-check of 8c0b019). The error itself is dropped, as its message names the path. */
const listed = (dir: string) => readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] as string[] : null)

/** Claude Code's folder name for a project folder: every character but a letter or digit made a dash. */
const claudeSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const SESSION = /^[A-Za-z0-9_-]{1,160}$/
/** What a scrub asks of a platform's paths: the host's, or `path.win32` in a test. */
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
 * system call wide, is lost to that other agent.
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
 * and 2 of #2385: a Bash append, a subagent, a transcript Claude Code pruned, `Notes.md` on a Mac). A transcript that records
 * no folder, or both, stays too.
 */
async function removeTranscripts(dir: string, folder: string, paths: FolderPaths, told?: (what: ScrubTold) => void): Promise<void> {
  // Only a folder that is not there is empty. One that cannot be listed stays whole, and its caller is told, by that word
  // alone: read as empty it went whole, its error's path into the log, or another folder's transcripts unread on a passing
  // error such as too many open files (security reviews 1 and 2 of 58b035e). A Buddy's cleanup then fails and is tried again
  // (host.ts endSession).
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
 * Removes from the shared Claude Code home ([home]/.claude, [home]/.claude.json and its backups) what Claude Code keeps of the
 * session: its prompt history lines and the pastes they kept, its project folder with its transcripts and memory (only the
 * transcripts that record its folder alone when another folder's share it, and [told] 'shared'; [told] 'unread' when its
 * transcript folder or one of its transcripts could not be read, and stays), its file history, todos, session environment
 * and debug log, and its folder's entry and repository paths in the config and in every backup of it ([told] 'unreadTodos'
 * or 'unreadBackups' when that folder could not be listed).
 */
export async function scrubClaudeSession(home: string, target: PurgeTarget, told?: (what: ScrubTold) => void, paths: FolderPaths = nodePath): Promise<void> {
  const sessionId = target.sessionId && SESSION.test(target.sessionId) ? target.sessionId : null
  const folder = folderOf(target, paths)
  const key = folder && folderKey(folder, paths)
  if (!sessionId && !folder) return
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
  const found: string[] = []
  await rewriteIfUnchanged(history, text => {
    const { kept, named } = split(text)
    found.push(...named)
    return kept.length ? `${kept.join('\n')}\n` : ''
  })
  // Only names its history line gave that are no path: `split` takes no other.
  for (const hash of new Set(found)) await rm(join(claude, 'paste-cache', `${hash}.txt`), { force: true })
  if (folder) for (const name of await transcriptFolders(join(claude, 'projects'), folder, paths)) await removeTranscripts(join(claude, 'projects', name), folder, paths, told)
  // Its private temporary folder: command output from its person's private work (lib/agentTmp.ts). A plain session shares its
  // Buddy's folder, and this one's TMPDIR with it, so the whole folder goes only once that folder has (review of #2563).
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
}

