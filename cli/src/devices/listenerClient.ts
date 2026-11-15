/**
 * One message from a tool on this computer to the devices' own listener (services/devicesListener.ts): `POST /` on its
 * socket, the message as JSON. Sent only to a socket that is this account's own, checked before a byte goes
 * (fetchOverSocket): what is sent can say which app is in front.
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
