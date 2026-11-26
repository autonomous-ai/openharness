// The one retry policy for the API clients. A network error (no status), a 429 and a 5xx are worth another try; any
// other error is the caller's to handle.
export function isTransient(error) {
  return error.status === undefined || error.status === 429 || error.status >= 500
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wraps a client's request function. A call that fails is sent again, at most `attempts` times in all, waiting baseMs
 *  before the second try and doubling the wait before each one after, plus up to `jitter` times that wait at random.
 *  Throws the last error, or the first one retryOn turns down. */
export function withRetry(request, { attempts = 3, baseMs = 50, jitter = 0, retryOn = isTransient } = {}) {
  return async (method, path, body, headers) => {
    // A POST the API took before it failed would be done again by another try, unless the API drops a repeated key.
    if (method === 'POST' && attempts > 1 && !headers?.['Idempotency-Key']) {
      throw new Error(`withRetry: a POST is retried only with an Idempotency-Key, and POST ${path} has none (issue 57)`)
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await request(method, path, body, headers)
      } catch (error) {
        if (attempt >= attempts || !retryOn(error)) throw error
        const wait = baseMs * 2 ** (attempt - 1)
        await sleep(wait + Math.random() * jitter * wait)
      }
    }
  }
}
