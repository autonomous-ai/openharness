import { createConnection } from 'node:net'

const RETRY_MS = 250

// The gateway drops connections for a few seconds while it rolls over, so a push retries until its deadline rather than
// failing on the first refused or reset connection.
export function pushBatch(points, { host, port, apiKey, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  const body = `${JSON.stringify({ apiKey, points })}\n`
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host, port })
      const retry = () => {
        socket.destroy()
        if (Date.now() + RETRY_MS < deadline) setTimeout(attempt, RETRY_MS)
        else reject(new Error(`timed out after ${timeoutMs} ms connecting to ${host}:${port}`))
      }
      socket.setTimeout(Math.max(deadline - Date.now(), 1), retry)
      socket.once('error', retry)
      socket.once('connect', () => {
        socket.setTimeout(0)
        socket.end(body, () => resolve(points.length))
      })
    }
    attempt()
  })
}
