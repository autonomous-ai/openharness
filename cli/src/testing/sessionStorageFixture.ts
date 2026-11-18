/** A test's directory outlives every storage process and descriptor that used it. */
import type { ChildProcess } from 'node:child_process'
import type { SessionStorage } from '../lib/sessionStorage.js'

export async function closeSessionStorageFixture(storage: SessionStorage): Promise<void> {
  const child = (storage as unknown as { child?: ChildProcess }).child
  const closed = child ? new Promise<void>(resolve => child.once('close', () => resolve())) : Promise.resolve()
  const outcomes = await Promise.allSettled([storage.close(), closed])
  const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
  if (child?.pid) {
    try { process.kill(child.pid, 0); failures.push(new Error('fixture storage child still exists')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'fixture storage cleanup failed')
}
