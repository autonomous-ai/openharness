import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeLink, removePath, removeQuietly } from './removePath.js'

// A copy of the module, so a test can make a removal fail.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'remove-path-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
const there = (path: string) => { try { lstatSync(path); return true } catch { return false } }

it('removes a link whose target is gone, so a link can be made in its place', () => {
  const link = join(root, 'tool')
  symlinkSync(join(root, 'gone'), link)
  removePath(link)
  expect(there(link)).toBe(false)
  symlinkSync(join(root, 'new'), link)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
})

it('removes a link to a folder and leaves the folder and what is in it', () => {
  const target = join(root, 'checkout'), link = join(root, 'linked')
  mkdirSync(target)
  writeFileSync(join(target, 'kept'), 'kept')
  symlinkSync(target, link, 'junction')
  removePath(link)
  expect(there(link)).toBe(false)
  expect(existsSync(join(target, 'kept'))).toBe(true)
})

it('removes a folder with what is in it, a file, and nothing when nothing is there', () => {
  const folder = join(root, 'folder'), file = join(root, 'file')
  mkdirSync(join(folder, 'inner'), { recursive: true })
  writeFileSync(join(folder, 'inner', 'a'), 'a')
  writeFileSync(file, 'f')
  removePath(folder)
  removePath(file)
  removePath(join(root, 'never'))
  expect([there(folder), there(file)]).toEqual([false, false])
})

it('removes only a link or a file where a link is kept, and refuses a real folder there', () => {
  const link = join(root, 'tool'), folder = join(root, 'bin-folder')
  symlinkSync(join(root, 'gone'), link)
  removeLink(link)
  expect(there(link)).toBe(false)
  mkdirSync(join(folder, 'inner'), { recursive: true })
  expect(() => removeLink(folder)).toThrow()
  expect(existsSync(join(folder, 'inner'))).toBe(true)
  removeLink(join(root, 'never'))
})

it('takes a path under a file as nothing there', () => {
  const file = join(root, 'file')
  writeFileSync(file, 'f')
  removePath(join(file, 'under'))
  removeLink(join(file, 'under'))
  expect(there(file)).toBe(true)
})

it('removes quietly a file, a link whose target is gone, a folder with what is in it, and nothing when nothing is there', () => {
  const file = join(root, 'file'), link = join(root, 'tool'), folder = join(root, 'folder')
  writeFileSync(file, 'f')
  symlinkSync(join(root, 'gone'), link)
  mkdirSync(join(folder, 'inner'), { recursive: true })
  writeFileSync(join(folder, 'inner', 'a'), 'a')
  for (const path of [file, link, folder, join(root, 'never')]) removeQuietly(path)
  expect([there(file), there(link), there(folder)]).toEqual([false, false, false])
})

it('returns when the removal throws, as Windows does for a file another program holds', () => {
  const file = join(root, 'held')
  writeFileSync(file, 'f')
  const busy = () => { throw Object.assign(new Error('EBUSY: fixture'), { code: 'EBUSY' }) }
  vi.spyOn(fs, 'unlinkSync').mockImplementation(busy)
  vi.spyOn(fs, 'rmSync').mockImplementation(busy)
  expect(() => removeQuietly(file)).not.toThrow()
  expect(there(file)).toBe(true)
})
