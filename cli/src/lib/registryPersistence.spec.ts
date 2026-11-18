import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const interleave = vi.hoisted(() => ({
  read: undefined as undefined | ((path: string, value: unknown) => Promise<unknown>),
  stat: undefined as undefined | ((path: string, value: unknown) => Promise<unknown>),
  phase: undefined as undefined | ((path: string, phase: string) => Promise<void>),
}))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const value = await actual.mkdir(...args)
      await interleave.phase?.(String(args[0]), 'mkdir')
      return value
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args)
      return interleave.read ? interleave.read(String(args[0]), value) : value
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const value = await actual.lstat(...args)
      return interleave.stat ? interleave.stat(String(args[0]), value) : value
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle)
      handle.writeFile = async (...options) => { await write(...options); await interleave.phase?.(String(args[0]), 'write') }
      handle.sync = async () => { await sync(); await interleave.phase?.(String(args[0]), 'sync') }
      const readBytes = handle.read.bind(handle)
      handle.read = (async (...options: Parameters<typeof handle.read>) => {
        const value = await readBytes(...options)
        return interleave.read && value.bytesRead > 0 ? interleave.read(String(args[0]), value) : value
      }) as typeof handle.read
      const read = handle.readFile.bind(handle)
      handle.readFile = (async (...options: Parameters<typeof handle.readFile>) => {
        const value = await read(...options)
        return interleave.read ? interleave.read(String(args[0]), value) : value
      }) as typeof handle.readFile
      return handle
    },
  }
})

import { AtomicWriteUnconfirmed, RegistryWriteQueue, registryFileLock } from './registryPersistence.js'
let directory: string, lock: string, owner: string
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const deadline = (ms = 5_000) => {
  const expires = performance.now() + ms
  return { expires, check: () => { if (performance.now() >= expires) throw new Error('fixture deadline') } }
}
const publish = (token: string, pid = process.pid) => writeFileSync(owner,
  JSON.stringify({ token, pid, startMarker: '' }), { mode: 0o600 })
const replace = () => {
  rmSync(lock, { recursive: true, force: true })
  mkdirSync(lock, { mode: 0o700 })
  publish('replacement-owner')
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'registry-lock-interleave-'))
  lock = join(directory, 'registry.json.lock')
  owner = join(lock, 'owner.json')
})
afterEach(() => {
  interleave.read = undefined
  interleave.stat = undefined
  interleave.phase = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it('does not remove a replacement lock after its cleanup read has yielded', async () => {
  const entered = deferred(), release = deferred()
  let cleanup = false
  interleave.read = async (path, value) => {
    if (path === owner && cleanup) { entered.resolve(); await release.promise }
    return value
  }
  const committed = registryFileLock(directory, deadline(), async () => { cleanup = true; return 'committed' })
  await entered.promise
  replace()
  release.resolve()
  expect(await committed).toBe('committed')
  expect(existsSync(owner)).toBe(true)
  expect(JSON.parse(readFileSync(owner, 'utf8')).token).toBe('replacement-owner')
})

it('does not reclaim an ownerless directory after its owner was published during inspection', async () => {
  mkdirSync(lock, { mode: 0o700 })
  const old = new Date(Date.now() - 10_000)
  utimesSync(lock, old, old)
  const entered = deferred(), release = deferred()
  let inspections = 0
  interleave.stat = async (path, value) => {
    if (path === lock && ++inspections === 2) { entered.resolve(); await release.promise }
    return value
  }
  const apply = vi.fn(async () => {})
  const committed = registryFileLock(directory, deadline(500), apply)
  const settled = committed.catch(error => error)
  await entered.promise
  publish('late-owner')
  release.resolve()
  expect(await settled).toBeInstanceOf(Error)
  expect(apply).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(owner, 'utf8')).token).toBe('late-owner')
})

it('does not reclaim a replacement after a dead owner recheck yielded', async () => {
  mkdirSync(lock, { mode: 0o700 })
  publish('dead-owner', 2_147_483_647)
  const entered = deferred(), release = deferred()
  let reads = 0
  interleave.read = async (path, value) => {
    if (path === owner && ++reads === 2) { entered.resolve(); await release.promise }
    return value
  }
  const apply = vi.fn(async () => {})
  const committed = registryFileLock(directory, deadline(500), apply)
  const settled = committed.catch(error => error)
  await entered.promise
  replace()
  release.resolve()
  expect(await settled).toBeInstanceOf(Error)
  expect(apply).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(owner, 'utf8')).token).toBe('replacement-owner')
})

it('privately reads and bounds the owner at final publication', async () => {
  await registryFileLock(directory, deadline(), async checkOwner => {
    const contents = readFileSync(owner, 'utf8')
    writeFileSync(owner, contents + ' '.repeat(8_192))
    expect(checkOwner).toThrow()
    writeFileSync(owner, contents)
    const outside = join(directory, 'outside-owner')
    writeFileSync(outside, contents, { mode: 0o600 })
    rmSync(owner)
    symlinkSync(outside, owner)
    expect(checkOwner).toThrow()
    rmSync(owner)
    writeFileSync(owner, contents, { mode: 0o600 })
  })
})

it('holds a lock with unexpected contents without walking or removing them', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await registryFileLock(directory, deadline(), async () => {
    mkdirSync(join(lock, 'unexpected'), { mode: 0o700 })
    writeFileSync(join(lock, 'unexpected', 'keep'), 'keep')
  })
  expect(existsSync(owner)).toBe(true)
  expect(readFileSync(join(lock, 'unexpected', 'keep'), 'utf8')).toBe('keep')
  expect(warn).toHaveBeenCalledWith('[registry] lock cleanup refused unexpected contents')
  warn.mockRestore()
})

it('expires queued replies without running them and retains active ownership until settlement', async () => {
  vi.useFakeTimers()
  const queue = new RegistryWriteQueue(), active = deferred()
  const first = queue.run(async limit => { await active.promise; limit.check() }).catch(error => error)
  const expired = vi.fn(async () => {})
  const second = queue.run(expired).catch(error => error)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await first).toBeInstanceOf(Error)
  expect(await second).toBeInstanceOf(Error)
  expect(expired).not.toHaveBeenCalled()
  const next = vi.fn(async () => 'next')
  const third = queue.run(next)
  expect(next).not.toHaveBeenCalled()
  active.resolve()
  expect(await third).toBe('next')
  expect(expired).not.toHaveBeenCalled()
})

it('admits at most 64 queued operations behind the unsettled writer', async () => {
  const queue = new RegistryWriteQueue(), active = deferred()
  const first = queue.run(async () => active.promise)
  const queued = Array.from({ length: 64 }, () => queue.run(async () => 'accepted'))
  const overflow = vi.fn(async () => 'overflow')
  await expect(queue.run(overflow)).rejects.toThrow('queue is full')
  expect(overflow).not.toHaveBeenCalled()
  active.resolve()
  await first
  expect(await Promise.all(queued)).toEqual(Array(64).fill('accepted'))
})

it('cannot acknowledge a writer after a caller catches its terminal close failure', async () => {
  const queue = new RegistryWriteQueue()
  const result = queue.run(async deadline => {
    try { deadline.failClosed() } catch { /* Ordinary observation writes log their own failures. */ }
    return 'must not acknowledge'
  })
  await expect(result).rejects.toThrow('restart required')
  await expect(queue.run(async () => 'must not run')).rejects.toThrow('restart required')
})

it.each(['mkdir', 'write', 'sync'])('does not publish after the deadline expires during owner %s', async phase => {
  const entered = deferred(), release = deferred()
  let expired = false
  interleave.phase = async (path, at) => {
    if (at !== phase || path !== (phase === 'mkdir' ? lock : owner)) return
    entered.resolve(); await release.promise
  }
  const apply = vi.fn(async () => 'must not publish')
  const settled = registryFileLock(directory, { expires: performance.now() + 5_000,
    check: () => { if (expired) throw new Error('fixture deadline') } }, apply).catch(error => error)
  await entered.promise
  expired = true
  expect(existsSync(lock)).toBe(true)
  release.resolve()
  expect(await settled).toBeInstanceOf(Error)
  expect(apply).not.toHaveBeenCalled()
  // Before an inode/token was captured the ownerless directory must remain conservative debris.
  expect(existsSync(lock)).toBe(phase === 'mkdir')
})

it('includes late owner publication in the two-second acquisition budget', async () => {
  const entered = deferred(), release = deferred(), begun = performance.now()
  interleave.phase = async (path, at) => {
    if (path === owner && at === 'sync') { entered.resolve(); await release.promise }
  }
  const apply = vi.fn(async () => {})
  const result = registryFileLock(directory, deadline(), apply).catch(error => error)
  await entered.promise
  vi.spyOn(performance, 'now').mockReturnValue(begun + 2_500)
  release.resolve()
  expect(await result).toMatchObject({ message: expect.stringContaining('registry lock is busy') })
  expect(apply).not.toHaveBeenCalled()
  expect(existsSync(lock)).toBe(false)
})

// Cleanup can fail after the image became visible; that cannot turn uncertainty into a proven refusal.
it.each(['prepare', 'published', 'admitted'] as const)('classifies an escaping cleanup failure at %s without releasing its writer early', async phase => {
  const queue = new RegistryWriteQueue(), cleanup = deferred(), entered = deferred()
  const failure = new Error('fixture cleanup refused')
  const result = queue.run(async deadline => {
    if (phase !== 'prepare') deadline.markPublished()
    if (phase === 'admitted') deadline.markAdmitted()
    entered.resolve()
    await cleanup.promise
    throw failure
  }).catch(error => error)
  await entered.promise
  const next = vi.fn(async () => 'next'), following = queue.run(next)
  expect(next).not.toHaveBeenCalled()
  cleanup.resolve()
  const error = await result
  if (phase === 'published') {
    expect(error).toBeInstanceOf(AtomicWriteUnconfirmed)
    expect(error).toMatchObject({ cause: failure, retryable: false })
  } else if (phase === 'admitted') {
    expect(error.constructor.name).toBe('RegistryCleanupUnavailable')
    expect(error.cause).toBe(failure)
    expect(error).not.toBeInstanceOf(AtomicWriteUnconfirmed)
    expect(error.message).toBe('Registry persistence unavailable: admitted write cleanup failed; restart required')
  } else expect(error).toBe(failure)
  expect(await following).toBe('next')
})

it('preserves an existing uncertain publication and its finite disk cause', async () => {
  const queue = new RegistryWriteQueue()
  const error = new AtomicWriteUnconfirmed(Object.assign(new Error('fixture full disk'), { code: 'ENOSPC' }), true)
  await expect(queue.run(async deadline => { deadline.markPublished(); throw error })).rejects.toBe(error)
})

it('begins a new publication only after the prior phase was admitted', async () => {
  const queue = new RegistryWriteQueue(), failure = new Error('fixture next preparation failed')
  await expect(queue.run(async deadline => {
    deadline.beginPublication(); deadline.beginPublication()
    deadline.markAdmitted() // No publication yet: a duplicate completion cannot invent admission.
    deadline.markPublished(); deadline.markPublished()
    expect(() => deadline.beginPublication()).toThrow(AtomicWriteUnconfirmed)
    deadline.markAdmitted(); deadline.markAdmitted()
    deadline.beginPublication(); deadline.beginPublication()
    throw failure
  })).rejects.toBe(failure)
})

it('does not invent admitted state from completion before any publication', async () => {
  const queue = new RegistryWriteQueue(), failure = new Error('fixture preparation failed')
  await expect(queue.run(async deadline => {
    deadline.beginPublication(); deadline.markAdmitted(); deadline.markAdmitted()
    throw failure
  })).rejects.toBe(failure)
})

it('keeps a new unadmitted publication uncertain after an earlier admitted phase', async () => {
  const queue = new RegistryWriteQueue(), failure = new Error('fixture second publication failed')
  const error = await queue.run(async deadline => {
    deadline.markPublished(); deadline.markAdmitted()
    deadline.markPublished()
    throw failure
  }).catch(error => error)
  expect(error).toBeInstanceOf(AtomicWriteUnconfirmed)
  expect(error).toMatchObject({ cause: failure, retryable: false })
})

it('names an admitted cleanup deadline without changing the admitted row into publication uncertainty', async () => {
  const queue = new RegistryWriteQueue(), entered = deferred(), cleanup = deferred()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const result = queue.run(async deadline => {
    deadline.markPublished(); deadline.markAdmitted()
    entered.resolve(); await cleanup.promise
    deadline.check()
  }).catch(error => error)
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await result).constructor.name).toBe('RegistryCleanupUnavailable')
    expect(await result).not.toBeInstanceOf(AtomicWriteUnconfirmed)
  } finally { cleanup.resolve(); vi.useRealTimers(); await queue.finish(async () => {}) }
})
