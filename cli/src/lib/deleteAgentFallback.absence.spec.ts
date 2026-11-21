import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { checkPidRuntime } from './deleteAgentFallback.js'
import type { ProcessRow } from './processTable.js'

const rows = vi.hoisted(() => vi.fn<() => Promise<ProcessRow[] | null>>())
vi.mock('./processTable.js', async original => ({ ...await original<object>(), processRows: rows }))

const identity = { pid: 4242, executable: '/fixture/engine', startMarker: 'fixture-start' }
const session = { engine: 'hermes' as const, processIdentity: identity }
let probe: MockInstance<typeof process.kill>
beforeEach(() => {
  rows.mockReset().mockResolvedValue([{ ...identity, parentPid: 1, args: 'fixture' }])
  probe = vi.spyOn(process, 'kill').mockReturnValue(true)
})
afterEach(() => vi.restoreAllMocks())

it.skipIf(process.platform === 'win32')('confirms kernel absence without reading the process table', async () => {
  probe.mockImplementation(() => { throw Object.assign(new Error('fixture absent'), { code: 'ESRCH' }) })
  rows.mockResolvedValue(null)
  expect(await checkPidRuntime(session)).toMatchObject({ state: 'gone' })
  expect(probe).toHaveBeenCalledExactlyOnceWith(identity.pid, 0)
  expect(rows).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('asks afresh after absence and checks a reused PID through its full identity', async () => {
  probe.mockImplementationOnce(() => { throw Object.assign(new Error('fixture absent'), { code: 'ESRCH' }) })
  expect(await checkPidRuntime(session)).toMatchObject({ state: 'gone' })
  rows.mockResolvedValue([{ ...identity, startMarker: 'replacement', parentPid: 1, args: 'fixture' }])
  expect(await checkPidRuntime(session)).toMatchObject({ state: 'gone' })
  expect(probe).toHaveBeenCalledTimes(2)
  expect(rows).toHaveBeenCalledExactlyOnceWith(identity.pid)
})

it.each(['EPERM', 'EACCES', 'EINVAL', undefined] as const)('a %s probe error keeps unavailable identity unknown', async code => {
  probe.mockImplementation(() => { throw Object.assign(new Error('fixture failure'), { code }) })
  rows.mockResolvedValue(null)
  expect(await checkPidRuntime(session)).toMatchObject({ state: 'unknown' })
  expect(rows).toHaveBeenCalledExactlyOnceWith(identity.pid)
})

it.each(['match', 'start', 'executable'] as const)('existence alone cannot replace the %s identity comparison', async change => {
  rows.mockResolvedValue([{ ...identity, ...(change === 'start' ? { startMarker: 'replacement' }
    : change === 'executable' ? { executable: '/different/engine' } : {}), parentPid: 1, args: 'fixture' }])
  expect(await checkPidRuntime(session)).toMatchObject({ state: change === 'match' ? 'alive' : 'gone' })
  expect(rows).toHaveBeenCalledExactlyOnceWith(identity.pid)
})

it.each([0, -1, 1.5, NaN, Infinity, 0x8000_0000, 0xffff_ffff, Number.MAX_SAFE_INTEGER])(
  'never passes persisted PID %s to the kernel probe', async pid => {
    rows.mockResolvedValue(null)
    expect(await checkPidRuntime({ ...session, processIdentity: { ...identity, pid } })).toMatchObject({ state: 'unknown' })
    expect(probe).not.toHaveBeenCalled()
    expect(rows).toHaveBeenCalledExactlyOnceWith(pid)
  },
)

it('needs neither a kernel probe nor a table for a session with no identity', async () => {
  expect(await checkPidRuntime({ ...session, processIdentity: null })).toMatchObject({ state: 'gone' })
  expect(probe).not.toHaveBeenCalled()
  expect(rows).not.toHaveBeenCalled()
})
