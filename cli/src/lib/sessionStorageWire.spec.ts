import { describe, expect, it } from 'vitest'
import { credentialEquality, sessionCredentialReference, sessionDocument, sessionImageProof, storedGridLaunch } from './sessionStorageWire.js'

const proof = { document: { kind: 'registry' }, identity: '1:2:3', bytes: 3, sha256: 'a'.repeat(64) }
const credential = { version: 1, binding: 'b'.repeat(64), row: { agentId: 'fixture', registeredAt: 1 },
  source: { kind: 'image', proof } }
const launch = { networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.example.test', credential }

describe('private session storage wire guards', () => {
  it.each([null, false, 1, 'registry', [], {}, { kind: 'stopped', agentId: '../other' }, { kind: 'superseded', agentId: '' },
    { kind: 'stopped', agentId: 1 }])('refuses non-document and path-shaped identities (%#)', value => {
    expect(sessionDocument(value)).toBe(false)
  })

  it.each([{ kind: 'registry' }, { kind: 'legacy-registry' }, { kind: 'names' },
    { kind: 'stopped', agentId: 'fixture-A_1' }, { kind: 'superseded', agentId: 'fixture-A_1' }])(
    'recognizes only fixed document kinds with a safe selected identity (%#)', value => {
      expect(sessionDocument(value)).toBe(true)
    })

  it.each([null, [], true, {}, { ...proof, identity: 'path/to/file' }, { ...proof, sha256: 'not-a-proof' },
    { ...proof, bytes: -1 }, { ...proof, bytes: 0.5 }])('refuses malformed image proof fields (%#)', value => {
    expect(sessionImageProof(value)).toBe(false)
  })

  it.each([null, [], false, {}, { ...credential, version: 2 }, { ...credential, binding: 'wrong' },
    { ...credential, row: { agentId: 'fixture', registeredAt: Infinity } },
    { ...credential, source: { kind: 'import', lease: 'not-a-lease' } }])('refuses malformed credential references (%#)', value => {
    expect(sessionCredentialReference(value)).toBe(false)
  })

  it('keeps private binding equality independent of unrelated image witnesses without accepting plaintext', () => {
    expect(sessionImageProof(proof)).toBe(true)
    expect(sessionCredentialReference(credential)).toBe(true)
    expect(sessionCredentialReference({ ...credential, row: { agentId: 'fixture', registeredAt: null },
      source: { kind: 'import', lease: '12345678-1234-1234-1234-123456789012' } })).toBe(true)
    expect(storedGridLaunch(launch)).toBe(true)
    expect(storedGridLaunch({ ...launch, apiKey: 'fixture-rejected' })).toBe(false)
    expect(credentialEquality(launch)).toEqual({ ...launch, credential: { version: 1, binding: credential.binding, row: credential.row } })
    expect(credentialEquality({ unknown: true })).toEqual({ unknown: true })
  })
})
