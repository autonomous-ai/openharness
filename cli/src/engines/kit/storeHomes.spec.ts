import { afterEach, expect, it, vi } from 'vitest'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { forgetStoreHomes, listStoreHomes, readStoreHomes } from './storeHomes.js'

vi.mock('node:fs/promises', () => ({ readdir: vi.fn(), stat: vi.fn() }))
const declared = { profiles: 'profiles', store: (home: string) => join(home, 'state.db'), max: 2, ttlMs: 30_000 }
const directory = (name: string) => ({ name, isDirectory: () => true })
const entries = (...names: string[]) => vi.mocked(readdir).mockResolvedValue(names.map(directory) as never)
afterEach(() => { vi.resetAllMocks(); forgetStoreHomes(declared) })

it('uses fresh admission evidence even when optional readers have a cached listing', async () => {
  entries()
  expect(await listStoreHomes(declared, '/home')).toEqual(['/home'])
  entries('new')
  vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never)
  expect(await readStoreHomes(declared, '/home')).toEqual({ homes: ['/home', '/home/profiles/new'], complete: true })
  expect(await listStoreHomes(declared, '/home')).toEqual(['/home'])
})

it('distinguishes known absence from incomplete enumeration, unreadable stores and truncation', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error('directory read failed'), { code }))
    expect(await readStoreHomes(declared, '/home')).toEqual({ homes: ['/home'], complete: code === 'ENOENT' })
  }
  entries('a', 'b')
  vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    .mockResolvedValueOnce({ isFile: () => true } as never)
  expect(await readStoreHomes(declared, '/home')).toEqual({ homes: ['/home', '/home/profiles/b'], complete: true })
  vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    .mockResolvedValueOnce({ isFile: () => true } as never)
  expect(await readStoreHomes(declared, '/home')).toEqual({ homes: ['/home', '/home/profiles/b'], complete: false })
  entries('a', 'b', 'omitted')
  vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never)
  expect(await readStoreHomes(declared, '/home')).toEqual({ homes: ['/home', '/home/profiles/a', '/home/profiles/b'], complete: false })
  vi.mocked(readdir).mockResolvedValue([{ name: 'ordinary-file', isDirectory: () => false }, directory('bad-store')] as never)
  vi.mocked(stat).mockResolvedValue({ isFile: () => false } as never)
  expect(await readStoreHomes(declared, '/home')).toEqual({ homes: ['/home'], complete: false })
})
