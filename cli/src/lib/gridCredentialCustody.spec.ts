import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'

const reading = vi.hoisted(() => ({ active: false, canary: '', plaintext: false, rawReads: 0,
  paths: new Set<string>(), descriptors: new Set<number>() }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const selected = (value: unknown) => typeof value === 'number' ? reading.descriptors.has(value) : reading.paths.has(String(value))
  const note = (value: unknown) => { if (reading.active && selected(value)) reading.rawReads++ }
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args)
      if (reading.paths.has(String(args[0]))) reading.descriptors.add(fd)
      return fd
    },
    open: (...args: unknown[]) => {
      const callback = args.pop() as (error: NodeJS.ErrnoException | null, fd: number) => void
      ;(actual.open as (...args: unknown[]) => void)(...args, (error: NodeJS.ErrnoException | null, fd: number) => {
        if (!error && reading.paths.has(String(args[0]))) reading.descriptors.add(fd)
        callback(error, fd)
      })
    },
    closeSync: (fd: number) => { actual.closeSync(fd); reading.descriptors.delete(fd) },
    readSync: (...args: Parameters<typeof actual.readSync>) => { note(args[0]); return actual.readSync(...args) },
    read: (...args: Parameters<typeof actual.read>) => { note(args[0]); return actual.read(...args) },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => { note(args[0]); return actual.readFileSync(...args) },
    readFile: (...args: Parameters<typeof actual.readFile>) => { note(args[0]); return actual.readFile(...args) },
  }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (reading.active && reading.paths.has(String(args[0]))) reading.rawReads++
    return actual.readFile(...args)
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), readFile = handle.readFile.bind(handle), read = handle.read.bind(handle)
    const note = () => { if (reading.active && reading.paths.has(String(args[0]))) reading.rawReads++ }
    handle.readFile = (async (...options: Parameters<typeof readFile>) => {
      note()
      const value = await readFile(...options)
      if (reading.active && String(value).includes(reading.canary)) reading.plaintext = true
      return value
    }) as typeof handle.readFile
    handle.read = ((...options: Parameters<typeof read>) => { note(); return read(...options) }) as typeof handle.read
    return handle
  } }
})

let directory: string
let registry: typeof import('./registry.js')['registry']
let stopped: import('./stoppedAgents.js').StoppedAgentStore
let selected: RegisteredSession
let canary: string

// Boolean assertions keep even synthetic credentials out of failure output.
function containsCanary(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes(canary)
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  const entries = value instanceof Map ? [...value.entries()].flat() : value instanceof Set ? [...value] : Object.values(value)
  return entries.some(entry => containsCanary(entry, seen))
}

beforeEach(async () => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'grid-custody-'))
  for (const name of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(name, directory)
  ;({ registry } = await import('./registry.js'))
  const { StoppedAgentStore } = await import('./stoppedAgents.js')
  stopped = new StoppedAgentStore(join(directory, 'stopped-agents'))
  await registry.load()
  canary = randomUUID()
  reading.active = false; reading.canary = canary; reading.plaintext = false; reading.rawReads = 0
  reading.paths = new Set([join(directory, 'registry.json'), join(directory, 'stopped-agents', 'grid-custody-agent.json')])
  reading.descriptors.clear()
  const override = { networkId: 'fixture-grid', networkName: 'Fixture', baseUrl: 'https://grid.example.test/v1',
    apiKey: canary, model: 'fixture-model' }
  const pending = await registry.openPendingAgent({ agentId: 'grid-custody-agent', engine: 'claude',
    runtimes: [{ backend: 'tmux', paneId: '%101' }], cwd: directory,
    grid: { baseUrl: override.baseUrl, model: override.model }, gridLaunchRecord: { override, webSearch: 'unsupported' } })
  expect(pending !== null).toBe(true)
  selected = pending!
  await registry.flush()
})

afterEach(async () => {
  // A write that has not settled still owns its fixture files.
  await registry?.flush()
  await (await import('./sessionStorage.js')).sessionStorage.close()
  reading.active = false
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('durable Grid credential custody', () => {
  it('keeps the imported credential out of registered session state', () => {
    expect(containsCanary(registry.byAgent(selected.agentId))).toBe(false)
    expect(containsCanary(registry)).toBe(false)
  })

  it('keeps the sole legacy durable image readable for whole-build rollback', async () => {
    const contents = readFileSync(join(directory, 'registry.json'), 'utf8')
    const { parseGridLaunchOverride, answerGridLaunch } = await import('./gridLaunch.js')
    const parsed = parseGridLaunchOverride(JSON.parse(contents)[0].gridLaunch)
    expect(parsed.state === 'ok').toBe(true)
    if (parsed.state !== 'ok') return
    const built = answerGridLaunch({ engine: 'claude', override: parsed.override, machine: { hermesSystemManaged: false } },
      () => { throw new Error('Offline rollback must not refresh a Grid key') })
    expect(built.ok).toBe(true)
    expect(built.ok && Object.values(built.launch.env).includes(canary)).toBe(true)
  })

  it('projects stopped catalog state without changing the old-readable durable image', async () => {
    await stopped.save(selected)
    const contents = readFileSync(join(directory, 'stopped-agents', `${selected.agentId}.json`), 'utf8')
    expect(contents.includes(canary)).toBe(true)
    expect(containsCanary(await stopped.get(selected.agentId))).toBe(false)
    expect(containsCanary(await stopped.list())).toBe(false)
  })

  it('reloads session metadata without retaining the imported credential', async () => {
    await registry.load()
    expect(registry.byAgent(selected.agentId) !== undefined).toBe(true)
    expect(containsCanary(registry.byAgent(selected.agentId))).toBe(false)
    expect(containsCanary(registry)).toBe(false)
  })

  it('resolves only the durably published selected reference for an offline launch', async () => {
    await registry.load()
    const reference = registry.byAgent(selected.agentId)!.gridLaunch!
    const { answerSelectedGridLaunch } = await import('./gridLaunch.js')
    const { sessionStorage } = await import('./sessionStorage.js')
    const answer = await answerSelectedGridLaunch({ engine: 'claude', override: reference,
      machine: { hermesSystemManaged: false } }, () => { throw new Error('Offline Grid must not refresh') },
    selected => sessionStorage.resolveSelected(selected))
    expect(answer.ok).toBe(true)
    expect(answer.ok && Object.values(answer.launch.env).includes(canary)).toBe(true)
    expect(answer.ok && containsCanary(answer.override)).toBe(false)
    expect(containsCanary(registry)).toBe(false)
    const changed = structuredClone(reference)
    changed.credential.row.registeredAt = (changed.credential.row.registeredAt ?? 0) + 1
    const refused = await answerSelectedGridLaunch({ engine: 'claude', override: changed,
      machine: { hermesSystemManaged: false } }, () => { throw new Error('Offline Grid must not refresh') },
    selected => sessionStorage.resolveSelected(selected))
    expect(refused).toMatchObject({ ok: false, error: 'GRID_CREDENTIAL_UNAVAILABLE' })
  })

  it('does not read the legacy plaintext image in the current core process', async () => {
    await stopped.save(selected)
    reading.active = true
    await registry.load()
    await stopped.get(selected.agentId)
    await stopped.list()
    reading.active = false
    expect(reading.plaintext).toBe(false)
    expect(reading.rawReads).toBe(0)
  })
})
