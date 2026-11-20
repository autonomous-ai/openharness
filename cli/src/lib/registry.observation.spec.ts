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

const asyncSync = vi.hoisted(() => vi.fn((sync: () => Promise<void>) => sync()))
const reads = vi.hoisted(() => ({ afterRegistryRead: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle)
    handle.sync = () => asyncSync(sync)
    if (args[0] === file) {
      const read = handle.readFile.bind(handle)
      handle.readFile = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs)
        const afterRead = reads.afterRegistryRead
        reads.afterRegistryRead = undefined
        afterRead?.()
        return result
      }) as typeof handle.readFile
    }
    return handle
  } }
})
const fsyncs = () => vi.mocked(fsyncSync).mock.calls.length + asyncSync.mock.calls.length

let directory: string
let file: string
let registry: typeof Registry
// Loads the module graph once, before any hook's time limit: cold, it takes seconds on a loaded machine. Each test
// still imports fresh modules (vi.resetModules), now from the warm transform cache.
await import('./registry.js')
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
  expect((await registry.openProcessAgent(input))).not.toBeNull()
  await registry.flush()
  clearCounts()
  vi.setSystemTime(Date.now() + 5000)
})

afterEach(async () => {
  reads.afterRegistryRead = undefined
  vi.mocked(fsyncSync).mockReset()
  asyncSync.mockReset()
  // Failure tests deliberately leave unsafe or corrupt state; settle the final barrier before cleanup.
  await registry.flush().catch(() => {})
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

describe('unchanged discovery observations', () => {
  it('preserves saved bytes, clock and the live row while returning a detached observation without writes', async () => {
    const row = registry.byAgent(input.agentId)!
    const original = readFileSync(file, 'utf8')
    const touchedAt = row.touchedAt
    registry.setTerminalAvailable(row.agentId, false)
    for (let pass = 0; pass < 3; pass++) {
      await observe()
      const observed = (await registry.openProcessAgent({ ...input, processIdentity: { ...input.processIdentity } }))!.entry
      expect(observed).toEqual(row)
      expect(observed).not.toBe(row)
      expect(observed.processIdentity).not.toBe(row.processIdentity)
      vi.setSystemTime(Date.now() + 5000)
    }
    expect(registry.terminalAvailable(row.agentId)).toBe(true)
    expect(registry.byProcess('claude', input.processIdentity)).toBe(row)
    expect(row.touchedAt).toBe(touchedAt)
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(registryWrites()).toBe(0)
    expect(lockAttempts()).toBe(0)
    expect(fsyncs()).toBe(0)
  })

  it('refuses an unchanged observation whose caller loses authority during the private read', async () => {
    const original = readFileSync(file, 'utf8')
    let current = true
    reads.afterRegistryRead = () => { current = false }
    await expect(registry.openProcessAgent(input, { current: () => current })).rejects.toThrow('ownership group changed')
    expect(current).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(registryWrites()).toBe(0)
  })

  it('keeps strict admission for a staged local row when a peer replaced its durable owner', async () => {
    const live = registry.byAgent(input.agentId)!
    live.title = 'Staged local title'
    const [peer] = readRows()
    peer.processIdentity.startMarker = 'peer-process-generation'
    writeFileSync(file, JSON.stringify([peer], null, 2))
    const durable = readFileSync(file, 'utf8')
    await expect(registry.openProcessAgent(input)).rejects.toThrow('saved binding changed')
    expect(readFileSync(file, 'utf8')).toBe(durable)
    expect(live.title).toBe('Staged local title')
    expect(registryWrites()).toBe(0)
  })

  it('does not return a launch receipt revoked while native authority refreshes', async () => {
    const live = registry.byAgent(input.agentId)!
    const result = await registry.openProcessAgent(input, { refresh: async () => {
      live.active = false
    } }).catch(() => null)
    expect(result).toBeNull()
    expect(registry.byAgent(input.agentId)?.active).toBe(false)
    await registry.flush()
    expect(readRows()[0].active).toBe(false)
  })

  // The daemon rewrote registry.json every 5 s when only key order differed (2026-10-06 profile).
  it('does not rewrite a registry saved with another key order, yet writes a real change', async () => {
    const reversed = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T
    const [saved] = readRows()
    writeFileSync(file, JSON.stringify([reversed({
      ...saved, processIdentity: reversed(saved.processIdentity), runtimes: saved.runtimes.map(reversed),
      launch: { state: 'ready' }, forkedFrom: { name: 'Parent', agentId: 'parent-agent' },
      closePlan: reversed(plan), lastOpenedAt: 1790900000000,
    })], null, 2))
    clearCounts()
    registry.load()
    const discover = () => registry.transaction(() => {
      registry.updateRuntimes(input.agentId, [{ backend: 'tmux', paneId: '%31' }])
      registry.updateProcessIdentity(input.agentId, { ...input.processIdentity })
    })
    await discover()
    expect(registryWrites()).toBe(1)
    const bytes = readFileSync(file, 'utf8')
    const touchedAt = readRows()[0].touchedAt
    clearCounts()
    for (let pass = 0; pass < 3; pass++) {
      vi.setSystemTime(Date.now() + 5000)
      await discover()
    }
    expect(registryWrites()).toBe(0)
    expect(lockAttempts()).toBe(0)
    expect(fsyncs()).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(readRows()[0]).toMatchObject({ touchedAt, launch: { state: 'ready' }, closePlan: plan,
      forkedFrom: { name: 'Parent', agentId: 'parent-agent' }, lastOpenedAt: 1790900000000 })
    await registry.transaction(() => {
      registry.updateProcessIdentity(input.agentId, { ...input.processIdentity, startMarker: 'fixture-next' })
    })
    expect(registryWrites()).toBe(1)
    expect(fsyncs()).toBe(3)
    expect(readRows()[0]).toMatchObject({ processIdentity: { startMarker: 'fixture-next' }, touchedAt: Date.now() })
  })

  it('keeps another process\'s change to a nested field when a different field changes here', async () => {
    ;(await registry.setClosePlan(input.agentId, plan))
    const [saved] = readRows()
    writeFileSync(file, JSON.stringify([{ ...saved, closePlan: { ...plan, state: 'failed', detail: 'external' } }], null, 2))
    await registry.transaction(() => registry.updateProcessIdentity(input.agentId, input.processIdentity, 'ori'))
    expect(readRows()[0]).toMatchObject({ gateway: 'ori', closePlan: { state: 'failed', detail: 'external' } })
    expect(registry.byAgent(input.agentId)?.closePlan?.state).toBe('failed')
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
    expect(fsyncs()).toBe(3)
    clearCounts()
    await observe()
    expect(fsyncs()).toBe(0)
  })

  it('durably reactivates a dormant process and finishes a pending launch', async () => {
    registry.setActive(input.agentId, false)
    registry.setLaunch(input.agentId, { state: 'starting' })
    await registry.flush()
    clearCounts()
    const row = await registry.transaction(async () => (await registry.openProcessAgent(input))!.entry)
    expect(readRows()[0]).toMatchObject({ active: true, launch: { state: 'ready' }, touchedAt: Date.now() })
    expect(registryWrites()).toBe(1)
    expect(row.launch?.state).toBe('ready')
    clearCounts()
    ;(await registry.openProcessAgent(input))
    expect(fsyncs()).toBe(0)
    await registry.transaction(() => registry.setActive(input.agentId, false))
    clearCounts()
    await observe()
    expect(readRows()[0].active).toBe(true)
    expect(registryWrites()).toBe(1)
  })

  it('persists newly learned launch metadata and an unbound folder exactly once', async () => {
    const learned = { ...input, cwd: '/fixture/moved', codexHome: '/fixture/profile',
      hermesHome: '/fixture/hermes', gateway: 'ori' as const }
    await registry.transaction(async () => (await registry.openProcessAgent(learned)))
    expect(readRows()[0]).toMatchObject({ cwd: learned.cwd, codexHome: learned.codexHome,
      hermesHome: learned.hermesHome, dsh: null, gateway: 'ori' })
    expect(registryWrites()).toBe(1)
    clearCounts()
    ;(await registry.openProcessAgent(learned))
    expect(fsyncs()).toBe(0)
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
    expect(fsyncs()).toBe(0)
  })

  it('does not trust cached bytes when file permissions or type change', async () => {
    const original = readFileSync(file, 'utf8')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    chmodSync(file, 0o660)
    await expect(observe()).rejects.toThrow()
    expect(statSync(file).mode & 0o777).toBe(0o660)
    expect(registryWrites()).toBe(0)
    chmodSync(file, 0o600)
    renameSync(file, `${file}.target`)
    symlinkSync(`${file}.target`, file)
    clearCounts()
    await expect(observe()).rejects.toThrow()
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
    expect(fsyncs()).toBe(0)
  })

  it('imports an external close cancellation without resurrecting it on the next pass', async () => {
    const row = registry.byAgent(input.agentId)!
    ;(await registry.setClosePlan(input.agentId, plan))
    const [external] = readRows()
    delete external.closePlan
    writeFileSync(file, JSON.stringify([external], null, 2))
    await observe()
    expect(registry.byAgent(input.agentId)).toBe(row)
    expect(row.closePlan).toBeUndefined()
    clearCounts()
    await observe()
    expect(readRows()[0].closePlan).toBeUndefined()
    expect(fsyncs()).toBe(0)
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
    await expect(observe()).rejects.toThrow()
    expect(statSync(directory).mode & 0o777).toBe(0o770)
    expect(lockAttempts()).toBe(0)
    expect(fsyncs()).toBe(0)
  })

  it.each(['[{', '[{"schemaVersion":99}]'])('retains an external invalid registry without hiding the failure: %s', async (bytes) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(file, bytes)
    await expect(observe()).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe(bytes)
    expect(registryWrites()).toBe(0)
  })

  it('retries a failed actual change on the next unchanged observation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    asyncSync.mockImplementationOnce(async () => { throw new Error('fixture disk failure') })
    await expect(registry.transaction(() => registry.updateProcessIdentity(input.agentId, input.processIdentity, 'ori'))).rejects.toThrow('registry storage write failed')
    expect(readRows()[0].gateway).not.toBe('ori')
    clearCounts()
    await observe()
    expect(readRows()[0].gateway).toBe('ori')
    expect(registryWrites()).toBe(1)
    expect(fsyncs()).toBe(3)
  })

  it('always durably acknowledges close intents, including identical retries', async () => {
    ;(await registry.setClosePlan(input.agentId, plan))
    clearCounts()
    ;(await registry.setClosePlan(input.agentId, { ...plan }))
    expect(readRows()[0].closePlan).toEqual(plan)
    expect(registryWrites()).toBe(1)
    expect(fsyncs()).toBe(3)
  })

  it('rejects and rolls back a close intent when storage fails', async () => {
    asyncSync.mockImplementationOnce(async () => { throw new Error('fixture disk failure') })
    await expect((async () => (await registry.setClosePlan(input.agentId, plan)))()).rejects.toThrow('registry storage write failed')
    expect(registry.byAgent(input.agentId)?.closePlan).toBeUndefined()
    expect(readRows()[0].closePlan).toBeUndefined()
    ;(await registry.setClosePlan(input.agentId, plan))
    expect(readRows()[0].closePlan).toEqual(plan)
  })

  // Each of these is another process's write this view has not read: a hook's, a second daemon's, a
  // command's. CI's registry-observation contract lost the first one when a process was starved.
  it('a cancellation from a view that never saw another process\'s close plan removes it', async () => {
    const [row] = readRows()
    writeFileSync(file, JSON.stringify([{ ...row, closePlan: plan }], null, 2))
    ;(await registry.setClosePlan(input.agentId, null))
    expect(readRows()[0].closePlan).toBeUndefined()
    expect(registry.byAgent(input.agentId)?.closePlan).toBeUndefined()
  })

  it('a close retried over another process\'s cancellation is written again', async () => {
    ;(await registry.setClosePlan(input.agentId, plan))
    const [row] = readRows()
    delete row.closePlan
    writeFileSync(file, JSON.stringify([row], null, 2))
    ;(await registry.setClosePlan(input.agentId, { ...plan }))
    expect(readRows()[0].closePlan).toEqual(plan)
  })

  it('a cancellation never brings back a row another process removed', async () => {
    writeFileSync(file, JSON.stringify([], null, 2))
    ;(await registry.setClosePlan(input.agentId, null))
    expect(readRows()).toEqual([])
    expect(registry.byAgent(input.agentId)).toBeUndefined()
  })

  it('a cancellation whose save failed is not written by a later save', async () => {
    const [row] = readRows()
    writeFileSync(file, JSON.stringify([{ ...row, closePlan: plan }], null, 2))
    asyncSync.mockImplementationOnce(async () => { throw new Error('fixture disk failure') })
    await expect((async () => (await registry.setClosePlan(input.agentId, null)))()).rejects.toThrow('registry storage write failed')
    await observe()
    expect(readRows()[0].closePlan).toEqual(plan)
  })

  it('never acknowledges a close intent within an uncommitted transaction', async () => {
    await expect(registry.transaction(async () => (await registry.setClosePlan(input.agentId, plan))))
      .rejects.toThrow('uncommitted registry transaction')
    expect(registry.byAgent(input.agentId)?.closePlan).toBeUndefined()
    expect(readRows()[0].closePlan).toBeUndefined()
  })
})
