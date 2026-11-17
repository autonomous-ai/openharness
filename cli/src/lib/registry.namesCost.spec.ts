import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { registry as Registry } from './registry.js'

const io = vi.hoisted(() => ({ file: '', namesPublished: false, failDirectorySync: false,
  publications: [] as string[], read: undefined as undefined | (() => Promise<void>),
  prepare: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      if (String(args[1]) === io.file) {
        io.publications.push(actual.readFileSync(io.file, 'utf8'))
        io.namesPublished = true
      }
    },
    fsyncSync: (fd: number) => {
      if (io.namesPublished && actual.fstatSync(fd).isDirectory()) {
        io.namesPublished = false
        if (io.failDirectorySync) throw new Error('fixture names directory durability unavailable')
      }
      actual.fsyncSync(fd)
    },
    fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      if (io.namesPublished && actual.fstatSync(fd).isDirectory()) {
        io.namesPublished = false
        if (io.failDirectorySync) { queueMicrotask(() => callback(new Error('fixture names directory durability unavailable'))); return }
      }
      actual.fsync(fd, callback)
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), close = handle.close.bind(handle), sync = handle.sync.bind(handle)
    handle.close = async () => {
      await close()
      if (String(args[0]) === io.file) await io.read?.()
    }
    handle.sync = async () => {
      await sync()
      if (String(args[0]).startsWith(io.file + '.') && String(args[0]).endsWith('.tmp')) await io.prepare?.()
    }
    return handle
  } }
})
vi.mock('./bootId.js', async original => ({ ...await original<object>(),
  currentBootId: () => 'fixture-boot', bootChanged: () => false,
}))

const ID = 'names-cost-agent', CHOSEN = 'Chosen name'
let root = '', registry: typeof Registry | undefined, release: (() => void) | undefined
const accepted: Promise<unknown>[] = []
const names = (): Record<string, string> => JSON.parse(readFileSync(io.file, 'utf8'))
function within<T>(pending: Promise<T>, name: string, ms = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + ' deadline')), ms)
    pending.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
function track<T>(pending: Promise<T>): Promise<T> {
  accepted.push(pending)
  void pending.catch(() => {})
  return pending
}
function hold(boundary: 'read' | 'prepare') {
  let enter!: () => void, resume!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { resume = resolve })
  release = resume
  io[boundary] = async () => {
    io[boundary] = undefined
    enter()
    await within(waiting, 'names image release')
  }
  return { entered: () => within(entered, 'names image arrival'), release: resume }
}

beforeEach(async () => {
  vi.resetModules()
  registry = undefined; release = undefined; accepted.length = 0
  io.namesPublished = false; io.failDirectorySync = false; io.publications = []
  io.read = undefined; io.prepare = undefined
  root = mkdtempSync(join(tmpdir(), 'registry-names-cost-'))
  for (const folder of ['home', 'data', 'runtime']) mkdirSync(join(root, folder), { mode: 0o700 })
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'), CLAUDE_PROJECTS_DIR: join(root, 'home', '.claude', 'projects'),
    CODEX_HOME: join(root, 'home', '.codex'), CURSOR_HOME: join(root, 'home', '.cursor') })) vi.stubEnv(key, value)
  io.file = join(root, 'data', 'agent-names.json')
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}', { mode: 0o600 })
  registry = (await import('./registry.js')).registry
  await registry.load()
  expect(await registry.openProcessAgent({ agentId: ID, engine: 'claude', tmuxPane: '%1',
    processIdentity: { pid: 1001, executable: '/fixture/claude', startMarker: 'fixture-owner' },
  })).not.toBeNull()
  expect(await registry.rename(ID, CHOSEN)).not.toBeNull()
  await registry.flush()
  io.publications = []
})

afterEach(async () => {
  io.read = undefined; io.prepare = undefined; release?.(); release = undefined
  io.failDirectorySync = false; io.namesPublished = false
  let settled = false
  try {
    await within(Promise.allSettled(accepted), 'accepted names caller cleanup', 10_000)
    if (registry) await within(registry.flush({ exiting: true }), 'registry cleanup', 10_000)
    settled = true
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    if (settled && root) rmSync(root, { recursive: true, force: true })
  }
})

it.each([false, true])('keeps an unchanged names image without republishing it (empty=%s)', async empty => {
  if (empty) await registry!.deleteSavedNames([ID])
  io.publications = []
  const before = readFileSync(io.file, 'utf8'), owner = registry!.byAgent(ID)
  await registry!.flush()
  await registry!.flush()
  expect(readFileSync(io.file, 'utf8')).toBe(before)
  expect(registry!.byAgent(ID)).toBe(owner)
  expect(io.publications).toEqual([])
})

it('still publishes an explicit same-value rename before acknowledging it', async () => {
  const held = hold('prepare'), replied = vi.fn()
  const pending = track(registry!.rename(ID, CHOSEN).then(value => { replied(value); return value }))
  await held.entered()
  expect(replied).not.toHaveBeenCalled()
  expect(io.publications).toEqual([])
  held.release()
  expect(await pending).not.toBeNull()
  expect(io.publications).toEqual([JSON.stringify({ [ID]: CHOSEN }, null, 2)])
  expect(registry!.displayName(registry!.byAgent(ID)!)).toBe(CHOSEN)
})

it('refuses a same-value rename whose authority changed during preparation', async () => {
  const before = readFileSync(io.file, 'utf8'), held = hold('prepare')
  let current = true
  const pending = track(registry!.rename(ID, CHOSEN, { current: () => current }))
  await held.entered()
  current = false
  held.release()
  await expect(pending).rejects.toThrow('owner')
  expect(readFileSync(io.file, 'utf8')).toBe(before)
  expect(io.publications).toEqual([])
})

it.skipIf(process.platform === 'win32')('retries an uncertain same-value rename even when its bytes already match', async () => {
  const before = readFileSync(io.file, 'utf8')
  io.failDirectorySync = true
  await expect(registry!.rename(ID, CHOSEN)).rejects.toThrow('name storage write failed')
  expect(io.publications).toEqual([before])
  expect(readFileSync(io.file, 'utf8')).toBe(before)
  io.failDirectorySync = false; io.publications = []
  await registry!.flush()
  expect(io.publications).toEqual([before])
  expect(registry!.displayName(registry!.byAgent(ID)!)).toBe(CHOSEN)
})

it('preserves a name inherited while an earlier flush holds its read', async () => {
  const held = hold('read'), pending = track(registry!.flush())
  await held.entered()
  registry!.inheritName(ID, 'next-session')
  held.release()
  await pending
  await registry!.flush()
  expect(names()).toEqual({ [ID]: CHOSEN, 'next-session': CHOSEN })
})

it('keeps a peer-only name on the existing merge and publication path', async () => {
  writeFileSync(io.file, JSON.stringify({ peer: 'Peer name' }, null, 2))
  await registry!.flush()
  expect(names()).toEqual({ peer: 'Peer name', [ID]: CHOSEN })
  expect(io.publications).toHaveLength(1)
})

it('recreates a missing names image from the local names', async () => {
  rmSync(io.file)
  await registry!.flush()
  expect(names()).toEqual({ [ID]: CHOSEN })
  expect(io.publications).toHaveLength(1)
})

it('still refuses malformed names when no local rename is pending', async () => {
  const before = readFileSync(io.file, 'utf8'), invalid = 'private-invalid-names'
  writeFileSync(io.file, invalid)
  try {
    const failure = await registry!.flush().catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('name storage contains invalid JSON')
    expect(String(failure)).not.toContain(invalid)
    expect(io.publications).toEqual([])
  } finally { writeFileSync(io.file, before) }
})
