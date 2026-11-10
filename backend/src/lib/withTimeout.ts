/** A wait that ran out: its code is `TIMEOUT`, which error logs show (errorCode). */
export class TimeoutError extends Error {
  readonly code = 'TIMEOUT'
  readonly ms: number
  constructor(ms: number) {
    // The message the push senders read a timeout by (push/apns.ts, push/fcm.ts).
    super('timeout')
    this.ms = ms
    this.name = 'TimeoutError'
  }
}

/** `run`'s answer, or a TimeoutError after `ms`. `run` is handed a signal that aborts then: a call that takes it (a download, a
 *  request) stops, so nothing it holds is left running after its caller gave up. */
export function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const control = new AbortController()
  const answer = run(control.signal)
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(ms)
      control.abort(error)
      reject(error)
    }, ms)
  })
  return Promise.race([answer, late]).finally(() => clearTimeout(timer))
}
