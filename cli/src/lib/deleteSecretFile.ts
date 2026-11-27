/**
 * Deletes a file that holds a secret (the sign-in, the remote password), or says it could not. 11-27: both deletes
 * swallowed every failure, the person was told the secret was gone, and the next start loaded it again.
 */
import { rmSync } from 'fs'
import { pauseSync } from './secureState.js'

/** A secret file still on disk. Its message is the caller's fixed word and the errno code, never the path or any content:
 *  it reaches the terminal and the daemon's answer. */
export class SecretNotDeleted extends Error {
  override readonly name = 'SecretNotDeleted'
  constructor(word: string, readonly code: string) { super(`${word} (${code})`) }
}

/** Blocks for [ms]; a spec's own in place of [pauseSync]. */
export type Wait = (ms: number) => void

/** An antivirus or an indexer on Windows holds a file open for a moment after it is read, and a delete then fails with
 *  EBUSY or EPERM. Tried again within about a second: a person is waiting on the command. */
const HELD = new Set(['EBUSY', 'EPERM'])
const TRIES = 3
const RETRY_WAIT_MS = 400

/** Deletes [path], and all it holds when [recursive]; one already gone is no failure. A held one is tried again, and a
 *  recursive one on ENOTEMPTY too: on Windows a folder whose held file is pending deletion fails with it. Any other
 *  failure, or the last, is thrown as it came. The one loop for every held delete: Node's own `maxRetries` is
 *  recursive-only, and its retries run inside Node, past the `node:fs` seam the specs fail a delete through. */
export function deleteHeld(path: string, recursive: boolean, wait: Wait = pauseSync): void {
  for (let tries = 1; ; tries++) {
    try {
      rmSync(path, { recursive, force: true })
      return
    } catch (error) {
      const code = errnoOf(error)
      const held = HELD.has(code) || (recursive && code === 'ENOTEMPTY')
      if (!held || tries === TRIES) throw error
      wait(RETRY_WAIT_MS)
    }
  }
}

/** Deletes [file]; one already gone is no failure. Anything else that keeps it throws [SecretNotDeleted] with [word]. */
export function deleteSecretFile(file: string, word: string, wait: Wait = pauseSync): void {
  try {
    deleteHeld(file, false, wait)
  } catch (error) {
    throw new SecretNotDeleted(word, errnoOf(error))
  }
}

/** The errno code of a failed delete; anything that is not one is UNKNOWN, so no other text reaches the message. */
export function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'UNKNOWN'
}
