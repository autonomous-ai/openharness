import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiConnectionMetadata, UNREADABLE } from './apiConnectionMetadata.js'
import { ApiConnections, apiConnectionsRequest } from './apiConnections.js'
import { asWindows } from '../testing/windowsOpen.js'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  const windows = (await import('../testing/windowsOpen.js')).windowsOpenFs(actual)
  return { ...windows, readFileSync: vi.fn(actual.readFileSync), renameSync: vi.fn(actual.renameSync) }
})

const key = 'migration-fixture-key'
const input = { provider: 'openrouter', apiKey: key }
const posix = process.platform !== 'win32'
let root: string, dir: string, file: string, list: string, store: ApiConnections, metadata: ApiConnectionMetadata
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'api-migration-')))
  dir = join(root, 'api-connections')
  file = join(dir, 'connections.json')
  list = join(dir, 'list.json')
  store = new ApiConnections(root)
  metadata = new ApiConnectionMetadata(root)
})
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
const document = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'))
const failed = () => expect(apiConnectionsRequest(store, { action: 'list' })).toEqual({
  error: 'API_CONNECTIONS_FAILED', detail: UNREADABLE,
})

describe('saved API migration and rollback', () => {
  it('upgrades a legacy key document without rewriting it, then supports old-build edits, adds and removals', () => {
    const saved = store.save(input)
    const legacy = document(file)
    delete legacy.recognizedBases
    fs.writeFileSync(file, JSON.stringify(legacy))
    fs.rmSync(list)
    expect(metadata.saved()).toBe(true)
    const original = fs.readFileSync(file, 'utf8')
    expect(store.list()).toEqual([saved])
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(document(list)).toEqual({ version: 1, connections: [saved] })
    // These are the old writer's published bytes, including credentials, which rollback still understands.
    legacy.connections[0].name = 'Changed by old build'
    legacy.connections[0].apiKey = 'rotated-fixture-key'
    legacy.connections.push({ ...legacy.connections[0], id: 'second', name: 'Second' })
    fs.writeFileSync(file, JSON.stringify(legacy))
    expect(new ApiConnections(root).list().map(row => row.name)).toEqual(['Changed by old build', 'Second'])
    expect(store.toolEnvironment(saved.id).OPENROUTER_API_KEY).toBe('rotated-fixture-key')
    expect(fs.readFileSync(list, 'utf8')).not.toContain('rotated-fixture-key')
    fs.writeFileSync(file, JSON.stringify({ ...legacy, connections: [] }))
    expect(store.list()).toEqual([])
    expect(metadata.saved()).toBe(false)
  })

  it('clears a stale list when an old build or the owner removed the key document', () => {
    store.save(input)
    fs.rmSync(file)
    expect(store.list()).toEqual([])
    expect(metadata.saved()).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })

  it.each(['json', 'missing-key', 'duplicate-id', 'too-many', 'vocabulary', 'oversized'])('preserves malformed legacy storage: %s', kind => {
    store.save(input)
    const legacy = document(file), row = legacy.connections[0]
    fs.rmSync(list)
    if (kind === 'missing-key') delete row.apiKey
    if (kind === 'duplicate-id') legacy.connections.push(row)
    if (kind === 'too-many') legacy.connections = Array.from({ length: 101 }, (_, n) => ({ ...row, id: `api-${n}` }))
    if (kind === 'vocabulary') legacy.recognizedBases = ['https://user:fixture@example.test']
    const bytes = kind === 'json' ? '{broken-' + key : kind === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : JSON.stringify(legacy)
    fs.writeFileSync(file, bytes)
    failed()
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes)
    expect(fs.existsSync(list)).toBe(false)
  })

  it('leaves the old list and committed key after a failed publication, then repairs on the next read', () => {
    const saved = store.save(input), before = fs.readFileSync(list, 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rename = vi.mocked(fs.renameSync), actual = rename.getMockImplementation()!
    rename.mockImplementation((from, to) => { if (to === list) throw new Error(key); actual(from, to) })
    store.save({ ...saved, name: 'Edited' })
    expect(document(file).connections[0]).toMatchObject({ name: 'Edited', apiKey: key })
    expect(fs.readFileSync(list, 'utf8')).toBe(before)
    expect(fs.readdirSync(dir).sort()).toEqual(['connections.json', 'list.json'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[apis]'))
    expect(JSON.stringify(warn.mock.calls)).not.toContain(key)
    rename.mockImplementation(actual)
    expect(store.list()[0].name).toBe('Edited')
    expect(document(list).connections[0].name).toBe('Edited')
  })
})

describe('untrusted migration files', () => {
  it.each(['link', 'dangling-link', 'directory'])('refuses an unsafe legacy entry without opening it: %s', kind => {
    fs.mkdirSync(dir, { mode: 0o700 })
    const target = join(root, 'target')
    if (kind === 'link') fs.writeFileSync(target, key)
    if (kind === 'directory') fs.mkdirSync(file)
    else fs.symlinkSync(target, file)
    vi.mocked(fs.readFileSync).mockClear()
    expect(() => metadata.saved()).toThrow(UNREADABLE)
    failed()
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled()
    expect(fs.existsSync(list)).toBe(false)
  })

  it.runIf(posix).each(['directory', 'store'])('refuses writable legacy %s without changing it', kind => {
    store.save(input)
    fs.rmSync(list)
    const target = kind === 'directory' ? dir : file
    fs.chmodSync(target, kind === 'directory' ? 0o777 : 0o666)
    vi.mocked(fs.readFileSync).mockClear()
    expect(() => metadata.saved()).toThrow(UNREADABLE)
    failed()
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled()
    expect(fs.statSync(target).mode & 0o777).toBe(kind === 'directory' ? 0o777 : 0o666)
    expect(fs.existsSync(list)).toBe(false)
  })

  it.each(['json', 'key', 'extra-field', 'duplicate-id', 'oversized', 'link', 'dangling-link', 'hard-link'])('rejects and repairs a damaged metadata list: %s', kind => {
    const saved = store.save(input), original = fs.readFileSync(file, 'utf8')
    fs.rmSync(list)
    if (kind === 'link') fs.symlinkSync(file, list)
    else if (kind === 'dangling-link') fs.symlinkSync(join(root, 'absent'), list)
    else if (kind === 'hard-link') fs.linkSync(file, list)
    else fs.writeFileSync(list, kind === 'json' ? '{bad' : kind === 'oversized' ? 'x'.repeat(1024 * 1024 + 1)
      : JSON.stringify({ version: 1, connections: kind === 'duplicate-id' ? [saved, saved]
        : [{ ...saved, ...(kind === 'key' ? { apiKey: key } : { unexpected: true }) }] }), { mode: 0o600 })
    expect(() => metadata.saved()).toThrow(UNREADABLE)
    // A hard link to the key document also makes the key document unsafe. Remove that alias before repairing it.
    if (kind === 'hard-link') fs.rmSync(list)
    expect(store.list()).toEqual([saved])
    expect(metadata.saved()).toBe(true)
    expect(document(list)).toEqual({ version: 1, connections: [saved] })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })

  it('does not read an oversized derivative while repairing it', () => {
    const saved = store.save(input)
    fs.writeFileSync(list, 'x'.repeat(1024 * 1024 + 1))
    const read = vi.mocked(fs.readFileSync), actual = read.getMockImplementation()!
    let oversizedRead = false
    read.mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const size = typeof path === 'number' ? fs.fstatSync(path).size : fs.statSync(path).size
      if (size > 1024 * 1024) oversizedRead = true
      return (actual as Function)(path, ...args)
    }) as typeof fs.readFileSync)
    expect(store.list()).toEqual([saved])
    expect(oversizedRead).toBe(false)
    expect(document(list)).toEqual({ version: 1, connections: [saved] })
  })

  it('reports an unreplaceable non-file list without touching the committed key', () => {
    const saved = store.save(input), original = fs.readFileSync(file, 'utf8')
    fs.rmSync(list)
    fs.mkdirSync(list)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => metadata.saved()).toThrow(UNREADABLE)
    expect(store.list()).toEqual([saved])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[apis]'))
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(fs.statSync(list).isDirectory()).toBe(true)
  })

  it('migrates in a Windows data root without POSIX modes and refuses linked metadata', () => {
    asWindows(root, () => {
      const saved = store.save(input)
      fs.rmSync(list)
      expect(metadata.saved()).toBe(true)
      expect(store.list()).toEqual([saved])
      fs.rmSync(list)
      fs.symlinkSync(file, list)
      expect(() => metadata.saved()).toThrow(UNREADABLE)
      expect(store.list()).toEqual([saved])
      expect(metadata.saved()).toBe(true)
    })
  })

  it.runIf(posix)('tightens safe legacy permissions, and repairs writable metadata from the trusted key store', () => {
    const saved = store.save(input)
    fs.chmodSync(dir, 0o755)
    fs.chmodSync(file, 0o644)
    fs.chmodSync(list, 0o666)
    expect(() => metadata.saved()).toThrow(UNREADABLE)
    expect(store.list()).toEqual([saved])
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(list).mode & 0o777).toBe(0o600)
  })

  it('does not replace an unchanged list', () => {
    store.save(input)
    vi.mocked(fs.renameSync).mockClear()
    store.list()
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it('opens only metadata on a launch, and no file contents during the legacy fallback', () => {
    store.save(input)
    const read = vi.mocked(fs.readFileSync), actual = read.getMockImplementation()!
    const keyInode = fs.statSync(file).ino
    let openedKey = false
    read.mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const info = typeof path === 'number' ? fs.fstatSync(path) : fs.statSync(path)
      if (info.ino === keyInode) openedKey = true
      return (actual as Function)(path, ...args)
    }) as typeof fs.readFileSync)
    expect(metadata.saved()).toBe(true)
    expect(openedKey).toBe(false)
    fs.rmSync(list)
    read.mockClear()
    expect(metadata.saved()).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })
})
