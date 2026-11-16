/**
 * One message from a tool on this computer to the devices' own listener (services/devicesListener.ts): `POST /` on its
 * socket, the message as JSON; for an ask's message the JSON object it answers, and for a stream's message the stream it
 * answers. Sent only to a socket that is this
 * account's own, checked before a byte goes (fetchOverSocket): what is sent can say which app is in front, or which tab.
 */
import { fetchOverSocket } from '../lib/localTransport.js'
import { devicesListenerPath } from './listenerPath.js'

/** True when the listener took [message] (a 2xx). False, never a throw, for no listener, one not this account's own, any other answer or none in time. */
export async function tellDevices(
  dataDir: string, message: { type: string } & Record<string, unknown>,
  options: { platform?: NodeJS.Platform; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const path = devicesListenerPath(dataDir, options.platform)
  if (!path) return false
  try {
    const answer = await (options.fetch ?? fetchOverSocket(path))('http://devices.invalid/', {
      method: 'POST', body: JSON.stringify(message), signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    })
    // Unread, an answer would hold its connection, and the listener takes only 16.
    await answer.body?.cancel()
    return answer.ok
  } catch { return false }
}

export const ASK_ANSWER_MAX = 1024

/** One message the listener answers with a JSON object: that object. Null, never a throw, for no listener, one not
 *  this account's own, any answer but a 200 whose body is a JSON object of at most ASK_ANSWER_MAX bytes, or none in time. */
export async function askDevices(
  dataDir: string, message: { type: string } & Record<string, unknown>,
  options: { platform?: NodeJS.Platform; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  const path = devicesListenerPath(dataDir, options.platform)
  if (!path) return null
  try {
    // The bound covers the body as well as the headers: the signal aborts a read still under way.
    const answer = await (options.fetch ?? fetchOverSocket(path))('http://devices.invalid/', {
      method: 'POST', body: JSON.stringify(message), signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
    })
    // Read or cancelled, never left: an unread answer would hold its connection, and the listener takes only 16.
    if (answer.status !== 200) {
      await answer.body?.cancel()
      return null
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const data of answer.body ?? []) {
      size += data.byteLength
      // Leaving the loop cancels the rest of the body.
      if (size > ASK_ANSWER_MAX) return null
      chunks.push(Buffer.from(data))
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

/**
 * A message the listener answers with a stream (`tabs`): each chunk of a `200` answer's body is handed on as it comes.
 * True once that body has ended, however it ended: the stream had opened. False, never a throw, for no listener, one not
 * this account's own, any other answer, or no answer's headers in 2 s. An abort ends it and lets its connection go.
 */
export async function streamDevices(
  dataDir: string, message: { type: string }, chunk: (data: Buffer) => void,
  options: { signal: AbortSignal; platform?: NodeJS.Platform; fetch?: typeof fetch },
): Promise<boolean> {
  const path = devicesListenerPath(dataDir, options.platform)
  if (!path) return false
  // Only the answer's headers are bounded: the body is the stream, open for as long as the listener holds it.
  const unanswered = new AbortController()
  const bound = setTimeout(() => unanswered.abort(), 2000)
  let answer: Response
  try {
    answer = await (options.fetch ?? fetchOverSocket(path))('http://devices.invalid/', {
      method: 'POST', body: JSON.stringify(message), signal: AbortSignal.any([options.signal, unanswered.signal]),
    })
    if (answer.status !== 200) {
      await answer.body?.cancel()
      return false
    }
  } catch { return false } finally { clearTimeout(bound) }
  try {
    for await (const data of answer.body ?? []) chunk(Buffer.from(data))
  } catch { /* the listener closed the connection, or the abort let it go: the stream has ended either way */ }
  return true
}
