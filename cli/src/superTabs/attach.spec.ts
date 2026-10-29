import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'

/** A name swapped while it is checked: right after it was opened, before its real path is read. */
const swap = vi.hoisted(() => ({ at: '', to: '', move: '' }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const native = (path: Parameters<typeof fs.realpathSync.native>[0]) => {
    if (swap.at && path === swap.at) {
      if (swap.move) fs.renameSync(swap.at, swap.move)
      else fs.unlinkSync(swap.at)
      fs.symlinkSync(swap.to, swap.at)
      swap.at = ''
    }
    return fs.realpathSync.native(path)
  }
  const realpathSync = Object.assign((...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args), { native })
  return { ...fs, default: { ...fs, realpathSync }, realpathSync }
})
const { readInsideFolder } = await import('./attach.js')

const made: string[] = []
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dir = (prefix: string) => { const path = mkdtempSync(join(tmpdir(), prefix)); made.push(path); return path }

it('reads a file inside the folder whole, by its own name and type', () => {
  const folder = dir('buddy-folder-')
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  expect(readInsideFolder([join(folder, 'plan.md')], folder)).toEqual([{ name: 'plan.md', type: 'text/markdown', bytes: Buffer.from('# Plan\n') }])
})

it('refuses a name swapped for a link out of the folder between opening it and checking where it is', () => {
  const folder = dir('buddy-folder-'), outside = dir('buddy-outside-')
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside bytes')
  Object.assign(swap, { at: join(folder, 'plan.md'), to: join(outside, 'secret.txt') })
  expect(() => readInsideFolder([join(folder, 'plan.md')], folder)).toThrow('is outside your folder')
  // The opened file moved out with its one name, and the name now leads to another file inside: the file opened is not
  // the one named.
  unlinkSync(join(folder, 'plan.md'))
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  writeFileSync(join(folder, 'other.md'), '# Other\n')
  Object.assign(swap, { at: join(folder, 'plan.md'), to: join(folder, 'other.md'), move: join(outside, 'moved.md') })
  expect(() => readInsideFolder([join(folder, 'plan.md')], folder)).toThrow('is outside your folder')
})

it('refuses a link as the last name, a folder inside, and a file over the limit', () => {
  const folder = dir('buddy-folder-')
  writeFileSync(join(folder, 'plan.md'), '# Plan\n')
  symlinkSync(join(folder, 'plan.md'), join(folder, 'alias.md'))
  expect(() => readInsideFolder([join(folder, 'alias.md')], folder)).toThrow('is outside your folder')
  expect(() => readInsideFolder([folder.concat('/')], folder)).toThrow('is outside your folder')
  writeFileSync(join(folder, 'big.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))
  expect(() => readInsideFolder([join(folder, 'big.bin')], folder)).toThrow('over the 10.0 MB limit')
})

// Run apart: a blocking open stops the whole process, which no test timeout in it can end (re-check of #2103).
it.skipIf(process.platform === 'win32')('refuses a named pipe and the terminal\'s input without waiting on them', async () => {
  const folder = dir('buddy-folder-')
  execFileSync('mkfifo', [join(folder, 'pipe.md')])
  const script = `
    const { readInsideFolder } = await import(${JSON.stringify(new URL('./attach.ts', import.meta.url).pathname)})
    const tried = (path) => { try { readInsideFolder([path], process.argv[1]); return 'read' } catch (error) { return error.message } }
    console.log(JSON.stringify([tried(process.argv[2]), tried('/dev/stdin')]))
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, folder, join(folder, 'pipe.md')],
    { timeout: 15_000 })
  expect(JSON.parse(stdout.trim())).toEqual([`${join(folder, 'pipe.md')} is not a file.`, expect.stringContaining('/dev/stdin is outside your folder')])
}, 20_000)
