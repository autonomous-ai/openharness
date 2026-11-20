import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectHookFile } from './nativeHookFiles.js'

const reads = vi.hoisted(() => ({ paths: [] as string[], after: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
    const result = fs.lstatSync(...args), path = String(args[0])
    reads.paths.push(path); reads.after?.(path)
    return result
  } }
})
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-capture-paths-')))
  reads.paths.length = 0
})
afterEach(() => { reads.after = undefined; rmSync(root, { recursive: true, force: true }) })

it.each(['present', 'absent', 'nested absent', 'alias present', 'alias absent'] as const)(
  'reuses only the provisional parent walk for a %s file', kind => {
    const parent = join(root, 'profile'), alias = join(root, 'selected')
    mkdirSync(parent)
    if (kind.startsWith('alias')) symlinkSync(parent, alias, 'dir')
    const suffix = kind === 'nested absent' ? join('missing', 'child', 'settings.json') : 'settings.json'
    const file = join(kind.startsWith('alias') ? alias : parent, suffix)
    const present = kind === 'present' || kind === 'alias present'
    if (present) writeFileSync(file, '{"kept":true}')
    const captured = inspectHookFile(file)
    expect(captured.content).toBe(present ? '{"kept":true}' : null)
    expect(captured.directory).toBe(kind === 'nested absent' ? join(parent, 'missing', 'child') : parent)
    // Initial walk + snapshot, followed by both fresh final route passes.
    expect(reads.paths.filter(path => path === root)).toHaveLength(4)
    reads.paths.length = 0
    captured.verify()
    expect(reads.paths.filter(path => path === root)).toHaveLength(2)
    mkdirSync(captured.directory, { recursive: true })
    writeFileSync(file, '{"changed":true}')
    expect(captured.verify).toThrow(/changed/)
  },
)

it('keeps the requested parent when the selected leaf points into a different directory', () => {
  const parent = join(root, 'profile'), target = join(root, 'other')
  mkdirSync(parent); mkdirSync(target)
  const file = join(parent, 'settings.json'), actual = join(target, 'settings.json')
  writeFileSync(actual, 'content'); symlinkSync(actual, file)
  const captured = inspectHookFile(file)
  expect(captured.directory).toBe(parent)
  expect(captured.content).toBe('content')
  captured.verify()
})

it.each(['replacement', 'alias'] as const)('refuses a parent %s after its initial snapshot', change => {
  const parent = join(root, 'profile'), displaced = join(root, 'previous'), file = join(parent, 'settings.json')
  mkdirSync(parent); writeFileSync(file, 'content')
  let seen = 0, changed = false
  reads.after = path => {
    if (path !== parent || ++seen !== 2) return
    reads.after = undefined; changed = true; renameSync(parent, displaced)
    if (change === 'alias') symlinkSync(displaced, parent, 'dir')
    else { mkdirSync(parent); renameSync(join(displaced, 'settings.json'), file) }
  }
  expect(() => inspectHookFile(file)).toThrow(/changed/)
  expect(changed).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('content')
})

it.each(['absent', 'nested absent'] as const)('refuses new ancestry during %s capture', kind => {
  const parent = join(root, 'profile'), displaced = join(root, 'previous')
  mkdirSync(parent)
  const file = join(parent, ...(kind === 'absent' ? [] : ['missing', 'child']), 'settings.json')
  let seen = 0, changed = false
  reads.after = path => {
    if (path !== parent || ++seen !== 2) return
    reads.after = undefined; changed = true; renameSync(parent, displaced); symlinkSync(displaced, parent, 'dir')
  }
  expect(() => inspectHookFile(file)).toThrow(/changed|unconfirmed alias/)
  expect(changed).toBe(true)
})

it('refuses an absent ancestor becoming a regular file before capture returns', () => {
  const missing = join(root, 'missing'), file = join(missing, 'child', 'settings.json')
  let seen = 0, changed = false
  reads.after = path => {
    if (path !== missing || ++seen !== 2) return
    reads.after = undefined; changed = true; writeFileSync(missing, 'other content')
  }
  expect(() => inspectHookFile(file)).toThrow(/not a directory/)
  expect(changed).toBe(true)
  expect(readFileSync(missing, 'utf8')).toBe('other content')
})
