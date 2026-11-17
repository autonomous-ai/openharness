import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { createSetupProbeExecutor } from './setupProbe.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(() => Object.assign(new actual.ChildProcess(), {
    connected: true, send: vi.fn(),
  })) }
})
afterEach(() => vi.clearAllMocks())

it.each(['expiry', 'cancel', 'disconnect'] as const)('never spawns queued work after an unused keeper answers %s', reason => {
  const executor = createSetupProbeExecutor()
  executor.warmOnce()
  const args = vi.mocked(spawn).mock.calls[0]![1] as string[]
  const started = vi.fn(() => Object.assign(new EventEmitter(), {
    pid: 101, stdout: new PassThrough(), stderr: new PassThrough(),
  }))
  const process = Object.assign(new EventEmitter(), {
    platform: 'linux', env: {}, connected: true, send: vi.fn(), exit: vi.fn(), kill: vi.fn(),
  })
  const timers = new Map<number, { run: () => void; ms: number }>()
  let timer = 0
  runInNewContext(args.at(-1)!, {
    process, Buffer,
    require: (name: string) => name === 'node:child_process' ? { spawn: started, execFile: vi.fn() } : {},
    setTimeout: (run: () => void, ms: number) => { timers.set(++timer, { run, ms }); return timer },
    clearTimeout: (id: number) => timers.delete(id),
  })
  if (reason === 'expiry') [...timers.values()].find(value => value.ms === 5000)!.run()
  else if (reason === 'cancel') process.emit('message', { cancel: true })
  else process.emit('disconnect')
  // Hold the send callback/exit timer: a work message can already be queued behind cancellation.
  expect(process.send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'SETUP_PROBE_CANCELLED' }) }), expect.any(Function))
  expect(process.exit).not.toHaveBeenCalled()
  process.emit('message', { file: '/fixture/engine', args: ['--version'], options: { env: {}, maxBuffer: 64 }, group: {} })
  expect(started).not.toHaveBeenCalled()
  executor.close()
})

it('refuses an execution captured before final close and cannot warm after close', async () => {
  const executor = createSetupProbeExecutor(), execute = executor.execute
  executor.close()
  executor.warmOnce()
  const result = new Promise(resolve => execute('/fixture/engine', ['--version'], {}, error => resolve(error?.code)))
  // The pre-fix fake keeper answers so the caller assertion fails without waiting on a timeout.
  for (const result of vi.mocked(spawn).mock.results) (result.value as ChildProcess).emit('message', { error: null, stdout: '', stderr: '' })
  expect(await result).toBe('SETUP_PROBE_CANCELLED')
  expect(spawn).not.toHaveBeenCalled()
})
