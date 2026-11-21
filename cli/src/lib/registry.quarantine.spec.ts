import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashOf } from './log.js'
import { REGISTRY_WRITE_DEADLINE_MS } from './registryPersistence.js'

// The one way a corrupt registry is still refused: it cannot even be moved aside.
const rename = vi.hoisted(() => ({ fails: false as false | 'error' | 'string' }))
vi.mock('fs', async (real) => {
  const actual = await real<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string) => {
      if (rename.fails === 'error' && String(to).includes('.corrupt-')) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
      if (rename.fails === 'string' && String(to).includes('.corrupt-')) throw 'read-only file system'
      return actual.renameSync(from, to)
    },
  }
})

vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
const deadline = await vi.hoisted(() => import('../testing/registryDeadline.js'))
vi.mock('node:fs/promises', original => deadline.slowSyncFsPromises(original))

let dataDir = ''
const processIdentity = (pid: number) => ({ pid, executable: 'claude', startMarker: `Mon Aug 10 10:00:${String(pid % 60).padStart(2, '0')} 2026` })

async function loadRegistry() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  process.env.CLAUDE_PROJECTS_DIR = dataDir
  process.env.CODEX_HOME = dataDir
  process.env.CURSOR_HOME = dataDir
  return (await import('./registry.js')).registry
}

describe('a registry no version can load', () => {
  let error: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    // No test here means the write deadline to pass: how fast this machine writes the registry never fails them.
    deadline.holdRegistryDeadline(REGISTRY_WRITE_DEADLINE_MS)
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-quarantine-'))
    rename.fails = false
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('with two rows claiming one agent: moved aside, and the registry starts empty and writable', async () => {
    const registry = await loadRegistry()
    registry.load()
    ;(await registry.openProcessAgent({ agentId: 'a1', engine: 'claude', tmuxPane: '%1', processIdentity: processIdentity(101) }))
    ;(await registry.openProcessAgent({ agentId: 'a2', engine: 'claude', tmuxPane: '%2', processIdentity: processIdentity(102) }))
    const file = join(dataDir, 'registry.json')
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    rows[1] = { ...rows[1], agentId: rows[0].agentId }
    const duplicated = JSON.stringify(rows)
    writeFileSync(file, duplicated, { mode: 0o600 })

    const again = await loadRegistry()
    again.load()
    expect(again.list()).toEqual([])
    const aside = readdirSync(dataDir).filter((name) => name.startsWith('registry.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dataDir, aside[0]), 'utf8')).toBe(duplicated)
    ;(await again.openProcessAgent({ agentId: 'a3', engine: 'claude', tmuxPane: '%3', processIdentity: processIdentity(103) }))
    expect(again.list().map((s) => s.agentId)).toEqual(['a3'])
  })

  it('that cannot be moved aside is left as it is, and nothing is written over it', async () => {
    const file = join(dataDir, 'registry.json')
    writeFileSync(file, '[{"agentId":', { mode: 0o600 })
    rename.fails = 'error'
    const registry = await loadRegistry()
    registry.load()
    expect(error).toHaveBeenCalledWith('[registry] registry is not JSON, and it could not be moved aside (EXDEV); refusing to overwrite it')
    ;(await registry.openProcessAgent({ agentId: 'must-not-write', engine: 'claude', tmuxPane: '%9', processIdentity: processIdentity(109) }))
    expect(readFileSync(file, 'utf8')).toBe('[{"agentId":')
    expect(readdirSync(dataDir).filter((name) => name.startsWith('registry.json.corrupt-'))).toEqual([])
  })

  it('that is not JSON is said without the parse error\'s message, which quotes its rows: the names of the person\'s harnesses', async () => {
    const file = join(dataDir, 'registry.json')
    writeFileSync(file, '[{"agentId":"a1","defaultName": SECRET-NAME-MARKER}]', { mode: 0o600 })
    const registry = await loadRegistry()
    registry.load()
    expect(registry.list()).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[registry\] registry is not JSON; moved it aside to [0-9a-f]{8} and started empty$/))
    expect(error.mock.calls.flat().join('\n')).not.toContain('SECRET')
  })

  it('a corrupt registry is moved aside and named by a hash', async () => {
    // The data folder is under the person's home, whose name is theirs.
    dataDir = mkdtempSync(join(tmpdir(), 'sentinel-registry-'))
    writeFileSync(join(dataDir, 'registry.json'), '{"schemaVersion":2}', { mode: 0o600 })
    const registry = await loadRegistry()
    registry.load()
    const aside = readdirSync(dataDir).filter((name) => name.startsWith('registry.json.corrupt-'))
    expect(aside).toHaveLength(1)
    const lines = error.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n')
    expect(lines).not.toContain('sentinel')
    expect(lines).toContain(`[registry] registry root is not an array; moved it aside to ${hashOf(join(dataDir, aside[0]))} and started empty`)
  })

  it('names the kind of failure it could not be moved by, whatever was thrown', async () => {
    const file = join(dataDir, 'registry.json')
    writeFileSync(file, '{"schemaVersion":2}', { mode: 0o600 })
    rename.fails = 'string'
    const registry = await loadRegistry()
    registry.load()
    expect(error).toHaveBeenCalledWith('[registry] registry root is not an array, and it could not be moved aside (string); refusing to overwrite it')
  })
})
