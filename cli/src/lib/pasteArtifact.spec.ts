import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { NATIVE_EVIDENCE_MS } from '../engines/kit/nativeEvidence.js'
import { chmod, link, lstat, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPreparedPaste, pasteFileVersion } from './pasteArtifact.js'

const closeFault = vi.hoisted(() => ({ fail: false, calls: 0 }))
vi.mock('node:fs', async actual => {
  const fs = await actual<typeof import('node:fs')>()
  return { ...fs, closeSync: (fd: number) => {
    closeFault.calls++
    fs.closeSync(fd)
    if (closeFault.fail) throw new Error('fixture close failure')
  } }
})

const roots: string[] = []
async function artifact() {
  const root = await mkdtemp(join(tmpdir(), 'paste-proof-')); roots.push(root)
  const directory = join(root, 'paste-drops', 'file-uploads')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const generation = randomUUID(), name = `${generation}-fixture.txt`, path = join(directory, name)
  await writeFile(path, 'private fixture', { mode: 0o600 })
  return { root, directory, generation, name, path, version: pasteFileVersion(await lstat(path, { bigint: true })) }
}
afterEach(async () => { vi.restoreAllMocks(); closeFault.fail = false; closeFault.calls = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('prepared file authority', () => {
  it('names unconfirmed descriptor cleanup when validation fails before returning its proof', async () => {
    const file = await artifact()
    closeFault.fail = true
    expect(() => openPreparedPaste(file.generation, { ...file, version: 'stale' }, file.root)).toThrow('PASTE_FILE_CLOSE_FAILED')
    expect(closeFault.calls).toBe(1)
  })

  it.each([false, true])('attempts proof close only once, including uncertain=%s', async (fail) => {
    const file = await artifact(), proof = openPreparedPaste(file.generation, file, file.root)
    closeFault.fail = fail
    if (fail) {
      expect(() => proof.close()).toThrow('PASTE_FILE_CLOSE_FAILED')
      expect(() => proof.close()).toThrow('PASTE_FILE_CLOSE_FAILED')
    } else { proof.close(); proof.close() }
    expect(closeFault.calls).toBe(1)
    expect(proof.current()).toBe(false)
  })

  it.each(['unchanged', 'edited', 'ancestry'] as const)('rechecks retained authority after waiting beyond the initial budget: %s', async (change) => {
    const file = await artifact()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const proof = openPreparedPaste(file.generation, file, file.root)
    try {
      clock = NATIVE_EVIDENCE_MS + 1
      expect(proof.current()).toBe(true)
      if (change === 'edited') await writeFile(file.path, 'changed private fixture')
      if (change === 'ancestry') {
        await rename(file.directory, `${file.directory}-old`)
        await mkdir(file.directory, { mode: 0o700 })
      }
      expect(proof.current()).toBe(change === 'unchanged')
    } finally { proof.close() }
  })

  it('still refuses a final verification that exceeds its own fresh budget', async () => {
    const file = await artifact()
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const proof = openPreparedPaste(file.generation, file, file.root)
    try {
      now.mockImplementation(() => { clock += NATIVE_EVIDENCE_MS + 1; return clock })
      expect(proof.current()).toBe(false)
    } finally { proof.close() }
  })

  it('accepts only the selected generation and a bounded single path component', async () => {
    const file = await artifact()
    for (const name of [join(file.root, 'outside'), `${randomUUID()}-fixture.txt`, `${file.generation}-../outside`,
      `${file.generation}-a\nb`, `${file.generation}-x:y`, `${file.generation}-x.`, `${file.generation}-${'x'.repeat(121)}`]) {
      expect(() => openPreparedPaste(file.generation, { name, version: file.version }, file.root)).toThrow('PASTE_INVALID_ARTIFACT')
    }
    expect(() => openPreparedPaste('bad', file, file.root)).toThrow('PASTE_INVALID_ARTIFACT')
    const opened = openPreparedPaste(file.generation, file, file.root)
    expect(opened.path).toBe(file.path)
    expect(opened.current()).toBe(true)
    opened.close()
  })

  it('refuses a worker-selected symlink and a hardlink to another file', async () => {
    const file = await artifact(), outside = join(file.root, 'outside')
    await rename(file.path, outside)
    await symlink(outside, file.path)
    expect(() => openPreparedPaste(file.generation, file, file.root)).toThrow('PASTE_INVALID_ARTIFACT')
    await unlink(file.path)
    await link(outside, file.path)
    const version = pasteFileVersion(await lstat(file.path, { bigint: true }))
    expect(() => openPreparedPaste(file.generation, { ...file, version }, file.root)).toThrow('PASTE_INVALID_ARTIFACT')
  })

  it('detects a replacement pathname while the original descriptor remains open', async () => {
    const file = await artifact(), opened = openPreparedPaste(file.generation, file, file.root)
    try {
      await rename(file.path, join(file.directory, 'old'))
      await writeFile(file.path, 'replacement', { mode: 0o600 })
      expect(opened.current()).toBe(false)
    } finally { opened.close() }
  })

  it('detects edits to the same inode and ancestry replacement at the final guard', async () => {
    const file = await artifact(), opened = openPreparedPaste(file.generation, file, file.root)
    try {
      await writeFile(file.path, 'changed contents')
      expect(opened.current()).toBe(false)
      await rename(file.directory, `${file.directory}-old`)
      await mkdir(file.directory, { mode: 0o700 })
      expect(opened.current()).toBe(false)
    } finally { opened.close() }
  })

  it('refuses unsafe file or directory permissions and empty artifacts', async () => {
    const file = await artifact()
    if (process.platform !== 'win32') {
      await chmod(file.path, 0o644)
      const version = pasteFileVersion(await lstat(file.path, { bigint: true }))
      expect(() => openPreparedPaste(file.generation, { ...file, version }, file.root)).toThrow('PASTE_INVALID_ARTIFACT')
      await chmod(file.path, 0o600)
      await chmod(join(file.root, 'paste-drops'), 0o777)
      expect(() => openPreparedPaste(file.generation, file, file.root)).toThrow('PASTE_INVALID_ARTIFACT')
      await chmod(join(file.root, 'paste-drops'), 0o700)
    }
    await writeFile(file.path, '')
    const version = pasteFileVersion(await lstat(file.path, { bigint: true }))
    expect(() => openPreparedPaste(file.generation, { ...file, version }, file.root)).toThrow('PASTE_INVALID_ARTIFACT')
  })
})
