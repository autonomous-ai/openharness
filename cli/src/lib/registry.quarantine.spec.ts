import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('with two rows claiming one agent: preserved and held for recovery', async () => {
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
    expect(aside).toHaveLength(0)
    expect(readFileSync(file, 'utf8')).toBe(duplicated)
    again.openProcessAgent({ agentId: 'a3', engine: 'claude', tmuxPane: '%3', processIdentity: processIdentity(103) })
    expect(again.list()).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(duplicated)
  })

  it('is left as it is, and nothing is written over it', async () => {
    const file = join(dataDir, 'registry.json')
    writeFileSync(file, '[{"agentId":', { mode: 0o600 })
    const registry = await loadRegistry()
    registry.load()
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[registry\] registry is not JSON \(.*\); preserving saved state and refusing to overwrite it$/))
    registry.openProcessAgent({ agentId: 'must-not-write', engine: 'claude', tmuxPane: '%9', processIdentity: processIdentity(109) })
    expect(readFileSync(file, 'utf8')).toBe('[{"agentId":')
    expect(readdirSync(dataDir).filter((name) => name.startsWith('registry.json.corrupt-'))).toEqual([])
  })

  it('reports an invalid root without moving or replacing it', async () => {
    const file = join(dataDir, 'registry.json')
    writeFileSync(file, '{"schemaVersion":2}', { mode: 0o600 })
    const registry = await loadRegistry()
    registry.load()
    expect(error).toHaveBeenCalledWith('[registry] registry root is not an array; preserving saved state and refusing to overwrite it')
  })
})
