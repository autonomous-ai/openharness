import * as fs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readHomeCatalog } from './homeCatalog.js'

const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => clock.now } }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync), fstatSync: vi.fn(actual.fstatSync), closeSync: vi.fn(actual.closeSync), linkSync: vi.fn(actual.linkSync) }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, opendir: vi.fn(actual.opendir) }
})
vi.mock('../../lib/loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
let actual: typeof fs, root = ''
let homes: typeof import('../../lib/engineHomes.js')
let repair: typeof import('../../lib/sessionRepair.js')
const path = (...parts: string[]) => join(root, ...parts)
const catalog = () => path('data', 'engine-homes.json')
const ID = 'aaaaaaaa-1111-4222-8333-444444444444'
function write(text: unknown): void {
  fs.mkdirSync(dirname(catalog()), { recursive: true })
  fs.writeFileSync(catalog(), typeof text === 'string' ? text : JSON.stringify(text), { mode: 0o600 })
}
function transcript(home: string): string {
  const file = join(home, 'sessions', 'day', `rollout-${ID}.jsonl`)
  fs.mkdirSync(dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd: path('work'), source: 'cli' } }) + '\n')
  return file
}
beforeEach(async () => {
  actual = await vi.importActual<typeof fs>('node:fs')
  vi.mocked(asyncFs.opendir).mockReset().mockImplementation((await vi.importActual<typeof asyncFs>('node:fs/promises')).opendir)
  for (const name of ['lstatSync', 'openSync', 'readSync', 'fstatSync', 'closeSync', 'linkSync'] as const) {
    vi.mocked(fs[name]).mockReset().mockImplementation(actual[name] as never)
  }
  clock.now = 0
  root = actual.realpathSync(fs.mkdtempSync(join(tmpdir(), 'home-catalog-')))
  for (const [name, value] of Object.entries({ HOME: path('home'), ADAPTER_DATA_DIR: path('data'),
    ADAPTER_RUNTIME_DIR: path('runtime'), CODEX_HOME: path('codex'), CLAUDE_PROJECTS_DIR: path('claude', 'projects') })) vi.stubEnv(name, value)
  vi.resetModules()
  homes = await import('../../lib/engineHomes.js')
  repair = await import('../../lib/sessionRepair.js')
})
afterEach(() => {
  homes.resetEngineHomes(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  actual.rmSync(root, { recursive: true, force: true })
})

describe('fresh complete native home evidence', () => {
  it('reads a new installation and bypasses catalog evidence for explicit profiles and other engines', () => {
    expect(homes.nativeSessionRoots('codex')).toEqual([path('codex', 'sessions')])
    write('{ incomplete')
    expect(homes.nativeSessionRoots('codex', path('profile'))).toEqual([path('profile', 'sessions')])
    expect(homes.nativeSessionRoots('pi')).toEqual([])
    expect(homes.nativeSessionRoots('toString')).toEqual([])
    expect(() => homes.nativeSessionRoots('claude', path('profile'))).toThrow(/catalog/)
  })

  it('reads each complete list fresh, deduplicates only equal paths and returns independent arrays', () => {
    write({ claude: [path('c'), path('c')], codex: [path('a')] })
    expect(homes.nativeSessionRoots('claude')).toEqual([path('claude', 'projects'), path('c', 'projects')])
    const first = homes.nativeSessionRoots('codex'); first.push('/not-evidence')
    write({ claude: [path('c')], codex: [path('a'), path('b')] })
    expect(homes.nativeSessionRoots('codex')).toEqual([path('codex', 'sessions'), path('a', 'sessions'), path('b', 'sessions')])
  })

  it('does not reuse the legacy inode/mtime/size stamp when a competitor is added', async () => {
    const own = transcript(path('codex')); transcript(path('moved'))
    const text = JSON.stringify({ codex: [path('moved')] })
    write('{"codex":[]}'.padEnd(text.length, ' '))
    const before = actual.statSync(catalog())
    // Pin a representable timestamp before priming the old stamp cache.
    actual.utimesSync(catalog(), before.atime, new Date('2026-10-09T00:00:00Z'))
    expect(homes.movedHomes('codex')).toEqual([])
    await expect(repair.findResumedTranscript('codex', ID)).resolves.toBe(own)
    write(text); actual.utimesSync(catalog(), before.atime, new Date('2026-10-09T00:00:00Z'))
    expect(homes.movedHomes('codex')).toEqual([path('moved')]) // The durable catalog reader now refreshes legacy callers too.
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toThrow('more than one transcript')
  })

  it.each(['{', '[]', 'null', '{"codex":42}', '{"claude":["relative"]}', '{"codex":[null]}',
    '{"future":["/home"]}', '{"codex":["/bad\\u0000path"]}', '{"codex":["/competitor"],"codex":[]}',
    '{"co\\u0064ex":["/competitor"],"codex":[]}'])('holds malformed evidence without rewriting it: %s', text => {
    write(text)
    expect(() => homes.nativeSessionRoots('codex')).toThrow(/saved engine-home catalog/)
    expect(actual.readFileSync(catalog(), 'utf8')).toBe(text)
    write({ codex: [path('recovered')] })
    expect(homes.nativeSessionRoots('codex')).toContain(path('recovered', 'sessions'))
  })

  it.each(['bytes', 'homes', 'path'])('bounds the complete catalog: %s', limit => {
    write(limit === 'bytes' ? '{}'.padEnd(65537, ' ') : { codex: limit === 'homes'
      ? Array.from({ length: 64 }, (_, n) => path(String(n))) : ['/' + 'x'.repeat(4096)] })
    expect(() => readHomeCatalog(catalog())).toThrow(/limit|oversized|invalid home/)
    expect(() => homes.nativeSessionRoots('codex')).toThrow(/limit|oversized|invalid home/)
    if (limit === 'bytes') expect(fs.openSync).not.toHaveBeenCalled()
  })

  it('bounds the raw list before deduplicating repeated homes', () => {
    write({ codex: Array.from({ length: 64 }, () => path('same')) })
    expect(() => readHomeCatalog(catalog())).toThrow('known session-home limit')
  })

  it('holds a catalog that disappears or drops a previously observed home, then recovers', () => {
    write({ codex: [path('a')] }); homes.nativeSessionRoots('codex')
    actual.unlinkSync(catalog())
    expect(() => homes.nativeSessionRoots('codex')).toThrow('previously observed or unsaved home')
    write({ codex: [path('b')] })
    expect(() => homes.nativeSessionRoots('codex')).toThrow('previously observed or unsaved home')
    write({ codex: [path('a'), path('b')] })
    expect(homes.nativeSessionRoots('codex')).toHaveLength(3)
  })

  it('retains a competing home observed by a valid held read across A -> B -> A recovery', async () => {
    const own = transcript(path('codex')); transcript(path('b'))
    write({ codex: [path('a')] })
    await expect(repair.findResumedTranscript('codex', ID)).resolves.toBe(own)
    write({ codex: [path('b')] })
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toThrow('previously observed or unsaved home')
    write({ codex: [path('a')] })
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toThrow('previously observed or unsaved home')
    write({ codex: [path('a'), path('b')] })
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toThrow('more than one transcript')
  })

  it('retains a bounded overflow fact when successive valid catalogs reveal too many homes', () => {
    const first = Array.from({ length: 63 }, (_, n) => path(`observed-${n}`))
    write({ codex: first }); expect(homes.nativeSessionRoots('codex')).toHaveLength(64)
    write({ codex: [path('one-more')] })
    expect(() => homes.nativeSessionRoots('codex')).toThrow('known session-home limit')
    write({ codex: first })
    expect(() => homes.nativeSessionRoots('codex')).toThrow('known session-home limit')
  })

  it('holds an oversized legacy list before copying or iterating it', () => {
    const legacy = Array.from({ length: 64 }, (_, n) => path(`legacy-${n}`))
    write({ codex: legacy }); homes.movedHomes('codex')
    write({ codex: [] })
    let visited = false
    const iterator = Array.prototype[Symbol.iterator]
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      if (this.length === 64 && this[0] === legacy[0]) {
        visited = true
        throw new Error('oversized legacy list must not be visited')
      }
      return iterator.call(this)
    }
    try {
      expect(() => homes.nativeSessionRoots('codex')).toThrow('known session-home limit')
      expect(visited).toBe(false)
    } finally { Array.prototype[Symbol.iterator] = iterator }
  })

  it('does not exclude a pending competitor after durable adoption failed to persist', async () => {
    transcript(path('codex')); transcript(path('unsaved'))
    write({ codex: [] })
    vi.mocked(fs.linkSync).mockImplementation(() => { throw new Error('fixture disk unavailable') })
    expect(() => homes.adoptHomes({ CODEX_HOME: path('unsaved') })).toThrow('durable adoption')
    expect(JSON.parse(actual.readFileSync(catalog(), 'utf8'))).toEqual({ codex: [] })
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toThrow(/incomplete record pool|previously observed or unsaved home/)
    vi.mocked(fs.linkSync).mockImplementation(actual.linkSync)
    homes.confirmHomes({ CODEX_HOME: path('unsaved') })
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toThrow('more than one transcript')
  })

  it('keeps the typed hold when the catalog becomes unreadable during exact lookup', async () => {
    write({ codex: [] }); transcript(path('codex'))
    const native = await vi.importActual<typeof asyncFs>('node:fs/promises')
    vi.mocked(asyncFs.opendir).mockImplementationOnce(async (name, options) => {
      const directory = await native.opendir(name, options)
      write('{')
      return directory
    })
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
    write({ codex: [] })
    await expect(repair.findResumedTranscript('codex', ID)).resolves.toBe(transcript(path('codex')))
  })

  it.each(['directory', 'symlink', 'dangling parent', 'write permission'])('holds unsafe native file evidence: %s', kind => {
    fs.mkdirSync(path('data'))
    if (kind === 'directory') fs.mkdirSync(catalog())
    else if (kind === 'symlink') { fs.writeFileSync(path('target'), '{}'); fs.symlinkSync(path('target'), catalog()) }
    else if (kind === 'dangling parent') { fs.rmdirSync(path('data')); fs.symlinkSync(path('missing'), path('data')) }
    else { write({}); fs.chmodSync(catalog(), 0o666) }
    expect(() => homes.nativeSessionRoots('codex')).toThrow(/catalog/)
  })

  it.each(['inspect', 'open', 'read'])('holds %s errors and succeeds on the next fresh read', stage => {
    write({ codex: [path('a')] })
    const method = stage === 'inspect' ? 'lstatSync' : stage === 'open' ? 'openSync' : 'readSync'
    vi.mocked(fs[method]).mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
    expect(() => homes.nativeSessionRoots('codex')).toThrow(/catalog/)
    expect(homes.nativeSessionRoots('codex')).toContain(path('a', 'sessions'))
  })

  it('handles short reads without accepting a prefix and closes every opened descriptor', () => {
    write({ codex: [path('a')] })
    vi.mocked(fs.readSync).mockImplementation((fd, buffer, options = {}) =>
      actual.readSync(fd, buffer, { ...options, length: Math.min(options.length ?? buffer.byteLength, 3) }))
    expect(readHomeCatalog(catalog()).homes.codex).toEqual([path('a')])
    expect(fs.closeSync).toHaveBeenCalledTimes(1)
    vi.mocked(fs.readSync).mockReturnValueOnce(0)
    expect(() => readHomeCatalog(catalog())).toThrow('ended during its read')
    expect(fs.closeSync).toHaveBeenCalledTimes(2)
  })

  it.each(['operations', 'deadline'])('bounds an unfinished read by %s', limit => {
    write({ codex: [path('a'.repeat(200))] })
    vi.mocked(fs.readSync).mockImplementation((fd, buffer, options = {}) => {
      if (limit === 'deadline') clock.now = 251
      return actual.readSync(fd, buffer, limit === 'deadline' ? options : { ...options, length: 1 })
    })
    expect(() => readHomeCatalog(catalog())).toThrow(limit === 'deadline' ? 'read deadline' : 'read-operation limit')
    expect(fs.closeSync).toHaveBeenCalledTimes(1)
  })

  it.each(['append', 'rename', 'ancestor replacement'])('rejects a catalog changed by %s during its descriptor read', kind => {
    write({ codex: [path('a')] })
    vi.mocked(fs.readSync).mockImplementationOnce((fd, buffer, options) => {
      const count = actual.readSync(fd, buffer, options)
      if (kind === 'append') actual.appendFileSync(catalog(), ' ')
      else if (kind === 'rename') { actual.writeFileSync(path('replacement'), '{}'); actual.renameSync(path('replacement'), catalog()) }
      else {
        // Moving the ordinary parent preserves the opened file's inode/ctime. Only the
        // pathname fence can notice that a different catalog now occupies its old path.
        actual.renameSync(path('data'), path('saved-data')); write({})
      }
      return count
    })
    expect(() => readHomeCatalog(catalog())).toThrow('changed during its read')
    expect(fs.closeSync).toHaveBeenCalledTimes(1)
  })

  it('ties an opened descriptor to the inspected inode even when the pathname returns before fstat', () => {
    write({ codex: [path('a')] }); actual.writeFileSync(path('other'), '{}', { mode: 0o600 })
    vi.mocked(fs.openSync).mockImplementationOnce((name, flags) => {
      actual.renameSync(catalog(), path('original')); actual.renameSync(path('other'), catalog())
      const fd = actual.openSync(name, flags)
      actual.renameSync(catalog(), path('other')); actual.renameSync(path('original'), catalog())
      return fd
    })
    expect(() => readHomeCatalog(catalog())).toThrow('changed before it could be opened')
    expect(fs.closeSync).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid UTF-8 instead of turning replacement characters into a native home', () => {
    fs.mkdirSync(path('data'))
    actual.writeFileSync(catalog(), Buffer.concat([Buffer.from('{"codex":["/'), Buffer.from([0xff]), Buffer.from('"]}')]), { mode: 0o600 })
    expect(() => readHomeCatalog(catalog())).toThrow('could not be read completely')
  })
})
