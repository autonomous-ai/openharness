import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { buddyAccountFile } from './buddyAccount.js'
import { PASTE_DROPS_DIR } from './pasteDropFiles.js'
import { env } from '../config/env.js'

/**
 * What is left of a Buddy's guard (task #2832). Until Ken's decision of 11-04 a Buddy ran read-only, behind a PreToolUse hook
 * that answered every tool call (security reviews of #1992, #2092, #2310). A Buddy is its owner's right hand now: on their own
 * machine it launches like their own session, in full mode (superTabs/start.ts), and the hook, its wide reads and their
 * "run:" approvals, the lists of files sent to it and the read-only folder are gone.
 *
 * What stays is the proof its owner is here: at each message its owner sends it in their own Buddy chat, signed in on this
 * machine, the host grants the Buddy session for this launch, for an hour (superTabs/host.ts). A relay to its owner's own
 * sessions holds only while that grant does (messages/service.ts, #2626). Each session's grant is kept in a list of its own in
 * Harness's data folder, which the Swarm's end of the session removes (`forgetBuddyReads`).
 */

/** Where a Buddy session's list is: its grant. */
export interface BuddyReads { file: string }

/** Where every Buddy session's list is kept: Harness's data folder, never a Buddy's own folder, where a commit or a pull
 *  could put one. */
const listsDir = () => join(env.ADAPTER_DATA_DIR, 'buddy-reads')

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Lists that nothing has written to for a day, of sessions ended or quiet, hold no grant still live: best-effort, at each
 *  write. A mark goes once its list has, and not before: its session's end still finds the list by it. A listed file lasts
 *  as long, as Harness keeps a download a day (lib/pasteDropFiles.ts). */
const KEPT_MS = 24 * 60 * 60 * 1000

/** The list for one Buddy session, by its Swarm skill's key. */
export function buddyReadsOf(key: string): BuddyReads {
  return { file: join(listsDir(), `${sha256(key)}.json`) }
}

/**
 * The mark beside [list] that [session] listed in it: an empty file, read by its name alone. The end of a session finds its
 * own lists by these even where a list cannot be read, and so leaves every other session's alone. Follow-up to #2248 (Lead,
 * 10-30): whose a list was that could not be read could not be told, so it held back the end of every Buddy on the machine.
 */
const markOf = (list: string, session: string) => `${list.replace(/\.json$/, '')}.${sha256(session)}.owner`
const MARK = /\.[0-9a-f]{64}\.owner$/

/** The grant: to this session, at this launch, for this account, at this time (delta reviews of #2310). */
interface Grant { session: string; account: string; launch: string; at: number }
/** `session`: the native session the host delivered to, whose list goes when the Swarm ends it (`forgetBuddyReads`). `files`
 *  and `links`: what its person sent it, for a Buddy still running the guard of a release before #2832 (`listSentToOldGuard`);
 *  kept through every write, as that guard reads them. An older list's approvals are not kept: nothing records them now. */
interface List { version: 1; session: string; wide?: Grant | false; files?: ListedFile[]; links?: ListedLink[] }
interface ListedFile { path: string; dev: string; ino: string; size: string; sha256: string; at: number }
interface ListedLink { url: string; at: number }

/** What [file] holds for [session]: nothing another session listed under the same key, nor anything unreadable. Listed files
 *  and links from the last day only, as long as Harness keeps a download. */
function heldList(file: string, session: string, now = Date.now()): List {
  const none: List = { version: 1, session }
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { session?: unknown; wide?: unknown; files?: unknown; links?: unknown }
    if (held.session !== session) return none
    const grant = held.wide === false ? false : held.wide && typeof held.wide === 'object' ? held.wide as Grant : undefined
    const fresh = (value: unknown) => (Array.isArray(value) ? value : []).filter((entry): entry is Record<string, unknown> => !!entry
      && typeof entry === 'object' && Number.isFinite(entry.at) && now - (entry.at as number) < KEPT_MS)
    const files = fresh(held.files).filter((entry): entry is Record<string, unknown> & ListedFile => ['path', 'dev', 'ino', 'size', 'sha256']
      .every(field => typeof entry[field] === 'string'))
    const links = fresh(held.links).filter((entry): entry is Record<string, unknown> & ListedLink => typeof entry.url === 'string')
    return { version: 1, session, ...(grant !== undefined ? { wide: grant } : {}),
      ...(files.length ? { files: files.map(({ path, dev, ino, size, sha256, at }) => ({ path, dev, ino, size, sha256, at })) } : {}),
      ...(links.length ? { links: links.map(({ url, at }) => ({ url, at })) } : {}) }
  } catch { return none }
}

function sweep(dir: string, now: number): void {
  try {
    const names = readdirSync(dir), present = new Set(names)
    for (const name of names) {
      try {
        if (MARK.test(name)) { if (!present.has(name.replace(MARK, '.json'))) rmSync(join(dir, name), { force: true }) }
        else if ((name.endsWith('.json') || name.endsWith('.tmp')) && now - statSync(join(dir, name)).mtimeMs >= KEPT_MS) rmSync(join(dir, name), { force: true })
      } catch { /* raced: ignore */ }
    }
  } catch { /* unreadable: nothing to sweep */ }
}

/** A claude.ai Artifact link, or null. */
function artifactLink(text: string): string | null {
  let url: URL
  try { url = new URL(text) } catch { return null }
  const path = /^\/((?:code\/)?artifact\/[A-Za-z0-9_-]{1,100})\/?$/.exec(url.pathname)
  if (!path || url.protocol !== 'https:' || !['claude.ai', 'preview.claude.ai'].includes(url.hostname) || url.port || url.username
    || url.password || url.search || url.hash) return null
  return `https://${url.hostname}/${path[1]}`
}

/** The claude.ai Artifact links in a message's text, each as the artifact's own link: a query or fragment the person's
 *  link carried is dropped, so the Buddy is told the artifact's one link (superTabs/host.ts). */
export function artifactLinks(text: string): string[] {
  const found = new Set<string>()
  for (const [candidate] of text.matchAll(/https:\/\/[^\s<>()[\]{}"'`]+/gi)) {
    let url: URL
    try { url = new URL(candidate.replace(/[.,;:!?]+$/, '')) } catch { continue }
    url.search = ''; url.hash = ''
    const link = artifactLink(url.href)
    if (link) found.add(link)
  }
  return [...found].slice(0, 50)
}

/**
 * Writes [list] as [session]'s: every writer of a session's list comes here (security reviews of #2261, folded into #2310,
 * Lead 10-30). Its mark first, so a list that cannot be read still holds back its own session's end and no other
 * (`forgetBuddyReads`): created only as a file of its own, never through a link, and one already there must be a plain
 * file. Other sessions' marks beside the list go, as the list is no longer theirs. Then the list, as one rename. Throws
 * when it cannot, so the host tries the delivery again.
 */
function writeList(file: string, session: string, list: List): void {
  const dir = dirname(file), own = markOf(file, session)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let fd: number | undefined
  try { fd = openSync(own, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !lstatSync(own).isFile()) throw error
  } finally { if (fd !== undefined) closeSync(fd) }
  const prefix = `${basename(file).replace(/\.json$/, '')}.`
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix) && MARK.test(name) && name.length === prefix.length + 70 && join(dir, name) !== own) rmSync(join(dir, name), { force: true })
  }
  writeWhole(file, list)
}

/** Writes [value] to [file] as one rename, mode 600: a reader sees a whole old file or a whole new one, never a part. */
function writeWhole(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Whether the Buddy folder [root] is still locked by the guard of a release before #2832: its guard script, and the local
 * settings that run it, naming it by this folder's own path, which no commit can know (security review 2 of #2832). A Buddy
 * launched then keeps running that guard until it starts again (lib/swarmSkills.ts removes the lock at its next launch).
 */
export function heldByOldGuard(root: string): boolean {
  const guard = join(root, '.claude', 'buddy-guard.mjs'), settings = join(root, '.claude', 'settings.local.json')
  try {
    const plain = (path: string) => { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() }
    return plain(guard) && plain(settings) && readFileSync(settings, 'utf8').includes(guard)
  } catch { return false }
}

/** At most as many entries as the guard before #2832 kept: ten messages' worth of files, and as many links. */
const MAX_FILES = 100, MAX_LINKS = 50
/** A download's limit (superTabs/attachments.ts): no larger file is listed. */
const MAX_BYTES = 256 * 1024 * 1024

/** [path] as a listed file: one regular file with no other name, at most a download's size, by its device, inode, size and
 *  the SHA-256 of its bytes, all read from the one file opened (never through a link); null for anything else. What the
 *  guard before #2832 checks again when the Buddy opens it (security reviews 1 and 2 of #2248). */
function listedFile(path: string, at: number): ListedFile | null {
  let fd: number | undefined
  try {
    const named = lstatSync(path, { bigint: true })
    if (!named.isFile() || named.nlink !== 1n || named.size > MAX_BYTES) return null
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== named.dev || stat.ino !== named.ino || stat.size > MAX_BYTES) return null
    // No more than the size it opened at: a file still being written to is not read on.
    const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024)
    let total = 0n
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      total += BigInt(read)
      if (total > stat.size) return null
      hash.update(chunk.subarray(0, read))
    }
    return { path, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), sha256: hash.digest('hex'), at }
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * Lists for a Buddy session still running the guard of a release before #2832 (`heldByOldGuard`) the files and Artifact
 * links its own person sent it in their own Buddy chat, as that release's host did (task #3159: once #2832 stopped listing,
 * that guard refused every screenshot Scholes sent his Buddy). The host decides whose a message is (superTabs/host.ts); this
 * lists only files Harness downloaded into paste-drops, each by its exact path, device, inode, size and SHA-256, which the
 * guard checks again when the Buddy opens it. Throws when it cannot write, so the host tries the delivery again.
 * Remove after 2026-12-04, with the older saved mode in engines/claude/launch.ts, once every such Buddy has started again.
 */
export function listSentToOldGuard(reads: BuddyReads, sent: { session: string; files: readonly string[]; links: readonly string[] },
  now = Date.now(), drops: string = PASTE_DROPS_DIR): void {
  const files = sent.files.flatMap(path => {
    const file = dirname(path) === drops ? listedFile(path, now) : null
    return file ? [file] : []
  })
  const links = sent.links.flatMap((url): ListedLink[] => artifactLink(url) === url ? [{ url, at: now }] : [])
  if (!files.length && !links.length) return
  mkdirSync(dirname(reads.file), { recursive: true, mode: 0o700 })
  sweep(dirname(reads.file), now)
  const held = heldList(reads.file, sent.session, now)
  writeList(reads.file, sent.session, { ...held,
    files: [...(held.files ?? []).filter(entry => !files.some(file => file.path === entry.path)), ...files].slice(-MAX_FILES),
    links: [...(held.links ?? []).filter(entry => !links.some(link => link.url === entry.url)), ...links].slice(-MAX_LINKS) })
}

/**
 * Grants a Buddy session its owner's presence, or takes it back ([wide]), in its list ([reads]). The
 * host decides at each of its person's own messages: theirs, in their own Buddy chat, on their own machine, and the account
 * signed in on this machine (superTabs/host.ts). Throws when it cannot write, so the host tries the delivery again.
 */
export function grantBuddyWide(reads: BuddyReads, input: { session: string; wide: false } | { session: string; wide: true; account: string; launch: string },
  now = Date.now()): void {
  const wide: Grant | false = input.wide ? { session: input.session, account: input.account, launch: input.launch, at: now } : false
  mkdirSync(dirname(reads.file), { recursive: true, mode: 0o700 })
  sweep(dirname(reads.file), now)
  writeList(reads.file, input.session, { ...heldList(reads.file, input.session, now), wide })
}

/** How long a grant holds after its person's last message. */
export const BUDDY_GRANT_MS = 60 * 60 * 1000

/**
 * Whether the Buddy session whose list is [reads], launched in [folder], holds its person's grant now (messages/service.ts,
 * #2626). The host wrote it at its person's last message, theirs,
 * in their own Buddy chat, signed in on this machine; it holds for this launch, the account signed in here now, and an
 * hour. A list, launch file or account file that cannot be read is no grant.
 */
export function buddyGrantLive(reads: BuddyReads, folder: string, now = Date.now(), accountFile: string = buddyAccountFile()): boolean {
  try {
    const list = JSON.parse(readFileSync(reads.file, 'utf8')) as { session?: unknown; wide?: unknown }
    const grant = list.wide as Partial<Grant> | false | undefined
    const launch = buddyLaunchOf(folder)
    if (!grant || typeof grant !== 'object' || typeof list.session !== 'string' || grant.session !== list.session || !launch || grant.launch !== launch) return false
    const account = (JSON.parse(readFileSync(accountFile, 'utf8')) as { accountId?: unknown }).accountId
    const age = now - Number(grant.at)
    return typeof account === 'string' && account.length > 0 && grant.account === account && Number.isFinite(age) && age > -60_000 && age < BUDDY_GRANT_MS
  } catch { return false }
}

/** Takes back the grant in [reads]'s list, whoever's session it names: at each launch (delta reviews of #2310). */
export function revokeBuddyWide(reads: BuddyReads): void {
  let session: unknown
  try { session = (JSON.parse(readFileSync(reads.file, 'utf8')) as { session?: unknown }).session } catch { return }
  if (typeof session === 'string') writeList(reads.file, session, { ...heldList(reads.file, session), wide: false })
}

export { buddyAccountFile, writeBuddyAccount } from './buddyAccount.js'

/** Where a Buddy's launch keeps its launch id in its folder, and what it says there now. */
export const buddyLaunchFile = (folder: string): string => join(folder, '.claude', 'buddy-launch')
export function buddyLaunchOf(folder: string): string | null {
  try { return readFileSync(buddyLaunchFile(folder), 'utf8').trim() || null } catch { return null }
}

/**
 * Deletes the lists of [session], once the Swarm has ended it: its Buddy removed, its person gone from the Swarm, or its
 * chat purged with its project (Lead, 10-30). A session no longer running here is found too. Its own lists are those its
 * mark is beside (`markOf`), unless another session has listed under the same key since, and, beside no mark of its own,
 * those that name it (a list written before lists were marked). Nothing else is touched or holds its end back: another
 * session's list, or one that names no session beside no mark, which the host never writes and the day's sweep removes.
 * Follow-up to #2248 (Lead, 10-30): one list that could not be read held back the end of every Buddy on the machine. So
 * a list is read only for the session it names: one that cannot be read names none. Its own is removed unread, by its
 * mark; another session's is skipped, and is that session's to remove.
 *
 * What it cannot finish throws, so the host tries again and does not acknowledge the end meanwhile (re-check 2 of #2248):
 * an own list it cannot delete (a folder it cannot write to), which it empties in place where it can, needing only the
 * file, so it grants nothing meanwhile, keeping that list's mark and its session so the next try finds it; and a
 * mark it cannot delete. A list that went between the folder's read and its own counts as gone.
 *
 * It fails by fixed codes alone (`SentListsError`), never with the error it caught: the host logs what it failed with, and
 * a filesystem error's message names its path, in the person's home (follow-up to #2389's security re-check 2).
 */
export function forgetBuddyReads(session: string, dir = listsDir()): void {
  let names: string[]
  try { names = readdirSync(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new SentListsError(['SENT_LISTS_UNREAD'])
  }
  const own = `.${sha256(session)}.owner`
  const marked = new Set(names.filter(name => name.endsWith(own)).map(name => `${name.slice(0, -own.length)}.json`))
  const kept = new Set<string>()
  const failed = new Set<SentListsFailure>()
  // Only a list's own name: a .tmp is a write not yet renamed, which no guard reads.
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    let text: string | undefined, unreadable = false
    try { text = readFileSync(file, 'utf8') } catch (error) { unreadable = (error as NodeJS.ErrnoException).code !== 'ENOENT' }
    let named: unknown
    try { named = text === undefined ? undefined : (JSON.parse(text) as { session?: unknown } | null)?.session } catch { /* not JSON: it names no session */ }
    if (!marked.has(name)) {
      // Not its own by mark. One it cannot read is another session's to remove when that session's mark is beside it, and
      // otherwise whose it is cannot be told: kept, and the end fails so it is tried again, as before marks (review of #2261).
      if (unreadable) {
        const base = `${name.slice(0, -'.json'.length)}.`
        if (!names.some(other => other.startsWith(base) && MARK.test(other))) failed.add('SENT_LIST_UNREAD')
        continue
      }
      if (named !== session) continue
    } else if (typeof named === 'string' && named !== session) continue
    try { rmSync(file, { force: true }) } catch {
      const empty: List = { version: 1, session }
      try { writeFileSync(file, `${JSON.stringify(empty)}\n`) } catch { /* neither: the host's next try is all that is left */ }
      kept.add(name)
      failed.add('SENT_LIST_KEPT')
    }
  }
  for (const name of names) {
    if (!name.endsWith(own) || kept.has(`${name.slice(0, -own.length)}.json`)) continue
    try { rmSync(join(dir, name), { force: true }) } catch { failed.add('SENT_LIST_MARK_KEPT') }
  }
  if (failed.size) throw new SentListsError(SENT_LISTS_FAILURES.filter(code => failed.has(code)))
}

/** What kept an ended session's lists from all going, in the order they are named: its lists folder could not be read; a list
 *  whose session could not be told could not be read, and was kept; one of its own lists could not be deleted, and was emptied
 *  where it could be; or the mark beside one could not be deleted. */
const SENT_LISTS_FAILURES = ['SENT_LISTS_UNREAD', 'SENT_LIST_UNREAD', 'SENT_LIST_KEPT', 'SENT_LIST_MARK_KEPT'] as const
export type SentListsFailure = typeof SENT_LISTS_FAILURES[number]

/** `forgetBuddyReads`'s failure: its codes, each once, and nothing of the errors behind them, whose messages name paths. */
export class SentListsError extends Error {
  constructor(readonly codes: readonly SentListsFailure[]) {
    super(codes.join(', '))
    this.name = 'SentListsError'
  }
}

/**
 * Whose a Buddy's folder is, as the start that made it found (security review 2 of #2832). A Buddy runs with its owner's full
 * rights, and a relaunch (a restart, a model switch, a move) never passes the start's own-machine check (superTabs/start.ts
 * buddyOnOwnMachine). So that start records here, by the folder's name (its worktree named for the start, or its folder of
 * project copies), the owner it checked, before anything launches; every launch of a Buddy then requires that record
 * (lib/swarmSkills.ts). A Buddy saved before this record existed has none, and waits for its owner to start it again.
 * In Harness's data folder, never the Buddy's own folder, which it can write. One small file per Buddy start, removed with
 * the data folder; a start's folder name is never reused.
 */
export const buddyOwnerFile = (dataDir: string, leaf: string): string =>
  join(dataDir, 'buddy-owners', createHash('sha256').update(leaf).digest('hex').slice(0, 32))
export function markBuddyOwner(leaf: string, personId: string, dataDir: string = env.ADAPTER_DATA_DIR): void {
  const file = buddyOwnerFile(dataDir, leaf)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify({ personId })}\n`, { mode: 0o600 })
}
/** The owner recorded for the Buddy folder [root]: by its name, or its name before a -2, -3 a taken one got
 *  (lib/gitProject.ts). Null when none was recorded or it cannot be read. */
export function buddyOwnerOf(root: string, dataDir: string = env.ADAPTER_DATA_DIR): string | null {
  const name = basename(root)
  for (const leaf of new Set([name, name.replace(/-\d+$/, '')])) {
    try {
      const personId = (JSON.parse(readFileSync(buddyOwnerFile(dataDir, leaf), 'utf8')) as { personId?: unknown }).personId
      if (typeof personId === 'string' && personId) return personId
    } catch { /* none for this name */ }
  }
  return null
}
/** The account the host last read as signed in here (lib/buddyAccount.ts), or null before it has read one. */
export function signedInAccount(file: string = buddyAccountFile()): string | null {
  try {
    const accountId = (JSON.parse(readFileSync(file, 'utf8')) as { accountId?: unknown }).accountId
    return typeof accountId === 'string' && accountId ? accountId : null
  } catch { return null }
}
