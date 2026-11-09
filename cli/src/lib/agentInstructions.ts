/**
 * An agent's instructions file: `agents/<name>.md`, in the folder the agent works in, on the computer it runs on.
 *
 * The owner reads and saves it from their other computers through the daemon here, which holds the one copy. It goes
 * through neither GitHub nor our servers: some people do not want what they tell an agent in git or on a server. So
 * this reads and writes a person's own words, on a request a relay carries (sealed, never logged: services/projects.ts):
 *
 *  - The request chooses only the name, and a name is one file name (`fileNameOf`): the file is always
 *    `<folder>/agents/<name>.md`.
 *  - Never through a link. `agents` and the file are the two places a request can lead out of the project by,
 *    and a checkout can carry either one as a link (git keeps links): a save through it would replace a file that is
 *    not the person's instructions, a read would show one. Both are checked with `lstat` and neither is followed,
 *    and the file is opened with O_NOFOLLOW besides. The agent's own folder is the registry's and may sit behind links
 *    itself (`/tmp` on a Mac), so it is never resolved.
 *  - Bounded: at most 64 KiB read or written, whatever the file or the request holds.
 *  - Whole bytes: a file that is not UTF-8 is not read, as showing it would turn its bytes into replacement
 *    characters and saving that would change the person's file.
 *  - The version is the SHA-256 of the file's bytes, and a save names the one the writer saw: over any other file
 *    it is refused (`CHANGED`) rather than overwrite what the writer never read. `''` is "no file". There is no
 *    lock: the check and the replace are two steps of one request, a few milliseconds apart, and the apps are one
 *    person's own computers.
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
  constructor(readonly code: 'BAD_NAME' | 'BAD_TEXT' | 'TOO_LARGE' | 'UNSAFE_PATH' | 'CHANGED') { super(code); this.name = 'InstructionsError' }
}

/** Strict, and keeping a byte-order mark as the character it is: the text read is then exactly what saving it writes. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const versionOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** The file's name for what the person calls the agent, trimmed. A separator or a leading dot is how a name leaves
 *  `agents/` (`../x`, `.git`), and a control character is something no file name needs and a log or a terminal obeys. */
function fileNameOf(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed.length > 100 || trimmed.startsWith('.') || /[\\/]|\p{Cc}/u.test(trimmed)) throw new InstructionsError('BAD_NAME')
  return `${trimmed}.md`
}

/** What is at `path`, not following it, or null where there is nothing (or nothing can be: below a file). */
async function entry(path: string): Promise<Stats | null> {
  try { return await lstat(path) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/** Where the file is and what is there. Each of `agents` and the file is a plain folder or file, or is not there. */
async function locate(cwd: string, fileName: string): Promise<{ dir: string; file: string; info: Stats | null }> {
  const dir = join(cwd, 'agents'), file = join(dir, fileName)
  const folder = await entry(dir)
  if (folder && !folder.isDirectory()) throw new InstructionsError('UNSAFE_PATH')
  const info = await entry(file)
  // From lstat, so a link is not a file here, and nor is a folder or a named pipe, which would hold an open for ever.
  if (info && !info.isFile()) throw new InstructionsError('UNSAFE_PATH')
  return { dir, file, info }
}

/** The file's bytes, read to one past the limit at most: a file over it is refused, never read whole. */
async function readBytes(file: string): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const bytes = Buffer.alloc(INSTRUCTIONS_MAX_BYTES + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) return bytes.subarray(0, length)
      length += bytesRead
      if (length > INSTRUCTIONS_MAX_BYTES) throw new InstructionsError('TOO_LARGE')
    }
  } finally { await handle.close() }
}

/** The file's text and version, or `{ text: null, version: '' }` when there is no file. */
export async function readInstructions(cwd: string, name: unknown): Promise<{ text: string | null; version: string }> {
  const { file, info } = await locate(cwd, fileNameOf(name))
  if (!info) return { text: null, version: '' }
  const bytes = await readBytes(file)
  return { text: utf8.decode(bytes), version: versionOf(bytes) }
}

/** Saves [text] as the file, making `agents/` when it is missing, if the file is as the writer saw it: [seen] is the
 *  version it read, or `''` for no file. Gives the new version. */
export async function writeInstructions(cwd: string, name: unknown, text: unknown, seen: unknown): Promise<{ version: string }> {
  const fileName = fileNameOf(name)
  if (typeof text !== 'string') throw new InstructionsError('BAD_TEXT')
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > INSTRUCTIONS_MAX_BYTES) throw new InstructionsError('TOO_LARGE')
  // Not recursive: a project that has moved away is not made again, with an agents folder in it.
  await mkdir(join(cwd, 'agents')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const { dir, file, info } = await locate(cwd, fileName)
  if (seen !== (info ? versionOf(await readBytes(file)) : '')) throw new InstructionsError('CHANGED')
  const temporary = join(dir, `.${randomUUID()}.tmp`)
  try {
    // `wx` makes a new file or fails, and never follows a link. The old file's mode, never looser than it was.
    const handle = await open(temporary, 'wx', info ? info.mode & 0o777 : 0o666)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }) }
  return { version: versionOf(bytes) }
}
