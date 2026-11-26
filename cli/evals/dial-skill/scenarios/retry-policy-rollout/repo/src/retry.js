// The one retry policy for the API clients. A network error (no status), a 429 and a 5xx are worth another try; any
// other error is the caller's to handle.
export function isTransient(error) {
  return error.status === undefined || error.status === 429 || error.status >= 500
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Calls fn until it resolves, at most `attempts` times, waiting baseMs before the second try and doubling the wait
 *  before each one after. Throws the last error, or the first one retryOn turns down. */
export async function withRetry(fn, { attempts = 3, baseMs = 50, retryOn = isTransient } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= attempts || !retryOn(error)) throw error
      await sleep(baseMs * 2 ** (attempt - 1))
    }
  }
}
