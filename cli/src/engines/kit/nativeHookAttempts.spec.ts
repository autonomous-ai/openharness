import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectHookFile, runHookPreparation, type HookPreparationAttempt } from './nativeHookFiles.js'

const disk = vi.hoisted(() => ({ held: true, pending: new Map<number, (error: Error | null) => void>(),
  onStat: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
  lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { disk.onStat?.(String(args[0])); return fs.lstatSync(...args) },
  fsync: (fd: number, done: (error: Error | null) => void) => {
    if (disk.held) disk.pending.set(fd, done)
    else queueMicrotask(() => done(null))
  },
  }
})
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
afterEach(async () => { disk.onStat = undefined; await release(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

it.each(['before dispatch', 'after flush'] as const)('refuses changed caller file evidence %s before publishing', async boundary => {
  const file = join(root, 'hooks'), dependency = join(root, 'dependency')
  writeFileSync(file, 'before'); writeFileSync(dependency, 'captured')
  const evidence = inspectHookFile(dependency), work = vi.fn((attempt: HookPreparationAttempt) => inspectHookFile(file).replace('after', attempt))
  const prepared = runHookPreparation([file], work, { verify: evidence.verify }).catch(error => error)
  if (boundary === 'after flush') { await drain(); expect(disk.pending.size).toBe(1) }
  writeFileSync(dependency, 'newer')
  await release()
  expect(await prepared).toEqual(expect.objectContaining({ message: expect.stringMatching(/changed/) }))
  expect(readFileSync(file, 'utf8')).toBe('before')
  if (boundary === 'before dispatch') expect(work).not.toHaveBeenCalled()
})

it('checks caller file evidence again after its own route reads and before allowing the next effect', async () => {
  const file = join(root, 'hooks'), dependency = join(root, 'dependency')
  writeFileSync(file, 'before'); writeFileSync(dependency, 'captured')
  const evidence = inspectHookFile(dependency)
  let reachedEffect = false
  const outcome = await runHookPreparation([file], async attempt => {
    disk.onStat = path => {
      if (path !== file) return
      disk.onStat = undefined
      writeFileSync(dependency, 'newer')
    }
    attempt.verify()
    reachedEffect = true
  }, { verify: evidence.verify }).catch(error => error)
  expect(outcome).toEqual(expect.objectContaining({ message: expect.stringMatching(/changed/) }))
  expect(reachedEffect).toBe(false)
})

it.each(['join', 'settle'] as const)('keeps caller file dependencies through a %s wait', async kind => {
  const file = join(root, 'hooks'), dependency = join(root, 'dependency')
  writeFileSync(file, 'before'); writeFileSync(dependency, 'captured')
  const evidence = inspectHookFile(dependency), confirmed = vi.fn(), work = vi.fn(async () => true)
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('original', attempt), { identity: 'original' }).catch(error => error)
  await drain()
  const waiting = runHookPreparation([file], work, { identity: kind === 'join' ? 'original' : 'replacement',
    settleConflicts: kind === 'settle', verify: evidence.verify, confirmed }).catch(error => error)
  await drain()
  writeFileSync(dependency, 'newer')
  await release(); await previous
  expect(await waiting).toEqual(expect.objectContaining({ message: expect.stringMatching(/changed/) }))
  expect(work).not.toHaveBeenCalled()
  expect(confirmed).not.toHaveBeenCalled()
})

it.each(['join', 'settle'] as const)('refuses stale caller dependencies before entering a %s wait', async kind => {
  const file = join(root, 'hooks'), dependency = join(root, 'dependency')
  writeFileSync(file, 'before'); writeFileSync(dependency, 'captured')
  const evidence = inspectHookFile(dependency), work = vi.fn(async () => true)
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('original', attempt), { identity: 'original' }).catch(error => error)
  await drain(); writeFileSync(dependency, 'newer')
  let refusal: unknown
  const waiting = runHookPreparation([file], work, { identity: kind === 'join' ? 'original' : 'replacement',
    settleConflicts: kind === 'settle', verify: evidence.verify }).catch(error => { refusal = error })
  try {
    await drain()
    expect(refusal).toEqual(expect.objectContaining({ message: expect.stringMatching(/changed/) }))
    expect(work).not.toHaveBeenCalled()
  } finally { await release(); await waiting; await previous }
  // Refusing an invalid waiter must not revoke the original writer.
  expect(readFileSync(file, 'utf8')).toBe('original')
})

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

const settlement = { settleConflicts: true }
it('waits for actual conflicting I/O settlement after its caller timed out, then captures its own files', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('obsolete', attempt), { timeoutMs: 10 }).catch(error => error)
  await drain()
  const fd = [...disk.pending.keys()][0]
  await vi.advanceTimersByTimeAsync(10)
  expect((await previous).message).toMatch(/deadline/)
  const work = vi.fn(async (attempt: HookPreparationAttempt) => {
    expect(readFileSync(file, 'utf8')).toBe('before')
    await inspectHookFile(file).replace('launch', attempt)
    return true
  })
  let answered = false
  const launch = runHookPreparation([file], work, { ...settlement, timeoutMs: 100 }).catch(error => error).finally(() => { answered = true })
  await drain()
  expect(answered).toBe(false)
  expect(work).not.toHaveBeenCalled()
  expect(fstatSync(fd).isFile()).toBe(true)
  await release()
  expect(await launch).toBe(true)
  expect(work).toHaveBeenCalledOnce()
  expect(readFileSync(file, 'utf8')).toBe('launch')
})

it.each(['owner', 'alias'] as const)('rechecks the original %s after conflicting work actually settles', async change => {
  const file = join(root, 'hooks'), alias = join(root, 'alias'), other = join(root, 'other')
  writeFileSync(file, 'before'); writeFileSync(other, 'foreign'); symlinkSync(file, alias)
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('obsolete', attempt)).catch(error => error)
  await drain()
  let current = true
  const work = vi.fn(async () => true)
  const launch = runHookPreparation([alias], work, { ...settlement, current: () => current }).catch(error => error)
  await drain()
  if (change === 'owner') current = false
  else { unlinkSync(alias); symlinkSync(other, alias) }
  await release(); await previous
  expect((await launch).message).toMatch(/changed/)
  expect(work).not.toHaveBeenCalled()
  expect(readFileSync(file, 'utf8')).toBe('before')
  expect(readFileSync(other, 'utf8')).toBe('foreign')
})

it('bounds a launch settlement wait without releasing the old descriptor or starting new work', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('obsolete', attempt)).catch(error => error)
  await drain()
  const fd = [...disk.pending.keys()][0], work = vi.fn(async () => true)
  const launch = runHookPreparation([file], work, { ...settlement, timeoutMs: 5 }).catch(error => error)
  await vi.advanceTimersByTimeAsync(5)
  expect((await launch).message).toMatch(/deadline/)
  expect(fstatSync(fd).isFile()).toBe(true)
  expect(work).not.toHaveBeenCalled()
  await expect(runHookPreparation([file], work)).rejects.toThrow(/still owns/)
  await release(); await previous
  expect(readFileSync(file, 'utf8')).toBe('before')
})

it('uses the existing sixteen-waiter bound and makes only one fresh reservation after settlement', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('obsolete', attempt)).catch(error => error)
  await drain()
  const work = vi.fn(async () => true)
  const waiting = Array.from({ length: 16 }, () => runHookPreparation([file], work, settlement).catch(error => error))
  await expect(runHookPreparation([file], work, settlement)).rejects.toThrow(/waiters.*occupied/)
  await release(); await previous
  const answers = await Promise.all(waiting)
  expect(answers.filter(answer => answer === true)).toHaveLength(1)
  expect(work).toHaveBeenCalledOnce()
})


it('spends the original deadline across settlement and its own publication', async () => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('obsolete', attempt)).catch(error => error)
  await drain()
  const work = vi.fn((attempt: HookPreparationAttempt) => inspectHookFile(file).replace('launch', attempt))
  const launch = runHookPreparation([file], work, { ...settlement, timeoutMs: 10 }).catch(error => error)
  await vi.advanceTimersByTimeAsync(6)
  const [fd, finish] = [...disk.pending.entries()][0]
  disk.pending.delete(fd); finish(null)
  await drain()
  expect(work).toHaveBeenCalledOnce()
  expect(disk.pending.size).toBe(1)
  await vi.advanceTimersByTimeAsync(4)
  expect((await launch).message).toMatch(/deadline/)
  expect(readFileSync(file, 'utf8')).toBe('before')
  await release(); await previous
  expect(readFileSync(file, 'utf8')).toBe('before')
})

it.each(['settle', 'join'] as const)('keeps sixteen expired %s waiters charged until their underlying promise settles', async kind => {
  const file = join(root, 'hooks'); writeFileSync(file, 'before')
  const previous = runHookPreparation([file], attempt => inspectHookFile(file).replace('original', attempt), { identity: 'original', timeoutMs: 1_000 }).catch(error => error)
  await drain()
  const work = vi.fn(async () => true)
  const options = { timeoutMs: 5, ...(kind === 'join' ? { identity: 'original' } : settlement) }
  const waiting = Array.from({ length: 16 }, () => runHookPreparation([file], work, options).catch(error => error))
  await vi.advanceTimersByTimeAsync(5)
  expect((await Promise.all(waiting)).every(error => /deadline/.test(error.message))).toBe(true)
  expect(disk.pending.size).toBe(1)
  const overflow = runHookPreparation([file], work, options).catch(error => error)
  await vi.advanceTimersByTimeAsync(5)
  expect((await overflow).message).toMatch(/waiters.*occupied/)
  expect(work).not.toHaveBeenCalled()
  await release(); await previous
  expect(await runHookPreparation([file], work, options)).toBe(true)
  expect(work).toHaveBeenCalledOnce()
})
