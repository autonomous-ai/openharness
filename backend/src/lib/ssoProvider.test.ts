import { describe, expect, it } from 'vitest'
import { authorizeUrl, normalizeSignInProvider, normalizeSsoClientId } from './sso.js'

/**
 * `provider` is which button the person pressed: Continue with Google, Continue with Apple. Both
 * authorize routes need no token and the value goes into the authorize URL's query, so only the
 * two names this product sends are passed on.
 */
describe('sign-in provider', () => {
  it('keeps the two accounts the clients offer', () => {
    expect(normalizeSignInProvider('google')).toBe('google')
    expect(normalizeSignInProvider('apple')).toBe('apple')
  })

  it('trims and lowercases', () => {
    expect(normalizeSignInProvider('  Google ')).toBe('google')
    expect(normalizeSignInProvider('APPLE\n')).toBe('apple')
  })

  it('is absent for anything else, which is the sign-in page\'s own chooser', () => {
    expect(normalizeSignInProvider(undefined)).toBeUndefined()
    expect(normalizeSignInProvider('')).toBeUndefined()
    expect(normalizeSignInProvider('sso')).toBeUndefined()
    expect(normalizeSignInProvider('github')).toBeUndefined()
    expect(normalizeSignInProvider('google&prompt=none')).toBeUndefined()
    expect(normalizeSignInProvider(42)).toBeUndefined()
  })
})

describe('SSO client', () => {
  it('keeps the four surfaces\' own clients', () => {
    for (const id of ['harness-cli', 'harness-desktop', 'harness-web', 'harness-mobile']) {
      expect(normalizeSsoClientId(id)).toBe(id)
    }
  })

  it('is absent for anything else, which is the configured client', () => {
    expect(normalizeSsoClientId(undefined)).toBeUndefined()
    expect(normalizeSsoClientId('')).toBeUndefined()
    expect(normalizeSsoClientId('harness-admin')).toBeUndefined()
    expect(normalizeSsoClientId('harness-cli&scope=admin')).toBeUndefined()
    expect(normalizeSsoClientId(7)).toBeUndefined()
  })
})

describe('authorize URL', () => {
  const url = (hints?: Parameters<typeof authorizeUrl>[4]) =>
    new URL(authorizeUrl('challenge', 'state', 'http://127.0.0.1:5000/callback', 'prod', hints))

  it('names the provider and the entry point when the client sent them', () => {
    const { searchParams } = url({ entryPoint: 'desktop', provider: 'apple' })
    expect(searchParams.get('provider')).toBe('apple')
    expect(searchParams.get('entry_point')).toBe('desktop')
    expect(searchParams.get('code_challenge')).toBe('challenge')
  })

  it('carries neither for a client that sent none, as before the buttons existed', () => {
    const { searchParams } = url()
    expect(searchParams.has('provider')).toBe(false)
    expect(searchParams.has('entry_point')).toBe(false)
    expect(searchParams.get('state')).toBe('state')
  })

  it('signs in as the surface that asked, or as the configured client', () => {
    expect(url({ clientId: 'harness-mobile' }).searchParams.get('client_id')).toBe('harness-mobile')
    const configured = url().searchParams.get('client_id')
    expect(configured).toBeTruthy()
    expect(configured).not.toBe('harness-mobile')
  })
})
