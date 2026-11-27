import { expect, it } from 'vitest'
import { sanitizeClientVersion } from './clientVersion.js'

it('keeps a version a client really sends, trimmed', () => {
  expect(sanitizeClientVersion('0.6.97')).toBe('0.6.97')
  expect(sanitizeClientVersion('0.6.97-dev.3+g1a2b3c')).toBe('0.6.97-dev.3+g1a2b3c')
  expect(sanitizeClientVersion(' 0.6.97 ')).toBe('0.6.97')
  expect(sanitizeClientVersion('1'.repeat(64))).toBe('1'.repeat(64))
})

it('drops anything else, never stored raw', () => {
  for (const raw of ['', '   ', '1'.repeat(65), '0.6.97 beta', '0.6.97;rm', '<b>0.6</b>', null, undefined, 42, {}, ['0.6.97']]) {
    expect(sanitizeClientVersion(raw)).toBeUndefined()
  }
})
