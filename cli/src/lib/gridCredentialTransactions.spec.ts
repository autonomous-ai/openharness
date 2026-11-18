/** Real Registry publication prefixes, with only disposable data and synthetic per-test credentials. */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ file: '', renamed: false, fail: false, peak: 0, closed: 0,
  sources: new Set<number>(), wait: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    open: (...args: any[]) => {
      const callback = args.pop()
      ;(actual.open as (...args: any[]) => void)(...args, (error: unknown, fd: number) => {
        if (!error && args[0] === io.file && (args[1] & (actual.constants.O_WRONLY | actual.constants.O_RDWR)) === actual.constants.O_RDONLY) {
          io.sources.add(fd); io.peak = Math.max(io.peak, io.sources.size)
        }
        callback(error, fd)
      })
    },
    closeSync: (fd: number) => {
      actual.closeSync(fd)
      if (io.sources.delete(fd)) {
        let closed = false
        try { actual.fstatSync(fd) } catch (error) { closed = (error as NodeJS.ErrnoException).code === 'EBADF' }
        if (!closed) throw new Error('source descriptor did not actually close')
        io.closed++
      }
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      if (args[1] === io.file) io.renamed = true
    },
    fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      const selected = io.renamed && actual.fstatSync(fd).isDirectory()
      if (selected) io.renamed = false
      actual.fsync(fd, error => {
        if (!selected) { callback(error); return }
        const wait = io.wait; io.wait = undefined
        void (wait?.() ?? Promise.resolve()).then(() => {
          if (io.fail) { io.fail = false; callback(Object.assign(new Error('fixture durability failure'), { code: 'EIO' })) }
          else callback(error)
        }, callback)
      })
    },
  }
})

let root: string, registry: typeof import('./registry.js')['registry'], storage: typeof import('./sessionStorage.js')['sessionStorage']
let first: string, second: string
let release: (() => void) | undefined
const override = (key: string) => ({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://grid.example.test/v1', apiKey: key })
const record = (key: string) => ({ override: override(key), webSearch: 'unsupported' as const })
const diskKeyMatches = (agentId: string, key: string): boolean => JSON.parse(readFileSync(io.file, 'utf8')).find((row: { agentId: string }) => row.agentId === agentId)?.gridLaunch?.apiKey === key
const liveContains = (key: string): boolean => JSON.stringify(registry.list()).includes(key)
const barrier = () => {
  let entered!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  io.wait = async () => { entered(); await waiting }
  return reached
}
beforeEach(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'grid-transactions-'))
  for (const name of ['home', 'data', 'runtime', 'codex']) mkdirSync(join(root, name), { mode: 0o700 })
  for (const [name, value] of Object.entries({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(root, 'codex'),
    CLAUDE_PROJECTS_DIR: join(root, 'home', '.claude', 'projects') })) vi.stubEnv(name, value)
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}', { mode: 0o600 })
  io.file = join(root, 'data', 'registry.json'); io.renamed = false; io.fail = false; io.peak = 0; io.closed = 0; io.sources.clear(); io.wait = undefined
  first = randomUUID(); second = randomUUID()
  registry = (await import('./registry.js')).registry
  storage = (await import('./sessionStorage.js')).sessionStorage
  await registry.load()
  for (const [index, agentId] of ['first', 'second'].entries()) {
    expect(await registry.openPendingAgent({ agentId, engine: 'claude', runtimes: [{ backend: 'tmux', paneId: `%${index + 1}` }], cwd: root,
      gridLaunchRecord: record(index ? second : first) })).not.toBeNull()
  }
  await registry.flush()
  io.peak = io.sources.size; io.closed = 0
})
afterEach(async () => {
  io.fail = false; io.wait = undefined; release?.(); release = undefined
  try { try { await registry.flush() } finally { await storage.close() } }
  finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) }
})

it('recovers the prior key after child loss and a different-target commit, retaining at most two source descriptors', async () => {
  const replacement = randomUUID(), peer = randomUUID()
  io.fail = true
  await expect(registry.setGridLaunch('first', record(replacement))).rejects.toMatchObject({ constructor: expect.objectContaining({ name: 'AtomicWriteUnconfirmed' }) })
  expect(diskKeyMatches('first', replacement)).toBe(true)
  expect(liveContains(first) || liveContains(replacement)).toBe(false)
  expect(io.sources.size).toBe(1)
  const child = (storage as unknown as { child: ChildProcess }).child
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL'); await exited
  expect(await registry.setGridLaunch('second', record(peer))).toBe(true)
  expect(diskKeyMatches('first', first)).toBe(true)
  expect(diskKeyMatches('second', peer)).toBe(true)
  expect(io.peak).toBe(2)
  expect(io.sources.size).toBe(0)
  expect(io.closed).toBeGreaterThanOrEqual(2)
})

it('keeps owned nested metadata across awaited preparation and rebases later live changes', async () => {
  const live = registry.byAgent('first')!, peer = registry.byAgent('second')!
  live.launchArgs = peer.launchArgs = ['--captured']
  const prepare = storage.prepare.bind(storage)
  let entered!: () => void, captured: unknown, encoded: unknown
  const reached = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const paused = vi.spyOn(storage, 'prepare').mockImplementationOnce(async (...args) => {
    const rows = args[2] as Array<{ agentId: string; launchArgs: string[] }>
    captured = rows.map(row => row.launchArgs)
    entered(); await waiting
    const prepared = await prepare(...args)
    encoded = JSON.parse(readFileSync(join(root, 'data', prepared.temporary), 'utf8'))
      .map((row: { launchArgs: string[] }) => row.launchArgs)
    return prepared
  })
  const saving = registry.flush()
  try {
    await reached
    live.launchArgs.push('--later')
    expect(captured).toEqual([['--captured'], ['--captured']])
    for (const args of captured as string[][]) expect(args).not.toBe(live.launchArgs)
    release!(); await saving
    expect(encoded).toEqual([['--captured'], ['--captured']])
    expect(registry.byAgent('first')!.launchArgs).toEqual(['--captured', '--later'])
    expect(registry.byAgent('second')!.launchArgs).toEqual(['--captured', '--later'])
    await registry.flush()
    expect(JSON.parse(readFileSync(io.file, 'utf8')).map((row: { launchArgs: string[] }) => row.launchArgs))
      .toEqual([['--captured', '--later'], ['--captured', '--later']])
  } finally { release!(); await saving; paused.mockRestore() }
})

it('does not recanonicalize a returned second Registry metadata image during preparation', async () => {
  registry.byAgent('first')!.title = 'Changed metadata'
  const stringify = JSON.stringify
  let publicRowCopies = 0
  const measure = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...args: unknown[]) => {
    if (value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 2) {
      const override = (value as { gridLaunch?: object }).gridLaunch
      if (override && !Object.hasOwn(override, 'credential') && !Object.hasOwn(override, 'apiKey')) publicRowCopies++
    }
    return (stringify as (...args: unknown[]) => string)(value, ...args)
  }) as typeof JSON.stringify)
  try { await registry.flush() } finally { measure.mockRestore() }
  expect(registry.byAgent('first')!.title).toBe('Changed metadata')
  expect(diskKeyMatches('first', first)).toBe(true)
  expect(publicRowCopies).toBe(0)
})

it('rekeys an intentionally copied credential for its new row and shares the final published witness', async () => {
  const original = registry.byAgent('first')!.gridLaunch!
  registry.byAgent('second')!.gridLaunch = original
  await registry.flush()
  const copied = registry.byAgent('second')!.gridLaunch!
  expect(copied).not.toBe(registry.byAgent('first')!.gridLaunch)
  expect(copied.credential).not.toBe(registry.byAgent('first')!.gridLaunch!.credential)
  expect(copied.credential.row).toEqual({ agentId: 'second', registeredAt: registry.byAgent('second')!.registeredAt })
  expect(copied.credential.binding === original.credential.binding).toBe(false)
  expect(diskKeyMatches('first', first) && diskKeyMatches('second', first)).toBe(true)
  expect((await storage.resolveSelected(copied)).apiKey === first).toBe(true)
  expect((await storage.resolveSelected(registry.byAgent('first')!.gridLaunch!)).apiKey === first).toBe(true)
  expect(copied.credential.source.kind).toBe('image')
})

it.each(['missing', 'duplicate', 'extra', 'row', 'time', 'binding', 'proof', 'document', 'source', 'extra-field', 'projection', 'metadata'])(
  'refuses a %s Registry credential receipt before rename and settles its owned temporary', async fault => {
    const before = readFileSync(io.file, 'utf8'), prepare = storage.prepare.bind(storage)
    const damaged = vi.spyOn(storage, 'prepare').mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args)
      if (prepared.projection !== 'registry-credentials') throw new Error('Expected Registry reference receipt')
      const changed = prepared as unknown as { projection: string; credentials: any[]; value?: unknown }
      switch (fault) {
        case 'missing': changed.credentials.pop(); break
        case 'duplicate': changed.credentials[1] = changed.credentials[0]; break
        case 'extra': changed.credentials.push(changed.credentials[0]); break
        case 'row': changed.credentials[0].row.agentId = 'foreign'; break
        case 'time': changed.credentials[0].row.registeredAt++; break
        case 'binding': changed.credentials[0].binding = '0'.repeat(64); break
        case 'proof': changed.credentials[0].source.proof = { ...prepared.proof, sha256: '0'.repeat(64) }; break
        case 'document': changed.credentials[0].source.proof = { ...prepared.proof, document: { kind: 'names' } }; break
        case 'source': changed.credentials[0].source = { kind: 'import', lease: randomUUID() }; break
        case 'extra-field': changed.credentials[0].unknown = true; break
        case 'projection': changed.projection = 'value'; break
        case 'metadata': changed.value = []; break
      }
      return prepared
    })
    try {
      await expect(registry.setGridLaunch('first', record(randomUUID()))).rejects.toThrow('prepared session references changed')
      expect(readFileSync(io.file, 'utf8') === before).toBe(true)
      expect(diskKeyMatches('first', first)).toBe(true)
    } finally { damaged.mockRestore() }
    const next = randomUUID()
    expect(await registry.setGridLaunch('first', record(next))).toBe(true)
    expect(diskKeyMatches('first', next)).toBe(true)
    expect((await storage.resolveSelected(registry.byAgent('first')!.gridLaunch!)).apiKey === next).toBe(true)
  })

it('serializes credential imports and admits neither key before its own directory settlement', async () => {
  const replacement = randomUUID(), peer = randomUUID(), reached = barrier()
  let firstAnswered = false, secondAnswered = false
  const firstWrite = registry.setGridLaunch('first', record(replacement)).then(value => { firstAnswered = true; return value })
  expect(await Promise.race([reached.then(() => true), firstWrite.then(() => false, () => false)])).toBe(true)
  const secondWrite = registry.setGridLaunch('second', record(peer)).then(value => { secondAnswered = true; return value })
  await Promise.resolve()
  expect(firstAnswered || secondAnswered).toBe(false)
  expect(diskKeyMatches('second', second)).toBe(true)
  expect(liveContains(replacement) || liveContains(peer)).toBe(false)
  release!()
  expect(await firstWrite).toBe(true); expect(await secondWrite).toBe(true)
  expect(diskKeyMatches('first', replacement) && diskKeyMatches('second', peer)).toBe(true)
  expect(io.sources.size).toBe(0)
  expect(io.peak).toBeLessThanOrEqual(2)
})

it('retains cancellation uncertainty until a later write restores the old selected key', async () => {
  const replacement = randomUUID(), reached = barrier()
  let current = true
  const pending = registry.setGridLaunch('first', record(replacement), { current: () => current }).catch(error => error)
  expect(await Promise.race([reached.then(() => true), pending.then(() => false)])).toBe(true)
  current = false; release!()
  expect((await pending).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(await pending).toMatchObject({ retryable: false })
  expect(io.sources.size).toBe(1)
  await registry.flush()
  expect(diskKeyMatches('first', first)).toBe(true)
  expect(io.sources.size).toBe(0)
})
