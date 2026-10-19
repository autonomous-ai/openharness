import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookCredentialPath, loadOrCreateHookCredential } from './hookAuth.js'
import { LOCAL_CREDENTIAL_HEADER, localCredentialHeaders, localCredentialMatches, readLocalCredential, suppliedLocalCredential } from './localCredential.js'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-cred-'))
  dirs.push(dir)
  return dir
}

describe('the daemon\'s local credential', () => {
  it('is the hook credential, sent as X-Harness-Local by a process that can read it', () => {
    const dir = dataDir()
    const credential = loadOrCreateHookCredential(dir)
    expect(readLocalCredential(dir)).toBe(credential)
    expect(localCredentialHeaders(dir)).toEqual({ [LOCAL_CREDENTIAL_HEADER]: credential })
  })

  it('adds no header when there is no credential to read, or one another user could have written', () => {
    const dir = dataDir()
    expect(localCredentialHeaders(dir)).toEqual({})
    loadOrCreateHookCredential(dir)
    chmodSync(hookCredentialPath(dir), 0o644)
    expect(readLocalCredential(dir)).toBeNull()
    expect(localCredentialHeaders(dir)).toEqual({})
  })

  it('is read from the named header first, else from a bearer', () => {
    expect(suppliedLocalCredential({ headers: { 'x-harness-local': 'named', authorization: 'Bearer other' } })).toBe('named')
    expect(suppliedLocalCredential({ headers: { authorization: 'Bearer bearer' } })).toBe('bearer')
    expect(suppliedLocalCredential({ headers: { 'x-harness-local': '', authorization: 'Bearer bearer' } })).toBe('bearer')
    expect(suppliedLocalCredential({ headers: { authorization: 'Basic abc' } })).toBeUndefined()
    expect(suppliedLocalCredential({ headers: {} })).toBeUndefined()
  })

  it('matches only the exact credential', () => {
    const credential = loadOrCreateHookCredential(dataDir())
    expect(localCredentialMatches(credential, { headers: { 'x-harness-local': credential } })).toBe(true)
    expect(localCredentialMatches(credential, { headers: { authorization: `Bearer ${credential}` } })).toBe(true)
    const wrong = `${credential.slice(0, -1)}${credential.endsWith('x') ? 'y' : 'x'}`
    expect(localCredentialMatches(credential, { headers: { 'x-harness-local': wrong } })).toBe(false)
    expect(localCredentialMatches(credential, { headers: { 'x-harness-local': credential.slice(1) } })).toBe(false)
    expect(localCredentialMatches(credential, { headers: {} })).toBe(false)
  })
})
