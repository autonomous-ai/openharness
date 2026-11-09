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
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

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

/** The file's bytes, to one past the limit at most: never the file whole, and the one byte over says there was more. */
async function readPrefix(file: string): Promise<Buffer> {
  // The check of the file and this open are two steps: a file swapped for a named pipe between them would hold the open for
  // ever. NONBLOCK opens a pipe at once, and the handle is looked at again, as a pipe would otherwise read as an empty file.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new InstructionsError('UNSAFE_PATH')
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

/** What else instructs an agent, besides a file of its own: the project's own files, directly in its folder. */
const SHARED_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const

interface SharedInstructions { name: (typeof SHARED_NAMES)[number]; text: string; truncated: boolean }

/** One of the shared files as it is shown: its text, to the limit, and whether there was more. Null where there is no such file. */
async function readShared(cwd: string, name: SharedInstructions['name']): Promise<SharedInstructions | null> {
  const file = join(cwd, name)
  if (!await plainFile(file)) return null
  const bytes = await readPrefix(file)
  const truncated = bytes.length > INSTRUCTIONS_MAX_BYTES
  try {
    // A file cut at the limit may end inside a character. Decoding as a stream holds an unfinished one back, so the text
    // stops at the last whole character; a file that is whole and ends inside one is not text.
    const text = truncated ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, INSTRUCTIONS_MAX_BYTES), { stream: true })
      : utf8.decode(bytes)
    return { name, text, truncated }
  } catch { throw new InstructionsError('NOT_UTF8') }
}

/** The files that instruct the agent besides its own, for a person to read beside it and never to change: AGENTS.md and
 *  CLAUDE.md when each is a plain file directly in its folder, never a parent's or the home's. Held to the rules of its own
 *  file: a link is not followed (a project often makes one of them the other, and then it is shown once, by the file itself),
 *  and each is read to the limit, with `truncated` saying it was cut, at a whole character. No file is an error of the whole:
 *  one that cannot be shown is left out. A file that is not a plain file is as the person made it; one that is not text, and
 *  one the disk fails on, come back in `failed` with the error, for the caller to tell. */
export async function readSharedInstructions(cwd: string): Promise<{ shared: SharedInstructions[]; failed: Array<{ name: string; error: unknown }> }> {
  const shared: SharedInstructions[] = [], failed: Array<{ name: string; error: unknown }> = []
  for (const name of SHARED_NAMES) {
    try {
      const one = await readShared(cwd, name)
      if (one) shared.push(one)
    } catch (error) {
      if (!(error instanceof InstructionsError && error.code === 'UNSAFE_PATH')) failed.push({ name, error })
    }
  }
  return { shared, failed }
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
