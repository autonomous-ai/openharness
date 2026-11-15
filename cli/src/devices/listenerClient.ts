/**
 * One message from a tool on this computer to the devices' own listener (services/devicesListener.ts): `POST /` on its
 * socket, the message as JSON, and for a stream's message the stream it answers. Sent only to a socket that is this
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
