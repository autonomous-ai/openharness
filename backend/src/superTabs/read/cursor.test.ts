import { describe, expect, it } from 'vitest'
import { cursorFor, readCursor } from './cursor.js'

const T0 = 1_793_010_104_375
const DAY = 86_400_000
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

describe('change cursor (design 4.2)', () => {
  it('starts 30 s before the read began and carries the epoch, as unpadded base64url the daemon proxy passes', () => {
    const cursor = cursorFor(T0, 3)
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toEqual({ v: 2, t: T0 - 30_000, e: 3 })
  })

  it('reads back a cursor of the current epoch made within tombstone retention', () => {
    expect(readCursor(cursorFor(T0, 3), 3, T0 + 5_000)).toEqual({ since: T0 - 30_000 })
  })

  it.each([
    ['garbage', '!!not-base64!!'],
    ['not JSON', Buffer.from('hello').toString('base64url')],
    ['an older format', b64({ v: 1, t: T0, e: 3 })],
    ['a time that is not a number', b64({ v: 2, t: '1793010104375', e: 3 })],
    ['no epoch', b64({ v: 2, t: T0 })],
    ['a JSON array', b64([2, T0, 3])],
  ])('asks for a reload on %s', (_case, cursor) => {
    expect(readCursor(cursor, 3, T0)).toEqual({ reload: true })
  })

  it('asks for a reload when who may see what changed since the cursor', () => {
    expect(readCursor(cursorFor(T0, 3), 4, T0 + 1_000)).toEqual({ reload: true })
  })

  it('asks for a reload when tombstones made after the cursor may already be purged (7 days, 1 hour margin)', () => {
    const cursor = cursorFor(T0, 3), since = T0 - 30_000
    expect(readCursor(cursor, 3, since + 7 * DAY - 3_600_000)).toEqual({ since })
    expect(readCursor(cursor, 3, since + 7 * DAY - 3_600_000 + 1)).toEqual({ reload: true })
  })
})
