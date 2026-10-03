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
})
