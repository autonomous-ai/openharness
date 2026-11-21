import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { launch as claudeLaunch } from '../claude/launch.js'
import { preparedStatusLine, statusLineScript } from './statusLine.js'

import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'

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
beforeEach(() => { dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'status-line-'))) })
afterEach(() => {
  disk.watch = ''
  disk.changes = []
  rmSync(dataDir, { recursive: true, force: true })
})

it('the save goes through a temporary file renamed onto the target', async () => {
  const file = join(dataDir, 'statusline', 'statusline.mjs')
  // An older release's script, which a session's status line may be running.
  mkdirSync(join(dataDir, 'statusline'))
  writeFileSync(file, '// an older script\n', { mode: 0o600 })
  disk.watch = file
  const files = { home: join(dataDir, 'home'), personal: dataDir, cwd: null, read: () => null }
  await runHookPreparation([file], attempt => inspectHookFile(file, 0o600).replace(statusLineScript(), attempt))
  expect(preparedStatusLine(claudeLaunch.statusLine!, files, dataDir, process.execPath, () => file, 'darwin', null)).not.toBeNull()
  expect(disk.changes).toEqual(['rename'])
  expect(readFileSync(file, 'utf8')).not.toBe('// an older script\n')
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
})
