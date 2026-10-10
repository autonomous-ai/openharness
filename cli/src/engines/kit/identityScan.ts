/** Bounded native evidence. An unfinished lookup cannot prove that a conversation is unique. */
import { constants, type Dirent, type Stats } from 'node:fs'
import { open, opendir } from 'node:fs/promises'

export class IdentityReadUnavailable extends Error {
  readonly code = 'IDENTITY_UNAVAILABLE'
  constructor(reason: string, message = `Conversation identity is held: ${reason}.`) { super(message) }
}

export type IdentityVersion = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'> & {
  /** Descriptor numbers can exceed Number's exact range; never round kernel ownership evidence. */
  fileKey?: { device: bigint; inode: bigint }
}

/** Shared across every directory/root in one lookup, including entries that are not transcripts. */
export const identityScanBudget = () => ({ remaining: 4096 })

/** A regular file only. Nonblocking open prevents a native-store FIFO from hanging session control. */
export async function identityBytes(path: string, maxBytes: number, expected?: IdentityVersion,
  budget?: { step(bytes?: number): void },
): Promise<Buffer> {
  budget?.step()
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    budget?.step()
    const before = await handle.stat()
    if (!before.isFile()) throw new IdentityReadUnavailable('the native record is not a regular file')
    if (expected?.fileKey) {
      const exact = await handle.stat({ bigint: true })
      if (exact.dev !== expected.fileKey.device || exact.ino !== expected.fileKey.inode) {
        throw new IdentityReadUnavailable('the opened native record is not the file held by the process')
      }
    }
    // A pathname can switch to another inode and back while a caller awaits its header. The
    // opened descriptor must be the candidate that authorized this read, not only the path at return.
    if (expected && (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size
      || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs)) {
      throw new IdentityReadUnavailable('the opened native record differs from the inspected candidate')
    }
    const length = Math.min(before.size, maxBytes)
    const bytes = Buffer.alloc(length)
    let read = 0
    let calls = 0
    while (read < length) {
      budget?.step()
      if (budget && ++calls > 64) throw new IdentityReadUnavailable('the native header read-operation limit was reached')
      const next = await handle.read(bytes, read, length - read, read)
      budget?.step(next.bytesRead)
      if (!next.bytesRead) throw new IdentityReadUnavailable('the native record ended during the read')
      read += next.bytesRead
    }
    const after = await handle.stat()
    budget?.step()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new IdentityReadUnavailable('the native record changed during the read')
    }
    // Atomic rename leaves the old descriptor perfectly readable. Reopen the path without
    // waiting for a writer and verify that it still names the record we just read.
    const current = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
      throw new IdentityReadUnavailable('the native record disappeared during the read')
    })
    try {
      const now = await current.stat()
      budget?.step()
      if (now.dev !== before.dev || now.ino !== before.ino || now.size !== before.size
        || now.mtimeMs !== before.mtimeMs || now.ctimeMs !== before.ctimeMs) {
        throw new IdentityReadUnavailable('the native record was replaced during the read')
      }
    } finally { await current.close() }
    return bytes
  } finally { await handle.close() }
}

/** opendir bounds the directory buffer too; readdir followed by slice would still read the whole tree. */
export async function* identityEntries(path: string, budget: { remaining: number }, missingOkay = true): AsyncGenerator<Dirent> {
  // An empty or missing directory still costs a filesystem operation.
  if (budget.remaining-- <= 0) throw new IdentityReadUnavailable('the directory entry limit was reached')
  let directory
  try { directory = await opendir(path, { bufferSize: 32 }) }
  catch (error) {
    if (missingOkay && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new IdentityReadUnavailable('a session directory could not be read')
  }
  try {
    // The iterator closes the directory on completion, exceptions and early return.
    for await (const entry of directory) {
      if (budget.remaining-- <= 0) throw new IdentityReadUnavailable('the directory entry limit was reached')
      yield entry
    }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    throw new IdentityReadUnavailable('a session directory could not be read completely')
  }
}

/** Small whole-file identity, never a prefix that could omit a conflicting field. */
export async function identityFile(path: string, maxBytes = 64 * 1024): Promise<string> {
  let bytes: Buffer
  try { bytes = await identityBytes(path, maxBytes + 1) }
  catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error
    throw new IdentityReadUnavailable('the native record could not be read')
  }
  if (bytes.length > maxBytes) throw new IdentityReadUnavailable('the native record exceeds the read limit')
  return bytes.toString('utf8')
}

/** Only complete lines from a bounded prefix; EOF may complete the final line without a newline. */
export async function identityHead(path: string, lines: number, maxBytes = 256 * 1024, expected?: IdentityVersion): Promise<{ lines: string[]; complete: boolean }> {
  const bytes = await identityBytes(path, maxBytes + 1, expected).catch(error => {
    if (error instanceof IdentityReadUnavailable) throw error
    throw new IdentityReadUnavailable('the native header could not be read')
  })
  const complete = bytes.length <= maxBytes
  const head = bytes.subarray(0, maxBytes).toString('utf8').split('\n')
  if (!complete) head.pop()
  return { lines: head.slice(0, lines), complete: complete && head.length <= lines }
}
