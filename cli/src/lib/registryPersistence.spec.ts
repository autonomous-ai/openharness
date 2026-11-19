import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const interleave = vi.hoisted(() => ({
  read: undefined as undefined | ((path: string, value: unknown) => Promise<unknown>),
  stat: undefined as undefined | ((path: string, value: unknown) => Promise<unknown>),
  phase: undefined as undefined | ((path: string, phase: string) => Promise<void>),
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
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
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await interleave.rename?.(String(args[0]), String(args[1]))
      return actual.rename(...args)
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const value = await actual.lstat(...args)
      return interleave.stat ? interleave.stat(String(args[0]), value) : value
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      await interleave.phase?.(String(args[0]), 'open')
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

import { RegistryWriteQueue, registryFileLock } from './registryPersistence.js'
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
/** The folder a phase at [path] works in, when it is this process's temporary lock folder. */
const temporaryAt = (path: string, phase: string) => {
  const folder = phase === 'mkdir' ? path : basename(path) === 'owner.json' ? dirname(path) : ''
  return dirname(folder) === directory && basename(folder).startsWith(`registry.json.lock.${process.pid}.`)
    && folder.endsWith('.tmp') ? folder : null
}
const lockEntries = () => readdirSync(directory).filter(name => name.startsWith('registry.json.lock'))
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
  interleave.rename = undefined
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

it.each(['mkdir', 'write', 'sync'])('does not publish after the deadline expires during owner %s', async phase => {
  const entered = deferred(), release = deferred()
  let expired = false, folder = ''
  interleave.phase = async (path, at) => {
    if (at !== phase || !temporaryAt(path, at)) return
    folder = temporaryAt(path, at)!
    entered.resolve(); await release.promise
  }
  const apply = vi.fn(async () => 'must not publish')
  const settled = registryFileLock(directory, { expires: performance.now() + 5_000,
    check: () => { if (expired) throw new Error('fixture deadline') } }, apply).catch(error => error)
  await entered.promise
  expired = true
  expect(existsSync(folder)).toBe(true)
  release.resolve()
  expect(await settled).toBeInstanceOf(Error)
  expect(apply).not.toHaveBeenCalled()
  expect(lockEntries()).toEqual([])
})

it('includes late owner publication in the two-second acquisition budget', async () => {
  const entered = deferred(), release = deferred(), begun = performance.now()
  interleave.phase = async (path, at) => {
    if (at === 'sync' && temporaryAt(path, at)) { entered.resolve(); await release.promise }
  }
  const apply = vi.fn(async () => {})
  const result = registryFileLock(directory, deadline(), apply).catch(error => error)
  await entered.promise
  vi.spyOn(performance, 'now').mockReturnValue(begun + 2_500)
  release.resolve()
  expect(await result).toMatchObject({ message: expect.stringContaining('registry lock is busy') })
  expect(apply).not.toHaveBeenCalled()
  expect(lockEntries()).toEqual([])
})

it('a lock is never there without its owner', async () => {
  const violations: string[] = []
  const look = (at: string) => {
    if (!existsSync(lock)) return
    try {
      const saved = JSON.parse(readFileSync(owner, 'utf8'))
      if (saved.pid !== process.pid || !saved.token) violations.push(at)
    } catch { violations.push(at) }
  }
  interleave.phase = async (_path, at) => look(at)
  interleave.rename = async () => look('rename')
  expect(await registryFileLock(directory, deadline(), async () => 'held')).toBe('held')
  expect(violations).toEqual([])
})

it('a writer stopped while it takes the lock does not hold it', async () => {
  const stopped = deferred(), resume = deferred()
  let opened = false, expired = false
  interleave.phase = async (path, at) => {
    if (at !== 'open' || basename(path) !== 'owner.json' || opened) return
    opened = true
    stopped.resolve(); await resume.promise
  }
  const first = registryFileLock(directory, { expires: performance.now() + 5_000,
    check: () => { if (expired) throw new Error('fixture deadline') } }, async () => 'first').catch(error => error)
  await stopped.promise
  const apply = vi.fn(async () => 'second')
  try { expect(await registryFileLock(directory, deadline(), apply)).toBe('second') }
  finally { expired = true; resume.resolve() }
  expect(apply).toHaveBeenCalledOnce()
  expect(await first).toBeInstanceOf(Error)
  expect(lockEntries()).toEqual([])
})

it('a setup that fails leaves no lock and no temporary folder', async () => {
  interleave.phase = async (path, at) => {
    if (at === 'write' && basename(path) === 'owner.json') throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
  }
  const apply = vi.fn(async () => {})
  await expect(registryFileLock(directory, deadline(), apply)).rejects.toMatchObject({ code: 'ENOSPC' })
  expect(apply).not.toHaveBeenCalled()
  expect(lockEntries()).toEqual([])
})

it('a publish refused for a moment with no lock there is tried again', async () => {
  let renames = 0
  interleave.rename = async (_from, to) => {
    if (to === lock && !renames++) throw Object.assign(new Error('held by a scanner'), { code: 'EPERM' })
  }
  const apply = vi.fn(async () => { expect(lockEntries()).toEqual(['registry.json.lock']) })
  await registryFileLock(directory, deadline(), apply)
  expect(renames).toBe(2)
  expect(apply).toHaveBeenCalledOnce()
  expect(lockEntries()).toEqual([])
})

// Windows refuses a folder renamed onto any folder, so an older build's folder there is waited for like any lock.
it.skipIf(process.platform === 'win32')('an older build that makes its folder between the look and the publish does not enter', async () => {
  let raced = false
  interleave.rename = async (_from, to) => {
    if (to === lock && !raced) { raced = true; mkdirSync(lock, { mode: 0o700 }) }
  }
  await registryFileLock(directory, deadline(), async checkOwner => {
    checkOwner()
    let refused: unknown
    try { closeSync(openSync(owner, 'wx', 0o600)) } catch (error) { refused = (error as NodeJS.ErrnoException).code }
    expect(refused).toBe('EEXIST')
  })
  expect(raced).toBe(true)
})
