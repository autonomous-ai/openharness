import * as fs from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectorsDir, writePrivate } from './store.js'

// A copy of the module, so a test can make a removal fail.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

describe('connectorsDir', () => {
  it('a relative HARNESS_CONNECTIONS_DIR is under the home, as config/env.ts reads every Harness folder', () => {
    expect(connectorsDir({ HARNESS_CONNECTIONS_DIR: 'c', HOME: '/h' })).toBe(join('/h', 'c'))
  })
})

describe('writePrivate', () => {
  let root = ''
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'connectors-store-')) })
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
    expect(() => writePrivate(join(root, 'tokens.json'), { a: 1 })).toThrow(denied)
  })

  it('writes the file when a removal would throw', () => {
    holdRemovals()
    writePrivate(join(root, 'tokens.json'), { a: 1 })
    expect(JSON.parse(readFileSync(join(root, 'tokens.json'), 'utf8'))).toEqual({ a: 1 })
    expect(readdirSync(root)).toEqual(['tokens.json'])
  })
})
