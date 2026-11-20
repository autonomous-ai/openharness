import * as fs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSessionImageCodec } from './sessionImage.js'
import { stoppedArchiveWitness } from '../lib/stoppedAuthorityMetadata.js'
import * as custody from '../lib/secureState.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
vi.mock('node:fs/promises', async original => ({ ...await original<object>() }))
vi.mock('../lib/secureState.js', async original => ({ ...await original<object>() }))
let root: string, directory: string
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'session-query-page-'))
  directory = join(root, 'stopped-agents'); fs.mkdirSync(directory, { mode: 0o700 })
})
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
const write = (id: string, sessionId = id) => fs.writeFileSync(join(directory, id + '.json'),
  JSON.stringify({ version: 1, session: { agentId: id, registeredAt: 1, schemaVersion: 2, engine: 'claude', sessionId } }), { mode: 0o600 })
const query = (exceptAgentId?: string) => createSessionImageCodec(root).queryStopped({ kind: 'conversations', ids: ['wanted'], reservations: false,
  ...(exceptAgentId ? { exceptAgentId } : {}) }, performance.now() + 5000)
function beforeRead(change: (count: number, name?: string) => void) {
  const open = asyncFs.opendir
  vi.spyOn(asyncFs, 'opendir').mockImplementation((async (...args: Parameters<typeof open>) => {
    const directory = await open(...args), read = directory.read.bind(directory)
    let count = 0
    directory.read = (async () => { const entry = await read(); change(++count, entry?.name); return entry }) as typeof directory.read
    return directory
  }) as typeof open)
}

it('binds excluded metadata without parsing its content and keeps every other row selected', async () => {
  fs.writeFileSync(join(directory, 'excluded.json'), '{not-json', { mode: 0o600 })
  write('selected', 'wanted')
  expect((await query('excluded')).matches).toEqual([true])
})

it.each(['conversations', 'owners'] as const)('preserves missing-container %s answers without creating a directory', async kind => {
  fs.rmSync(directory, { recursive: true })
  const codec = createSessionImageCodec(root)
  const request = kind === 'conversations' ? { kind, ids: ['wanted'], reservations: false }
    : { kind, keys: ['claude\0\0\0wanted'], defaultCodexHome: join(root, 'codex') }
  expect(await codec.queryStopped(request, performance.now() + 5000)).toEqual({ witness: 'missing', matches: [false],
    ...(kind === 'owners' ? { selected: [] } : {}) })
  expect(fs.existsSync(directory)).toBe(false)
})

it('keeps an empty present directory distinct from missing authority', async () => {
  const result = await query()
  expect(result.matches).toEqual([false])
  expect(result.witness).toBe(stoppedArchiveWitness(directory))
  expect(result.witness).not.toBe('missing')
})

it('returns selected owner rows with the exact image and final directory proofs', async () => {
  write('selected', 'wanted')
  const result = await createSessionImageCodec(root).queryStopped({ kind: 'owners', keys: ['claude\0\0\0wanted'],
    defaultCodexHome: join(root, 'codex') }, performance.now() + 5000)
  expect(result.matches).toEqual([true])
  expect(result.witness).toBe(stoppedArchiveWitness(directory))
  expect(result.selected).toHaveLength(1)
  expect(result.selected![0]).toMatchObject({ state: 'image', json: true,
    proof: { document: { kind: 'stopped', agentId: 'selected' } }, value: { session: { agentId: 'selected', sessionId: 'wanted' } } })
})

it.each([false, true])('reads each exact image once and runs one final metadata scan, changed last row: %s', async changed => {
  for (let index = 0; index < 65; index++) write(`row-${index}`)
  if (changed) beforeRead((count, name) => { if (count === 65) write(name!.slice(0, -5), 'wanted') })
  const scan = vi.spyOn(fs, 'opendirSync'), open = vi.spyOn(fs, 'openSync'), parse = vi.spyOn(JSON, 'parse')
  const answer = await query()
  expect(answer.matches).toEqual([changed])
  expect(scan.mock.calls.filter(([path]) => path === directory)).toHaveLength(1)
  expect(open.mock.calls.filter(([path]) => String(path).endsWith('.json'))).toHaveLength(65)
  expect(parse).toHaveBeenCalledTimes(65)
  expect(answer.witness).toBe(stoppedArchiveWitness(directory))
  expect(scan.mock.calls.filter(([path]) => path === directory)).toHaveLength(2) // The parent's unchanged final fence.
  expect(parse).toHaveBeenCalledTimes(65)
})

it('refuses initial admission and shared cleanup uncertainty before opening its iterator', async () => {
  const open = vi.spyOn(asyncFs, 'opendir')
  const secure = vi.spyOn(custody, 'secureStateDirectory')
  secure.mockImplementationOnce(() => { throw new Error('fixture unsafe directory') })
  await expect(query()).rejects.toMatchObject({ code: 'unsafe' })
  secure.mockImplementationOnce(() => { throw new custody.StateFileCleanupUnconfirmed() })
  await expect(query()).rejects.toMatchObject({ code: 'cleanup-unconfirmed' })
  expect(open).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('groups all considered query names in 64-entry directory ownership scopes', async () => {
  for (let index = 0; index < 128; index++) fs.writeFileSync(join(directory, `ignored-${index}.tmp`), '')
  write('selected', 'wanted')
  const open = vi.spyOn(fs, 'openSync')
  expect((await query()).matches).toEqual([true])
  // Three retained page descriptors; metadata admission and the final witness acquire none. No initial full scan.
  expect(open.mock.calls.filter(([path]) => path === directory)).toHaveLength(3)
})

it('retains final detection when a nonmatching archive changes in place during the awaited scan', async () => {
  write('first'); write('second')
  let alreadyRead: string
  beforeRead((count, name) => {
    if (count === 1) alreadyRead = name!.slice(0, -5)
    if (count === 2) write(alreadyRead, 'wanted')
  })
  await expect(query()).rejects.toMatchObject({ code: 'changed' })
})

it.each(['before', 'after'] as const)('compares the observed graph to the final witness when bytes change %s their read', async phase => {
  write('selected', 'wanted')
  beforeRead(count => { if (count === (phase === 'before' ? 1 : 2)) write('selected', 'replacement') })
  if (phase === 'before') expect((await query()).matches).toEqual([false])
  else await expect(query()).rejects.toMatchObject({ code: 'changed' })
})

it.each(['missing', 'renamed'] as const)('refuses an archive that is %s after enumeration', async fault => {
  write('selected', 'wanted')
  beforeRead(count => {
    if (count !== 1) return
    if (fault === 'missing') fs.rmSync(join(directory, 'selected.json'))
    else fs.renameSync(join(directory, 'selected.json'), join(directory, 'renamed.json'))
  })
  await expect(query()).rejects.toMatchObject({ code: 'changed' })
})

it.each(['missing', 'refused'] as const)('refuses %s metadata for the intentionally excluded record', async fault => {
  write('excluded', 'wanted')
  if (fault === 'missing') beforeRead(count => { if (count === 1) fs.rmSync(join(directory, 'excluded.json')) })
  else {
    const stat = asyncFs.lstat
    vi.spyOn(asyncFs, 'lstat').mockImplementation((async (...args: Parameters<typeof stat>) => {
      if (args[0] === join(directory, 'excluded.json')) throw Object.assign(new Error('fixture metadata refused'), { code: 'EACCES' })
      return stat(...args)
    }) as typeof stat)
  }
  await expect(query('excluded')).rejects.toMatchObject({ code: fault === 'missing' ? 'changed' : 'EACCES' })
})

it('refuses an incomplete iterator even when the original and final directory witnesses match', async () => {
  write('first'); write('second', 'wanted')
  const open = asyncFs.opendir
  vi.spyOn(asyncFs, 'opendir').mockImplementation((async (...args: Parameters<typeof open>) => {
    const handle = await open(...args), read = handle.read.bind(handle)
    let delivered = false
    handle.read = (async () => { if (delivered) return null; delivered = true; return read() }) as typeof handle.read
    return handle
  }) as typeof open)
  await expect(query()).rejects.toMatchObject({ code: 'changed' })
})

it.each(['entries', 'deadline', 'close'] as const)('keeps %s refusal and actual iterator cleanup without a partial answer', async fault => {
  write('selected', 'wanted')
  let closed = false, reads = 0, now = 0
  if (fault === 'deadline') vi.spyOn(performance, 'now').mockImplementation(() => now)
  const open = asyncFs.opendir
  vi.spyOn(asyncFs, 'opendir').mockImplementation((async (...args: Parameters<typeof open>) => {
    const handle = await open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle)
    handle.read = (async () => {
      reads++
      if (fault === 'entries') return { name: 'ignored.tmp' }
      if (fault === 'deadline') now = 5001
      return read()
    }) as typeof handle.read
    handle.close = (async () => {
      await close(); closed = true
      if (fault === 'close') throw new Error('fixture close uncertain after physical settlement')
    }) as typeof handle.close
    return handle
  }) as typeof open)
  await expect(query()).rejects.toMatchObject({ code: fault === 'close' ? 'cleanup-unconfirmed' : 'expired' })
  expect(closed).toBe(true)
  if (fault === 'entries') expect(reads).toBe(16_385)
})

it('permits unrelated temporary writes without weakening its exact archive witness', async () => {
  write('selected', 'wanted')
  beforeRead(count => { if (count === 1) fs.writeFileSync(join(directory, 'unrelated.tmp'), '') })
  expect((await query()).matches).toEqual([true])
})

it.skipIf(process.platform === 'win32')('refuses directory replacement before a file and closes its iterator', async () => {
  write('selected', 'wanted')
  let closed = false
  const open = asyncFs.opendir
  vi.spyOn(asyncFs, 'opendir').mockImplementation((async (...args: Parameters<typeof open>) => {
    const handle = await open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle)
    handle.close = (async () => { await close(); closed = true }) as typeof handle.close
    handle.read = (async () => {
      const entry = await read()
      fs.renameSync(directory, directory + '-old'); fs.mkdirSync(directory, { mode: 0o700 }); write('selected', 'wanted')
      return entry
    }) as typeof handle.read
    return handle
  }) as typeof open)
  await expect(query()).rejects.toMatchObject({ code: 'changed' })
  expect(closed).toBe(true)
})
