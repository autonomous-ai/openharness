import type { CoreApi } from '../core/api.js'
import { READ_FORMAT, UPDATE_MESSAGE, UPDATE_REQUIRED } from './readContract.js'

type Json = Record<string, unknown>
export const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
export const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v)
/** A read that only adds context to a decision: it answers within `ms` or not at all, and never fails the request. */
export async function within<T>(read: Promise<T>, ms = 3000): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(resolve, ms, null) })]) } catch { return null } finally { clearTimeout(timer) }
}
/** Assignment statuses (and route outcomes) that mean the work is over; the backend's `activeWork` lists the same ones.
 *  `lost`: its agent died, stalled or hit a limit, and the Lead hands it on (the backend's v1 liveness). */
export const ENDED_WORK = ['done', 'stopped', 'cancelled', 'lost']

export class SuperTabHostError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message) }
}
/** A request the backend would not validate: the next, older form of it is tried (an older backend refusing a newer field). */
export const fieldRefused = (error: unknown) => error instanceof SuperTabHostError && error.status === 400 && error.code === 'VALIDATION_ERROR'
/** How long a field an older backend refused is left out. */
export const FIELD_REFUSED_MS = 10 * 60_000

export const REQUEST_BLOCKED = 'REQUEST_BLOCKED'
export const REQUEST_BLOCKED_MESSAGE = 'The server\'s firewall refused this. It refuses text naming a sensitive system file, such as /etc/passwd or win.ini. Say it another way and try again.'

/** The core signs each request. Neither the service nor its journal holds an account credential. HTTP 426 is a server that no
 *  longer serves this client's reads: whatever it says, the person is told to update Harness (design 4.11, 5.1). */
export async function backend(core: CoreApi, method: string, path: string, body?: unknown): Promise<unknown> {
  const reply = await core.account.backend(method, path, body)
  if (reply.status === 426) throw new SuperTabHostError(UPDATE_REQUIRED, UPDATE_MESSAGE, 426)
  if (reply.status < 200 || reply.status >= 300 || reply.body.success === false) {
    const error = object(reply.body.error)
    // No answer of ours in a 403: the firewall in front of the server refused the request by what it says, not "unavailable".
    if (reply.status === 403 && error.code === undefined && reply.body.code === undefined) throw new SuperTabHostError(REQUEST_BLOCKED, REQUEST_BLOCKED_MESSAGE, 403)
    throw new SuperTabHostError(String(error.code ?? reply.body.code ?? 'BACKEND_UNAVAILABLE'),
      String(error.message ?? reply.body.message ?? 'Could not reach this Super Tab.'), reply.status)
  }
  return reply.body.data
}

/** A read reply in a format this client cannot read comes from a newer server: the person updates Harness (design 5.1). */
export function readable<T>(reply: unknown): T {
  if (object(reply).format !== READ_FORMAT) throw new SuperTabHostError(UPDATE_REQUIRED, UPDATE_MESSAGE, 426)
  return reply as T
}
