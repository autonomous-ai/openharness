import { describe, expect, it, vi } from 'vitest'

vi.mock('../config/env.js', () => ({
  env: { HARNESS_CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
}))

import { decryptMachineCredential, encryptMachineCredential } from './machineCredential.js'

/** The envelope with the first character of its ciphertext changed to another: a first base64url character carries six
 *  whole bits, so the bytes always differ. Writing a fixed character changed nothing in the 1 run in 64 where the
 *  random value already had it (#1941's CI, 2026-10-28). */
const tampered = (envelope: string) => {
  const at = envelope.lastIndexOf('.') + 1
  return `${envelope.slice(0, at)}${envelope[at] === 'A' ? 'B' : 'A'}${envelope.slice(at + 1)}`
}

describe('machine credential envelope', () => {
  it('round-trips without storing plaintext and rejects tampering', () => {
    const secret = 'campaign-secret'
    const encrypted = encryptMachineCredential(secret)
    expect(encrypted).not.toContain(secret)
    expect(decryptMachineCredential(encrypted)).toBe(secret)
    expect(() => decryptMachineCredential(tampered(encrypted))).toThrow()
  })

  it('rejects tampering whatever character the random value has where it is changed', () => {
    // Each first character a ciphertext may start with, the one the tamper writes among them, found by encrypting again.
    for (const first of ['A', 'B', 'x']) {
      let encrypted = encryptMachineCredential('campaign-secret')
      for (let i = 0; encrypted[encrypted.lastIndexOf('.') + 1] !== first && i < 10_000; i++) encrypted = encryptMachineCredential('campaign-secret')
      expect(encrypted[encrypted.lastIndexOf('.') + 1]).toBe(first)
      expect(() => decryptMachineCredential(tampered(encrypted))).toThrow()
    }
  })
})
