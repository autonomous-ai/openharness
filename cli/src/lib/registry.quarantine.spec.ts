import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    dataDir = mkdtempSync(join(tmpdir(), 'adapter-registry-quarantine-'))
    rename.fails = false
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('with two rows claiming one agent: moved aside, and the registry starts empty and writable', async () => {
    const registry = await loadRegistry()
    registry.load()
    registry.openProcessAgent({ agentId: 'a1', engine: 'claude', tmuxPane: '%1', processIdentity: processIdentity(101) })
    registry.openProcessAgent({ agentId: 'a2', engine: 'claude', tmuxPane: '%2', processIdentity: processIdentity(102) })
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
    again.openProcessAgent({ agentId: 'a3', engine: 'claude', tmuxPane: '%3', processIdentity: processIdentity(103) })
    expect(again.list().map((s) => s.agentId)).toEqual(['a3'])
  })

  it('that cannot be moved aside is left as it is, and nothing is written over it', async () => {
    const file = join(dataDir, 'registry.json')
    writeFileSync(file, '[{"agentId":', { mode: 0o600 })
    rename.fails = 'error'
    const registry = await loadRegistry()
    registry.load()
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[registry\] registry is not JSON \(.*\), and it could not be moved aside \(EXDEV: cross-device link not permitted\); refusing to overwrite it$/))
    registry.openProcessAgent({ agentId: 'must-not-write', engine: 'claude', tmuxPane: '%9', processIdentity: processIdentity(109) })
    expect(readFileSync(file, 'utf8')).toBe('[{"agentId":')
    expect(readdirSync(dataDir).filter((name) => name.startsWith('registry.json.corrupt-'))).toEqual([])
  })

  it('says why it could not be moved, whatever the failure was', async () => {
    const file = join(dataDir, 'registry.json')
    writeFileSync(file, '{"schemaVersion":2}', { mode: 0o600 })
    rename.fails = 'string'
    const registry = await loadRegistry()
    registry.load()
    expect(error).toHaveBeenCalledWith('[registry] registry root is not an array, and it could not be moved aside (read-only file system); refusing to overwrite it')
  })
})
