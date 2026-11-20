import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, type PathLike } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEPT_INPUTS, ownedBy, ProgramRecords, programMay, readProgramToken, sameHash, withProgramLock } from './program.js'

// Every file opened for writing and every rename, in order; each call passes through (lib/secureState.ts imports
// node:fs too).
const disk = vi.hoisted(() => ({ calls: [] as Array<[op: 'write' | 'rename', path: string, to?: string]> }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const { O_WRONLY, O_RDWR } = actual.constants
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const flags = args[1]
      if (typeof flags === 'number' ? flags & (O_WRONLY | O_RDWR) : flags !== undefined && flags !== 'r') disk.calls.push(['write', String(args[0])])
      return actual.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] !== 'number') disk.calls.push(['write', String(args[0])])
      return actual.writeFileSync(...args)
    },
    renameSync: (from: PathLike, to: PathLike) => { disk.calls.push(['rename', String(from), String(to)]); return actual.renameSync(from, to) },
  }
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'program-')) })
afterEach(() => { disk.calls = []; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

const TOKEN = 'a'.repeat(40)
const tokenFile = (content = `${TOKEN}\n`, mode = 0o600): string => {
  const path = join(dir, `token-${Math.random()}`)
  writeFileSync(path, content)
  chmodSync(path, mode)
  return path
}

describe('a program token file', () => {
  it('is read as the SHA-256 of its token, a trailing newline taken off', () => {
    expect(readProgramToken(tokenFile()).hash).toBe(createHash('sha256').update(TOKEN).digest('hex'))
  })

  it('is refused when others may read it, it is short, a link, missing, or not the caller\'s', () => {
    const refused = (path: string, deps = {}) => { try { readProgramToken(path, deps); return null } catch (error) { return (error as { code?: string }).code } }
    expect(refused(tokenFile(undefined, 0o644))).toBe('BAD_TOKEN_FILE')
    expect(refused(tokenFile('short'))).toBe('BAD_TOKEN_FILE')
    expect(refused(tokenFile('x'.repeat(5_000)))).toBe('BAD_TOKEN_FILE')
    const link = join(dir, 'link')
    symlinkSync(tokenFile(), link)
    expect(refused(link)).toBe('BAD_TOKEN_FILE')
    expect(refused(join(dir, 'missing'))).toBe('BAD_TOKEN_FILE')
    expect(refused(dir)).toBe('BAD_TOKEN_FILE')
    expect(refused(tokenFile(), { uid: () => 424242 })).toBe('BAD_TOKEN_FILE')
    // Windows has no Unix mode: the ACL is the check there.
    expect(refused(tokenFile(undefined, 0o644), { platform: 'win32' })).toBeNull()
  })

  it('allows a reply and a resume, signed in or out: the one place a PM ruling changes', () => {
    expect(programMay('reply', false) && programMay('resume', true)).toBe(true)
    expect(sameHash('ab', 'ab')).toBe(true)
    expect(sameHash('ab', 'abc')).toBe(false)
  })
})

describe('the program harness records', () => {
  const hash = 'f'.repeat(64)
  const row = (agentId: string, name = 'openclaw-1', createdAt = 1) =>
    ({ agentId, tokenHash: hash, name, engine: 'openclaw', createdAt, startedAt: createdAt, inputs: [] })

  it('finds a harness by the program\'s name and token, newest first, and keeps its last inputs', () => {
    const records = new ProgramRecords(dir)
    expect(records.all()).toEqual([])
    records.put(row('a', 'OpenClaw-1', 1))
    records.put(row('b', 'openclaw-1', 2))
    expect(records.named('openclaw-1', hash).map((h) => h.agentId)).toEqual(['b', 'a'])
    expect(records.named('openclaw-1', '0'.repeat(64))).toEqual([])
    expect(ownedBy(dir, 'a', hash)).toBe(true)
    expect(ownedBy(dir, 'a', '0'.repeat(64))).toBe(false)
    expect(ownedBy(dir, 'zzz', hash)).toBe(false)
    records.started('a', 50)
    for (let i = 0; i < KEPT_INPUTS + 3; i++) records.taken('a', { id: `program:${i}`, takenAt: 100 + i })
    records.taken('missing', { id: 'x', takenAt: 1 })
    records.started('missing', 1)
    const a = records.get('a')!
    expect(a.startedAt).toBe(50)
    expect(a.inputs).toHaveLength(KEPT_INPUTS)
    expect(a.inputs.at(-1)!.id).toBe(`program:${KEPT_INPUTS + 2}`)
    records.prune(new Set(['a', 'b']))
    records.prune(new Set(['a']))
    expect(records.all().map((h) => h.agentId)).toEqual(['a'])
    records.forget('a')
    expect(records.get('a')).toBeNull()
  })

  it('reads past a file that is not its own shape', () => {
    const records = new ProgramRecords(dir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(records.path, 'not json')
    expect(records.all()).toEqual([])
    writeFileSync(records.path, JSON.stringify({ v: 1, harnesses: null }))
    expect(records.all()).toEqual([])
    writeFileSync(records.path, JSON.stringify({ v: 1, harnesses: { x: { agentId: 'x' }, y: { ...row('y'), inputs: 'no', createdAt: 'no' } } }))
    expect(records.all()).toEqual([{ ...row('y'), createdAt: 0 }])
    // OpenClaw's --local folder is kept when it names one.
    writeFileSync(records.path, JSON.stringify({ v: 1, harnesses: { y: { ...row('y'), local: '/state/y' }, z: { ...row('z'), local: '' }, w: { ...row('w'), local: 7, startedAt: 'no' } } }))
    expect(records.all()).toEqual([{ ...row('y'), local: '/state/y' }, row('z'), { ...row('w'), startedAt: 0 }])
  })

  it('the save goes through a temporary file renamed onto the target', () => {
    const records = new ProgramRecords(dir)
    records.put(row('a'))
    expect(disk.calls.filter(([op, path]) => op === 'write' && path === records.path)).toEqual([])
    const renames = disk.calls.filter(([op, , to]) => op === 'rename' && to === records.path)
    expect(renames).toHaveLength(1)
    expect(renames[0][1]).not.toBe(records.path)
    expect(dirname(renames[0][1])).toBe(dir)
  })

  it('a file at the old temporary name is left alone', () => {
    const records = new ProgramRecords(dir)
    const old = `${records.path}.${process.pid}.tmp`
    writeFileSync(old, 'another writer')
    records.put(row('a'))
    expect(readFileSync(old, 'utf8')).toBe('another writer')
  })

  it('a torn program-harnesses.json is set aside, not written over', () => {
    const records = new ProgramRecords(dir)
    writeFileSync(records.path, '{"')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    records.put(row('a'))
    expect(readFileSync(`${records.path}.unreadable`, 'utf8')).toBe('{"')
    expect(records.all().map((h) => h.agentId)).toEqual(['a'])
    expect(warn).toHaveBeenCalledWith('[state] program-harnesses.json could not be read (not valid JSON); kept as program-harnesses.json.unreadable, starting empty.')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a program-harnesses.json this account cannot read is not written over', () => {
    const records = new ProgramRecords(dir)
    records.put(row('a'))
    const before = readFileSync(records.path, 'utf8')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    chmodSync(records.path, 0o000)
    expect(() => records.put(row('b'))).toThrow('program-harnesses.json could not be read (EACCES)')
    chmodSync(records.path, 0o600)
    expect(readFileSync(records.path, 'utf8')).toBe(before)
  })

  it('runs two ensures of one name one after the other', async () => {
    const order: string[] = []
    const one = withProgramLock(dir, 'lamp', async () => { order.push('a+'); await new Promise((r) => setTimeout(r, 60)); order.push('a-') })
    const two = withProgramLock(dir, 'LAMP', async () => { order.push('b+'); order.push('b-') })
    await Promise.all([one, two])
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-'])
  })

  it('takes over a lock whose process is gone, and gives up on a live one in time', async () => {
    const name = 'lamp'
    const key = createHash('sha256').update(name).digest('hex').slice(0, 16)
    writeFileSync(join(dir, `program-ensure-${key}.lock`), JSON.stringify({ pid: 2 ** 22 + 7 }))
    expect(await withProgramLock(dir, name, async () => 'ran')).toBe('ran')
    writeFileSync(join(dir, `program-ensure-${key}.lock`), JSON.stringify({ pid: process.pid }))
    await expect(withProgramLock(dir, name, async () => 'ran', 50)).rejects.toMatchObject({ code: 'BUSY' })
  })
})
