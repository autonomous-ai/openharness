import { describe, expect, it } from 'vitest'
import { normalizeSignInAttribution } from './signInAttribution.js'

/**
 * `/api/auth/exchange` takes this from whoever holds a fresh code, and what passes is stored on the
 * user and reported on — so only the `utm_*` keys and `rid` survive, trimmed and capped.
 */
describe('sign-in attribution', () => {
  it('maps the five utm keys to their fields', () => {
    expect(normalizeSignInAttribution({
      utm_source: 'app',
      utm_medium: 'web',
      utm_campaign: 'launch',
      utm_term: 'agents',
      utm_content: 'hero',
    })).toEqual({ source: 'app', medium: 'web', campaign: 'launch', term: 'agents', content: 'hero' })
  })

  it('keeps the Autonomous referral id', () => {
    expect(normalizeSignInAttribution({ rid: 'r-123', utm_source: 'app' })).toEqual({ rid: 'r-123', source: 'app' })
  })

  it('keeps only the keys that were sent', () => {
    expect(normalizeSignInAttribution({ utm_source: 'app' })).toEqual({ source: 'app' })
  })

  it('drops unknown keys and non-string values', () => {
    expect(normalizeSignInAttribution({ utm_source: 'app', role: 'admin', utm_medium: 42 })).toEqual({ source: 'app' })
  })

  it('trims and caps each value', () => {
    expect(normalizeSignInAttribution({ utm_source: '  app  ' })).toEqual({ source: 'app' })
    expect(normalizeSignInAttribution({ utm_source: 'a'.repeat(500) })?.source).toHaveLength(128)
  })

  it('is absent rather than empty when nothing usable was sent', () => {
    expect(normalizeSignInAttribution(undefined)).toBeUndefined()
    expect(normalizeSignInAttribution(null)).toBeUndefined()
    expect(normalizeSignInAttribution('utm_source=app')).toBeUndefined()
    expect(normalizeSignInAttribution(['app'])).toBeUndefined()
    expect(normalizeSignInAttribution({})).toBeUndefined()
    expect(normalizeSignInAttribution({ utm_source: '   ' })).toBeUndefined()
  })
})
