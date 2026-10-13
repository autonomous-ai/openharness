import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, fstatSync, statSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectHookFile, runHookPreparation } from './nativeHookFiles.js'

const fault = vi.hoisted(() => ({ sync: false, write: false, onSync: undefined as ((fd: number) => void) | undefined, openAs: undefined as string | undefined, onStat: undefined as ((file: unknown, options: unknown) => void) | undefined }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { fault.onStat?.(...args); return fs.lstatSync(...args) },
    fsync: (fd: number, callback: (error: Error | null) => void) => {
      try { if (fault.sync) throw new Error('fixture sync unavailable'); fault.onSync?.(fd); fs.fsync(fd, callback) }
      catch (error) { queueMicrotask(() => callback(error as Error)) }
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => fs.openSync(fault.openAs ?? args[0], ...args.slice(1) as [number, number?]),
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.write && typeof args[0] === 'number') throw new Error('fixture disk full')
      return fs.writeFileSync(...args)
    },
  }
})
const roots: string[] = []
function prepared(file: string) {
  const observed = inspectHookFile(file)
  return { ...observed,
    replace: (next: string) => runHookPreparation([file], attempt => observed.replace(next, attempt)),
    remove: () => runHookPreparation([file], attempt => observed.remove(attempt)),
  }
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-files-')))
  roots.push(root)
  return { root, file: join(root, 'config.json') }
}
afterEach(() => { fault.sync = false; fault.write = false; fault.onSync = undefined; fault.openAs = undefined; fault.onStat = undefined; vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('publishes complete bytes durably, preserves private permissions and leaves no staging file', async () => {
  const { root, file } = fixture()
  writeFileSync(file, 'old', { mode: 0o600 })
  await prepared(file).replace('new')
  expect(readFileSync(file, 'utf8')).toBe('new')
  expect(readdirSync(root)).toEqual(['config.json'])
  expect(inspectHookFile(file).content).toBe('new')
  await prepared(file).replace('new')
})

it('never turns a peer edit during final proof capture into a confirmed output', async () => {
  const { file } = fixture()
  writeFileSync(file, 'prepared hooks')
  const confirmed = vi.fn()
  await expect(runHookPreparation([file], async attempt => {
    const expected = inspectHookFile(file)
    attempt.observe(file, () => {
      expected.verify()
      // The next leaf read occurs after checking the published observation.
      // A peer writes real bytes at that boundary, before proof capture.
      fault.onStat = path => {
        if (path !== file) return
        fault.onStat = undefined
        writeFileSync(file, 'peer hooks')
      }
    })
    return true
  }, { confirmed })).rejects.toThrow(/changed/)
  expect(confirmed).not.toHaveBeenCalled()
  expect(readFileSync(file, 'utf8')).toBe('peer hooks')
})

it('creates and syncs a missing directory chain', async () => {
  const { root } = fixture(), file = join(root, 'new', 'nested', 'hooks.json')
  await prepared(file).replace('prepared')
  expect(readFileSync(file, 'utf8')).toBe('prepared')
  await prepared(file).remove()
  expect(inspectHookFile(file).content).toBeNull()
  await prepared(file).remove()
})

it('preserves a relocated config home and its file alias', async () => {
  const { root } = fixture(), real = join(root, 'real'), link = join(root, 'link')
  mkdirSync(real); symlinkSync(real, link)
  const target = join(real, 'settings.json'), file = join(link, 'settings.json')
  writeFileSync(target, 'old')
  const alias = join(root, 'alias.json'); symlinkSync(file, alias)
  await prepared(alias).replace('new')
  expect(realpathSync(alias)).toBe(target)
  expect(readFileSync(target, 'utf8')).toBe('new')
})

it('retains an intervening peer edit instead of overwriting a stale snapshot', async () => {
  const { file } = fixture()
  writeFileSync(file, 'before')
  const old = prepared(file)
  writeFileSync(file, 'peer edit')
  await expect(old.replace('ours')).rejects.toThrow(/changed/)
  await expect(old.remove()).rejects.toThrow(/changed/)
  expect(readFileSync(file, 'utf8')).toBe('peer edit')
})

it('refuses a replaced config alias and leaves both destinations untouched', async () => {
  const { root, file } = fixture(), first = join(root, 'first'), second = join(root, 'second')
  writeFileSync(first, 'one'); writeFileSync(second, 'two'); symlinkSync(first, file)
  const old = prepared(file)
  unlinkSync(file); symlinkSync(second, file)
  await expect(old.replace('ours')).rejects.toThrow(/changed/)
  expect(readFileSync(first, 'utf8')).toBe('one')
  expect(readFileSync(second, 'utf8')).toBe('two')
})

it('refuses directories, dangling aliases, oversized settings and read-only files', async () => {
  const { root, file } = fixture()
  expect(() => inspectHookFile(root)).toThrow()
  symlinkSync(join(root, 'absent'), file)
  expect(() => inspectHookFile(file)).toThrow()
  unlinkSync(file); writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
  expect(() => inspectHookFile(file)).toThrow(/bounded/)
  writeFileSync(file, 'foreign'); chmodSync(file, 0o444)
  await expect(prepared(file).replace('ours')).rejects.toThrow(/read-only/)
  expect(readFileSync(file, 'utf8')).toBe('foreign')
})

it('does not truncate the prior file or leave staging files after a write failure', async () => {
  const { root, file } = fixture()
  writeFileSync(file, 'previous'); fault.write = true
  await expect(prepared(file).replace('new')).rejects.toThrow(/disk full/)
  expect(readFileSync(file, 'utf8')).toBe('previous')
  expect(readdirSync(root)).toEqual(['config.json'])
  fault.write = false
  await prepared(file).replace('new')
  expect(readFileSync(file, 'utf8')).toBe('new')
})

it('cannot acknowledge a failed sync even when the desired bytes already exist', async () => {
  const { file } = fixture()
  writeFileSync(file, 'already prepared'); fault.sync = true
  await expect(prepared(file).replace('already prepared')).rejects.toThrow(/sync unavailable/)
  fault.sync = false
  await expect(prepared(file).replace('already prepared')).resolves.toBeDefined()
})

it('retains removal uncertainty until a retry can sync the parent directory', async () => {
  const { file } = fixture()
  writeFileSync(file, 'owned'); fault.sync = true
  await expect(prepared(file).remove()).rejects.toThrow(/sync unavailable/)
  expect(inspectHookFile(file).content).toBeNull()
  await expect(prepared(file).remove()).rejects.toThrow(/sync unavailable/)
  fault.sync = false
  await expect(prepared(file).remove()).resolves.toBeDefined()
})

it('holds invalid UTF-8 without replacing its original bytes', async () => {
  const { file } = fixture(), bytes = Buffer.from([0x7b, 0xff, 0x7d])
  writeFileSync(file, bytes)
  expect(() => inspectHookFile(file)).toThrow()
  expect(readFileSync(file)).toEqual(bytes)
})

it('does not acknowledge a destination changed while its parent is being synced', async () => {
  const { file } = fixture()
  writeFileSync(file, 'old')
  fault.onSync = fd => {
    if (fstatSync(fd).isDirectory()) { fault.onSync = undefined; writeFileSync(file, 'peer replacement') }
  }
  await expect(prepared(file).replace('ours')).rejects.toThrow(/changed/)
  expect(readFileSync(file, 'utf8')).toBe('peer replacement')
})

it('does not acknowledge a removed plugin recreated during parent sync', async () => {
  const { file } = fixture()
  writeFileSync(file, 'managed')
  fault.onSync = fd => {
    if (fstatSync(fd).isDirectory()) { fault.onSync = undefined; writeFileSync(file, 'recreated') }
  }
  await expect(prepared(file).remove()).rejects.toThrow(/recreated/)
  expect(readFileSync(file, 'utf8')).toBe('recreated')
})

it('holds a plugin alias without deleting its shared target or the alias', async () => {
  const { root, file } = fixture(), target = join(root, 'shared.js')
  writeFileSync(target, 'shared plugin'); symlinkSync(target, file)
  await expect(prepared(file).remove()).rejects.toThrow(/alias/)
  expect(realpathSync(file)).toBe(target)
  expect(readFileSync(target, 'utf8')).toBe('shared plugin')
})

it('reconfirms an ancestor name left uncertain by an earlier failed parent sync', async () => {
  const { root } = fixture(), file = join(root, 'a', 'b', 'hooks.json'), inode = statSync(root).ino
  fault.onSync = fd => { if (fstatSync(fd).ino === inode) throw new Error('fixture ancestor publication unavailable') }
  await expect(prepared(file).replace('new')).rejects.toThrow(/ancestor publication/)
  let confirmed = false
  fault.onSync = fd => { if (fstatSync(fd).ino === inode) confirmed = true }
  await prepared(file).replace('new')
  expect(confirmed).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('new')
})

it('compares the unchanged file descriptor with the reviewed inode before syncing', async () => {
  const { root, file } = fixture(), other = join(root, 'other')
  writeFileSync(file, 'same'); writeFileSync(other, 'same')
  const observed = inspectHookFile(file)
  await expect(runHookPreparation([file], attempt => {
    fault.openAs = other
    return observed.replace('same', attempt)
  })).rejects.toThrow(/changed before sync/)
  expect(readFileSync(file, 'utf8')).toBe('same')
})


it.each(['replacement', 'in-place edit'])('preserves the destination if the staging file suffers a %s during its flush', async change => {
  const { root, file } = fixture()
  writeFileSync(file, 'original')
  fault.onSync = fd => {
    if (fstatSync(fd).isDirectory()) return
    fault.onSync = undefined
    const temporary = join(root, readdirSync(root).find(name => name.startsWith('.harness-hook-'))!)
    if (change === 'replacement') {
      const other = join(root, 'other'); writeFileSync(other, 'foreign'); renameSync(other, temporary)
    } else writeFileSync(temporary, 'foreign')
  }
  await expect(prepared(file).replace('ours')).rejects.toThrow(/staging file changed/)
  expect(readFileSync(file, 'utf8')).toBe('original')
  if (change === 'replacement') {
    const temporary = readdirSync(root).find(name => name.startsWith('.harness-hook-'))!
    expect(readFileSync(join(root, temporary), 'utf8')).toBe('foreign')
  }
})

it.each([0o022, 0o077])('preserves an existing shared file mode under umask %s', async mask => {
  const { file } = fixture()
  writeFileSync(file, 'old'); chmodSync(file, 0o660)
  const previous = process.umask(mask)
  try { await prepared(file).replace('new') } finally { process.umask(previous) }
  expect(statSync(file).mode & 0o777).toBe(0o660)
})


it('rechecks the deadline after the last filesystem observation before removal', async () => {
  const { file } = fixture()
  writeFileSync(file, 'owned')
  let now = 0, leafChecks = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const observed = inspectHookFile(file)
  await expect(runHookPreparation([file], attempt => {
    fault.onStat = (path, options) => {
      if (path === file && options === undefined && ++leafChecks === 2) now = 20
    }
    return observed.remove(attempt)
  }, { timeoutMs: 10 })).rejects.toThrow(/expired/)
  expect(leafChecks).toBe(2)
  expect(readFileSync(file, 'utf8')).toBe('owned')
})
