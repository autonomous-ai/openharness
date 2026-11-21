import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sourceFiles } from './sourceFiles.js'

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return { ...real, readdirSync: vi.fn(real.readdirSync) }
})

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'source-files-'))
  mkdirSync(join(root, 'lib', 'deep'), { recursive: true })
  writeFileSync(join(root, 'main.ts'), '')
  writeFileSync(join(root, '.eslintrc'), '')
  writeFileSync(join(root, 'lib', 'deep', 'a.ts'), '')
  mkdirSync(join(root, '.tmp', 'plugin-post-1'), { recursive: true })
  writeFileSync(join(root, '.tmp', 'plugin-post-1', 'plugin.ts'), '')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('lists every file from the root with /, but those in a dot-folder', () => {
  expect(sourceFiles(root).sort()).toEqual(['.eslintrc', 'lib/deep/a.ts', 'main.ts'])
})

it('does not fail when a scratch folder goes while it walks', () => {
  // As engines/pluginPosts.spec.ts removes its src/.tmp folder: after the root is listed, before the folder is.
  const real = vi.mocked(fs.readdirSync).getMockImplementation()!
  vi.mocked(fs.readdirSync).mockImplementationOnce(((path: fs.PathLike, options: never) => {
    const entries = real(path, options)
    rmSync(join(root, '.tmp'), { recursive: true })
    return entries
  }) as typeof fs.readdirSync)
  expect(sourceFiles(root).sort()).toEqual(['.eslintrc', 'lib/deep/a.ts', 'main.ts'])
})
