import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PENDING_TASKS_FILE } from './contract.js'
import { loadCursorPendingTasks, removeCursorPendingTasks } from './pendingTasks.js'

// How the watched path is changed, by either fs API: opened for writing in place, or a file renamed onto it. node:fs's
// synchronous calls say so (`sync …`), and count its temporary files too: a save on the event loop never makes them.
const disk = vi.hoisted(() => ({ watch: '', changes: [] as string[] }))
const writes = (flags: unknown) => typeof flags === 'number' ? (flags & 3) !== 0 : typeof flags === 'string' && flags !== 'r'
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (disk.watch && String(args[0]).startsWith(disk.watch) && writes(args[1])) disk.changes.push('sync write')
      return actual.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (args[0] === disk.watch) disk.changes.push('sync write')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (args[1] === disk.watch) disk.changes.push('sync rename')
      return actual.renameSync(...args)
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      if (args[0] === disk.watch && writes(args[1])) disk.changes.push('write')
      return actual.open(...args)
    },
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      if (args[0] === disk.watch) disk.changes.push('write')
      return actual.writeFile(...args)
    },
    rename: (...args: Parameters<typeof actual.rename>) => {
      if (args[1] === disk.watch) disk.changes.push('rename')
      return actual.rename(...args)
    },
  }
})

let dataDir = ''
let file = ''
const task = () => ({ sessionId: 's1', toolUseId: 't1', input: { prompt: 'p' }, createdAt: Date.now() })
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cursor-pending-'))
  file = join(dataDir, PENDING_TASKS_FILE)
})
afterEach(() => {
  disk.watch = ''
  disk.changes = []
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('the Cursor pending tasks file', () => {
  it('the save goes through a temporary file renamed onto the target, and never blocks the event loop', async () => {
    writeFileSync(file, JSON.stringify([task()]))
    disk.watch = file
    expect(await loadCursorPendingTasks(dataDir)).toHaveLength(1)
    expect(disk.changes).toEqual(['rename'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('a file at the old temporary name is left alone', async () => {
    writeFileSync(file, JSON.stringify([task()]))
    const planted = `${file}.${process.pid}.tmp`
    writeFileSync(planted, 'planted')
    expect(await loadCursorPendingTasks(dataDir)).toHaveLength(1)
    expect(readFileSync(planted, 'utf8')).toBe('planted')
  })

  it('a torn cursor-pending-tasks.json is set aside, not written over', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(file, '[{"')
    expect(await loadCursorPendingTasks(dataDir)).toEqual([])
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('[{"')
    expect(existsSync(file)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      `[state] ${PENDING_TASKS_FILE} could not be read (not valid JSON); kept as ${PENDING_TASKS_FILE}.unreadable, starting empty.`)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a file this account cannot read is neither deleted nor written over', async () => {
    const before = JSON.stringify([task()])
    writeFileSync(file, before)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    chmodSync(file, 0o000)
    expect(await loadCursorPendingTasks(dataDir)).toEqual([])
    await removeCursorPendingTasks(dataDir, 's1')
    chmodSync(file, 0o600)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})
