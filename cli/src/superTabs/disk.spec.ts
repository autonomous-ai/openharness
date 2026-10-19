import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCapacityDisk } from './disk.js'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
it('samples the actual managed worktree parent even when its source is elsewhere', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'super-tab-disk-')); directories.push(parent)
  const root = join(parent, 'not-created-yet')
  const ordinary = await readCapacityDisk(parent)
  expect(await readCapacityDisk('/unmounted/source/repo', true, root)).toMatchObject({ volume: ordinary.volume, path: parent })
  mkdirSync(join(root, 'worktrees'), { recursive: true })
  expect(await readCapacityDisk('/unmounted/source/repo', true, root)).toMatchObject({ path: join(root, 'worktrees') })
  await expect(readCapacityDisk('/unmounted/source/repo', false, root)).rejects.toThrow()
  rmSync(join(root, 'worktrees'), { recursive: true }); writeFileSync(join(root, 'worktrees'), 'not a folder')
  await expect(readCapacityDisk(parent, true, root)).rejects.toThrow('not a directory')
})
