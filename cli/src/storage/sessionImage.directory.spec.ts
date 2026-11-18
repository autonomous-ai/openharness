import * as fs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSessionImageCodec } from './sessionImage.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
vi.mock('node:fs/promises', async original => ({ ...await original<object>() }))
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
function beforeRead(change: (count: number) => void) {
  const open = asyncFs.opendir
  vi.spyOn(asyncFs, 'opendir').mockImplementation((async (...args: Parameters<typeof open>) => {
    const directory = await open(...args), read = directory.read.bind(directory)
    let count = 0
    directory.read = (async () => { const entry = await read(); change(++count); return entry }) as typeof directory.read
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

it.skipIf(process.platform === 'win32')('groups all considered query names in 64-entry directory ownership scopes', async () => {
  for (let index = 0; index < 128; index++) fs.writeFileSync(join(directory, `ignored-${index}.tmp`), '')
  write('selected', 'wanted')
  const open = vi.spyOn(fs, 'openSync')
  expect((await query()).matches).toEqual([true])
  // Two archive witnesses plus three admission/retained-FD pairs; ignored names also consume work.
  expect(open.mock.calls.filter(([path]) => path === directory)).toHaveLength(8)
})

it('retains final detection when a nonmatching archive changes in place during the awaited scan', async () => {
  write('first'); write('second')
  beforeRead(count => { if (count === 2) write('first', 'wanted') })
  await expect(query()).rejects.toMatchObject({ code: 'changed' })
})

it.each(['before', 'after'] as const)('retains the original and final witness when bytes change %s their read', async phase => {
  write('selected', 'wanted')
  beforeRead(count => { if (count === (phase === 'before' ? 1 : 2)) write('selected', 'replacement') })
  await expect(query()).rejects.toMatchObject({ code: 'changed' })
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
