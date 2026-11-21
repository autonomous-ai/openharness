import { describe, expect, it } from 'vitest'
import { b64e, newIdentity } from './core.js'
import { MAX_RECIPIENTS, openVault, sealVault } from './connectorVault.js'
import { VAULT_CIPHERTEXT_CHARS, VAULT_PLAINTEXT_BYTES } from '../connectors/vaultBounds.js'

const a = newIdentity(), b = newIdentity(), c = newIdentity(), stranger = newIdentity()
const pub = (id: { pub: Uint8Array }) => b64e(id.pub)
const machines = new Set([pub(a), pub(b), pub(c)])

describe('the connector vault envelope', () => {
  it('bounds secret content before encrypting or decoding it', () => {
    expect(() => sealVault('x'.repeat(VAULT_PLAINTEXT_BYTES + 1), a, [])).toThrow('vault limit')
    const envelope = sealVault('synthetic', a, [])
    expect(openVault({ ...envelope, ct: 'x'.repeat(VAULT_CIPHERTEXT_CHARS + 1) }, a, machines)).toBeNull()
    expect(openVault({ ...envelope, keys: Array(65).fill('synthetic') }, a, machines)).toBeNull()
    expect(openVault({ ...envelope, keys: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), 'synthetic'])) }, a, machines)).toBeNull()
  })
  it('opens on the sender and every machine it was sealed for, and on no other key', () => {
    const envelope = sealVault('{"linear":1}', a, [pub(b)])
    expect(Object.keys(envelope.keys).sort()).toEqual([pub(a), pub(b)].sort())
    expect(openVault(envelope, a, machines)).toBe('{"linear":1}')
    expect(openVault(envelope, b, machines)).toBe('{"linear":1}')
    expect(openVault(envelope, c, machines)).toBeNull()
    expect(JSON.stringify(envelope)).not.toContain('linear')
  })

  it('opens only what a trusted machine signed, untouched', () => {
    const envelope = sealVault('secret', a, [pub(b)])
    expect(openVault(envelope, b, new Set([pub(b)]))).toBeNull()
    // The backend swaps in its own envelope, sealed for b by a key the log does not hold.
    expect(openVault(sealVault('evil', stranger, [pub(b)]), b, machines)).toBeNull()
    // Or claims a trusted sender for it.
    expect(openVault({ ...sealVault('evil', stranger, [pub(b)]), sender: pub(a) }, b, machines)).toBeNull()
    for (const field of ['ct', 'nonce', 'eph'] as const) {
      const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1
      expect(openVault({ ...envelope, [field]: bytes.toString('base64') }, b, machines)).toBeNull()
    }
    expect(openVault({ ...envelope, keys: { [pub(b)]: envelope.keys[pub(a)] } }, b, machines)).toBeNull()
  })

  it('reads nothing from what is not an envelope', () => {
    for (const junk of [null, 'x', {}, { v: 2 }, { ...sealVault('x', a, []), keys: { [pub(a)]: 1 } }]) {
      expect(openVault(junk, a, machines)).toBeNull()
    }
  })

  it('seals for as many machines as the backend keeps, and refuses more', () => {
    const many = Array.from({ length: MAX_RECIPIENTS - 1 }, () => pub(newIdentity()))
    expect(Object.keys(sealVault('x', a, many).keys)).toHaveLength(MAX_RECIPIENTS)
    expect(() => sealVault('x', a, [...many, pub(newIdentity())])).toThrow('too many')
  })
})
