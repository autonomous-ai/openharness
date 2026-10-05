import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})

import * as fsp from 'node:fs/promises'
import { assertNotLoopLog, snapshotArtifacts } from './artifacts.js'

describe('reserved loop logs', () => {
  let root: string
  const write = (path: string, text: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'artifacts-')); write('out.txt', 'y') })
  afterEach(() => { vi.mocked(fsp.realpath).mockRestore(); rmSync(root, { recursive: true, force: true }) })

  it('refuses a loop log as an artifact, directly or through an alias, and accepts other files', async () => {
    write('.harness/loop/1.stdout.log', 'x'); symlinkSync(join(root, '.harness/loop'), join(root, 'alias'))
    await expect(assertNotLoopLog(root, ['.harness/loop/1.stdout.log'])).rejects.toMatchObject({ code: 'INVALID_ARTIFACT', message: '.harness/loop/1.stdout.log is a loop check log, not an artifact.' })
    await expect(assertNotLoopLog(root, ['alias/1.stdout.log'])).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    await expect(assertNotLoopLog(root, ['.harness/loop'])).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    await expect(assertNotLoopLog(root, ['out.txt', 'missing.txt'])).resolves.toBeUndefined()
    await expect(snapshotArtifacts(root, join(root, 'dest'), ['.harness/loop/1.stdout.log'], () => {})).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
  })
  it.each([
    ['.harness is a link', 'sub', '.harness', 'sub/loop/1.stdout.log'],
    ['.harness/loop is a link', 'logs', '.harness/loop', 'logs/1.stdout.log'],
  ])('refuses the loop logs when %s, by either name', async (_name, target, link, real) => {
    write(join(target, link === '.harness' ? 'loop/1.stdout.log' : '1.stdout.log'), 'x')
    mkdirSync(join(root, link, '..'), { recursive: true }); symlinkSync(join(root, target), join(root, link))
    for (const path of ['.harness/loop/1.stdout.log', real]) {
      await expect(assertNotLoopLog(root, [path])).rejects.toMatchObject({ code: 'INVALID_ARTIFACT', message: `${path} is a loop check log, not an artifact.` })
      await expect(snapshotArtifacts(root, join(root, 'dest'), [path], () => {})).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' })
    }
    await expect(snapshotArtifacts(root, join(root, 'dest'), ['out.txt'], () => {})).resolves.toHaveLength(1)
  })
  it('copies the file it checked, even when an alias changes right after the check', async () => {
    write('.harness/loop/1.stdout.log', 'loop log'); write('safe/1.stdout.log', 'safe')
    const alias = join(root, 'alias'); symlinkSync(join(root, 'safe'), alias)
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let swapped = false
    vi.mocked(fsp.realpath).mockImplementation((async (path: string) => {
      const resolved = await actual.realpath(path)
      // The worker repoints the alias at the loop logs as soon as the path has been resolved once.
      if (!swapped && String(path).endsWith('alias/1.stdout.log')) { swapped = true; rmSync(alias); symlinkSync(join(root, '.harness/loop'), alias) }
      return resolved
    }) as typeof fsp.realpath)
    const saved = await snapshotArtifacts(root, join(root, 'dest'), ['alias/1.stdout.log'], () => {})
    expect(swapped).toBe(true)
    expect(saved).toMatchObject([{ path: 'alias/1.stdout.log', size: 4 }])
    expect(readFileSync(join(root, 'dest/alias/1.stdout.log'), 'utf8')).toBe('safe')
  })
})
