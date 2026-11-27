/**
 * Deletes a file that holds a secret (the sign-in, the remote password), or says it could not. 11-27: both deletes
 * swallowed every failure, the person was told the secret was gone, and the next start loaded it again.
 */
import { rmSync } from 'fs'

/** A secret file still on disk. Its message is the caller's fixed word and the errno code, never the path or any content:
 *  it reaches the terminal and the daemon's answer. */
export class SecretNotDeleted extends Error {
  override readonly name = 'SecretNotDeleted'
  constructor(word: string, readonly code: string) { super(`${word} (${code})`) }
}

/** Blocks for [ms]; a spec's own in place of [sleep]. */
export type Wait = (ms: number) => void

/** An antivirus or an indexer on Windows holds a file open for a moment after it is read, and a delete then fails with
 *  EBUSY or EPERM. Tried again within about a second: a person is waiting on the command. */
const HELD = new Set(['EBUSY', 'EPERM'])
const TRIES = 3
const RETRY_WAIT_MS = 400

/** Deletes [file]; one already gone is no failure. Anything else that keeps it throws [SecretNotDeleted] with [word]. */
export function deleteSecretFile(file: string, word: string, wait: Wait = sleep): void {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(file, { force: true })
      return
    } catch (error) {
      const code = errnoOf(error)
      if (!HELD.has(code) || tries === TRIES) throw new SecretNotDeleted(word, code)
      wait(RETRY_WAIT_MS)
    }
  }
}

/** Sleeps without spinning the CPU: the deletes and their callers are synchronous. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The errno code of a failed delete; anything that is not one is UNKNOWN, so no other text reaches the message. */
function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'UNKNOWN'
}
