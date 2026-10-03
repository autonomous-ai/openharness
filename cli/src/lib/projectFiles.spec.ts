import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addExcludeEntry, isLink, isPlainDir, isPlainFile } from './projectFiles.js'

const roots: string[] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'project-files-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const entry = { pattern: '**/.harness/handoff/', comment: 'Private handoff files' }

it('distinguishes files, directories, missing paths and live/dangling symlinks', () => {
  const root = fixture(), file = join(root, 'file'), missing = join(root, 'missing')
  writeFileSync(file, '')
  symlinkSync(file, join(root, 'file-link'))
  symlinkSync(root, join(root, 'dir-link'))
  symlinkSync(missing, join(root, 'dangling'))
  expect(isPlainFile(file)).toBe(true)
  expect(isPlainDir(root)).toBe(true)
  expect(isPlainFile(root)).toBe(false)
  expect(isPlainDir(file)).toBe(false)
  for (const path of [missing, join(root, 'file-link'), join(root, 'dir-link'), join(root, 'dangling')]) {
    expect(isPlainFile(path)).toBe(false)
    expect(isPlainDir(path)).toBe(false)
    expect(isLink(path)).toBe(path !== missing)
  }
  expect(isLink(file)).toBe(false)
})

it.each(['', 'existing', 'existing\n', `  ${entry.pattern}  \n`])('preserves existing exclude contents %j and adds at most one entry', text => {
  const root = fixture(), file = join(root, 'exclude')
  writeFileSync(file, text)
  expect(addExcludeEntry(file, entry)).toBe(file)
  const result = readFileSync(file, 'utf8')
  expect(result.startsWith(text)).toBe(true)
  expect(result.split('\n').filter(line => line.trim() === entry.pattern)).toHaveLength(1)
  expect(addExcludeEntry(file, entry)).toBe(file)
  expect(readFileSync(file, 'utf8')).toBe(result)
})

it('creates a missing parent and refuses linked files or parents without changing their targets', () => {
  const root = fixture(), file = join(root, 'info', 'exclude')
  expect(addExcludeEntry(file, entry)).toBe(file)
  const original = readFileSync(file, 'utf8')
  symlinkSync(file, join(root, 'linked-file'))
  symlinkSync(join(root, 'info'), join(root, 'linked-info'))
  expect(addExcludeEntry(join(root, 'linked-file'), { pattern: 'other', comment: '' })).toBeNull()
  expect(addExcludeEntry(join(root, 'linked-info', 'exclude'), { pattern: 'other', comment: '' })).toBeNull()
  expect(readFileSync(file, 'utf8')).toBe(original)
  mkdirSync(join(root, 'directory-exclude'))
  expect(() => addExcludeEntry(join(root, 'directory-exclude'), entry)).toThrow()
})
