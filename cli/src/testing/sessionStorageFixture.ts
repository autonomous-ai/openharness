/** A test's directory outlives every storage process and descriptor that used it. */
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { SessionStorage } from '../lib/sessionStorage.js'

/** Golden fixtures forbid host tools but still exercise the real, privately rooted storage child. */
export function spawnSessionStorageFixture(actual: typeof spawn, command: string, args: string[], options: SpawnOptions): ChildProcess {
  const entry = fileURLToPath(new URL('../storage/entry.ts', import.meta.url))
  if (command !== process.execPath || JSON.stringify(args) !== JSON.stringify(['--import', import.meta.resolve('tsx'), entry, '__storage'])
    || options.env?.ADAPTER_DATA_DIR !== process.env.ADAPTER_DATA_DIR || options.env?.HOME !== process.env.HOME
    || !Array.isArray(options.stdio) || options.stdio[3] !== 'ipc') throw new Error('Unexpected child in storage fixture')
  return actual(command, args, options)
}

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
