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
const query = () => createSessionImageCodec(root).queryStopped({ kind: 'conversations', ids: ['wanted'], reservations: false }, performance.now() + 5000)
function beforeRead(change: (count: number) => void) {
  const open = asyncFs.opendir
  vi.spyOn(asyncFs, 'opendir').mockImplementation((async (...args: Parameters<typeof open>) => {
    const directory = await open(...args), read = directory.read.bind(directory)
    let count = 0
    directory.read = (async () => { const entry = await read(); change(++count); return entry }) as typeof directory.read
    return directory
  }) as typeof open)
}

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
