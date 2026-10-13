import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'

const disk = vi.hoisted(() => ({ held: true, pending: new Map<number, (error: Error | null) => void>() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(),
  fsync: (fd: number, done: (error: Error | null) => void) => {
    if (disk.held) disk.pending.set(fd, done)
    else queueMicrotask(() => done(null))
  },
}))
let root: string
const drain = async () => { for (let n = 0; n < 80; n++) await Promise.resolve() }
async function release() {
  disk.held = false
  for (const done of disk.pending.values()) done(null)
  disk.pending.clear()
  await drain()
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-attempts-')))
  disk.held = true
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})
afterEach(async () => { await release(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

it('keeps the event loop available and retains the descriptor and reservation after its reply deadline', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const pending = runHookPreparation([file], attempt => inspectHookFile(file).replace('after', attempt), { timeoutMs: 20 }).catch(error => error)
  await drain()
  const fd = [...disk.pending.keys()][0]
  expect(fd).toBeTypeOf('number')
  expect(fstatSync(fd).isFile()).toBe(true)
  let stopped = false
  setTimeout(() => { stopped = true }, 1)
  await vi.advanceTimersByTimeAsync(20)
  expect(stopped).toBe(true)
  expect((await pending).message).toMatch(/deadline/)
  expect(readFileSync(file, 'utf8')).toBe('before')
  expect(fstatSync(fd).isFile()).toBe(true)
  await expect(runHookPreparation([file], async () => true)).rejects.toThrow(/still owns/)
  await release()
  expect(() => fstatSync(fd)).toThrow()
  expect(readdirSync(root)).toEqual(['hooks'])
  expect(readFileSync(file, 'utf8')).toBe('before')
  await runHookPreparation([file], attempt => inspectHookFile(file).replace('recovered', attempt))
  expect(readFileSync(file, 'utf8')).toBe('recovered')
})

it('reserves aliases together, joins identical work, and prevents a superseded port from publishing', async () => {
  const file = join(root, 'hooks'), alias = join(root, 'alias'); writeFileSync(file, 'before'); symlinkSync(file, alias)
  const first = runHookPreparation([file], attempt => inspectHookFile(file).replace('old port', attempt), { identity: 'old port' }).catch(error => error)
  const duplicate = vi.fn(async () => true)
  const joined = runHookPreparation([alias], duplicate, { identity: 'old port' }).catch(error => error)
  await drain()
  expect(duplicate).not.toHaveBeenCalled()
  await expect(runHookPreparation([alias], async () => true, { identity: 'new port' })).rejects.toThrow(/still owns/)
  await release()
  expect((await first).message).toMatch(/owner changed/)
  expect((await joined).message).toMatch(/owner changed/)
  expect(readFileSync(file, 'utf8')).toBe('before')
})

it('rechecks the original caller after a flush without acknowledging or publishing for a closed owner', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  let current = true
  const prepared = runHookPreparation([file], attempt => inspectHookFile(file).replace('late', attempt), { current: () => current }).catch(error => error)
  await drain(); current = false; await release()
  expect((await prepared).message).toMatch(/owner changed/)
  expect(readFileSync(file, 'utf8')).toBe('before')
})

it('bounds outstanding flushes and releases undispatched work when its deadline expires', async () => {
  const replies: Promise<unknown>[] = []
  for (let n = 0; n < 16; n++) {
    const file = join(root, String(n)); writeFileSync(file, 'before')
    replies.push(runHookPreparation([file], async attempt => {
      const fd = openSync(file, 'r')
      try { await attempt.flush(fd) } finally { closeSync(fd) }
    }, { timeoutMs: 10 }).catch(error => error))
  }
  await drain()
  expect(disk.pending.size).toBe(2)
  await expect(runHookPreparation([join(root, 'overflow')], async () => true)).rejects.toThrow(/slots/)
  await vi.advanceTimersByTimeAsync(10)
  await Promise.all(replies)
  expect(disk.pending.size).toBe(2)
  expect(await runHookPreparation([join(root, 'available')], async () => true)).toBe(true)
  await release()
  expect(await runHookPreparation([join(root, 'recovered')], async () => true)).toBe(true)
})


it('checks a changed second destination before publishing the first after a disk wait', async () => {
  const hooks = join(root, 'hooks'), approvals = join(root, 'approvals')
  writeFileSync(hooks, 'old hooks'); writeFileSync(approvals, 'old approvals')
  const pending = runHookPreparation([hooks, approvals], async attempt => {
    const first = inspectHookFile(hooks), second = inspectHookFile(approvals)
    const published = await first.replace('new hooks', attempt)
    await second.replace('new approvals', attempt)
    published.verify()
  }).catch(error => error)
  await drain()
  writeFileSync(approvals, 'foreign edit')
  await release()
  expect((await pending).message).toMatch(/changed/)
  expect(readFileSync(hooks, 'utf8')).toBe('old hooks')
  expect(readFileSync(approvals, 'utf8')).toBe('foreign edit')
})

it('checks each joining owner and deadline without cancelling the original installation', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const original = runHookPreparation([file], async attempt => {
    await inspectHookFile(file).replace('ready', attempt)
    return true
  }, { identity: 'same' })
  await drain()
  const work = vi.fn(async () => true)
  let refused: unknown
  void runHookPreparation([file], work, { identity: 'same', current: () => false }).catch(error => { refused = error })
  await drain()
  expect(refused).toEqual(expect.objectContaining({ message: expect.stringMatching(/joining owner/) }))
  const short = runHookPreparation([file], work, { identity: 'same', timeoutMs: 5 }).catch(error => error)
  let current = true
  const cancelled = runHookPreparation([file], work, { identity: 'same', current: () => current }).catch(error => error)
  await vi.advanceTimersByTimeAsync(5)
  expect((await short).message).toMatch(/joining preparation.*deadline/)
  current = false
  await release()
  expect(await original).toBe(true)
  expect((await cancelled).message).toMatch(/joining owner/)
  expect(work).not.toHaveBeenCalled()
  expect(readFileSync(file, 'utf8')).toBe('ready')
})


it('keeps a queued destination bound to the route it reserved before asynchronous dispatch', async () => {
  const first = join(root, 'first'), second = join(root, 'second'), alias = join(root, 'alias')
  writeFileSync(first, 'first'); writeFileSync(second, 'second'); symlinkSync(first, alias)
  const work = vi.fn(async () => true)
  const pending = runHookPreparation([alias], work).catch(error => error)
  unlinkSync(alias); symlinkSync(second, alias)
  await drain()
  expect((await pending).message).toMatch(/route changed/)
  expect(work).not.toHaveBeenCalled()
  expect(readFileSync(first, 'utf8')).toBe('first')
  expect(readFileSync(second, 'utf8')).toBe('second')
})


it('does not acknowledge an alias redirected while its identical preparation is joined', async () => {
  const file = join(root, 'hooks'), alias = join(root, 'alias'), other = join(root, 'other')
  writeFileSync(file, 'old'); writeFileSync(other, 'foreign'); symlinkSync(file, alias)
  const original = runHookPreparation([file], attempt => inspectHookFile(file).replace('ready', attempt), { identity: 'same' })
  await drain()
  const joined = runHookPreparation([alias], async () => true, { identity: 'same' }).catch(error => error)
  unlinkSync(alias); symlinkSync(other, alias)
  await release(); await original
  expect((await joined).message).toMatch(/changed/)
  expect(readFileSync(alias, 'utf8')).toBe('foreign')
})

it('checks the joining deadline even when the timer phase has not run', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'old')
  let finish!: (value: boolean) => void
  const work = new Promise<boolean>(resolve => { finish = resolve })
  const original = runHookPreparation([file], () => work, { identity: 'same' })
  const joined = runHookPreparation([file], async () => true, { identity: 'same', timeoutMs: 5 }).catch(error => error)
  await drain()
  const now = vi.spyOn(performance, 'now').mockReturnValue(10)
  finish(true)
  expect(await original).toBe(true)
  expect(await joined).toEqual(expect.objectContaining({ message: expect.stringMatching(/deadline/) }))
  now.mockRestore()
})

it('retains the joining caller’s alias in its final launch proof', async () => {
  const file = join(root, 'hooks'), alias = join(root, 'alias'), other = join(root, 'other')
  writeFileSync(file, 'old'); writeFileSync(other, 'foreign'); symlinkSync(file, alias)
  const original = runHookPreparation([file], attempt => inspectHookFile(file).replace('ready', attempt), { identity: 'same' })
  await drain()
  const confirmed = vi.fn()
  const joined = runHookPreparation([alias], async () => true, { identity: 'same', confirmed })
  await release(); await original; await joined
  const proof = confirmed.mock.calls[0]![0]
  expect(proof.files[0].file).toBe(alias)
  expect(proof.current()).toBe(true)
  unlinkSync(alias); symlinkSync(other, alias)
  expect(proof.current()).toBe(false)
})
