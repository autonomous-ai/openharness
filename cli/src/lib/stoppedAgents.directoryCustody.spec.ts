import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { closeSessionStorageFixture } from '../testing/sessionStorageFixture.js'
import type { StoppedAgentStore } from './stoppedAgents.js'
import type { RegisteredSession } from './registry.js'

const io = vi.hoisted(() => ({
  paths: new Map<number, string>(), opens: 0, closed: [] as string[], flushed: [] as string[],
  failClose: undefined as string | undefined, failSync: undefined as string | undefined,
  failRename: undefined as string | undefined, failUnlink: undefined as string | undefined,
  mutationCode: 'EACCES',
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[0]) === io.failRename) throw Object.assign(new Error('fixture refused rename'), { code: io.mutationCode })
      fs.renameSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
      if (String(args[0]) === io.failUnlink) {
        // Model another owner removing the marker after its guarded read.
        if (io.mutationCode === 'ENOENT') fs.unlinkSync(...args)
        throw Object.assign(new Error('fixture refused unlink'), { code: io.mutationCode })
      }
      fs.unlinkSync(...args)
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args); io.paths.set(fd, String(args[0])); io.opens++; return fd
    },
    closeSync: (fd: number) => {
      const path = io.paths.get(fd)!
      fs.closeSync(fd); io.paths.delete(fd); io.closed.push(path)
      if (io.failClose !== undefined && path === io.failClose) throw new Error('fixture uncertain directory close')
    },
    fsyncSync: (fd: number) => {
      const path = io.paths.get(fd)!
      io.flushed.push(path)
      if (io.failSync !== undefined && path === io.failSync) throw Object.assign(new Error('fixture directory flush failure'), { code: 'EIO' })
      fs.fsyncSync(fd)
    },
  }
})

let root: string, folder: string, aside: string, store: StoppedAgentStore, saved: RegisteredSession
let poisoned = false
beforeEach(async () => {
  vi.resetModules()
  poisoned = false
  io.failClose = io.failSync = undefined
  io.failRename = io.failUnlink = undefined
  root = fs.mkdtempSync(join(tmpdir(), 'stopped-directory-custody-'))
  folder = join(root, 'stopped-agents'); aside = join(folder, 'superseded')
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  const { registry } = await import('./registry.js'), { StoppedAgentStore } = await import('./stoppedAgents.js')
  const entry = (await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%8' }], cwd: root }))!
  saved = { ...entry, sessionId: 'custody-conversation' }
  store = new StoppedAgentStore(folder)
  await store.save(saved); await registry.flush()
  store.beginResume(saved.agentId)
  io.closed.length = 0; io.flushed.length = 0
}, 60_000)
afterEach(async () => {
  io.failClose = io.failSync = undefined
  io.failRename = io.failUnlink = undefined
  try {
    const closed = closeSessionStorageFixture((await import('./sessionStorage.js')).sessionStorage)
    if (!poisoned) await closed
    else {
      // The helper still waits for actual child close and proves PID absence before returning this terminal latch error.
      const failure = await closed.then(() => null, error => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.errors).toEqual([expect.objectContaining({ code: 'cleanup-unconfirmed' })])
    }
  }
  finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('closes the held directory when the Resume token does not match', () => {
  store.finishResume(saved.agentId, 'different-token')
  expect(fs.existsSync(join(folder, `${saved.agentId}.resume`))).toBe(true)
  expect(io.flushed).toEqual([])
  expect(io.closed.filter(path => path === folder)).toHaveLength(1)
  expect([...io.paths.values()].filter(path => path === folder)).toEqual([])
})

it.skipIf(process.platform === 'win32')('flushes the superseded name before confirming the removed source name', async () => {
  await store.supersede(saved.agentId, () => { io.closed.length = 0; io.flushed.length = 0; return true })
  expect(io.flushed).toEqual([aside, folder])
  for (const path of [aside, folder]) {
    expect(io.closed.filter(closed => closed === path)).toHaveLength(1)
    expect([...io.paths.values()].includes(path)).toBe(false)
  }
  expect(fs.existsSync(join(aside, `${saved.agentId}.json`))).toBe(true)
  expect(fs.existsSync(join(folder, `${saved.agentId}.resume`))).toBe(false)
})

it.skipIf(process.platform === 'win32')('closes both actual directory handles even when the first close is uncertain', async () => {
  const { StateFileCleanupUnconfirmed } = await import('./secureState.js')
  await expect(store.supersede(saved.agentId, () => {
    io.closed.length = 0; io.failClose = aside; poisoned = true; return true
  })).rejects.toBeInstanceOf(StateFileCleanupUnconfirmed)
  for (const path of [aside, folder]) {
    expect(io.closed.filter(closed => closed === path)).toHaveLength(1)
    expect([...io.paths.values()].includes(path)).toBe(false)
  }
  const opened = io.opens
  expect(() => store.finishResume(saved.agentId)).toThrow(StateFileCleanupUnconfirmed)
  expect(io.opens).toBe(opened)
})

it.skipIf(process.platform === 'win32').each(['destination', 'source'] as const)(
  'reports mutation uncertainty when the held %s directory flush fails', async which => {
  const { AtomicWriteUnconfirmed } = await import('./secureState.js')
  const result = await store.supersede(saved.agentId, () => {
    io.closed.length = 0; io.failSync = which === 'destination' ? aside : folder; return true
  }).catch(error => error)
  expect(result).toBeInstanceOf(AtomicWriteUnconfirmed)
  expect(result).toMatchObject({ retryable: false, cause: { code: 'EIO' } })
  expect(fs.existsSync(join(aside, `${saved.agentId}.json`))).toBe(true)
  for (const path of [aside, folder]) {
    expect(io.closed.filter(closed => closed === path)).toHaveLength(1)
    expect([...io.paths.values()].includes(path)).toBe(false)
  }
})

it.each(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'EBUSY'])(
  'preserves the definite %s refusal when the archive rename has not happened', async code => {
  const { AtomicWriteUnconfirmed } = await import('./secureState.js')
  io.failRename = join(folder, `${saved.agentId}.json`); io.mutationCode = code
  const result = await store.supersede(saved.agentId).catch(error => error)
  expect(result).not.toBeInstanceOf(AtomicWriteUnconfirmed)
  expect(result).toMatchObject({ code })
  expect(fs.existsSync(io.failRename)).toBe(true)
  expect(fs.existsSync(join(folder, `${saved.agentId}.resume`))).toBe(true)
  expect(fs.existsSync(join(aside, `${saved.agentId}.json`))).toBe(false)
  expect(io.flushed).toEqual([])
  expect([...io.paths.values()].filter(path => path === aside || path === folder)).toEqual([])
})

it('reports uncertainty when marker removal fails after the archive moved', async () => {
  const { AtomicWriteUnconfirmed } = await import('./secureState.js')
  io.failUnlink = join(folder, `${saved.agentId}.resume`); io.mutationCode = 'EACCES'
  const result = await store.supersede(saved.agentId).catch(error => error)
  expect(result).toBeInstanceOf(AtomicWriteUnconfirmed)
  expect(result).toMatchObject({ retryable: false, cause: { code: 'EACCES' } })
  expect(fs.existsSync(join(aside, `${saved.agentId}.json`))).toBe(true)
  expect(fs.existsSync(join(folder, `${saved.agentId}.json`))).toBe(false)
  expect(fs.existsSync(io.failUnlink)).toBe(true)
  expect([...io.paths.values()].filter(path => path === aside || path === folder)).toEqual([])
})

it('accepts a Resume marker removed after its guarded read', () => {
  io.failUnlink = join(folder, `${saved.agentId}.resume`); io.mutationCode = 'ENOENT'
  expect(() => store.finishResume(saved.agentId)).not.toThrow()
  expect(fs.existsSync(io.failUnlink)).toBe(false)
  expect(io.flushed).toEqual([])
  expect([...io.paths.values()].filter(path => path === folder)).toEqual([])
})

it.skipIf(process.platform === 'win32')('confirms a superseded archive when another owner already removed its marker', async () => {
  io.failUnlink = join(folder, `${saved.agentId}.resume`); io.mutationCode = 'ENOENT'
  await expect(store.supersede(saved.agentId)).resolves.toMatchObject({ agentId: saved.agentId })
  expect(fs.existsSync(join(aside, `${saved.agentId}.json`))).toBe(true)
  expect(fs.existsSync(io.failUnlink)).toBe(false)
  expect(io.flushed).toEqual([aside, folder])
  expect([...io.paths.values()].filter(path => path === aside || path === folder)).toEqual([])
})

it.each(['EPERM', 'EBUSY'])('preserves a definite %s archive deletion refusal', async code => {
  const { AtomicWriteUnconfirmed } = await import('./secureState.js')
  io.failUnlink = join(folder, `${saved.agentId}.json`); io.mutationCode = code
  const result = await store.remove(saved.agentId).catch(error => error)
  expect(result).not.toBeInstanceOf(AtomicWriteUnconfirmed)
  expect(result).toMatchObject({ code })
  expect(fs.existsSync(io.failUnlink)).toBe(true)
  expect(io.flushed).toEqual([])
  expect([...io.paths.values()].filter(path => path === folder)).toEqual([])
})
