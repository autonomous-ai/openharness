import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHomeAdopter, readAdoptedHomes } from './homeAdoption.js'

const clock = vi.hoisted(() => ({ now: 0, remaining: Infinity }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => --clock.remaining < 0 ? 251 : clock.now } }))

vi.mock('node:fs', async original => {
  const actual = await original<typeof fs>()
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync),
    fsyncSync: vi.fn(actual.fsyncSync), linkSync: vi.fn(actual.linkSync),
    readSync: vi.fn(actual.readSync), writeFileSync: vi.fn(actual.writeFileSync), opendirSync: vi.fn(actual.opendirSync), lstatSync: vi.fn(actual.lstatSync) }
})
let actual: typeof fs, root = '', file = ''
let adopter: ReturnType<typeof createHomeAdopter>
const empty = () => ({ claude: [], codex: [] as string[] })
const add = (...codex: string[]) => ({ claude: [], codex })
const record = (index: number) => join(file + '.adoptions', `${String(index).padStart(3, '0')}.json`)
const seal = (index: number) => index ? join(file + '.confirmations', `${String(index).padStart(3, '0')}.committed`) : file + '.adopted'
const unavailable = () => Object.assign(new Error('fixture storage unavailable'), { code: 'EIO' })
const files = new Map<number, string>()
beforeEach(async () => {
  clock.now = 0; clock.remaining = Infinity
  actual = await vi.importActual<typeof fs>('node:fs')
  for (const name of ['openSync', 'closeSync', 'fsyncSync', 'linkSync', 'readSync', 'writeFileSync', 'opendirSync', 'lstatSync'] as const) {
    vi.mocked(fs[name]).mockReset().mockImplementation(actual[name] as never)
  }
  files.clear()
  vi.mocked(fs.openSync).mockImplementation((...args) => {
    const fd = actual.openSync(...args); files.set(fd, String(args[0])); return fd
  })
  vi.mocked(fs.closeSync).mockImplementation(fd => { actual.closeSync(fd); files.delete(fd) })
  root = actual.realpathSync(actual.mkdtempSync(join(tmpdir(), 'durable-home-adoption-')))
  file = join(root, 'data', 'engine-homes.json')
  adopter = createHomeAdopter(file)
})
afterEach(() => { vi.restoreAllMocks(); actual.rmSync(root, { recursive: true, force: true }) })

describe('durable monotone home adoption', () => {
  it('leaves a new installation alone for an empty request', () => {
    expect(adopter.adopt(empty())).toEqual(empty())
    expect(actual.existsSync(file + '.adoptions')).toBe(false)
  })

  it('preserves the imported file and reads committed homes independently of module memory', () => {
    actual.mkdirSync(join(root, 'data'), { mode: 0o700 })
    const original = '{"codex":["/previous"]}\n'
    actual.writeFileSync(file, original, { mode: 0o600 })
    expect(() => adopter.adopt(add('/new'))).not.toThrow()
    expect(adopter.adopt(add('/new'))).toEqual(add('/previous', '/new'))
    expect(actual.readFileSync(file, 'utf8')).toBe(original)
    expect(readAdoptedHomes(file).homes).toEqual(add('/previous', '/new'))
    const first = actual.readFileSync(record(0), 'utf8')
    expect(adopter.adopt(add('/new'))).toEqual(add('/previous', '/new'))
    expect(actual.readFileSync(record(0), 'utf8')).toBe(first)
    expect(actual.existsSync(record(1))).toBe(false)
    actual.writeFileSync(file, '{"claude":["/external"]}', { mode: 0o600 })
    expect(adopter.adopt(add('/later'))).toEqual({ claude: ['/external'], codex: ['/previous', '/new', '/later'] })
    expect(readAdoptedHomes(file).homes).toEqual({ claude: ['/external'], codex: ['/previous', '/new', '/later'] })
  })

  it.each(['same', 'different', 'last-slot'] as const)('rebases an exclusive-publication loser without losing a winner: %s', mode => {
    const prior = mode === 'last-slot' ? Array.from({ length: 62 }, (_, n) => `/saved-${n}`) : ['/saved']
    adopter.adopt(add(...prior))
    let raced = false
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(to) === record(1) && !raced) {
        raced = true
        createHomeAdopter(file).adopt(add(mode === 'same' ? '/requested' : '/peer'))
      }
      return actual.linkSync(from, to)
    })
    if (mode === 'last-slot') expect(() => adopter.adopt(add('/requested'))).toThrow('known session-home limit')
    else expect(adopter.adopt(add('/requested')).codex).toEqual([...prior, ...(mode === 'same' ? [] : ['/peer']), '/requested'])
    const found = readAdoptedHomes(file).homes.codex
    expect(found).toEqual([...prior, ...(mode === 'same' ? ['/requested'] : ['/peer']), ...(mode === 'different' ? ['/requested'] : [])])
    expect(actual.existsSync(record(mode === 'different' ? 3 : 2))).toBe(false)
    expect(raced).toBe(true)
  })

  it.each(['write', 'stage-flush', 'record-link', 'journal-flush', 'confirmation-link', 'confirmation-flush'] as const)
    ('does not acknowledge a failed %s, and an idempotent retry confirms it', phase => {
      adopter.adopt(add('/saved'))
      let published = false, confirmed = false, failed = false
      const fail = () => { failed = true; throw unavailable() }
      vi.mocked(fs.writeFileSync).mockImplementation((...args) => {
        if (!failed && phase === 'write') fail()
        return actual.writeFileSync(...args)
      })
      vi.mocked(fs.linkSync).mockImplementation((from, to) => {
        if (String(to) === record(1)) {
          if (!failed && phase === 'record-link') fail()
          published = true
        }
        if (String(to) === seal(1)) {
          if (!failed && phase === 'confirmation-link') fail()
          confirmed = true
        }
        return actual.linkSync(from, to)
      })
      vi.mocked(fs.fsyncSync).mockImplementation(fd => {
        const path = files.get(fd)
        if (!failed && ((phase === 'stage-flush' && path?.includes('/.staging/'))
          || (phase === 'journal-flush' && published && path === file + '.adoptions')
          || (phase === 'confirmation-flush' && confirmed && path === file + '.confirmations'))) fail()
        actual.fsyncSync(fd)
      })
      expect(() => adopter.adopt(add('/requested'))).toThrow(/durable adoption/)
      expect(failed).toBe(true)
      if (published && !confirmed) expect(() => readAdoptedHomes(file)).toThrow('unconfirmed adoption')
      expect(adopter.adopt(add('/requested'))).toEqual(add('/saved', '/requested'))
      expect(readAdoptedHomes(file).homes).toEqual(add('/saved', '/requested'))
      expect(files.size).toBe(0)
    })

  it.each([false, true])('finishes a complete abandoned record after restart, including without another home request (empty=%s)', emptyRequest => {
    adopter.adopt(add('/saved'))
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(to) === seal(1)) throw unavailable()
      return actual.linkSync(from, to)
    })
    expect(() => adopter.adopt(add('/interrupted'))).toThrow()
    expect(() => readAdoptedHomes(file)).toThrow('unconfirmed adoption')
    vi.mocked(fs.linkSync).mockImplementation(actual.linkSync)
    let recovered
    expect(() => { recovered = adopter.adopt(emptyRequest ? empty() : add('/later')) }).not.toThrow()
    expect(recovered).toEqual(add('/saved', '/interrupted', ...(emptyRequest ? [] : ['/later'])))
  })

  it.each(['journal', 'confirmations', 'tail', 'legacy'] as const)('holds missing committed %s evidence and recovers when restored', target => {
    actual.mkdirSync(join(root, 'data'), { mode: 0o700 })
    actual.writeFileSync(file, '{"codex":["/previous"]}', { mode: 0o600 })
    adopter.adopt(add('/first')); adopter.adopt(add('/second'))
    const lost = target === 'journal' ? file + '.adoptions' : target === 'confirmations' ? file + '.confirmations' : target === 'tail' ? record(1) : file
    actual.renameSync(lost, lost + '.owned-backup')
    expect(() => readAdoptedHomes(file)).toThrow(/journal|catalog/)
    expect(() => adopter.adopt(add('/third'))).toThrow(/journal|catalog/)
    actual.renameSync(lost + '.owned-backup', lost)
    expect(readAdoptedHomes(file).homes).toEqual(add('/previous', '/first', '/second'))
  })

  it.each(['record', 'confirmation', 'unknown', 'symlink-staging', 'writable-record', 'oversized'] as const)
    ('preserves foreign or incomplete %s evidence without repair by replacement', target => {
      adopter.adopt(add('/saved'))
      if (target === 'record') actual.writeFileSync(record(0), '{ partial')
      if (target === 'confirmation') actual.writeFileSync(seal(0), 'foreign\n')
      if (target === 'unknown') actual.writeFileSync(join(file + '.adoptions', 'unknown'), 'foreign')
      if (target === 'symlink-staging') {
        actual.renameSync(join(file + '.adoptions', '.staging'), join(root, 'owned-staging'))
        actual.symlinkSync(join(root, 'owned-staging'), join(file + '.adoptions', '.staging'))
      }
      if (target === 'writable-record') actual.chmodSync(record(0), 0o666)
      if (target === 'oversized') actual.writeFileSync(record(0), 'x'.repeat(70_000))
      const before = actual.readFileSync(record(0), 'utf8')
      expect(() => readAdoptedHomes(file)).toThrow()
      expect(() => adopter.adopt(add('/new'))).toThrow()
      expect(actual.readFileSync(record(0), 'utf8')).toBe(before)
    })

  it('rechecks the whole record pool after reading its final entry', () => {
    adopter.adopt(add('/saved')); adopter.adopt(add('/later'))
    let changed = false
    vi.mocked(fs.readSync).mockImplementation((...args) => {
      const count = actual.readSync(...args as Parameters<typeof actual.readSync>)
      if (!changed && files.get(args[0]) === record(1)) {
        changed = true
        actual.writeFileSync(record(0), actual.readFileSync(record(0), 'utf8').replace('/saved', '/other'))
      }
      return count
    })
    expect(() => readAdoptedHomes(file)).toThrow('changed during its catalog read')
  })

  it('checks for a concurrent addition after the final proof pass', () => {
    adopter.adopt(add('/saved'))
    let reads = 0, appended = false
    vi.mocked(fs.readSync).mockImplementation((...args) => {
      const count = actual.readSync(...args as Parameters<typeof actual.readSync>)
      if (files.get(args[0]) === record(0) && ++reads === 2) {
        appended = true
        createHomeAdopter(file).adopt(add('/competitor'))
      }
      return count
    })
    expect(() => readAdoptedHomes(file)).toThrow('changed during its catalog read')
    expect(appended).toBe(true)
    expect(readAdoptedHomes(file).homes).toEqual(add('/saved', '/competitor'))
  })

  it('checks absent journal evidence again after a concurrent first adoption', () => {
    actual.mkdirSync(join(root, 'data'), { mode: 0o700 })
    actual.writeFileSync(file, '{"codex":[]}', { mode: 0o600 })
    let reads = 0, appended = false
    const open = vi.mocked(fs.openSync).getMockImplementation()!
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (String(args[0]) === file && ++reads === 2) {
        appended = true
        createHomeAdopter(file).adopt(add('/competitor'))
      }
      return open(...args)
    })
    expect(() => readAdoptedHomes(file)).toThrow('changed during its catalog read')
    expect(appended).toBe(true)
  })

  it.each(['first', 'append', 'idempotent'] as const)('imports a baseline appearing during %s publication before acknowledgement', phase => {
    if (phase !== 'first') adopter.adopt(add('/saved'))
    let changed = false
    const external = () => { changed = true; actual.writeFileSync(file, '{"codex":["/external"]}', { mode: 0o600 }) }
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (!changed && phase !== 'idempotent' && String(to) === record(phase === 'first' ? 0 : 1)) external()
      return actual.linkSync(from, to)
    })
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      if (!changed && phase === 'idempotent' && files.get(fd) === file + '.confirmations') external()
      actual.fsyncSync(fd)
    })
    const result = adopter.adopt(add(phase === 'idempotent' ? '/saved' : '/requested'))
    expect(result.codex).toContain('/external')
    expect(changed).toBe(true)
    actual.unlinkSync(file)
    expect(() => readAdoptedHomes(file)).toThrow('missing its adopted legacy catalog')
    actual.writeFileSync(file, '{}', { mode: 0o600 })
    expect(readAdoptedHomes(file).homes.codex).toContain('/external')
  })

  it.each(['replacement', 'removal'] as const)('retains a completely observed baseline across a deadline hold and %s', change => {
    let probes = 0
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      if (String(to) === record(0)) actual.writeFileSync(file, '{"codex":["/competitor"]}', { mode: 0o600 })
      return actual.linkSync(from, to)
    })
    vi.mocked(fs.lstatSync).mockImplementation(((path, options) => {
      // Let the final complete read return B, then exhaust the next rebase before B is imported.
      if (String(path) === record(127) && ++probes === 2) clock.remaining = 1
      return actual.lstatSync(path, options)
    }) as typeof fs.lstatSync)
    expect(() => adopter.adopt(add('/requested'))).toThrow('work deadline')
    expect(adopter.observations()).toEqual({ homes: add('/requested', '/competitor'), legacyRequired: true, exhausted: false })
    expect(actual.existsSync(record(1))).toBe(false)
    clock.remaining = Infinity
    vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync)
    if (change === 'removal') {
      actual.unlinkSync(file)
      expect(() => adopter.adopt(add('/requested'))).toThrow('missing its observed legacy catalog')
    }
    actual.writeFileSync(file, '{}', { mode: 0o600 })
    expect(adopter.adopt(empty()).codex).toEqual(['/requested', '/competitor'])
    expect(readAdoptedHomes(file).homes.codex).toContain('/competitor')
    actual.unlinkSync(file)
    expect(() => readAdoptedHomes(file)).toThrow('missing its adopted legacy catalog')
  })

  it('keeps observation overflow held through later retries', () => {
    actual.mkdirSync(join(root, 'data'), { mode: 0o700 })
    actual.writeFileSync(file, JSON.stringify(add('/first')), { mode: 0o600 })
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw unavailable() })
    expect(() => adopter.adopt(empty())).toThrow()
    actual.writeFileSync(file, JSON.stringify(add(...Array.from({ length: 63 }, (_, n) => `/next-${n}`))))
    expect(() => adopter.adopt(empty())).toThrow('known session-home limit')
    actual.writeFileSync(file, JSON.stringify(add('/first')))
    expect(() => adopter.adopt(empty())).toThrow('retained observation limit')
    expect(adopter.observations().exhausted).toBe(true)
    expect(actual.existsSync(record(0))).toBe(false)
  })

  it.each(['journal', 'confirmations', 'both'] as const)('holds an ancestor redirected only during %s enumeration to an old valid prefix', target => {
    adopter.adopt(add('/saved'))
    const old = join(root, 'old-data'), current = join(root, 'data'), aside = join(root, 'aside')
    actual.cpSync(current, old, { recursive: true })
    adopter.adopt(add('/competitor'))
    let redirected = false
    vi.mocked(fs.opendirSync).mockImplementation((path, options) => {
      const wanted = target === 'journal' ? file + '.adoptions' : file + '.confirmations'
      if (target === 'both' ? ![file + '.adoptions', file + '.confirmations'].includes(String(path)) : String(path) !== wanted) return actual.opendirSync(path, options)
      redirected = true
      actual.renameSync(current, aside); actual.symlinkSync(old, current)
      try { return actual.opendirSync(path, options) }
      finally { actual.unlinkSync(current); actual.renameSync(aside, current) }
    })
    expect(() => readAdoptedHomes(file)).toThrow('numbered entry pool')
    expect(redirected).toBe(true)
  })

  it('holds an addition after its next slot was inspected during the final numbered pass', () => {
    adopter.adopt(add('/saved'))
    let probes = 0, appended = false
    vi.mocked(fs.lstatSync).mockImplementation(((path, options) => {
      if (String(path) === record(127) && ++probes === 2) {
        appended = true
        createHomeAdopter(file).adopt(add('/late-competitor'))
      }
      return actual.lstatSync(path, options)
    }) as typeof fs.lstatSync)
    expect(() => readAdoptedHomes(file)).toThrow('changed its directory during enumeration')
    expect(appended).toBe(true)
  })

  it.each([['relative'], ['/bad\0path'], ['/' + 'x'.repeat(4096)], Array.from({ length: 64 }, (_, n) => `/home-${n}`)].map(paths => ({ paths })))
    ('refuses an invalid request without publishing any prefix: $paths', ({ paths }) => {
      expect(() => adopter.adopt(add(...paths))).toThrow('invalid home list')
      expect(actual.existsSync(record(0))).toBe(false)
    })

  it('holds when an I/O call exhausts the shared work deadline', () => {
    vi.mocked(fs.fsyncSync).mockImplementation(fd => { actual.fsyncSync(fd); clock.now += 251 })
    expect(() => adopter.adopt(add('/held'))).toThrow('work deadline')
    expect(actual.existsSync(record(0))).toBe(false)
  })
})
