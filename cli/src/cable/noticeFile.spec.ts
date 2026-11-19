import {
  chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { NOTICES_FILE, NOTICES_FILE_MAX_BYTES, NoticeFile } from './noticeFile.js'
import type { StoredNotice } from './notices.js'

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
afterEach(() => { fsCalls.length = 0; vi.restoreAllMocks() })

// Every folder made and every line said, so the last test can check no line names a path or what a card says.
const folders: string[] = []
const said: string[] = []

const aFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), 'dial-notices-'))
  folders.push(folder)
  return folder
}

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

interface Timer { ms: number; run: () => void; cancelled: boolean }

const timers = () => {
  const pending: Timer[] = []
  const after = (ms: number, run: () => void) => {
    const timer: Timer = { ms, run, cancelled: false }
    pending.push(timer)
    return () => { timer.cancelled = true }
  }
  return { after, pending }
}

const card = (n: number, over: Record<string, unknown> = {}): StoredNotice => ({
  agentId: `a${n}`, keys: [`claude:s${n}`], id: `shown:k${n}`, line: `Line ${n}`, host: 'orca', at: 1_000 + n, ...over,
}) as StoredNotice

const WHO = { name: 'api', engine: 'codex', machine: 'Mac mini' }

const store = (file: string, cards: StoredNotice[] = []) => {
  const { after, pending } = timers()
  const logs: string[] = []
  const noticeFile = new NoticeFile({ file, cards: () => cards, after, log: (line) => { logs.push(line); said.push(line) } })
  return { noticeFile, cards, pending, logs }
}

const aFile = () => join(aFolder(), NOTICES_FILE)
const fileOf = (cards: unknown[]) => JSON.stringify({ v: 1, cards })

const BAD_CARDS: Array<[string, Record<string, unknown>]> = [
  ['an empty agentId', { agentId: '' }],
  ['an agentId of 65 letters', { agentId: 'a'.repeat(65) }],
  ['an agentId that is a number', { agentId: 7 }],
  ['keys that are a string', { keys: 'claude:s1' }],
  ['five keys', { keys: ['k1', 'k2', 'k3', 'k4', 'k5'] }],
  ['an empty key', { keys: [''] }],
  ['a key of 161 letters', { keys: ['k'.repeat(161)] }],
  ['a key that is a number', { keys: [7] }],
  ['an id not shown:', { id: 'k1' }],
  ['an id of 65 letters', { id: `shown:${'k'.repeat(59)}` }],
  ['an empty line', { line: '' }],
  ['a line of 240 bytes', { line: 'é'.repeat(120) }],
  ['a host of 33 letters', { host: 'h'.repeat(33) }],
  ['a null host', { host: null }],
  ['a who that is a string', { who: 'api' }],
  ['a who with no machine', { who: { name: 'api', engine: 'codex' } }],
  ['a who with an empty name', { who: { ...WHO, name: '' } }],
  ['an at below 0', { at: -1 }],
  ['an at that is a fraction', { at: 1.5 }],
  ['an at that is a string', { at: '1' }],
]

// Not JSON, or JSON that is not an object: the shared reader's to set aside.
const SET_ASIDE: Array<[string, string, string]> = [
  ['not valid JSON', 'torn', '{"'],
  ['not valid JSON', 'not json', '{not json'],
  ['not valid JSON', 'empty', ''],
  ['unexpected content', 'a list', '[]'],
  ['unexpected content', 'null', 'null'],
  ['unexpected content', 'a number', '7'],
]

const DROPPED: Array<[string, string, string]> = [
  ['version', 'v 2', '{"v":2,"cards":[]}'],
  ['version', 'no v', '{"cards":[]}'],
  ['shape', 'no cards', '{"v":1}'],
  ['shape', 'cards that are an object', '{"v":1,"cards":{}}'],
  ['shape', '21 cards', fileOf(Array.from({ length: 21 }, (_, n) => card(n + 1)))],
  ['shape', 'two cards of one agent', fileOf([card(1), card(2, { agentId: 'a1' })])],
  ['shape', 'a null card', fileOf([card(1), null])],
  ...BAD_CARDS.map(([what, over]): [string, string, string] => ['shape', what, fileOf([card(1, over)])]),
]

describe('the file of pending notices', () => {
  it('no file reads as none, and says nothing', () => {
    const { noticeFile, logs } = store(aFile())
    expect(noticeFile.load()).toEqual([])
    expect(logs).toEqual([])
  })

  it('a set is written whole a second after its first change, and read by the next start', () => {
    const folder = aFolder()
    const file = join(folder, NOTICES_FILE)
    const { noticeFile, pending } = store(file, [card(1), card(2, { who: WHO })])
    noticeFile.changed()
    expect(pending).toEqual([{ ms: 1_000, run: expect.any(Function), cancelled: false }])
    expect(existsSync(file)).toBe(false)
    pending[0].run()
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify({ v: 1, cards: [card(1), card(2, { who: WHO })] })}\n`)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(folder)).toEqual([NOTICES_FILE])
    expect(store(file).noticeFile.load()).toEqual([card(1), card(2, { who: WHO })])
  })

  it('changes that come close together are one write, of the set as the write runs', () => {
    const file = aFile()
    const { noticeFile, cards, pending } = store(file, [card(1), card(2)])
    noticeFile.changed()
    noticeFile.changed()
    noticeFile.changed()
    expect(pending).toHaveLength(1)
    cards.push(card(3))
    pending[0].run()
    expect(store(file).noticeFile.load()).toEqual([card(1), card(2), card(3)])
    noticeFile.changed()
    expect(pending).toHaveLength(2)
  })

  it('close writes what waits and nothing after; with nothing waiting it writes nothing', () => {
    const file = aFile()
    const { noticeFile, cards, pending } = store(file, [card(1)])
    noticeFile.changed()
    noticeFile.close()
    expect(pending[0].cancelled).toBe(true)
    const written = readFileSync(file, 'utf8')
    expect(store(file).noticeFile.load()).toEqual([card(1)])
    cards.push(card(2))
    noticeFile.changed()
    expect(pending).toHaveLength(1)
    noticeFile.close()
    expect(readFileSync(file, 'utf8')).toBe(written)

    const fresh = aFile()
    store(fresh, [card(1)]).noticeFile.close()
    expect(existsSync(fresh)).toBe(false)
  })

  it('an empty set is an empty list', () => {
    const file = aFile()
    const { noticeFile, pending } = store(file)
    noticeFile.changed()
    pending[0].run()
    expect(readFileSync(file, 'utf8')).toBe('{"v":1,"cards":[]}\n')
  })

  it.each(DROPPED)('a %s file is dropped whole, in one line with the reason alone: %s', (reason, _what, text) => {
    const file = aFile()
    writeFileSync(file, text)
    const { noticeFile, pending, logs } = store(file, [card(1)])
    expect(noticeFile.load()).toEqual([])
    expect(logs).toEqual([`[device] notices · file dropped · ${reason}`])
    noticeFile.changed()
    pending[0].run()
    expect(store(file).noticeFile.load()).toEqual([card(1)])
  })

  it.each(SET_ASIDE)('a dial-notices.json that is %s (%s) is set aside, not written over', (failure, _what, text) => {
    const folder = aFolder()
    const file = join(folder, NOTICES_FILE)
    writeFileSync(file, text)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { noticeFile, pending, logs } = store(file, [card(1)])
    expect(noticeFile.load()).toEqual([])
    expect(logs).toEqual([])
    expect(warn).toHaveBeenCalledWith(`[state] ${NOTICES_FILE} could not be read (${failure}); kept as ${NOTICES_FILE}.unreadable, starting empty.`)
    noticeFile.changed()
    pending[0].run()
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe(text)
    expect(store(file).noticeFile.load()).toEqual([card(1)])
  })

  it('the save goes through a temporary file of its own renamed onto the target', () => {
    const file = aFile()
    const { noticeFile, pending } = store(file, [card(1)])
    noticeFile.changed()
    pending[0].run()
    const renames = fsCalls.filter(({ call, to }) => call === 'rename' && to === file)
    expect(renames).toHaveLength(1)
    // Made new and exclusive: never a file another writer or a planted link holds.
    const opens = fsCalls.filter(({ call, path }) => call === 'open' && path === renames[0].path)
    expect(opens).toHaveLength(1)
    expect(Number(opens[0].flags) & constants.O_EXCL).toBe(constants.O_EXCL)
    expect(fsCalls.some(({ call, path }) => path === file && call === 'write')).toBe(false)
  })

  it('a file at the old temporary name is left alone', () => {
    const file = aFile()
    writeFileSync(`${file}.${process.pid}.tmp`, 'another writer\'s')
    const { noticeFile, pending } = store(file, [card(1)])
    noticeFile.changed()
    pending[0].run()
    expect(readFileSync(`${file}.${process.pid}.tmp`, 'utf8')).toBe('another writer\'s')
    expect(store(file).noticeFile.load()).toEqual([card(1)])
  })

  it('a file at 32 KiB is read, one byte longer is not', () => {
    const file = aFile()
    const text = fileOf([card(1)])
    writeFileSync(file, text.padEnd(NOTICES_FILE_MAX_BYTES, ' '))
    const at = store(file)
    expect(at.noticeFile.load()).toEqual([card(1)])
    expect(at.logs).toEqual([])
    writeFileSync(file, text.padEnd(NOTICES_FILE_MAX_BYTES + 1, ' '))
    const over = store(file)
    expect(over.noticeFile.load()).toEqual([])
    expect(over.logs).toEqual(['[device] notices · file dropped · long'])
  })

  it('unknown fields are ignored and not carried', () => {
    const file = aFile()
    writeFileSync(file, JSON.stringify({
      v: 1, extra: true, cards: [{ ...card(1), color: 'red' }, card(2, { who: { ...WHO, avatar: 'cat' } })],
    }))
    expect(store(file).noticeFile.load()).toStrictEqual([card(1), card(2, { who: WHO })])
  })

  // Nothing was read to judge (a folder there, EACCES, EMFILE, a Windows scanner's EBUSY): what is there stays.
  it('a path that cannot be read is left, and nothing is written over it', () => {
    const folder = aFolder()
    const file = join(folder, NOTICES_FILE)
    mkdirSync(file)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { noticeFile, pending, logs } = store(file, [card(1)])
    expect(noticeFile.load()).toEqual([])
    expect(warn).toHaveBeenCalledWith(`[state] ${NOTICES_FILE} could not be read (EISDIR); left as it is, read again next time.`)
    noticeFile.changed()
    pending[0].run()
    expect(logs).toEqual([])
    expect(readdirSync(folder)).toEqual([NOTICES_FILE])
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a file this account cannot read is not written over', () => {
    const file = aFile()
    const kept = store(file, [card(2)])
    kept.noticeFile.changed()
    kept.pending[0].run()
    const before = readFileSync(file, 'utf8')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    chmodSync(file, 0o000)
    const { noticeFile, pending } = store(file, [card(1)])
    expect(noticeFile.load()).toEqual([])
    noticeFile.changed()
    pending[0].run()
    chmodSync(file, 0o600)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('a write that fails says the error\'s code, and the next change tries again', () => {
    const folder = aFolder()
    const file = join(folder, NOTICES_FILE)
    const { noticeFile, pending, logs } = store(file, [card(1)])
    expect(noticeFile.load()).toEqual([])
    mkdirSync(file)
    noticeFile.changed()
    pending[0].run()
    expect(logs).toEqual(['[device] notices · not saved · EISDIR'])
    expect(readdirSync(folder)).toEqual([NOTICES_FILE])
    noticeFile.changed()
    expect(pending).toHaveLength(2)
  })

  it('a card that fails the shape is left out of a write', () => {
    const file = aFile()
    const { noticeFile, pending } = store(file, [card(1), card(2, { line: 'x'.repeat(240) })])
    noticeFile.changed()
    pending[0].run()
    expect(store(file).noticeFile.load()).toEqual([card(1)])
  })

  // Each quote is written as two bytes, so twenty of the largest cards a shape allows are past the file's limit.
  it('a set too long for the file leaves its oldest cards out until it fits', () => {
    const file = aFile()
    const cards = Array.from({ length: 20 }, (_, n) => card(n + 1, {
      line: '"'.repeat(239),
      keys: ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(160)),
      who: { name: '"'.repeat(256), engine: 'codex', machine: '"'.repeat(256) },
    }))
    const { noticeFile, pending } = store(file, cards)
    noticeFile.changed()
    pending[0].run()
    expect(statSync(file).size).toBeLessThanOrEqual(NOTICES_FILE_MAX_BYTES)
    const next = store(file)
    const loaded = next.noticeFile.load()
    expect(next.logs).toEqual([])
    expect(loaded.length).toBeGreaterThan(0)
    expect(loaded).toEqual(cards.slice(-loaded.length))
    // Only as many as needed are left out: one more of the newest would not fit.
    expect(Buffer.byteLength(`${fileOf(cards.slice(-loaded.length - 1))}\n`)).toBeGreaterThan(NOTICES_FILE_MAX_BYTES)
  })

  it('no line holds the path or what a card says', () => {
    for (const line of said) {
      for (const folder of folders) expect(line).not.toContain(folder)
      expect(line).not.toContain('Line 1')
      expect(line).not.toContain('claude:s1')
    }
  })
})
