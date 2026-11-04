import { describe, expect, it } from 'vitest'
import { dropOptions } from './dropLegacy.js'

describe('the old state removal script\'s options', () => {
  it('only counts by default', () => {
    expect(dropOptions([])).toEqual({ apply: false, batch: 100 })
  })

  it('removes only when the backup is confirmed too', () => {
    expect(() => dropOptions(['--apply'])).toThrow('--backup-confirmed')
    expect(dropOptions(['--apply', '--backup-confirmed'])).toEqual({ apply: true, batch: 100 })
    expect(dropOptions(['--backup-confirmed', '--apply', '--batch', '25'])).toEqual({ apply: true, batch: 25 })
  })

  it('refuses a batch that is not a positive whole number, and unknown options', () => {
    for (const batch of ['0', '-1', '2.5', 'many']) expect(() => dropOptions(['--batch', batch])).toThrow('--batch')
    expect(() => dropOptions(['--batch'])).toThrow('--batch')
    expect(() => dropOptions(['--force'])).toThrow('--force')
  })
})
