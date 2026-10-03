import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { registry as Registry } from './registry.js'

// Count actual writes; the registry, locks, permission checks and fsyncs still use real files.
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>()
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync), mkdirSync: vi.fn(fs.mkdirSync) }
})

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
const readRows = () => JSON.parse(readFileSync(file, 'utf8'))
const clearCounts = () => vi.clearAllMocks()
const registryWrites = () => vi.mocked(renameSync).mock.calls.filter(([, target]) => target === file).length
const lockAttempts = () => vi.mocked(mkdirSync).mock.calls.filter(([target]) => target === `${file}.lock`).length

async function observe() {
  const row = registry.byAgent(input.agentId)!
  await registry.transaction(() => {
    expect(registry.updateRuntimes(row.agentId, row.runtimes, row.primaryRuntimeKey)).toBe(true)
    expect(registry.updateProcessIdentity(row.agentId, { ...row.processIdentity! })).toBe(true)
  })
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1790900000000)
  directory = mkdtempSync(join(tmpdir(), 'registry-observation-'))
  file = join(directory, 'registry.json')
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(key, directory)
  registry = (await import('./registry.js')).registry
  registry.load()
  expect(registry.openProcessAgent(input)).not.toBeNull()
  clearCounts()
  vi.setSystemTime(Date.now() + 5000)
})

afterEach(() => {
  vi.mocked(fsyncSync).mockReset()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('unchanged discovery observations', () => {
  it('preserves the saved bytes, clock and object identity without locks or fsyncs', async () => {
    const row = registry.byAgent(input.agentId)!
    const original = readFileSync(file, 'utf8')
    const touchedAt = row.touchedAt
    registry.setTerminalAvailable(row.agentId, false)
    for (let pass = 0; pass < 3; pass++) {
      await observe()
      expect(registry.openProcessAgent({ ...input, processIdentity: { ...input.processIdentity } })?.entry).toBe(row)
      vi.setSystemTime(Date.now() + 5000)
    }
    expect(registry.terminalAvailable(row.agentId)).toBe(true)
    expect(registry.byProcess('claude', input.processIdentity)).toBe(row)
    expect(row.touchedAt).toBe(touchedAt)
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(registryWrites()).toBe(0)
    expect(lockAttempts()).toBe(0)
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it('still persists a changed route and process generation in one durable transaction', async () => {
    const row = registry.byAgent(input.agentId)!
    const identity = { ...input.processIdentity, startMarker: 'replacement-generation', executable: '/fixture/new-claude' }
    await registry.transaction(() => {
      registry.updateRuntimes(row.agentId, [{ backend: 'tmux', paneId: '%32' }])
      registry.updateProcessIdentity(row.agentId, identity, 'ori', { baseUrl: 'https://fixture.invalid/relay', model: 'fixture' })
    })
    expect(registry.byProcess('claude', input.processIdentity)).toBeUndefined()
    expect(registry.byProcess('claude', identity)).toBe(row)
    expect(registry.byPaneEngine('%31', 'claude')).toBeUndefined()
    expect(registry.byPaneEngine('%32', 'claude')).toBe(row)
    expect(readRows()[0]).toMatchObject({ processIdentity: identity, gateway: 'ori', tmuxPane: '%32', touchedAt: Date.now() })
    expect(registryWrites()).toBe(1)
    expect(fsyncSync).toHaveBeenCalledTimes(3)
    clearCounts()
    await observe()
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it('durably reactivates a dormant process and finishes a pending launch', async () => {
    registry.setActive(input.agentId, false)
    registry.setLaunch(input.agentId, { state: 'starting' })
    clearCounts()
    const row = registry.openProcessAgent(input)!.entry
    expect(readRows()[0]).toMatchObject({ active: true, launch: { state: 'ready' }, touchedAt: Date.now() })
    expect(registryWrites()).toBe(1)
    expect(row.launch?.state).toBe('ready')
    clearCounts()
    registry.openProcessAgent(input)
    expect(fsyncSync).not.toHaveBeenCalled()
    registry.setActive(input.agentId, false)
    clearCounts()
    await observe()
    expect(readRows()[0].active).toBe(true)
    expect(registryWrites()).toBe(1)
  })

  it('persists newly learned launch metadata and an unbound folder exactly once', () => {
    const learned = { ...input, cwd: '/fixture/moved', codexHome: '/fixture/profile',
      hermesHome: '/fixture/hermes', dsh: 'examples/hello-world', gateway: 'ori' as const }
    registry.openProcessAgent(learned)
    expect(readRows()[0]).toMatchObject({ cwd: learned.cwd, codexHome: learned.codexHome,
      hermesHome: learned.hermesHome, dsh: learned.dsh, gateway: 'ori' })
    expect(registryWrites()).toBe(1)
    clearCounts()
    registry.openProcessAgent(learned)
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it.each(['in-place', 'atomic replacement'])('imports an external session bind on an otherwise unchanged pass (%s)', async (method) => {
    const row = registry.byAgent(input.agentId)!
    const [external] = readRows()
    external.sessionId = 'externally-bound-session'
    external.boundAt = Date.now()
    external.title = 'Hook title'
    const before = statSync(file)
    if (method === 'in-place') {
      writeFileSync(file, JSON.stringify([external], null, 2))
      utimesSync(file, before.atime, before.mtime)
    } else {
      const next = `${file}.external`
      writeFileSync(next, JSON.stringify([external], null, 2), { mode: 0o600 })
      renameSync(next, file)
    }
    clearCounts()
    await observe()
    expect(registry.get('externally-bound-session')).toBe(row)
    expect(row.title).toBe('Hook title')
    expect(readRows()[0].sessionId).toBe('externally-bound-session')
    clearCounts()
    await observe()
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it('does not trust cached bytes when file permissions or type change', async () => {
    const original = readFileSync(file, 'utf8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    chmodSync(file, 0o660)
    await observe()
    expect(error).toHaveBeenCalled()
    expect(statSync(file).mode & 0o777).toBe(0o660)
    expect(registryWrites()).toBe(0)
    chmodSync(file, 0o600)
    renameSync(file, `${file}.target`)
    symlinkSync(`${file}.target`, file)
    clearCounts()
    await observe()
    expect(error).toHaveBeenCalled()
    expect(registryWrites()).toBe(0)
    expect(readFileSync(`${file}.target`, 'utf8')).toBe(original)
  })

  it('retains external additions alongside a local change in the same pass', async () => {
    const [original] = readRows()
    const other = { ...original, agentId: 'hook-agent', sessionId: 'hook-session', tmuxPane: '%99',
      runtimes: [{ backend: 'tmux', paneId: '%99' }], primaryRuntimeKey: 'tmux\u0000%99',
      processIdentity: { ...input.processIdentity, pid: 1099, startMarker: 'fixture-1099' } }
    writeFileSync(file, JSON.stringify([{ ...original, title: 'external title' }, other]))
    await registry.transaction(() => {
      registry.updateProcessIdentity(input.agentId, input.processIdentity, 'ori')
      registry.updateRuntimes(input.agentId, [{ backend: 'tmux', paneId: '%31' }])
    })
    expect(registry.get('hook-session')?.agentId).toBe('hook-agent')
    expect(registry.byAgent(input.agentId)).toMatchObject({ title: 'external title', gateway: 'ori' })
    expect(readRows()).toHaveLength(2)
    clearCounts()
    await observe()
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it('imports an external close cancellation without resurrecting it on the next pass', async () => {
    const row = registry.byAgent(input.agentId)!
    registry.setClosePlan(input.agentId, plan)
    const [external] = readRows()
    delete external.closePlan
    writeFileSync(file, JSON.stringify([external], null, 2))
    await observe()
    expect(registry.byAgent(input.agentId)).toBe(row)
    expect(row.closePlan).toBeUndefined()
    clearCounts()
    await observe()
    expect(readRows()[0].closePlan).toBeUndefined()
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it('does not treat a removed registry as a matching cached file', async () => {
    rmSync(file)
    await observe()
    // No local change may undo an external deletion. The next discovery can adopt it afresh.
    expect(registry.list()).toEqual([])
    expect(readRows()).toEqual([])
    expect(registryWrites()).toBe(1)
  })

  it('rechecks the directory permissions even when file bytes match', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    chmodSync(directory, 0o770)
    await observe()
    expect(error).toHaveBeenCalled()
    expect(statSync(directory).mode & 0o777).toBe(0o770)
    expect(lockAttempts()).toBe(0)
    expect(fsyncSync).not.toHaveBeenCalled()
  })

  it.each(['[{', '[{"schemaVersion":99}]'])('retains an external invalid registry without hiding the failure: %s', async (bytes) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(file, bytes)
    await observe()
    expect(error).toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(registryWrites()).toBe(0)
  })

  it('retries a failed actual change on the next unchanged observation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('fixture disk failure') })
    registry.updateProcessIdentity(input.agentId, input.processIdentity, 'ori')
    expect(readRows()[0].gateway).not.toBe('ori')
    clearCounts()
    await observe()
    expect(readRows()[0].gateway).toBe('ori')
    expect(registryWrites()).toBe(1)
    expect(fsyncSync).toHaveBeenCalledTimes(3)
  })

  it('always durably acknowledges close intents, including identical retries', () => {
    registry.setClosePlan(input.agentId, plan)
    clearCounts()
    registry.setClosePlan(input.agentId, { ...plan })
    expect(readRows()[0].closePlan).toEqual(plan)
    expect(registryWrites()).toBe(1)
    expect(fsyncSync).toHaveBeenCalledTimes(3)
  })

  it('rejects and rolls back a close intent when storage fails', () => {
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('fixture disk failure') })
    expect(() => registry.setClosePlan(input.agentId, plan)).toThrow('fixture disk failure')
    expect(registry.byAgent(input.agentId)?.closePlan).toBeUndefined()
    expect(readRows()[0].closePlan).toBeUndefined()
    registry.setClosePlan(input.agentId, plan)
    expect(readRows()[0].closePlan).toEqual(plan)
  })

  it('never acknowledges a close intent within an uncommitted transaction', async () => {
    await expect(registry.transaction(() => registry.setClosePlan(input.agentId, plan)))
      .rejects.toThrow('uncommitted registry transaction')
    expect(registry.byAgent(input.agentId)?.closePlan).toBeUndefined()
    expect(readRows()[0].closePlan).toBeUndefined()
  })
})
