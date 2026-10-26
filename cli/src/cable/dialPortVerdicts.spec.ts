import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DialVerdicts } from './dialPortVerdicts.js'
import type { DialPort } from './serial.js'

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

  it('starts with no opinions from a file it cannot read, and writes a good one over it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'verdicts-')), 'dial-ports.json')
    writeFileSync(file, '{ not json')
    const verdicts = new DialVerdicts(file)
    expect(verdicts.isForeign(board('1'))).toBe(false)
    verdicts.markForeign(board('1'))
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
