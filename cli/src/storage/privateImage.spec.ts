import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readPrivateImage } from './privateImage.js'
import { sameSessionFileIdentity, sessionFileIdentity } from '../lib/sessionStorageWire.js'

vi.mock('node:fs/promises', async original => ({ ...await original<object>() }))

vi.mock('../lib/sessionStorageWire.js', async original => {
  const actual = await original<typeof import('../lib/sessionStorageWire.js')>()
  return { ...actual, sessionFileIdentity: vi.fn(actual.sessionFileIdentity) }
})
let root: string, file: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'private-image-'))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  file = join(root, 'state', 'image.json')
  writeFileSync(file, '[{"title":"fixture"}]', { mode: 0o600 })
  vi.mocked(sessionFileIdentity).mockClear()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('checks the exact read metadata without repeatedly serializing proof identities', async () => {
  const image = await readPrivateImage(file, 1024)
  expect(image?.bytes.toString()).toBe('[{"title":"fixture"}]')
  expect(sessionFileIdentity).toHaveBeenCalledTimes(0)
})

it('reads a private image inside its owning process without per-operation libuv round trips', async () => {
  const open = vi.spyOn(fs, 'open')
  const image = await readPrivateImage(file, 1024)
  expect(image?.bytes.toString()).toBe('[{"title":"fixture"}]')
  expect(open).toHaveBeenCalledTimes(0)
})

const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs', 'mode', 'uid', 'gid', 'nlink'] as const
const change = (stat: BigIntStats, field: typeof fields[number]): BigIntStats => {
  const result = Object.create(Object.getPrototypeOf(stat), Object.getOwnPropertyDescriptors(stat)) as BigIntStats
  result[field] += 1n
  return result
}

it.each(fields)('preserves the canonical proof equality for changed %s in every before/after/path ordering', field => {
  const before = lstatSync(file, { bigint: true }), changed = change(before, field)
  for (const [left, right] of [[before, before], [before, changed], [changed, before], [changed, changed]]) {
    expect(sameSessionFileIdentity(left, right)).toBe(sessionFileIdentity(left) === sessionFileIdentity(right))
  }
})

it('does not promote atime into an identity field', () => {
  const before = lstatSync(file, { bigint: true }), after = { ...before, atimeNs: before.atimeNs + 1n } as BigIntStats
  expect(sameSessionFileIdentity(before, after)).toBe(true)
  expect(sessionFileIdentity(before)).toBe(sessionFileIdentity(after))
})

it.each(fields.flatMap(field => ['after', 'path'].map(phase => ({ field, phase }))))(
  'refuses the actual read when $phase metadata changes $field', async ({ field, phase }) => {
    let closed = false
    const open = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args), stat = handle.stat.bind(handle), close = handle.close.bind(handle)
      let count = 0
      handle.stat = (async (options: { bigint: true }) => {
        const result = await stat(options)
        return phase === 'after' && ++count === 2 ? change(result, field) : result
      }) as typeof handle.stat
      handle.close = async () => { await close(); closed = true }
      return handle
    })
    const lstat = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const result = await lstat(...args)
      return phase === 'path' ? change(result as BigIntStats, field) : result
    }) as typeof fs.lstat)
    await expect(readPrivateImage(file, 1024)).rejects.toMatchObject({ code: 'changed' })
    expect(closed).toBe(true)
  })
