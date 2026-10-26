import type { CoreApi } from '../core/api.js'
import { UPDATE_MESSAGE, UPDATE_REQUIRED } from './readContract.js'

type Json = Record<string, unknown>
export const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
export const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v)
/** A read that only adds context to a decision: it answers within `ms` or not at all, and never fails the request. */
export async function within<T>(read: Promise<T>, ms = 3000): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(resolve, ms, null) })]) } catch { return null } finally { clearTimeout(timer) }
}
/** Assignment statuses (and route outcomes) that mean the work is over; the backend's `activeWork` lists the same ones. */
export const ENDED_WORK = ['done', 'stopped', 'cancelled']

export class SuperTabHostError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message) }
}

/** The core signs each request. Neither the service nor its journal holds an account credential. HTTP 426 is a server that no
 *  longer serves this client's reads: whatever it says, the person is told to update Harness (design 4.11, 5.1). */
export async function backend(core: CoreApi, method: string, path: string, body?: unknown): Promise<unknown> {
  const reply = await core.account.backend(method, path, body)
  if (reply.status === 426) throw new SuperTabHostError(UPDATE_REQUIRED, UPDATE_MESSAGE, 426)
  if (reply.status < 200 || reply.status >= 300 || reply.body.success === false) {
    const error = object(reply.body.error)
    throw new SuperTabHostError(String(error.code ?? reply.body.code ?? 'BACKEND_UNAVAILABLE'),
      String(error.message ?? reply.body.message ?? 'Could not reach this Super Tab.'), reply.status)
  }
  return reply.body.data
}
