import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn }))
import { loginShellEnvironment, resetLoginShellEnvironmentCache, warmLoginShellEnvironment } from './loginShellEnv.js'
function shell() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() })
  fake.spawn.mockReturnValue(child)
  return child
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubEnv('SHELL', '/test/shell'); vi.stubEnv('PATH', '/first')
  resetLoginShellEnvironmentCache(); fake.spawn.mockReset()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); resetLoginShellEnvironmentCache() })
it('ends a shell capture at its deadline even when the child never closes its output', async () => {
  const child = shell(), capture = warmLoginShellEnvironment()
  let settled = false
  void capture.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(settled).toBe(true)
  expect(await capture).toEqual({})
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
})
it('caps a shell banner instead of retaining unbounded output', async () => {
  const child = shell(), capture = warmLoginShellEnvironment()
  child.stdout.emit('data', Buffer.alloc(1_048_577))
  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  expect(await capture).toEqual({})
})
it('recaptures a changed PATH once and shares the pending shell', async () => {
  let child = shell()
  const first = warmLoginShellEnvironment()
  expect(warmLoginShellEnvironment()).toBe(first)
  child.stdout.emit('data', Buffer.from('__HARNESS_ENV_BEGIN__PATH=/old\0')); child.emit('close', 0)
  expect((await first).PATH).toBe('/old')
  vi.stubEnv('PATH', '/second'); child = shell()
  const second = warmLoginShellEnvironment()
  expect(fake.spawn).toHaveBeenCalledTimes(2)
  child.stdout.emit('data', Buffer.from('__HARNESS_ENV_BEGIN__PATH=/new\0')); child.emit('close', 0)
  expect((await second).PATH).toBe('/new')
  expect(loginShellEnvironment().PATH).toBe('/new')
})
