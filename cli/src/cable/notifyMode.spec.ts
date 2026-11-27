import { constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNotifyMode, NOTIFY_MODE_FILE, NotifyModeStore } from './notifyMode.js'

// Pass-through, recording which paths are opened, written by name and renamed.
const fsCalls = vi.hoisted(() => [] as Array<{ call: 'open' | 'write' | 'rename'; path: string; to?: string; flags?: unknown }>)
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      fsCalls.push({ call: 'open', path: String(args[0]), flags: args[1] })
      return actual.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] !== 'number') fsCalls.push({ call: 'write', path: String(args[0]) })
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      fsCalls.push({ call: 'rename', path: String(args[0]), to: String(args[1]) })
      return actual.renameSync(...args)
    },
  }
})

const folders: string[] = []
const aFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), 'notify-mode-'))
  folders.push(folder)
  return folder
}

afterEach(() => {
  fsCalls.length = 0
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('the stored Notifications mode', () => {
  it('full with no file', () => {
    expect(new NotifyModeStore(join(aFolder(), NOTIFY_MODE_FILE)).get()).toBe('full')
  })

  it('a mode set is read by the next store', () => {
    const folder = aFolder()
    const file = join(folder, NOTIFY_MODE_FILE)
    const store = new NotifyModeStore(file)
    expect(store.set('you')).toBeUndefined()
    expect(store.get()).toBe('you')
    expect(readFileSync(file, 'utf8')).toBe('{"mode":"you"}\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new NotifyModeStore(file).get()).toBe('you')
    expect(readdirSync(folder)).toEqual([NOTIFY_MODE_FILE])
  })

  it('the same mode again writes nothing', () => {
    const file = join(aFolder(), NOTIFY_MODE_FILE)
    const store = new NotifyModeStore(file)
    store.set('you')
    const before = statSync(file).ino
    expect(store.set('you')).toBeUndefined()
    expect(statSync(file).ino).toBe(before)
  })

  it('anything else reads as full', () => {
    // The last is a valid `you` padded past 1 KiB: only the size makes it full.
    for (const text of ['{not json', '{"mode":"loud"}', '["you"]', `{"mode":"you"}${' '.repeat(2048)}`]) {
      const file = join(aFolder(), NOTIFY_MODE_FILE)
      writeFileSync(file, text)
      const store = new NotifyModeStore(file)
      expect(store.get()).toBe('full')
      expect(store.set('you')).toBeUndefined()
      expect(readFileSync(file, 'utf8')).toBe('{"mode":"you"}\n')
    }
  })

  // The code says why, for the log, and is never a path.
  it('a mode that cannot be written stays as it was, and says the error\'s code', () => {
    const folder = aFolder()
    const file = join(folder, NOTIFY_MODE_FILE)
    mkdirSync(file)
    const store = new NotifyModeStore(file)
    expect(store.set('you')).toBe('EISDIR')
    expect(store.get()).toBe('full')
    expect(readdirSync(folder)).toEqual([NOTIFY_MODE_FILE])
  })

  it('the save goes through a temporary file of its own renamed onto the target', () => {
    const file = join(aFolder(), NOTIFY_MODE_FILE)
    new NotifyModeStore(file).set('you')
    const renames = fsCalls.filter(({ call, to }) => call === 'rename' && to === file)
    expect(renames).toHaveLength(1)
    // Made new and exclusive: never a file another writer or a planted link holds.
    const opens = fsCalls.filter(({ call, path }) => call === 'open' && path === renames[0].path)
    expect(opens).toHaveLength(1)
    expect(Number(opens[0].flags) & constants.O_EXCL).toBe(constants.O_EXCL)
    expect(fsCalls.some(({ call, path }) => path === file && call === 'write')).toBe(false)
  })

  it('a file at the old temporary name is left alone', () => {
    const file = join(aFolder(), NOTIFY_MODE_FILE)
    writeFileSync(`${file}.${process.pid}.tmp`, 'another writer\'s')
    expect(new NotifyModeStore(file).set('you')).toBeUndefined()
    expect(readFileSync(`${file}.${process.pid}.tmp`, 'utf8')).toBe('another writer\'s')
    expect(readFileSync(file, 'utf8')).toBe('{"mode":"you"}\n')
  })

  it('isNotifyMode takes full and you only', () => {
    expect(isNotifyMode('full')).toBe(true)
    expect(isNotifyMode('you')).toBe(true)
    for (const value of ['Full', 'loud', '', undefined, null, 1, { mode: 'you' }]) expect(isNotifyMode(value)).toBe(false)
  })
})
