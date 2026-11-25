import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { launch as claudeLaunch } from '../claude/launch.js'
import { readConfig } from './launchArgs.js'
import { statusLineSetting } from './statusLine.js'

// How the watched path is changed: opened for writing in place, or a file renamed onto it.
const disk = vi.hoisted(() => ({ watch: '', changes: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const writes = (flags: unknown) => typeof flags === 'number' ? (flags & 3) !== 0 : typeof flags === 'string' && flags !== 'r'
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (args[0] === disk.watch && writes(args[1])) disk.changes.push('write')
      return actual.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (args[0] === disk.watch) disk.changes.push('write')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (args[1] === disk.watch) disk.changes.push('rename')
      return actual.renameSync(...args)
    },
  }
})

let dataDir = ''
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'status-line-')) })
afterEach(() => {
  disk.watch = ''
  disk.changes = []
  rmSync(dataDir, { recursive: true, force: true })
})

it('the save goes through a temporary file renamed onto the target', () => {
  const file = join(dataDir, 'statusline', 'statusline.mjs')
  // An older release's script, which a session's status line may be running.
  mkdirSync(join(dataDir, 'statusline'))
  writeFileSync(file, '// an older script\n')
  disk.watch = file
  const files = { home: join(dataDir, 'home'), personal: dataDir, cwd: null, read: () => null }
  expect(statusLineSetting(claudeLaunch.statusLine!, files, dataDir, 'darwin')).not.toBeNull()
  expect(disk.changes).toEqual(['rename'])
  expect(readFileSync(file, 'utf8')).not.toBe('// an older script\n')
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
})

// PowerShell 5's `Set-Content -Encoding utf8` saves settings.json with a BOM, which Claude Code reads past
// (lib/settingsText.ts): the person's own status line still runs after Harness's.
it('passes along the person\'s own status line from a settings file saved with a BOM', () => {
  const home = join(dataDir, 'home')
  mkdirSync(home)
  writeFileSync(join(home, 'settings.json'), `\uFEFF${JSON.stringify({ statusLine: { type: 'command', command: 'echo owner-line' } })}`)
  const files = { home, personal: dataDir, cwd: null, read: readConfig }
  const setting = statusLineSetting(claudeLaunch.statusLine!, files, dataDir, 'darwin') as { statusLine: { command: string } }
  expect(setting.statusLine.command).toContain(`--then ${Buffer.from('echo owner-line', 'utf8').toString('base64url')}`)
})
