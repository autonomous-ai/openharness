import http from 'node:http'

/** Physical requests, including ones whose caller timed out but whose socket has not closed. */
export const CALLBACK_REQUESTS_MAX = 4

export function createCallbackReplay(options: { timeoutMs?: number; get?: typeof http.get } = {}) {
  const active = new Set<http.ClientRequest>()
  let stopped = false
  let draining: Promise<void> | undefined
  let drained: (() => void) | undefined
  const run = (url: string, signal: AbortSignal): Promise<{ status: number; location: string | null }> => {
    if (stopped || signal.aborted || active.size >= CALLBACK_REQUESTS_MAX) return Promise.reject(new Error('CALLBACK_UNAVAILABLE'))
    return new Promise((resolve, reject) => {
      let answer: { status: number; location: string | null } | undefined
      let request: http.ClientRequest
      let failure = 'CALLBACK_CLOSED'
      const abort = (): void => { failure = 'CALLBACK_ABORTED'; reject(new Error(failure)); request.destroy() }
      try {
        request = (options.get ?? http.get)(url, { agent: false, maxHeaderSize: 16_384 }, response => {
          const location = response.headers.location
          answer = { status: response.statusCode ?? 0, location: typeof location === 'string' ? location : null }
          // A sign-in only needs the headers. An endless body must not hold a process or a socket open.
          response.destroy()
          request.destroy()
        })
      } catch {
        reject(new Error('CALLBACK_NOT_STARTED'))
        return
      }
      active.add(request)
      const timer = setTimeout(() => {
        failure = 'CALLBACK_TIMEOUT'
        reject(new Error(failure))
        request.destroy()
      }, options.timeoutMs ?? 30_000)
      timer.unref?.()
      signal.addEventListener('abort', abort, { once: true })
      request.on('error', () => { failure = 'CALLBACK_FAILED'; request.destroy() })
      request.once('close', () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        active.delete(request)
        if (!active.size) drained?.()
        if (answer) resolve(answer)
        else reject(new Error(failure))
      })
      // The caller can have ended while the request was being constructed.
      if (signal.aborted) abort()
    })
  }
  return { run, stop: (): Promise<void> => {
    if (draining) return draining
    stopped = true
    if (!active.size) return Promise.resolve()
    draining = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CALLBACK_CLOSE_TIMEOUT')), 5_000)
      timer.unref?.()
      drained = () => { clearTimeout(timer); resolve() }
      for (const request of active) request.destroy()
    })
    return draining
  } }
}
