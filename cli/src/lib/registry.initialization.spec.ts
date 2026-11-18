import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminalRouteKey } from './terminalRuntime.js'

const turns = vi.hoisted(() => ({ pause: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:timers/promises', async original => {
  const actual = await original<typeof import('node:timers/promises')>()
  return { ...actual, setImmediate: async () => { await actual.setImmediate(); await turns.pause?.() } }
})
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(),
  processLockIdentity: () => ({ startMarker: 'fixture-start', generationMarker: 'fixture-generation' }), lockOwnerAlive: () => true,
}))

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let root: string, home: string, file: string, registry: typeof import('./registry.js')['registry']
let release: (() => void) | undefined
const pending: Promise<unknown>[] = []
const ids = ['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb']
const header = (id: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n'
const transcript = (index: number) => join(home, 'sessions', `rollout-${ids[index]}.jsonl`)

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'registry-initialization-')))
  home = join(root, 'codex'); file = join(root, 'data', 'registry.json')
  vi.stubEnv('ADAPTER_DATA_DIR', join(root, 'data')); vi.stubEnv('CODEX_HOME', home)
  mkdirSync(join(root, 'data')); mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}', { mode: 0o600 })
  const rows = ids.map((id, index) => {
    writeFileSync(transcript(index), header(id))
    return { launcherId: `fixture-${index}`, engine: 'codex', sessionId: id, transcriptPath: transcript(index), tmuxPane: `%${index + 1}`,
      projectDir: 'fixture', cwd: root, processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1 }
  })
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 })
  vi.resetModules(); ({ registry } = await import('./registry.js'))
})
afterEach(async () => {
  release?.(); release = undefined; turns.pause = undefined
  await Promise.allSettled(pending.splice(0))
  await registry.flush({ exiting: true }).catch(() => {})
  await (await import('./sessionStorage.js')).sessionStorage.close()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); rmSync(root, { recursive: true, force: true })
})

function pausedLoad() {
  const entered = deferred(), resumed = deferred()
  release = resumed.resolve
  turns.pause = async () => { turns.pause = undefined; entered.resolve(); await resumed.promise }
  const loading = registry.load()
  if (loading instanceof Promise) pending.push(loading)
  expect(loading).toBeInstanceOf(Promise)
  return { loading, entered: entered.promise, resume: resumed.resolve }
}

it('keeps initial image I/O owned without using the blocking reader or admitting callers', async () => {
  const { sessionStorage } = await import('./sessionStorage.js'), read = sessionStorage.read.bind(sessionStorage)
  const secure = await import('./secureState.js'), readSync = secure.readPrivateStateFile
  const entered = deferred(), resumed = deferred()
  release = resumed.resolve
  vi.spyOn(secure, 'readPrivateStateFile').mockImplementation((path, limit) => {
    if (path === file) throw new Error('fixture: whole-image disk read cannot run in line')
    return readSync(path, limit)
  })
  let held = false
  vi.spyOn(sessionStorage, 'read').mockImplementation(async (...args) => {
    if (args[0].kind === 'registry' && !held) { held = true; entered.resolve(); await resumed.promise }
    return read(...args)
  })
  const loading = registry.load(); pending.push(loading)
  expect(await Promise.race([entered.promise.then(() => 'reading'), loading.then(() => 'completed')])).toBe('reading')
  expect(() => registry.list()).toThrow('initializing')
  expect(() => registry.advertisedRows()).toThrow('initializing')
  expect(() => registry.markOpened('fixture-0')).toThrow('initializing')
  let closed = false
  const closing = registry.flush({ exiting: true }).then(() => { closed = true }); pending.push(closing)
  await Promise.resolve()
  expect(closed).toBe(false)
  resumed.resolve(); await loading; await closing
  expect(closed).toBe(true)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2)
})

it('owns the recovery read through settlement before moving the exact corrupt image aside', async () => {
  const original = 'fixture invalid JSON'
  writeFileSync(file, original, { mode: 0o600 })
  const { sessionStorage } = await import('./sessionStorage.js'), read = sessionStorage.read.bind(sessionStorage)
  const secure = await import('./secureState.js'), readSync = secure.readPrivateStateFile
  const entered = deferred(), resumed = deferred()
  release = resumed.resolve
  let synchronousReads = 0, asynchronousReads = 0
  vi.spyOn(secure, 'readPrivateStateFile').mockImplementation((path, limit) => {
    if (path === file && ++synchronousReads > 1) throw new Error('fixture: recovery disk read cannot run in line')
    return readSync(path, limit)
  })
  vi.spyOn(sessionStorage, 'read').mockImplementation(async (...args) => {
    if (args[0].kind === 'registry' && ++asynchronousReads === 2) { entered.resolve(); await resumed.promise }
    return read(...args)
  })
  const loading = registry.load(); pending.push(loading)
  expect(await Promise.race([entered.promise.then(() => 'reading'), loading.then(() => 'completed')])).toBe('reading')
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(() => registry.list()).toThrow('initializing')
  resumed.resolve(); await loading
  expect(existsSync(file)).toBe(false)
  const aside = readdirSync(join(root, 'data')).filter(name => name.startsWith('registry.json.corrupt-'))
  expect(aside).toHaveLength(1)
  expect(readFileSync(join(root, 'data', aside[0]!), 'utf8')).toBe(original)
  expect(registry.list()).toEqual([])
})

it('yields between complete native proofs without publishing rows or admitting callers', async () => {
  const entered = vi.fn(); registry.onEnter = entered
  const load = pausedLoad()
  // Until the old writer drains, only the previous complete view is readable.
  expect(registry.list()).toHaveLength(0)
  expect(() => registry.markOpened('fixture-0')).toThrow('initializing')
  await load.entered
  expect(entered).not.toHaveBeenCalled()
  expect(() => registry.list()).toThrow('initializing')
  expect(() => registry.byAgent('fixture-0')).toThrow('initializing')
  expect(() => registry.markOpened('fixture-0')).toThrow('initializing')
  await expect(registry.openPendingAgent({ engine: 'terminal', runtimes: [{ backend: 'tmux', paneId: '%3' }], cwd: root })).rejects.toThrow('initializing')
  expect(registry.load()).toBe(load.loading)
  load.resume(); await load.loading
  expect(registry.list()).toHaveLength(2)
  expect(registry.list().every(row => !row.identityHold)).toBe(true)
  expect(entered).toHaveBeenCalled()
  expect(JSON.parse(readFileSync(file, 'utf8')).every((row: { schemaVersion?: number }) => row.schemaVersion === 2)).toBe(true)
})

it('seals public admission on exit but lets owned initialization settle before closing the writer', async () => {
  const entered = vi.fn(); registry.onEnter = entered
  const load = pausedLoad(); await load.entered
  let closed = false
  const closing = registry.flush({ exiting: true }).then(() => { closed = true })
  pending.push(closing)
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(() => registry.markOpened('fixture-0')).toThrow()
  load.resume(); await load.loading; await closing
  expect(closed).toBe(true)
  expect(entered).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2)
  await expect(registry.load()).rejects.toThrow('closing')
})

it('keeps the previous complete view while an already admitted writer drains before reload', async () => {
  await registry.load()
  const publication = await import('./sessionPublication.js'), prepare = publication.prepareSessionPublication
  const entered = deferred(), resumed = deferred()
  release = resumed.resolve
  vi.spyOn(publication, 'prepareSessionPublication').mockImplementation(async (...args) => {
    if (args[1].kind === 'registry') { entered.resolve(); await resumed.promise }
    return prepare(...args)
  })
  const plan = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-conversation', requestedAt: Date.now(), state: 'waiting' as const }
  const writing = registry.setClosePlan('fixture-0', plan); pending.push(writing)
  await entered.promise
  const load = pausedLoad(), releaseLoad = release!
  release = () => { resumed.resolve(); releaseLoad() }
  expect(registry.list()).toHaveLength(2)
  expect(registry.byAgent('fixture-0')).not.toHaveProperty('closePlan')
  expect(() => registry.markOpened('fixture-0')).toThrow('initializing')
  resumed.resolve(); await expect(writing).resolves.toMatchObject({ closePlan: plan })
  await load.entered
  expect(() => registry.byAgent('fixture-0')).toThrow('initializing')
  load.resume(); await load.loading
  expect(registry.byAgent('fixture-0')).toMatchObject({ closePlan: plan })
})

it('does not grant lasting native authority to a leaf changed after its private row commitment', async () => {
  const load = pausedLoad(); await load.entered
  writeFileSync(transcript(0), header(ids[1]!))
  load.resume(); await load.loading
  expect(registry.byAgent('fixture-0')).toMatchObject({ sessionId: ids[0], transcriptPath: transcript(0) })
  await expect(registry.revalidateBinding('fixture-0')).rejects.toThrow()
  expect(registry.byAgent('fixture-0')?.sessionId).toBe(ids[0])
})

it('keeps a newer peer image when a later duplicate makes the private load invalid', async () => {
  const original = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify([original[0], { ...original[1], launcherId: original[0].launcherId }]), { mode: 0o600 })
  const load = pausedLoad(); await load.entered
  const peer = JSON.stringify([original[1]])
  writeFileSync(file, peer, { mode: 0o600 })
  load.resume(); await expect(load.loading).rejects.toThrow('registry image changed during initialization')
  expect(readFileSync(file, 'utf8')).toBe(peer)
  expect(registry.list()).toHaveLength(0)
})

it.each(['new row', 'stolen binding', 'cancelled close'] as const)('rebases a concurrent durable %s while migrating a private image', async change => {
  await registry.load()
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  rows[0].closePlan = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-conversation', requestedAt: Date.now(), state: 'waiting' }
  // The source needs a migration, while the peer publishes the current row format.
  writeFileSync(file, JSON.stringify(rows.map(({ schemaVersion: _schema, ...row }: Record<string, unknown>) => row)), { mode: 0o600 })
  const load = pausedLoad(); await load.entered
  if (change === 'new row') rows.push({ ...rows[1], agentId: 'peer', sessionId: '', transcriptPath: null,
    boundAt: null, source: null, tmuxPane: '%3', runtimes: [{ backend: 'tmux', paneId: '%3' }], primaryRuntimeKey: terminalRouteKey({ backend: 'tmux', paneId: '%3' }) })
  if (change === 'stolen binding') {
    rows[1].sessionId = rows[0].sessionId; rows[1].transcriptPath = rows[0].transcriptPath
    rows[0].sessionId = ''; rows[0].transcriptPath = null; rows[0].boundAt = null; rows[0].source = null
  }
  if (change === 'cancelled close') delete rows[0].closePlan
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 })
  load.resume(); await load.loading
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  if (change === 'new row') expect(saved.some((row: { agentId: string }) => row.agentId === 'peer')).toBe(true)
  if (change === 'stolen binding') {
    expect(registry.byAgent('fixture-0')?.sessionId).toBe('')
    expect(registry.bySession(ids[0]!)?.agentId).toBe('fixture-1')
  }
  if (change === 'cancelled close') expect(saved[0]).not.toHaveProperty('closePlan')
})

it('keeps initialization and migration markers behind required durable publication', async () => {
  const publication = await import('./sessionPublication.js'), prepare = publication.prepareSessionPublication
  const entered = deferred(), resumed = deferred()
  release = resumed.resolve
  vi.spyOn(publication, 'prepareSessionPublication').mockImplementation(async (...args) => {
    if (args[1].kind === 'registry') { entered.resolve(); await resumed.promise }
    return prepare(...args)
  })
  let ready = false
  const loading = registry.load().then(() => { ready = true }); pending.push(loading)
  await entered.promise
  expect(ready).toBe(false)
  expect(() => registry.list()).toThrow('initializing')
  expect(existsSync(join(root, 'data', 'registry-boot'))).toBe(false)
  expect(existsSync(join(root, 'data', 'registry-own-modes'))).toBe(false)
  resumed.resolve(); await loading
  expect(ready).toBe(true)
  expect(existsSync(join(root, 'data', 'registry-boot'))).toBe(true)
  expect(existsSync(join(root, 'data', 'registry-own-modes'))).toBe(true)
})

it('rejects a failed migration without exposing a partial image or advancing its markers', async () => {
  const before = readFileSync(file, 'utf8')
  const publication = await import('./sessionPublication.js')
  const prepare = publication.prepareSessionPublication
  vi.spyOn(publication, 'prepareSessionPublication').mockImplementation(async (...args) => {
    if (args[1].kind === 'registry') throw new Error('fixture write failure')
    return prepare(...args)
  })
  await expect(registry.load()).rejects.toThrow()
  expect(registry.list()).toHaveLength(0)
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(existsSync(join(root, 'data', 'registry-boot'))).toBe(false)
  expect(existsSync(join(root, 'data', 'registry-own-modes'))).toBe(false)
})

it('iterates exactly advertised membership in Registry order with current object identities', async () => {
  await registry.load()
  const [first, second] = registry.list()
  registry.setTerminalAvailable(second.agentId, true)
  registry.setTerminalAvailable(first.agentId, true)
  // Availability alone is the public predicate, even when the engine is dormant or unbound.
  first.active = false; first.sessionId = ''
  expect([...registry.advertisedRows()]).toEqual(registry.advertised())
  expect([...registry.advertisedRows()][0]).toBe(first)
  expect([...registry.advertisedRows()][1]).toBe(second)
  registry.setTerminalAvailable(first.agentId, false)
  expect([...registry.advertisedRows()]).toEqual([second])
  expect(registry.advertised()).toEqual([second])
  registry.setTerminalAvailable(second.agentId, false)
  expect([...registry.advertisedRows()]).toEqual([])
  expect(registry.list()).toEqual([first, second])
})
