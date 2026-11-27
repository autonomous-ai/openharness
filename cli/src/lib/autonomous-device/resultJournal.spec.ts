import * as fs from 'node:fs'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceResultJournal } from './resultJournal.js'

// A copy of the module, so a test can make a removal fail.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

describe('DeviceResultJournal.save', () => {
  let root = ''
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'device-results-')) })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true })
  })
  /** What Windows answers to the removal of a file another program still holds. */
  const holdRemovals = () => {
    const busy = () => { throw Object.assign(new Error('EBUSY: fixture'), { code: 'EBUSY' }) }
    vi.spyOn(fs, 'rmSync').mockImplementation(busy)
    vi.spyOn(fs, 'unlinkSync').mockImplementation(busy)
  }

  it('throws the error that stopped the write, not the one of its temporary\'s removal', () => {
    const denied = Object.assign(new Error('EACCES: fixture'), { code: 'EACCES' })
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw denied })
    holdRemovals()
    expect(() => new DeviceResultJournal(join(root, 'device-results.json')).save({ a: 1 })).toThrow(denied)
  })

  it('saves when a removal would throw', () => {
    const journal = new DeviceResultJournal(join(root, 'device-results.json'))
    holdRemovals()
    journal.save({ a: 1 })
    expect(journal.load()).toEqual({ a: 1 })
    expect(readdirSync(root)).toEqual(['device-results.json'])
  })
})
