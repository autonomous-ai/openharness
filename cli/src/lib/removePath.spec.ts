import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removePath } from './removePath.js'

let root = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'remove-path-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
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
