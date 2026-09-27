/**
 * The pair harness's token (pair/token.ts): none until the first launch, a new one for every launch that
 * makes the old one stop working at once, kept 0600 and read back after a restart; and the token a CLI or
 * MCP process presents, from its environment or the file it was told.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAIR_TOKEN_ENV, PAIR_TOKEN_FILE_ENV, PairToken, presentedToken } from './token.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-token-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('PairToken', () => {
  it('refuses everything before the first launch', () => {
    const token = new PairToken(join(dir, 'pair', 'token'))
    expect(token.launched).toBe(false)
    expect(token.matches('')).toBe(false)
    expect(token.matches('a'.repeat(64))).toBe(false)
  })

  it('rotates to a new 0600 token that alone matches, and a restart reads it back', () => {
    const file = join(dir, 'pair', 'token')
    const token = new PairToken(file)
    const first = token.rotate()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'pair')).mode & 0o777).toBe(0o700)
    expect(token.matches(first)).toBe(true)
    const second = token.rotate()
    expect(second).not.toBe(first)
    expect(token.matches(first)).toBe(false)
    expect(token.matches(second)).toBe(true)
    expect(token.matches(second.slice(1))).toBe(false)
    expect(token.matches(`${second} `)).toBe(false)
    expect(token.matches(123 as unknown as string)).toBe(false)
    const restarted = new PairToken(file)
    expect(restarted.launched).toBe(true)
    expect(restarted.matches(second)).toBe(true)
  })

  it('a saved file that is not a token is no token', () => {
    const file = join(dir, 'token')
    writeFileSync(file, 'ABC\n')
    expect(new PairToken(file).launched).toBe(false)
    writeFileSync(file, `${'g'.repeat(64)}\n`)
    expect(new PairToken(file).launched).toBe(false)
  })
})

describe('presentedToken', () => {
  it('prefers the environment, then the file named, then the file the environment names', () => {
    const file = join(dir, 'token')
    writeFileSync(file, ' from-file \n')
    const other = join(dir, 'other')
    writeFileSync(other, 'from-env-file')
    expect(presentedToken({ [PAIR_TOKEN_ENV]: ' direct ' }, file)).toBe('direct')
    expect(presentedToken({ [PAIR_TOKEN_ENV]: '  ', [PAIR_TOKEN_FILE_ENV]: other }, file)).toBe('from-file')
    expect(presentedToken({ [PAIR_TOKEN_FILE_ENV]: other })).toBe('from-env-file')
    expect(presentedToken({ [PAIR_TOKEN_FILE_ENV]: other }, '')).toBe('from-env-file')
  })

  it('nothing when there is no file, the file is empty, or it cannot be read', () => {
    expect(presentedToken({})).toBeNull()
    expect(presentedToken({}, join(dir, 'missing'))).toBeNull()
    const empty = join(dir, 'empty')
    writeFileSync(empty, ' \n')
    expect(presentedToken({}, empty)).toBeNull()
    const folder = join(dir, 'folder')
    mkdirSync(folder)
    expect(presentedToken({}, folder)).toBeNull()
  })
})
