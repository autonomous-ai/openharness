import { fstatSync } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * The client driving `harness login --json` — the desktop app — on standard input: its answers, one
 * line each, and its going away. A sign-in holds the daemon spawn lock for as long as it waits on a
 * browser or a phone (minutes), so one whose app quit or restarted must not wait on: the next sign-in
 * would sit behind it, silent. The app's end of the pipe closing is the cue.
 */
export interface JsonDriver {
  /** The next line the client sends, or null once it has gone. */
  nextLine(): Promise<string | null>
  /** Resolves when the client has gone (its end of stdin closed). */
  readonly gone: Promise<void>
}

type Input = NodeJS.ReadableStream & { fd?: number; ref?: () => void; unref?: () => void }

/**
 * Null unless stdin is a pipe or a socket — something a client holds open. `< /dev/null` (a script
 * that answers nothing) ends at once, and that is no sign of anyone having gone.
 */
export function watchJsonDriver(
  input: Input = process.stdin,
  isPipe: () => boolean = () => stdinIsPipe(),
): JsonDriver | null {
  if (!isPipe()) return null
  const lines: string[] = []
  const waiters: Array<(line: string | null) => void> = []
  let closed = false
  let markGone!: () => void
  const gone = new Promise<void>((resolve) => { markGone = resolve })
  const rl = createInterface({ input })
  // Listening must not keep the process alive once the sign-in is done; only a wait for an answer does.
  input.unref?.()
  rl.on('line', (line) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else lines.push(line)
  })
  rl.on('close', () => {
    closed = true
    for (const waiter of waiters.splice(0)) waiter(null)
    markGone()
  })
  return {
    gone,
    nextLine: () => {
      const queued = lines.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      if (closed) return Promise.resolve(null)
      input.ref?.()
      return new Promise((resolve) => {
        waiters.push((line) => {
          input.unref?.()
          resolve(line)
        })
      })
    },
  }
}

function stdinIsPipe(): boolean {
  try {
    const stat = fstatSync(0)
    return stat.isFIFO() || stat.isSocket()
  } catch {
    return false
  }
}
