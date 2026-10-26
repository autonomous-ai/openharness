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
