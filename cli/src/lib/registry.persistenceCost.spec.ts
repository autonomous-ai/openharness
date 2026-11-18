import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisteredSession, registry as Registry } from './registry.js'

type Row = Record<string, unknown>
const io = vi.hoisted(() => ({ file: '', published: false, failDirectorySync: false,
  durable: [] as Row[][], prepare: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const record = () => {
    io.durable.push(JSON.parse(actual.readFileSync(io.file, 'utf8')) as Row[])
    io.published = false
  }
  return { ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      if (String(args[1]) === io.file) {
        io.published = true
        if (process.platform === 'win32') record()
      }
    },
    fsyncSync: (fd: number) => {
      const publication = io.published && actual.fstatSync(fd).isDirectory()
      if (publication && io.failDirectorySync) throw new Error('fixture directory durability unavailable')
      actual.fsyncSync(fd)
      if (publication) record()
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle)
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

const A = 'cost-agent-a', B = 'cost-agent-b'
const plan = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-owner',
  requestedAt: 1790900000000, state: 'waiting' as const }
let root = ''
let registry: typeof Registry | undefined, release: (() => void) | undefined
const accepted: Promise<unknown>[] = []
const disk = (): Row[] => JSON.parse(readFileSync(io.file, 'utf8')) as Row[]
const row = (rows: Row[], id = A) => rows.find(value => value.agentId === id)!
const isPersistedRow = (value: unknown) => !!value && typeof value === 'object'
  && Object.hasOwn(value, 'schemaVersion') && Object.hasOwn(value, 'agentId')
const isOwnershipRecord = (value: unknown) => !!value && typeof value === 'object'
  && Object.hasOwn(value, 'agentId') && Object.hasOwn(value, 'evidenceRevision') && !isPersistedRow(value)
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
function holdPreparation() {
  let enter!: () => void, resume!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { resume = resolve })
  release = resume
  io.prepare = async () => {
    io.prepare = undefined
    enter()
    await within(held, 'prepared image release')
  }
  return { entered: () => within(entered, 'prepared image arrival'), release: resume }
}

beforeEach(async () => {
  vi.resetModules()
  registry = undefined; release = undefined; accepted.length = 0
  io.published = false; io.failDirectorySync = false; io.durable = []; io.prepare = undefined
  root = mkdtempSync(join(tmpdir(), 'registry-persistence-cost-'))
  for (const folder of ['home', 'data', 'runtime']) mkdirSync(join(root, folder), { mode: 0o700 })
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
    CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'), CLAUDE_PROJECTS_DIR: join(root, 'home', '.claude', 'projects'),
    CODEX_HOME: join(root, 'home', '.codex'), CURSOR_HOME: join(root, 'home', '.cursor') })) vi.stubEnv(key, value)
  io.file = join(root, 'data', 'registry.json')
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}', { mode: 0o600 })
  registry = (await import('./registry.js')).registry
  registry.load()
  for (const [index, agentId] of [A, B].entries()) {
    expect(await registry.openProcessAgent({ agentId, engine: 'claude', tmuxPane: `%${index + 1}`,
      processIdentity: { pid: 1001 + index, executable: '/fixture/claude', startMarker: `fixture-${index}` },
    })).not.toBeNull()
  }
  const live = registry.byAgent(A)!
  live.launchArgs = ['--before']; live.browser = true
  await registry.flush()
  io.durable = []
})

afterEach(async () => {
  io.prepare = undefined; release?.(); release = undefined
  io.failDirectorySync = false
  let settled = false
  try {
    await within(Promise.allSettled(accepted), 'accepted caller cleanup', 10_000)
    if (registry) await within(registry.flush({ exiting: true }), 'registry cleanup', 10_000)
    settled = true
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    if (settled && root) rmSync(root, { recursive: true, force: true })
  }
})

it('fingerprints each unchanged row once while preserving the exact durable bytes and live owner', async () => {
  const live = registry!.byAgent(A)!, before = readFileSync(io.file, 'utf8')
  const stringify = vi.spyOn(JSON, 'stringify')
  await registry!.flush()
  const fingerprints = stringify.mock.calls.filter(([value, replacer]) => isPersistedRow(value) && typeof replacer === 'function').length
  const owners = stringify.mock.calls.filter(([value, replacer]) => isOwnershipRecord(value) && typeof replacer === 'function').length
  stringify.mockRestore()
  expect(readFileSync(io.file, 'utf8')).toBe(before)
  expect(registry!.byAgent(A)).toBe(live)
  expect(io.durable).toEqual([])
  expect(fingerprints).toBeLessThanOrEqual(2)
  // A matching disk image needs no owner serialization; the snapshot still fences a changed image.
  expect(owners).toBe(0)
})

it('avoids repeated row comparisons and unused owner captures in a changed save and flush', async () => {
  const live = registry!.byAgent(A)!, peer = row(disk(), B)
  const stringify = vi.spyOn(JSON, 'stringify')
  expect(registry!.setCwd(A, '/fixture/changed')).toBe(true)
  await registry!.flush()
  const fingerprints = stringify.mock.calls.filter(([value, replacer]) => isPersistedRow(value) && typeof replacer === 'function').length
  const owners = stringify.mock.calls.filter(([value, replacer]) => isOwnershipRecord(value) && typeof replacer === 'function').length
  const images = stringify.mock.calls.filter(([value, replacer, space]) => Array.isArray(value)
    && value.length > 0 && value.every(isPersistedRow) && replacer === null && space === 2).length
  stringify.mockRestore()
  expect(registry!.byAgent(A)).toBe(live)
  expect(registry!.byProcess('claude', live.processIdentity!)).toBe(live)
  expect(row(disk())).toMatchObject({ cwd: '/fixture/changed', launchArgs: ['--before'] })
  expect(row(disk(), B)).toEqual(peer)
  expect(io.durable).toHaveLength(1)
  expect(images).toBe(1)
  expect(fingerprints).toBeLessThanOrEqual(12)
  expect(owners).toBe(0)
})

it('admits a durable owner without temporary property-pair arrays for its canonical row comparisons', async () => {
  const previous = disk(), fromEntries = Object.fromEntries
  let temporaryPropertyPairs = 0
  const entries = vi.spyOn(Object, 'fromEntries').mockImplementation(values => {
    // Forward the actual entries; retain only a count of canonical row/ownership property pairs.
    if (Array.isArray(values) && values.some(entry => Array.isArray(entry) && entry[0] === 'agentId')) {
      temporaryPropertyPairs += values.length
    }
    return fromEntries(values)
  })
  let opened
  try {
    opened = await registry!.openProcessAgent({ agentId: 'cost-agent-c', engine: 'claude', tmuxPane: '%3',
      processIdentity: { pid: 1003, executable: '/fixture/claude', startMarker: 'fixture-3' },
    })
  } finally { entries.mockRestore() }
  expect(opened?.entry.agentId).toBe('cost-agent-c')
  expect(io.durable).toHaveLength(1)
  const saved = disk()
  expect(saved).toHaveLength(3)
  expect(saved.slice(0, 2)).toEqual(previous)
  expect(saved[2]).toEqual(opened!.entry)
  expect(temporaryPropertyPairs).toBe(0)
})

it('avoids repeated canonical row copies when admitting a new durable owner', async () => {
  const previous = disk(), serialize = JSON.stringify
  let fingerprints = 0
  const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    if (isPersistedRow(value) && typeof replacer === 'function') fingerprints++
    return serialize(value, replacer, space)
  })
  let opened
  try {
    opened = await registry!.openProcessAgent({ agentId: 'cost-agent-c', engine: 'claude', tmuxPane: '%3',
      processIdentity: { pid: 1003, executable: '/fixture/claude', startMarker: 'fixture-3' },
    })
  } finally { stringify.mockRestore() }
  const saved = disk(), live = registry!.byAgent('cost-agent-c')!
  expect(opened?.entry.agentId).toBe('cost-agent-c')
  expect(io.durable).toHaveLength(1)
  expect(saved).toHaveLength(3)
  expect(saved.slice(0, 2)).toEqual(previous)
  expect(saved[2]).toEqual(opened!.entry)
  expect(opened!.entry).not.toBe(live)
  expect(opened!.entry.processIdentity).not.toBe(live.processIdentity)
  opened!.entry.processIdentity!.startMarker = 'receipt-only'
  expect(live.processIdentity!.startMarker).toBe('fixture-3')
  expect(disk()).toEqual(saved)
  expect(fingerprints).toBeLessThanOrEqual(11)
})

it('reuses private normalization across admission checks and unchanged prepared rows', async () => {
  const previous = disk(), { validTerminalRuntime } = await import('./registry.js')
  const filter = Array.prototype.filter
  let normalizations = 0
  const filtered = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], predicate, thisArg) {
    if (predicate === validTerminalRuntime) normalizations++
    return filter.call(this, predicate, thisArg)
  })
  let opened
  try {
    opened = await registry!.openProcessAgent({ agentId: 'cost-agent-c', engine: 'claude', tmuxPane: '%3',
      processIdentity: { pid: 1003, executable: '/fixture/claude', startMarker: 'fixture-3' },
    })
  } finally { filtered.mockRestore() }
  const saved = disk()
  expect(opened?.entry.agentId).toBe('cost-agent-c')
  expect(saved.map(value => value.agentId)).toEqual([A, B, 'cost-agent-c'])
  expect(saved.slice(0, 2)).toEqual(previous)
  expect(saved[2]).toEqual(opened!.entry)
  expect(io.durable).toEqual([saved])
  // Eighteen before prepared-row reuse: all three unchanged prepared rows were parsed again.
  expect(normalizations).toBeLessThanOrEqual(15)
})

it('rejects a live row made invalid after preparation instead of reusing its earlier normalized owner', async () => {
  const live = registry!.byAgent(A)!, originalProject = live.projectDir
  const before = readFileSync(io.file, 'utf8'), held = holdPreparation()
  const pending = track(registry!.setClosePlan(A, plan))
  await held.entered()
  ;(live as unknown as Record<string, unknown>).projectDir = 42
  held.release()
  try {
    await expect(pending).rejects.toThrow('invalid row')
    expect(io.durable).toEqual([])
    expect(readFileSync(io.file, 'utf8')).toBe(before)
    expect(live.closePlan).toBeUndefined()
    expect(registry!.byAgent(A)).toBe(live)
  } finally { live.projectDir = originalProject }
})

it('removes a departed baseline owner before placing its durable successor last', async () => {
  const peer = row(disk(), B)
  const result = await registry!.confirmEngineExit(A, 'successor')
  expect(result.state).toBe('confirmed')
  if (result.state !== 'confirmed' || !result.entry) throw new Error('fixture successor was not confirmed')
  const saved = disk()
  expect(saved.map(value => value.agentId)).toEqual([B, result.entry.agentId])
  expect(saved[0]).toEqual(peer)
  expect(saved[1]).toEqual(result.entry)
  expect(io.durable).toEqual([saved])
  expect(registry!.byAgent(A)).toBeUndefined()
  expect(registry!.byAgent(result.entry.agentId)).toMatchObject({ engine: 'terminal', sessionId: '', previousAgentId: A })
})

it('does not carry a removed baseline binding into staged discovery', async () => {
  const first = registry!.byAgent(A)!, second = registry!.byAgent(B)!
  Object.assign(first, { sessionId: 'fixture-departed', boundAt: 100, transcriptPath: '/fixture/departed.jsonl',
    source: 'hook', lastHookAt: 101, processIdentity: { ...first.processIdentity!, startTicks: 1 } })
  await registry!.flush()
  io.durable = []
  await registry!.transaction(async () => {
    second.processIdentity = { pid: 1001, executable: '/fixture/claude', startMarker: 'fixture-0' }
    expect(await registry!.confirmEngineExit(A, 'remove')).toEqual({ state: 'confirmed', entry: null })
  })
  const saved = disk()
  expect(saved.map(value => value.agentId)).toEqual([B])
  expect(saved[0]).toMatchObject({ sessionId: '', boundAt: null, transcriptPath: null, source: null })
  expect(io.durable).toEqual([saved])
  expect(registry!.byAgent(A)).toBeUndefined()
  expect(registry!.bySession('fixture-departed')).toBeUndefined()
})

it('carries the first changed owner binding when an admission flushes staged discovery', async () => {
  const first = registry!.byAgent(A)!, second = registry!.byAgent(B)!
  Object.assign(first, { sessionId: 'fixture-bound', boundAt: 100, transcriptPath: '/fixture/bound.jsonl',
    source: 'hook', lastHookAt: 101, processIdentity: { ...first.processIdentity!, startTicks: 1 } })
  await registry!.flush()
  io.durable = []
  const opened = await registry!.transaction(async () => {
    first.title = 'staged discovery'
    second.processIdentity = { pid: 1001, executable: '/fixture/claude', startMarker: 'fixture-0' }
    return registry!.openProcessAgent({ agentId: 'cost-agent-c', engine: 'claude', tmuxPane: '%3',
      processIdentity: { pid: 1003, executable: '/fixture/claude', startMarker: 'fixture-3' },
    })
  })
  const saved = disk()
  expect(saved.map(value => value.agentId)).toEqual([B, 'cost-agent-c'])
  expect(saved[0]).toMatchObject({ sessionId: 'fixture-bound', boundAt: 100,
    transcriptPath: '/fixture/bound.jsonl', source: 'hook', lastHookAt: 101 })
  expect(saved[1]).toEqual(opened!.entry)
  expect(io.durable).toEqual([saved])
  expect(registry!.byAgent(A)).toBeUndefined()
  expect(registry!.bySession('fixture-bound')?.agentId).toBe(B)
})

it('keeps canonical JSON bytes for nested objects, arrays, omitted values and literal prototype keys', async () => {
  const { rowFingerprint } = (await import('./registry.js')).saveMergeHelpers
  const nested = { b: 2, a: 1 }
  expect(rowFingerprint({ z: nested, a: [3, 2, 1], 10: 'ten', 2: 'two' }))
    .toBe('{"2":"two","10":"ten","a":[3,2,1],"z":{"a":1,"b":2}}')
  expect(rowFingerprint({ a: [3, 2, 1], z: { a: 1, b: 2 }, 2: 'two', 10: 'ten' }))
    .toBe('{"2":"two","10":"ten","a":[3,2,1],"z":{"a":1,"b":2}}')
  expect(Object.keys(nested)).toEqual(['b', 'a'])
  expect(rowFingerprint({ second: nested, first: nested }))
    .toBe('{"first":{"a":1,"b":2},"second":{"a":1,"b":2}}')
  expect(rowFingerprint({ omitted: undefined, callable: () => 1, symbol: Symbol('fixture'),
    values: [undefined, () => 1, Symbol('fixture'), NaN, Infinity, -0, , null] }))
    .toBe('{"values":[null,null,null,null,null,0,null,null]}')
  const literalKeys = JSON.parse('{"prototype":false,"constructor":"literal","__proto__":{"z":2,"a":1}}')
  expect(rowFingerprint(literalKeys)).toBe('{"__proto__":{"a":1,"z":2},"constructor":"literal","prototype":false}')
  expect(Object.getPrototypeOf(literalKeys)).toBe(Object.prototype)
  let calls = 0
  const inherited = Object.create({ toJSON() { calls++; return { z: 2, a: 1 } } })
  expect(rowFingerprint({ inherited, date: new Date('2026-01-01T00:00:00.000Z') }))
    .toBe('{"date":"2026-01-01T00:00:00.000Z","inherited":{"a":1,"z":2}}')
  expect(calls).toBe(1)
  expect(() => rowFingerprint({ value: 1n })).toThrow(TypeError)
  const circular: Record<string, unknown> = {}; circular.self = circular
  expect(() => rowFingerprint(circular)).toThrow()
})

it.each(['flush', 'transaction'] as const)('refuses an acknowledged %s observation whose owner changes during preparation', async via => {
  const live = registry!.byAgent(A)!, peer = row(disk(), B), held = holdPreparation()
  let pending: Promise<unknown>
  if (via === 'flush') {
    live.cwd = '/fixture/acknowledged-observation'
    pending = track(registry!.flush())
  } else {
    pending = track(registry!.transaction(() => {
      expect(registry!.setCwd(A, '/fixture/acknowledged-observation')).toBe(true)
    }))
  }
  await held.entered()
  expect(io.durable).toEqual([])
  expect(row(disk()).cwd).not.toBe('/fixture/acknowledged-observation')
  expect(registry!.updateProcessIdentity(A, { ...live.processIdentity!, startMarker: 'replacement' })).toBe(true)
  held.release()
  await expect(pending).rejects.toThrow('owner')
  await registry!.flush()
  expect(registry!.byAgent(A)).toBe(live)
  expect(row(disk())).toMatchObject({ cwd: '/fixture/acknowledged-observation', processIdentity: { startMarker: 'replacement' } })
  expect(row(disk(), B)).toEqual(peer)
  expect(io.durable.length).toBeGreaterThan(0)
  expect(io.durable.every(image => (row(image).processIdentity as RegisteredSession['processIdentity'])?.startMarker === 'replacement')).toBe(true)
})

it.each(['nested process identity', 'evidence revision'] as const)('refuses an acknowledged observation whose %s changes during preparation', async change => {
  const live = registry!.byAgent(A)!, peer = row(disk(), B), bytes = readFileSync(io.file, 'utf8')
  const identity = { ...live.processIdentity! }, revision = live.evidenceRevision
  expect(live).not.toHaveProperty('identityHold')
  live.cwd = '/fixture/acknowledged-observation'
  const before = structuredClone(live), held = holdPreparation()
  const pending = track(registry!.flush())
  await held.entered()
  expect(io.durable).toEqual([])
  expect(readFileSync(io.file, 'utf8')).toBe(bytes)

  const currentIdentity = change === 'nested process identity' ? { ...identity, startMarker: 'nested-replacement' } : identity
  if (change === 'nested process identity') {
    const nested = live.processIdentity!
    nested.startMarker = currentIdentity.startMarker
    expect(live.processIdentity).toBe(nested)
    expect(live.evidenceRevision).toBe(revision)
  } else {
    expect(registry!.setIdentityHold(A, 'fixture evidence changed')).toBe(true)
    expect(registry!.setIdentityHold(A)).toBe(true)
    expect(live).not.toHaveProperty('identityHold')
    expect(live.evidenceRevision).not.toBe(revision)
    // Clearing the hold restores every field except the authority revision; no persisted fact changed.
    expect({ ...live, evidenceRevision: revision }).toEqual(before)
  }
  held.release()
  await expect(pending).rejects.toThrow('owner')
  expect(io.durable).toEqual([])
  expect(readFileSync(io.file, 'utf8')).toBe(bytes)

  await registry!.flush()
  expect(registry!.byAgent(A)).toBe(live)
  expect(registry!.byProcess('claude', currentIdentity)).toBe(live)
  expect(live.processIdentity).toEqual(currentIdentity)
  const saved = row(disk())
  expect(saved).toMatchObject({ cwd: '/fixture/acknowledged-observation', processIdentity: currentIdentity })
  expect(saved).not.toHaveProperty('identityHold')
  expect(saved).not.toHaveProperty('evidenceRevision')
  expect(row(disk(), B)).toEqual(peer)
  expect(io.durable).toHaveLength(1)
})

it('copies only the two pre-await row images for a changed observation and its public flush', async () => {
  const live = registry!.byAgent(A)!, peer = row(disk(), B)
  const clone = vi.spyOn(globalThis, 'structuredClone')
  expect(registry!.setCwd(A, '/fixture/changed')).toBe(true)
  await registry!.flush()
  const rowsCopied = clone.mock.calls.filter(([value]) => isPersistedRow(value)).length
  clone.mockRestore()
  expect(registry!.byAgent(A)).toBe(live)
  expect(registry!.byProcess('claude', live.processIdentity!)).toBe(live)
  expect(row(disk())).toMatchObject({ cwd: '/fixture/changed', launchArgs: ['--before'] })
  expect(row(disk(), B)).toEqual(peer)
  expect(io.durable).toHaveLength(1)
  expect(rowsCopied).toBeLessThanOrEqual(4)
})

it('keeps the captured strict image immutable and durably rebases nested alias edits and deletion', async () => {
  const live = registry!.byAgent(A)!, held = holdPreparation(), candidate: RegisteredSession['closePlan'] = { ...plan }
  const closing = track(registry!.setClosePlan(A, candidate))
  await held.entered()
  candidate.state = 'failed'
  live.launchArgs!.push('--after')
  delete live.browser
  expect(row(disk())).not.toHaveProperty('closePlan')
  expect(io.durable).toEqual([])
  held.release()
  const receipt = await closing
  await registry!.flush()
  expect(row(io.durable[0])).toMatchObject({ closePlan: plan, launchArgs: ['--before'], browser: true })
  expect(row(io.durable.at(-1)!)).toMatchObject({ closePlan: plan, launchArgs: ['--before', '--after'] })
  expect(row(io.durable.at(-1)!)).not.toHaveProperty('browser')
  expect(row(disk())).toMatchObject({ closePlan: plan, launchArgs: ['--before', '--after'] })
  expect(row(disk())).not.toHaveProperty('browser')
  expect(registry!.byAgent(A)).toBe(live)
  expect(receipt?.closePlan).toEqual(plan)
  receipt!.closePlan!.state = 'failed'
  expect(live.closePlan).toEqual(plan)
  expect(row(disk()).closePlan).toEqual(plan)
})

it('clears resumed lineage in its durable snapshot while preserving a later nested live edit', async () => {
  const archived = structuredClone(registry!.byAgent(A)!)
  const publication = await registry!.confirmEngineExit(A, 'successor')
  if (publication.state !== 'confirmed' || !publication.entry) throw new Error('successor fixture was not published')
  const shell = publication.entry
  const live = registry!.byAgent(shell.agentId)!
  live.launchArgs = ['--before']
  await registry!.flush()
  io.durable = []
  expect(row(disk(), shell.agentId).previousAgentId).toBe(A)
  const held = holdPreparation()
  const pending = track(registry!.resumePendingAgent(archived, [{ backend: 'tmux', paneId: '%3' }]))
  await held.entered()
  expect(registry!.byAgent(A)).toBeUndefined()
  expect(row(disk(), shell.agentId).previousAgentId).toBe(A)
  live.launchArgs.push('--during')
  held.release()
  expect((await pending)?.agentId).toBe(A)
  await registry!.flush()
  expect(row(io.durable[0], shell.agentId)).not.toHaveProperty('previousAgentId')
  expect(row(io.durable[0], shell.agentId).launchArgs).toEqual(['--before'])
  expect(row(disk(), shell.agentId)).not.toHaveProperty('previousAgentId')
  expect(row(disk(), shell.agentId).launchArgs).toEqual(['--before', '--during'])
  expect(registry!.byAgent(shell.agentId)).toBe(live)
  expect(live).not.toHaveProperty('previousAgentId')
  expect(row(disk())).toMatchObject({ agentId: A, processIdentity: null, tmuxPane: '%3' })
})

it.skipIf(process.platform === 'win32')('durably rebases a nested edit to a peer-recovered row after image preparation', async () => {
  const { AtomicWriteUnconfirmed } = await import('./secureState.js')
  const prior = registry!.byAgent(A)!
  io.failDirectorySync = true
  await expect(track(registry!.setClosePlan(A, plan))).rejects.toBeInstanceOf(AtomicWriteUnconfirmed)
  io.failDirectorySync = false
  io.published = false
  expect(prior.closePlan).toBeUndefined()
  expect(row(disk()).closePlan).toEqual(plan)
  expect(io.durable).toEqual([])

  const peer = disk(), peerOwner = row(peer)
  peerOwner.cwd = '/fixture/peer-recovered'
  const peerIdentity = { ...prior.processIdentity!, startMarker: 'peer-recovered-start' }
  peerOwner.processIdentity = peerIdentity
  writeFileSync(io.file, JSON.stringify(peer, null, 2))

  const held = holdPreparation()
  expect(registry!.setCwd(B, '/fixture/unrelated-local')).toBe(true)
  await held.entered()
  const recovered = registry!.byAgent(A)!
  expect(recovered).not.toBe(prior)
  expect(recovered).toMatchObject({ cwd: '/fixture/peer-recovered', processIdentity: peerIdentity, closePlan: plan })
  expect(io.durable).toEqual([])
  // Recovery exposed this row after the original pre-await capture. Its later edit is still local work.
  recovered.processIdentity!.startMarker = 'later-live-start'
  const flushed = track(registry!.flush())
  held.release()
  await flushed

  expect(row(io.durable[0])).toMatchObject({ cwd: '/fixture/peer-recovered', processIdentity: peerIdentity, closePlan: plan })
  expect(row(disk())).toMatchObject({ cwd: '/fixture/peer-recovered',
    processIdentity: { ...peerIdentity, startMarker: 'later-live-start' }, closePlan: plan })
  expect(registry!.byAgent(A)).toBe(recovered)
  expect(recovered.processIdentity).toEqual({ ...peerIdentity, startMarker: 'later-live-start' })
  expect(registry!.byProcess('claude', recovered.processIdentity!)).toBe(recovered)
  expect(row(disk(), B).cwd).toBe('/fixture/unrelated-local')
  expect(io.durable.every(image => row(image, B).cwd === '/fixture/unrelated-local')).toBe(true)
})

it.each(['cancelled', 'replaced'] as const)('refuses a strict close whose selected authority was %s during preparation', async change => {
  let current = true
  const live = registry!.byAgent(A)!, held = holdPreparation()
  const closing = track(registry!.setClosePlan(A, plan, { current: () => current }))
  await held.entered()
  if (change === 'cancelled') current = false
  else registry!.updateProcessIdentity(A, { ...live.processIdentity!, startMarker: 'replacement' })
  held.release()
  await expect(closing).rejects.toThrow('owner')
  await registry!.flush()
  expect(live.closePlan).toBeUndefined()
  expect(row(disk())).not.toHaveProperty('closePlan')
  expect(io.durable.every(image => !Object.hasOwn(row(image), 'closePlan'))).toBe(true)
  if (change === 'replaced') expect(row(disk()).processIdentity).toMatchObject({ startMarker: 'replacement' })
})

it('keeps a queued same-value close cancellation durable after the earlier removal publishes', async () => {
  await registry!.setClosePlan(A, plan)
  io.durable = []
  const held = holdPreparation(), first = track(registry!.setClosePlan(A, null))
  await held.entered()
  const second = track(registry!.setClosePlan(A, null))
  held.release()
  const receipts = await Promise.all([first, second])
  await registry!.flush()
  expect(receipts.every(receipt => receipt && !Object.hasOwn(receipt, 'closePlan'))).toBe(true)
  expect(io.durable).toHaveLength(2)
  expect(io.durable.every(image => !Object.hasOwn(row(image), 'closePlan'))).toBe(true)
  expect(row(disk())).not.toHaveProperty('closePlan')
  expect(registry!.byAgent(A)).not.toHaveProperty('closePlan')
})

it.skipIf(process.platform === 'win32')('refuses a successful strict receipt when the published image lacks directory durability', async () => {
  const { AtomicWriteUnconfirmed } = await import('./secureState.js')
  const live = registry!.byAgent(A)!
  const serialize = JSON.stringify
  let recoveryFingerprints = 0
  const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    if (io.published && isPersistedRow(value) && typeof replacer === 'function') recoveryFingerprints++
    return serialize(value, replacer, space)
  })
  io.failDirectorySync = true
  await expect(track(registry!.setClosePlan(A, plan))).rejects.toBeInstanceOf(AtomicWriteUnconfirmed)
  stringify.mockRestore()
  expect(row(disk()).closePlan).toEqual(plan)
  expect(io.durable).toEqual([])
  expect(registry!.byAgent(A)).toBe(live)
  expect(live.closePlan).toBeUndefined()
  expect(recoveryFingerprints).toBeLessThanOrEqual(4)
})
