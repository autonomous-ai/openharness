import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'

vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const TASK = 'Fix the parser'
const SESSION = 'agent:main:harness-1'
const runtimes = [{ backend: 'tmux' as const, paneId: '%1' }]
let root: string
let lines: string[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'registry-first-task-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  lines = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

async function load() { vi.resetModules(); const mod = await import('./registry.js'); mod.registry.load(); return mod }
const disk = (): RegisteredSession[] => JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
async function pending() {
  const { registry, strictPersistedRow } = await load()
  const row = registry.openPendingAgent({ engine: 'openclaw', cwd: root, runtimes, firstTask: TASK })!
  expect(row).toBeTruthy()
  return { registry, row, strictPersistedRow }
}
async function bound() {
  const made = await pending()
  expect(made.registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root })).toBeTruthy()
  return made
}

it('a first task is saved on the row and read back by the next daemon', async () => {
  const { row } = await pending()
  expect(row.firstTask).toBe(TASK)
  expect(disk()[0].firstTask).toBe(TASK)
  const { registry } = await load()
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
  expect(lines.some(line => line.includes(`[agent] ${row.agentId.slice(0, 8)} first task kept`))).toBe(true)
  expect(lines.filter(line => line.includes(TASK))).toEqual([])
})

it('a bind keeps it', async () => {
  const { registry, row } = await pending()
  const bind = registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root })!
  expect(bind.entry.firstTask).toBe(TASK)
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
})

it('taking it removes it from the file before it is returned, once', async () => {
  const { registry, row } = await bound()
  expect(registry.takeFirstTask(row.agentId)).toBe(TASK)
  expect(disk()[0]).not.toHaveProperty('firstTask')
  expect(registry.takeFirstTask(row.agentId)).toBeNull()
  const next = await load()
  expect(next.registry.byAgent(row.agentId)).not.toHaveProperty('firstTask')
})

it('an unbound agent keeps its task', async () => {
  const { registry, row } = await pending()
  expect(registry.takeFirstTask(row.agentId)).toBeNull()
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
  expect(registry.takeFirstTask('gone')).toBeNull()
})

it('a registry that cannot save keeps the task', async () => {
  const { registry, row } = await bound()
  writeFileSync(join(root, 'registry.json'), '{unreadable', { mode: 0o600 })
  expect(() => registry.takeFirstTask(row.agentId)).toThrow()
  expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
})

it('inside a reconcile transaction it is taken only after the commit', async () => {
  const { registry, row } = await bound()
  let taken: Promise<string | null> | undefined
  await registry.transaction(() => {
    expect(() => registry.takeFirstTask(row.agentId)).toThrow()
    expect(registry.byAgent(row.agentId)?.firstTask).toBe(TASK)
    taken = registry.afterTransaction(() => registry.takeFirstTask(row.agentId))
  })
  await expect(taken).resolves.toBe(TASK)
  expect(disk()[0]).not.toHaveProperty('firstTask')
})

it('the shell an archived agent leaves behind carries no task', async () => {
  const { registry, row } = await bound()
  const archived = registry.byAgent(row.agentId)!
  expect(registry.releaseEngine(row.agentId, true)!.firstTask).toBeUndefined()
  expect(archived.firstTask).toBe(TASK)
})

it('a saved row keeps only a text task', async () => {
  const { strictPersistedRow } = await pending()
  const row = disk()[0]
  expect(strictPersistedRow({ ...row, firstTask: 42 })!.firstTask).toBeUndefined()
  expect(strictPersistedRow({ ...row, firstTask: '' })!.firstTask).toBeUndefined()
  expect(strictPersistedRow({ ...row, firstTask: 'x' })!.firstTask).toBe('x')
})
