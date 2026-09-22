import { describe, expect, it } from 'vitest'
import { normalizeEntryPoint } from './sso.js'

/**
 * `entry_point` is where a sign-in started. It reaches auth-service's login_events and BigQuery,
 * and `/api/auth/authorize-native` is unauthenticated, so whatever is accepted here is what an
 * anonymous caller can write into our analytics. auth-service itself only truncates at 255.
 */
describe('entry point', () => {
  it('keeps the values this product sends', () => {
    expect(normalizeEntryPoint('cli')).toBe('cli')
    expect(normalizeEntryPoint('desktop')).toBe('desktop')
  })

  it('accepts the shape web sign-ins already use', () => {
    expect(normalizeEntryPoint('sign-modal--orders_and_returns')).toBe('sign-modal--orders_and_returns')
  })

  it('trims and lowercases, so one place is not two rows in the report', () => {
    expect(normalizeEntryPoint('  Desktop  ')).toBe('desktop')
    expect(normalizeEntryPoint('cli\n')).toBe('cli')
  })

  it('is absent rather than empty when nothing was sent', () => {
    expect(normalizeEntryPoint(undefined)).toBeUndefined()
    expect(normalizeEntryPoint('')).toBeUndefined()
    expect(normalizeEntryPoint('   ')).toBeUndefined()
    expect(normalizeEntryPoint(42)).toBeUndefined()
  })

  it('refuses anything that is not a plain key, rather than passing it on', () => {
    // A query/fragment injection into the authorize URL, whitespace that would split a report row,
    // and the long strings auth-service would otherwise store up to 255 chars of.
    expect(normalizeEntryPoint('cli&prompt=none')).toBeUndefined()
    expect(normalizeEntryPoint('cli desktop')).toBeUndefined()
    expect(normalizeEntryPoint('cli\ndesktop')).toBeUndefined()
    expect(normalizeEntryPoint('a'.repeat(65))).toBeUndefined()
    expect(normalizeEntryPoint('-leading-dash')).toBeUndefined()
  })
})
