import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fsyncSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { registry as Registry } from './registry.js'

// Rows are compared without regard to key order. These cases check that this hides only key order:
// another writer's real changes still land, local real changes still write, and the file keeps its format.
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), mkdirSync: vi.fn(fs.mkdirSync) }
})

type Row = Record<string, unknown>
let directory: string
let file: string
let registry: typeof Registry
const input = {
  agentId: 'observed-agent', engine: 'claude' as const, tmuxPane: '%31', cwd: '/fixture/project',
  processIdentity: { pid: 1031, executable: '/fixture/claude', startMarker: 'fixture-1031' },
}
const plan = {
  id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-conversation',
  requestedAt: 1790900000000, state: 'waiting' as const,
}
const readRows = (): Row[] => JSON.parse(readFileSync(file, 'utf8'))
const writeRows = (rows: unknown[]) => writeFileSync(file, JSON.stringify(rows, null, 2))
const clearCounts = () => vi.clearAllMocks()
const registryWrites = () => vi.mocked(renameSync).mock.calls.filter(([, target]) => target === file).length
const lockAttempts = () => vi.mocked(mkdirSync).mock.calls.filter(([target]) => target === `${file}.lock`).length
/** Every object's keys reversed, at every depth; array order kept. Same data, as another writer may order it. */
const reversedDeep = (value: unknown): unknown => Array.isArray(value)
  ? value.map(reversedDeep)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reversedDeep(inner)]))
    : value
const tick = () => vi.setSystemTime(Date.now() + 5000)

async function observe(on: typeof Registry = registry, identity: Row = { ...input.processIdentity }) {
  const row = on.byAgent(input.agentId)!
  await on.transaction(() => {
    expect(on.updateRuntimes(row.agentId, row.runtimes, row.primaryRuntimeKey)).toBe(true)
    expect(on.updateProcessIdentity(row.agentId, identity as typeof input.processIdentity)).toBe(true)
  })
}

async function freshRegistry(): Promise<typeof Registry> {
  vi.resetModules()
  const next = (await import('./registry.js')).registry
  next.load()
  return next
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1790900000000)
  directory = mkdtempSync(join(tmpdir(), 'registry-fingerprint-'))
  file = join(directory, 'registry.json')
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(key, directory)
  registry = (await import('./registry.js')).registry
  registry.load()
  expect(registry.openProcessAgent(input)).not.toBeNull()
  clearCounts()
  tick()
})

afterEach(() => {
  vi.mocked(fsyncSync).mockReset()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('key-order-insensitive row comparison', () => {
  it('adopts another writer\'s nested change while idle, then stays quiet', async () => {
    registry.setClosePlan(input.agentId, plan)
    const [saved] = readRows()
    const external = { ...saved, closePlan: { ...plan, state: 'failed', detail: 'external' } }
    writeRows([reversedDeep(external)])
    clearCounts()
    await observe()
    expect(registryWrites()).toBe(1)
    expect(registry.byAgent(input.agentId)?.closePlan).toMatchObject({ state: 'failed', detail: 'external' })
    const bytes = readFileSync(file, 'utf8')
    clearCounts()
    for (let pass = 0; pass < 3; pass++) { tick(); await observe() }
    expect(registryWrites()).toBe(0)
    expect(lockAttempts()).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(readRows()[0]).toEqual(external)
  })

  it('does not bring back a close plan another process removed when a different field changes here', () => {
    registry.setClosePlan(input.agentId, plan)
    const [saved] = readRows()
    const { closePlan: _removed, ...withoutPlan } = saved
    writeRows([reversedDeep(withoutPlan)])
    expect(registry.updateProcessIdentity(input.agentId, input.processIdentity, 'ori')).toBe(true)
    expect(readRows()[0]).toMatchObject({ gateway: 'ori' })
    expect(readRows()[0]).not.toHaveProperty('closePlan')
    expect(registry.byAgent(input.agentId)).not.toHaveProperty('closePlan')
  })

  it('does not let a reordered copy of the old process identity overwrite another writer\'s new one', async () => {
    const [saved] = readRows()
    const next = { ...input.processIdentity, startMarker: 'external-generation' }
    writeRows([reversedDeep({ ...saved, processIdentity: next })])
    await observe(registry, reversedDeep(input.processIdentity) as Row)
    expect(readRows()[0].processIdentity).toEqual(next)
    expect(registry.byAgent(input.agentId)?.processIdentity).toEqual(next)
  })

  it('keeps the local value when both sides changed the same nested field, whatever the key order', async () => {
    const [saved] = readRows()
    writeRows([reversedDeep({ ...saved, processIdentity: { ...input.processIdentity, startMarker: 'external' } })])
    const local = { ...input.processIdentity, startMarker: 'local' }
    await observe(registry, reversedDeep(local) as Row)
    expect(readRows()[0].processIdentity).toEqual(local)
    expect(registry.byAgent(input.agentId)?.processIdentity).toEqual(local)
  })

  it('treats a reordered grid as unchanged but writes a changed or cleared one', () => {
    const grid = { baseUrl: 'https://relay.example/v1', model: null }
    expect(registry.updateProcessIdentity(input.agentId, input.processIdentity, undefined, grid)).toBe(true)
    expect(registryWrites()).toBe(1)
    const touchedAt = registry.byAgent(input.agentId)!.touchedAt
    const bytes = readFileSync(file, 'utf8')
    clearCounts()
    tick()
    registry.updateProcessIdentity(input.agentId, reversedDeep(input.processIdentity) as typeof input.processIdentity,
      undefined, { model: null, baseUrl: grid.baseUrl })
    expect(registryWrites()).toBe(0)
    expect(lockAttempts()).toBe(0)
    expect(registry.byAgent(input.agentId)!.touchedAt).toBe(touchedAt)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    tick()
    registry.updateProcessIdentity(input.agentId, input.processIdentity, undefined, { model: 'other', baseUrl: grid.baseUrl })
    expect(registryWrites()).toBe(1)
    expect(readRows()[0]).toMatchObject({ grid: { model: 'other' }, touchedAt: Date.now() })
    tick()
    registry.updateProcessIdentity(input.agentId, input.processIdentity, undefined, null)
    expect(registryWrites()).toBe(2)
    expect(readRows()[0]).toMatchObject({ grid: null, touchedAt: Date.now() })
  })

  it('keeps the saved file format: two-space JSON in insertion order, never sorted keys', async () => {
    // One load first, so the row carries load()'s own normalisation (dshRuntime, gridWebSearch).
    registry.load()
    await observe()
    const [saved] = readRows()
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify([saved], null, 2))
    expect(Object.keys(saved)).not.toEqual(Object.keys(saved).sort())
    expect(Object.keys(saved.processIdentity as Row)).toEqual(['pid', 'executable', 'startMarker'])
    // A file another writer ordered differently is written back in that order, not canonicalised.
    writeRows([reversedDeep(saved)])
    registry.load()
    await observe()
    const [written] = readRows()
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify([written], null, 2))
    expect(written).toEqual(saved)
    expect(Object.keys(written)).not.toEqual(Object.keys(written).sort())
    expect(Object.keys(written.processIdentity as Row)).toEqual(['startMarker', 'executable', 'pid'])
  })

  it('a hand-written file with runtimes out of order saves once in canonical order, then stays quiet', async () => {
    const [saved] = readRows()
    writeRows([{
      ...saved,
      runtimes: [{ paneId: '%32', backend: 'tmux' }, { backend: 'tmux', paneId: '%31' }],
      primaryRuntimeKey: 'tmux\u0000%32',
      tmuxPane: '%31',
    }])
    clearCounts()
    registry.load()
    await observe()
    expect(registryWrites()).toBe(1)
    const row = registry.byAgent(input.agentId)!
    expect(row.runtimes.map((runtime) => runtime.paneId)).toEqual(['%31', '%32'])
    expect(row.primaryRuntimeKey).toBe('tmux\u0000%32')
    expect((readRows()[0].runtimes as Row[]).map((runtime) => runtime.paneId)).toEqual(['%31', '%32'])
    expect(readRows()[0]).toMatchObject({ primaryRuntimeKey: 'tmux\u0000%32', tmuxPane: '%31' })
    clearCounts()
    for (let pass = 0; pass < 3; pass++) { tick(); await observe() }
    expect(registryWrites()).toBe(0)
    expect(lockAttempts()).toBe(0)
  })

  it('two registries over one file keep each other\'s changes and converge instead of rewriting back and forth', async () => {
    const first = registry
    const second = await freshRegistry()
    expect(second.updateProcessIdentity(input.agentId, input.processIdentity, 'ori')).toBe(true)
    tick()
    expect(first.updateProcessIdentity(input.agentId, input.processIdentity, undefined,
      { baseUrl: 'https://relay.example/v1', model: null })).toBe(true)
    clearCounts()
    for (let pass = 0; pass < 2; pass++) {
      tick(); await observe(first)
      tick(); await observe(second)
    }
    // Each side may adopt the other's last commit once; after that, neither writes.
    expect(registryWrites()).toBeLessThanOrEqual(2)
    clearCounts()
    for (let pass = 0; pass < 3; pass++) {
      tick(); await observe(first)
      tick(); await observe(second)
    }
    expect(registryWrites()).toBe(0)
    expect(lockAttempts()).toBe(0)
    expect(fsyncSync).not.toHaveBeenCalled()
    const expected = { gateway: 'ori', grid: { baseUrl: 'https://relay.example/v1', model: null } }
    expect(readRows()[0]).toMatchObject(expected)
    expect(first.byAgent(input.agentId)).toMatchObject(expected)
    expect(second.byAgent(input.agentId)).toMatchObject(expected)
  })
})
