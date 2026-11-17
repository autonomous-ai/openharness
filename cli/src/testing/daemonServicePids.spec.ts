import { expect, it } from 'vitest'

const { loggedServicePids } = await import('../../e2e/harness/daemon.js' as string) as {
  loggedServicePids: (log: string, name: string, master: number | null, table: ReadonlyArray<{ pid: number; ppid: number }>) => number[]
}
const started = (name: string, pid: number, again = '') => `2026-11-17 10:00:00.000 [harnessd] service ${name} started (pid ${pid})${again}\n`
const log = started('search', 41) + started('edge', 42) + started('search', 55, ' · restart 1')

it('lists the pids the master logged for a service process that are still its children', () => {
  const table = [{ pid: 41, ppid: 7 }, { pid: 42, ppid: 7 }, { pid: 55, ppid: 7 }]
  expect(loggedServicePids(log, 'search', 7, table)).toEqual([41, 55])
  expect(loggedServicePids(log, 'edge', 7, table)).toEqual([42])
})

// The title did this before: a pid the master logged can be anyone's once that process has gone.
it('leaves out a pid that has gone, or is a stranger\'s now', () => {
  expect(loggedServicePids(log, 'search', 7, [{ pid: 55, ppid: 7 }])).toEqual([55])
  expect(loggedServicePids(log, 'search', 7, [{ pid: 41, ppid: 1 }, { pid: 55, ppid: 7 }])).toEqual([55])
})

it('lists none with no master, for a process the master never started, or for a longer name', () => {
  expect(loggedServicePids(log, 'search', null, [{ pid: 41, ppid: 7 }])).toEqual([])
  expect(loggedServicePids(log, 'models', 7, [{ pid: 41, ppid: 7 }])).toEqual([])
  expect(loggedServicePids(started('searchers', 41), 'search', 7, [{ pid: 41, ppid: 7 }])).toEqual([])
})
