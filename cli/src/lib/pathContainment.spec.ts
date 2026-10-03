import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { env } from '../config/env.js'
import { tempRoots, within, withinRoots } from './pathContainment.js'

let root: string
const unrestricted = env.HARNESS_FS_BROWSE_UNRESTRICTED
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'harness-containment-')))
  env.HARNESS_FS_BROWSE_UNRESTRICTED = undefined
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  env.HARNESS_FS_BROWSE_UNRESTRICTED = unrestricted
})

it('counts a root itself and what is under it, and nothing else', () => {
  expect(within('/a/b', '/a/b')).toBe(true)
  expect(within('/a/b', '/a/b/c/d')).toBe(true)
  // The reason this is `relative()` and not `startsWith`: a sibling shares the prefix.
  expect(within('/a/b', '/a/bc')).toBe(false)
  expect(within('/a/b', '/a')).toBe(false)
  expect(within('/a/b', '/other')).toBe(false)
})

it('measures the target against roots resolved through their symlinks', async () => {
  const real = join(root, 'real')
  await mkdir(real)
  await writeFile(join(real, 'file'), 'x')
  const link = join(root, 'link')
  await symlink(real, link)
  // The root is named by its link; a file inside the folder it points at is still inside it.
  expect(await withinRoots(join(real, 'file'), [link])).toBe(true)
  expect(await withinRoots(join(root, 'elsewhere'), [real])).toBe(false)
})

it('refuses when no root resolves, rather than allowing everything', async () => {
  expect(await withinRoots(join(root, 'file'), [])).toBe(false)
  expect(await withinRoots(join(root, 'file'), [join(root, 'not-there')])).toBe(false)
  // One good root among unresolvable ones still admits what is inside it.
  expect(await withinRoots(join(root, 'file'), [join(root, 'not-there'), root])).toBe(true)
})

it('honours the folder-browser opt-out', async () => {
  expect(await withinRoots('/etc/passwd', [root])).toBe(false)
  env.HARNESS_FS_BROWSE_UNRESTRICTED = '1'
  expect(await withinRoots('/etc/passwd', [root])).toBe(true)
})

it('names both temp directories, because macOS has a private one and agents still write /tmp', () => {
  expect(tempRoots()).toContain(tmpdir())
  expect(tempRoots()).toContain('/tmp')
})
