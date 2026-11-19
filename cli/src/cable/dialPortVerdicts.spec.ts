import { constants, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialVerdicts } from './dialPortVerdicts.js'
import type { DialPort } from './serial.js'

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

const board = (session?: string, serialNumber = 'AA:01'): DialPort =>
  ({ path: '/dev/board', serialNumber, vendorId: 0x303a, productId: 0x1001, ...(session ? { session } : {}) })

describe('verdicts on USB boards', () => {
  it('holds for one attachment of a board and lets go when it is unplugged or reset', () => {
    const verdicts = new DialVerdicts()
    expect(verdicts.isForeign(board('1'))).toBe(false)
    verdicts.markForeign(board('1'))
    expect(verdicts.isForeign(board('1'))).toBe(true)
    // A new attachment: the board may have been reflashed into a dial in between.
    expect(verdicts.isForeign(board('2'))).toBe(false)
    // Another board is another board.
    expect(verdicts.isForeign(board('1', 'BB:02'))).toBe(false)
  })

  it('expires on its own, as the safety net for a change the USB attachment did not show', () => {
    let now = 1_000_000
    const verdicts = new DialVerdicts(undefined, () => now)
    verdicts.markForeign(board('1'))
    now += 5 * 60 * 60_000
    expect(verdicts.isForeign(board('1'))).toBe(true)
    now += 2 * 60 * 60_000
    expect(verdicts.isForeign(board('1'))).toBe(false)
  })

  it('is only a short pause when nothing identifies the attachment', () => {
    let now = 1_000_000
    const verdicts = new DialVerdicts(undefined, () => now)
    verdicts.markForeign(board(undefined))
    now += 5 * 60_000
    expect(verdicts.isForeign(board(undefined))).toBe(true)
    now += 6 * 60_000
    expect(verdicts.isForeign(board(undefined))).toBe(false)
  })

  it('outlives the daemon: a restart does not cost another probe', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'verdicts-')), 'nested', 'dial-ports.json')
    new DialVerdicts(file).markForeign(board('7'))
    expect(new DialVerdicts(file).isForeign(board('7'))).toBe(true)
    expect(new DialVerdicts(file).isForeign(board('8'))).toBe(false)
  })

  it('a torn dial-ports.json is set aside, not written over', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'verdicts-')), 'dial-ports.json')
    writeFileSync(file, '{"')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const verdicts = new DialVerdicts(file)
    expect(verdicts.isForeign(board('1'))).toBe(false)
    verdicts.markForeign(board('1'))
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('AA:01')
    expect(warn).toHaveBeenCalledWith(
      '[state] dial-ports.json could not be read (not valid JSON); kept as dial-ports.json.unreadable, starting empty.')
  })

  it('the save goes through a temporary file of its own renamed onto the target', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'verdicts-')), 'dial-ports.json')
    new DialVerdicts(file).markForeign(board('1'))
    const renames = fsCalls.filter(({ call, to }) => call === 'rename' && to === file)
    expect(renames).toHaveLength(1)
    // Made new and exclusive: never a file another writer or a planted link holds.
    const opens = fsCalls.filter(({ call, path }) => call === 'open' && path === renames[0].path)
    expect(opens).toHaveLength(1)
    expect(Number(opens[0].flags) & constants.O_EXCL).toBe(constants.O_EXCL)
    expect(fsCalls.some(({ call, path }) => path === file && call === 'write')).toBe(false)
  })

  it('a file at the old temporary name is left alone', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'verdicts-')), 'dial-ports.json')
    writeFileSync(`${file}.${process.pid}.tmp`, 'another writer\'s')
    new DialVerdicts(file).markForeign(board('1'))
    expect(readFileSync(`${file}.${process.pid}.tmp`, 'utf8')).toBe('another writer\'s')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveProperty('AA:01')
  })

  it('never judges foreign a board that once greeted as a dial, across restarts and attachments', () => {
    // A Harness Pro rebooting while the daemon restarted stayed silent past the probe, was marked foreign
    // and left on its "Harness" screen for hours (a user's logs, 10-15, 10-16 and 10-22).
    const file = join(mkdtempSync(join(tmpdir(), 'verdicts-')), 'dial-ports.json')
    new DialVerdicts(file).markDial(board('1'))
    const next = new DialVerdicts(file)
    next.markForeign(board('2'))
    expect(next.isForeign(board('2'))).toBe(false)
    expect(new DialVerdicts(file).isForeign(board('3'))).toBe(false)
    // Another board is still judged on its own.
    next.markForeign(board('2', 'BB:02'))
    expect(next.isForeign(board('2', 'BB:02'))).toBe(true)
  })

  it('remembers which board greeted, across restarts, so only a known Harness Pro is ever reset', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'verdicts-')), 'dial-ports.json')
    const verdicts = new DialVerdicts(file)
    expect(verdicts.isPro(board('1'))).toBe(false)
    // A round dial (no board) is a dial, not a Pro.
    verdicts.markDial(board('1', 'RD:01'))
    expect(verdicts.isPro(board('1', 'RD:01'))).toBe(false)
    // A dial recorded before the board was kept learns it on its next greeting.
    verdicts.markDial(board('1'))
    verdicts.markDial(board('1'), 'pro')
    expect(new DialVerdicts(file).isPro(board('2'))).toBe(true)
    // A later greeting that names no board keeps what is known.
    new DialVerdicts(file).markDial(board('2'))
    expect(new DialVerdicts(file).isPro(board('3'))).toBe(true)
    // A foreign board is never a Pro.
    verdicts.markForeign(board('1', 'BB:02'))
    expect(verdicts.isPro(board('1', 'BB:02'))).toBe(false)
  })
})
