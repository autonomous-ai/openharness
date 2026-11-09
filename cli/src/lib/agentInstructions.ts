/**
 * An agent's instructions file: `agents/<name>.md`, in the folder the agent works in, on the computer it runs on.
 *
 * The owner reads and saves it from their other computers through the daemon here, which holds the one copy. It goes
 * through neither GitHub nor our servers: some people do not want what they tell an agent in git or on a server. So
 * this reads and writes a person's own words, on a request a relay carries (sealed, never logged: services/projects.ts):
 *
 *  - The request chooses only the name, and a name is one file name that any computer of the account can keep
 *    (`fileNameOf`): the file is always `<folder>/agents/<name>.md`.
 *  - Never through a link. `agents` and the file are the two places a request can lead out of the project by,
 *    and a checkout can carry either one as a link (git keeps links): a save through it would replace a file that is
 *    not the person's instructions, a read would show one. Both are checked with `lstat` and neither is followed,
 *    and the file is opened with O_NOFOLLOW besides. The agent's own folder is the registry's and may sit behind links
 *    itself (`/tmp` on a Mac), so it is never resolved.
 *  - Bounded: at most 64 KiB read or written, whatever the file or the request holds.
 *  - Whole text: a file that is not UTF-8 is not read or saved over (`NOT_UTF8`), as showing it would turn its bytes
 *    into replacement characters and saving that would change the person's file. The same for text with an unpaired
 *    surrogate, which a write turns into U+FFFD: it would not be what was sent, and its version would not be of it.
 *  - The version is the SHA-256 of the file's bytes, and a save names the one the writer saw: over any other file
 *    it is refused (`CHANGED`) rather than overwrite what the writer never read. `''` is "no file". The check and the
 *    replace are two steps, so saves of one file take turns in this process (`takingTurns`): two that saw the same
 *    version would both pass the check, and the later rename would win unseen.
 *  - The `agents` folder is made when a save goes ahead, not before: a refused save leaves no empty folder behind.
 *  - A save is a new file renamed over the old one, so a full disk or a crash leaves the old file or the new one,
 *    never half of either; a file the person made private keeps its mode.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, parse, relative, sep } from 'node:path'

/** The most a file may hold, read or written: far more than instructions need, and the most a request can make the
 *  daemon hold in memory. */
const INSTRUCTIONS_MAX_BYTES = 64 * 1024

/** A refusal the apps read by its code. Anything else thrown here is the disk's: not something the person can fix by
 *  changing the request. */
export class InstructionsError extends Error {
  constructor(readonly code: 'BAD_NAME' | 'BAD_TEXT' | 'TOO_LARGE' | 'UNSAFE_PATH' | 'NOT_UTF8' | 'CHANGED') { super(code); this.name = 'InstructionsError' }
}

/** Strict, and keeping a byte-order mark as the character it is: the text read is then exactly what saving it writes. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const versionOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** What Windows keeps for devices, not files: CON, PRN, AUX, NUL, COM and LPT with a digit (the superscript ones too),
 *  in any case, and with or without an extension (`NUL.txt` is NUL). */
const DEVICE_NAME = /^(?:con|prn|aux|nul|(?:com|lpt)[0-9\xb9\xb2\xb3])(?:\.|$)/i

/** The file's name for what the person calls the agent, trimmed. The file is the same agent's wherever it runs, so a
 *  name that one computer of the account cannot keep as a file would make it two things: Windows refuses `< > : " | ? *`
 *  (`:` also opens a hidden stream), a name ending in a dot, and the device names above. A separator or a leading dot is
 *  how a name leaves `agents/` (`../x`, `.git`), and a control character is something no file name needs and a log or a
 *  terminal obeys. Names of CJK and emoji are 3 and 4 bytes a character and a file name holds 255: at most 200 with `.md`. */
function fileNameOf(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  const fileName = `${trimmed}.md`
  if (!trimmed || trimmed.length > 100 || Buffer.byteLength(fileName) > 200 || trimmed.startsWith('.') || trimmed.endsWith('.')
    || /[\\/<>:"|?*]|\p{Cc}/u.test(trimmed) || DEVICE_NAME.test(trimmed)) throw new InstructionsError('BAD_NAME')
  return fileName
}

/** What is at `path`, not following it, or null where there is nothing (or nothing can be: below a file). */
async function entry(path: string): Promise<Stats | null> {
  try { return await lstat(path) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/** What is at [path] when it is a plain file, or null where there is nothing. From lstat, so a link is not a file here, and
 *  nor is a folder or a named pipe, which would hold an open for ever. */
async function plainFile(path: string): Promise<Stats | null> {
  const info = await entry(path)
  if (info && !info.isFile()) throw new InstructionsError('UNSAFE_PATH')
  return info
}

/** What is at the file, after checking that each of `agents` and the file is a plain folder or file, or is not there. */
async function locate(dir: string, file: string): Promise<Stats | null> {
  const folder = await entry(dir)
  if (folder && !folder.isDirectory()) throw new InstructionsError('UNSAFE_PATH')
  return plainFile(file)
}

/** The file's bytes, to one past the limit at most: never the file whole, and the one byte over says there was more. [looked]
 *  is the file as it was looked at, where it is not enough that the handle is a plain file: it must be that file. */
async function readPrefix(file: string, looked?: Stats): Promise<Buffer> {
  // The check of the file and this open are two steps: a file swapped for a named pipe between them would hold the open for
  // ever. NONBLOCK opens a pipe at once, and the handle is looked at again, as a pipe would otherwise read as an empty file.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const found = await handle.stat()
    if (!found.isFile() || (looked && (found.ino !== looked.ino || found.dev !== looked.dev))) throw new InstructionsError('UNSAFE_PATH')
    const bytes = Buffer.alloc(INSTRUCTIONS_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    return bytes.subarray(0, length)
  } finally { await handle.close() }
}

/** The file's bytes: a file over the limit is refused. */
async function readBytes(file: string): Promise<Buffer> {
  const bytes = await readPrefix(file)
  if (bytes.length > INSTRUCTIONS_MAX_BYTES) throw new InstructionsError('TOO_LARGE')
  return bytes
}

/** The file's text and version: only of a file that is UTF-8. */
async function readText(file: string): Promise<{ text: string; version: string }> {
  const bytes = await readBytes(file)
  try { return { text: utf8.decode(bytes), version: versionOf(bytes) } } catch { throw new InstructionsError('NOT_UTF8') }
}

/** The saves in turn for each file that has one going, by its path as the request spells it. A failed save does not hold
 *  up the next, and a file is gone from here once nothing is waiting on it. */
const saves = new Map<string, Promise<void>>()

/** [save], once every save of [file] asked for before it has finished. */
async function takingTurns<T>(file: string, save: () => Promise<T>): Promise<T> {
  const turn = (saves.get(file) ?? Promise.resolve()).then(save)
  const tail = turn.then(() => {}, () => {})
  saves.set(file, tail)
  try { return await turn } finally { if (saves.get(file) === tail) saves.delete(file) }
}

/** The file's text and version, or `{ text: null, version: '' }` when there is no file. */
export async function readInstructions(cwd: string, name: unknown): Promise<{ text: string | null; version: string }> {
  const dir = join(cwd, 'agents'), file = join(dir, fileNameOf(name))
  if (!await locate(dir, file)) return { text: null, version: '' }
  return readText(file)
}

/** What else instructs an agent, besides a file of its own: the files its engines really load. Claude Code reads CLAUDE.md,
 *  .claude/CLAUDE.md and CLAUDE.local.md in the agent's folder and in every folder above it. Codex reads, in each folder from the
 *  project's root (the nearest with a `.git`, or the agent's folder where there is none) down to the agent's, AGENTS.override.md or
 *  else AGENTS.md: one file in each, and not an empty one. What an engine loads is its own to change, so this is the one place
 *  that says it. */
const CLAUDE_LOADS = ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']
const CODEX_LOADS = ['AGENTS.override.md', 'AGENTS.md']
/** What is looked for in each folder, the two files a reader has always had in the agent's folder first. */
const SHARED_FILES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']
/** How many folders above the agent's are looked in: at most 6 folders and 30 files. */
const PARENTS = 5
/** The most text of these files that one read carries, so that the reply stays small whatever the folders hold: once that much is
 *  read, the files after it are there and not shown. The last one read can go over it by a file's 64 KiB. */
const SHARED_MAX_BYTES = 256 * 1024

type Engine = 'claude' | 'codex'

/** A file as the apps are told of it: its name, where it is (from the agent's folder, with `/`), and which engines load it. */
interface Located { name: string; path: string; loadedBy: Engine[] }
interface SharedInstructions extends Located { text: string; truncated: boolean }

/** One of those files, there and not shown, and why in the words the apps read: a link that leaves the project or leads to
 *  nothing, a file that is not text, a file this user may not open or the disk fails on, or what is not a plain file (a folder, a
 *  named pipe), or because the files before it have used up what one read carries (SHARED_MAX_BYTES). [error] is what went wrong
 *  where the caller may log it, for a file that is not text and for the disk's failures, and is not there for what is as the
 *  person made it. */
interface SkippedInstructions extends Located { why: 'link' | 'not_text' | 'unreadable' | 'not_a_file' | 'too_much'; error?: unknown }

/** What reading one file came to: its text, or why it is not shown. */
type Read = { text: string; truncated: boolean } | { why: SkippedInstructions['why']; error?: unknown }

/** The agent's folder and the [PARENTS] above it, nearest first and never the root of the disk, and the project's root among
 *  them: the nearest folder with a `.git` (a folder, or the file of a worktree), or null where there is none. */
async function foldersOf(cwd: string): Promise<{ dirs: string[]; root: string | null }> {
  const dirs = [cwd]
  while (dirs.length <= PARENTS) {
    const up = dirname(dirs[dirs.length - 1])
    if (up === parse(up).root) break
    dirs.push(up)
  }
  for (const dir of dirs) if (await lstat(join(dir, '.git')).then(() => true, () => false)) return { dirs, root: dir }
  return { dirs, root: null }
}

/** The real path of [path] where it leads somewhere, or null where it does not (a link to nowhere, a loop). */
const realOrNull = (path: string): Promise<string | null> => realpath(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') return null
  throw error
})

/** One file as it is shown (its text, to the limit, and whether there was more), or why it is not, or null where there is none.
 *  It does not throw: a file that cannot be shown is a reason, not a failure of the read. [dir] is a real path, so a link on the
 *  way can only be the file itself or the folder in [rel] (`.claude`), and lstat says which: a path with none is read as it is,
 *  wherever it is. One through a link is followed only from a folder inside the project ([root], real) to a plain file inside it,
 *  and what it leads to is read where it is, as the file that was looked at. A file there when [room] is false is not read. */
async function readFile(root: string, dir: string, rel: string, room: boolean): Promise<Read | null> {
  const file = join(dir, rel)
  try {
    const info = await entry(file)
    if (!info) return null
    if (!room) return { why: 'too_much' }
    const folder = rel.includes('/') ? await entry(join(dir, dirname(rel))) : null
    let path = file
    if (info.isSymbolicLink() || folder?.isSymbolicLink()) {
      const real = await realOrNull(file)
      const inside = (at: string) => at.startsWith(root + sep)
      if (!real || !(dir === root || inside(dir)) || !inside(real)) return { why: 'link' }
      path = real
    }
    const target = path === file ? info : await entry(path)
    if (!target?.isFile()) return { why: 'not_a_file' }
    const bytes = await readPrefix(path, path === file ? undefined : target)
    const truncated = bytes.length > INSTRUCTIONS_MAX_BYTES
    try {
      // A file cut at the limit may end inside a character. Decoding as a stream holds an unfinished one back, so the text
      // stops at the last whole character; a file that is whole and ends inside one is not text.
      const text = truncated ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, INSTRUCTIONS_MAX_BYTES), { stream: true })
        : utf8.decode(bytes)
      return { text, truncated }
    } catch { throw new InstructionsError('NOT_UTF8') }
  } catch (error) {
    const code = error instanceof InstructionsError ? error.code : undefined
    // Swapped for a named pipe between the check and the open: not a plain file, as it was said above.
    if (code === 'UNSAFE_PATH') return { why: 'not_a_file' }
    return { why: code === 'NOT_UTF8' ? 'not_text' : 'unreadable', error }
  }
}

/** The files that instruct the agent besides its own, for a person to read beside it and never to change: what its engines
 *  really load (see CLAUDE_LOADS), in the agent's folder and in up to [PARENTS] folders above it, never the root of the disk, and
 *  always the AGENTS.md and CLAUDE.md of its folder. Each comes with where it is and which engines load it; a file no engine loads
 *  where it is (AGENTS.md above the project's root) is not read. Never through a link that leaves the project, and through none
 *  above its root. Each is read to the limit, with `truncated` saying it was cut, at a whole character, and no more than
 *  SHARED_MAX_BYTES of them in all. No file is an error of the whole: one that is there and is not shown comes back in `skipped`,
 *  with why. */
export async function readSharedInstructions(cwd: string): Promise<{ shared: SharedInstructions[]; skipped: SkippedInstructions[] }> {
  // The engines look up from the folder they run in as the system gives it to them, its real path: so this does too. A folder that
  // is not there has nothing to show; one the disk cannot resolve (a loop) is looked in by its own name only, so that each file it
  // would hold is told as unreadable.
  const real = await realpath(cwd).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : undefined)
  if (real === null) return { shared: [], skipped: [] }
  const base = real ?? cwd
  const { dirs, root } = real ? await foldersOf(base) : { dirs: [base], root: null }
  const codexDirs = root ? dirs.slice(0, dirs.indexOf(root) + 1) : [base]
  const found: Array<Located & { dir: string; rel: string; read: Read }> = []
  let spent = 0
  for (const dir of dirs) {
    for (const rel of SHARED_FILES) {
      const loadedBy: Engine[] = [...(CLAUDE_LOADS.includes(rel) ? ['claude' as const] : []), ...(CODEX_LOADS.includes(rel) && codexDirs.includes(dir) ? ['codex' as const] : [])]
      if (!loadedBy.length) continue
      const read = await readFile(root ?? base, dir, rel, spent < SHARED_MAX_BYTES)
      if (read && 'text' in read) spent += Buffer.byteLength(read.text)
      if (read) found.push({ dir, rel, name: basename(rel), path: relative(base, join(dir, rel)).split(sep).join('/'), loadedBy, read })
    }
  }
  // Codex takes one file of a folder: AGENTS.override.md when there is anything in it, else AGENTS.md; an empty one is not loaded.
  // An override that is there and not shown for another reason (a link, not text) is still the one it takes; one the disk could
  // not look at is not known to be there.
  const blank = (one?: { read: Read }) => !!one && 'text' in one.read && one.read.text.trim() === ''
  const wins = (one?: { read: Read }) => !!one && ('text' in one.read ? !blank(one) : one.read.why !== 'unreadable')
  const drop = (one?: { loadedBy: Engine[] }) => { if (one) one.loadedBy = one.loadedBy.filter((engine) => engine !== 'codex') }
  for (const dir of codexDirs) {
    const override = found.find((one) => one.dir === dir && one.rel === 'AGENTS.override.md')
    const plain = found.find((one) => one.dir === dir && one.rel === 'AGENTS.md')
    if (blank(override)) drop(override)
    if (blank(plain) || wins(override)) drop(plain)
  }
  const shared: SharedInstructions[] = [], skipped: SkippedInstructions[] = []
  for (const { name, path, loadedBy, read } of found) {
    if ('text' in read) shared.push({ name, path, loadedBy, ...read })
    else skipped.push({ name, path, loadedBy, ...read })
  }
  return { shared, skipped }
}

/** Saves [text] as the file, making `agents/` when it is missing, if the file is as the writer saw it: [seen] is the
 *  version it read, or `''` for no file. Gives the new version. */
export async function writeInstructions(cwd: string, name: unknown, text: unknown, seen: unknown): Promise<{ version: string }> {
  const fileName = fileNameOf(name)
  // `\p{Cs}` under the `u` flag is exactly an unpaired surrogate (a pair is one character): `isWellFormed` is not in the
  // ES2023 library this is built against.
  if (typeof text !== 'string' || /\p{Cs}/u.test(text)) throw new InstructionsError('BAD_TEXT')
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > INSTRUCTIONS_MAX_BYTES) throw new InstructionsError('TOO_LARGE')
  const dir = join(cwd, 'agents'), file = join(dir, fileName)
  return takingTurns(file, async () => {
    const before = await locate(dir, file)
    if (seen !== (before ? (await readText(file)).version : '')) throw new InstructionsError('CHANGED')
    // Only now that the save goes ahead, so a refused one leaves no folder. Not recursive: a project that has moved away
    // is not made again, with an agents folder in it. Checked again once it is there, as a link may have taken its place.
    await mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const info = await locate(dir, file)
    const temporary = join(dir, `.${randomUUID()}.tmp`)
    try {
      // `wx` makes a new file or fails, and never follows a link. The old file's mode, never looser than it was.
      const handle = await open(temporary, 'wx', info ? info.mode & 0o777 : 0o666)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await rename(temporary, file)
    } finally { await rm(temporary, { force: true }) }
    return { version: versionOf(bytes) }
  })
}
