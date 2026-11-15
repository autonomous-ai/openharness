import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeHeldFiles, nativeOpenFiles } from './nativeConversation.js'
import { readProcessEvidence } from './processEvidence.js'
import { readDescriptorEvidence, type NativeDescriptor } from '../engines/kit/nativeDescriptors.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'

vi.mock('./processEvidence.js', () => ({ readProcessEvidence: vi.fn() }))
vi.mock('../engines/kit/nativeDescriptors.js', async original => ({ ...await original<object>(), readDescriptorEvidence: vi.fn() }))
const expected = { pid: 42, executable: 'openclaw', startMarker: '2026-11-16T00:00:00.000Z' }
let root: string, path: string, descriptors: NativeDescriptor[]
const joined = vi.fn(async () => {})
const verified = vi.fn(async () => {})
const selected = () => nativeHeldFiles(expected, name => name.endsWith('/state.db'))
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-held-files-'))); path = join(root, 'state.db')
  writeFileSync(path, 'native state')
  const info = lstatSync(path, { bigint: true })
  descriptors = [{ fd: '3', path, kind: 'REG', device: info.dev, inode: info.ino }, { fd: '4', path: 'pipe', kind: 'FIFO' }]
  vi.mocked(readProcessEvidence).mockReset().mockResolvedValue({ parent: expected, children: [], verify: vi.fn(), verifyDescriptors: joined } as never)
  vi.mocked(readDescriptorEvidence).mockReset().mockImplementation(async () => ({ descriptors, verify: verified }))
  joined.mockReset().mockResolvedValue(); verified.mockReset().mockResolvedValue()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('brackets matching file locations with the captured process and a joined final identity check', async () => {
  const result = await selected()
  expect(result.paths).toEqual([path]); result.verify()
  expect(readProcessEvidence).toHaveBeenCalledWith(42, expect.anything(), undefined, expected)
  expect(joined).toHaveBeenCalledWith(new Map([[42, descriptors]]))
  expect(readProcessEvidence).toHaveBeenCalledBefore(vi.mocked(readDescriptorEvidence))
  expect(verified).toHaveBeenCalledBefore(joined)
})

it.each(['pool', 'owner'] as const)('never turns an incomplete %s verification into an empty/default location', async which => {
  ;(which === 'pool' ? verified : joined).mockRejectedValueOnce(new IdentityReadUnavailable('the native evidence changed'))
  await expect(selected()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})

it('holds a disappeared captured owner before asking for any file paths', async () => {
  vi.mocked(readProcessEvidence).mockResolvedValue({ parent: null } as never)
  await expect(selected()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(readDescriptorEvidence).not.toHaveBeenCalled()
})

it('preserves optional discovery without process authority while refusing an invalid captured owner', async () => {
  expect(await nativeOpenFiles(42)).toEqual([path])
  expect(readProcessEvidence).not.toHaveBeenCalled()
  expect(await nativeOpenFiles(0)).toEqual([])
  await expect(nativeHeldFiles({ ...expected, pid: 0 }, () => true)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})

it('distinguishes verified empty from malformed or over-limit matching descriptors', async () => {
  descriptors = []
  const empty = await selected(); expect(empty.paths).toEqual([]); empty.verify()
  descriptors = [{ fd: '3', path: path + ' (deleted)', kind: 'REG', device: 1n, inode: 2n }]
  await expect(selected()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  const info = lstatSync(path, { bigint: true })
  descriptors = Array.from({ length: 65 }, (_, i) => ({ fd: String(i + 3), path, kind: 'REG', device: info.dev, inode: info.ino }))
  await expect(selected()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
