/**
 * The account's connected services, sealed for its machines (backend routes/connectorVault.ts keeps the
 * envelope and never a key to it). One sender, any number of recipients, each an account machine's
 * device key from the signed device log:
 *
 *   - A fresh content key encrypts the JSON (ChaCha20-Poly1305, random nonce).
 *   - The content key is wrapped for each recipient: X25519 between one ephemeral key and the recipient's
 *     Ed25519 device key in its Montgomery form, through HKDF bound to both public keys.
 *   - The sender signs every field with its own device key. A recipient opens only an envelope signed by
 *     a key it trusts (a machine of the account's log), so the backend, which can replace the envelope,
 *     cannot make a computer accept connections it wrote itself (an MCP address of its own, say).
 *
 * Only the gateway holds this machine's identity and synchronizes these envelopes. Core carries metadata only.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519'
import { sha256 } from '@noble/hashes/sha2'
import { hkdf } from '@noble/hashes/hkdf'
import { randomBytes } from '@noble/hashes/utils'
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { b64d, b64e, lvCat, sign, utf8, verify, type Identity } from './core.js'
import { VAULT_CIPHERTEXT_CHARS, VAULT_PLAINTEXT_BYTES } from '../connectors/vaultBounds.js'

const CONTEXT = 'harness-connector-vault-v1'
const WRAP = 'harness-connector-vault-wrap-v1'
const ZERO_NONCE = new Uint8Array(12)
/** The most machines one envelope is sealed for; the backend refuses more. */
export const MAX_RECIPIENTS = 64

export interface VaultEnvelope {
  v: 1
  /** The sender's Ed25519 device key, base64. */
  sender: string
  /** The ephemeral X25519 key every wrap is made with, base64. */
  eph: string
  nonce: string
  ct: string
  /** Recipient device key (base64) → its wrapped content key (base64). */
  keys: Record<string, string>
  sig: string
}

function signed(envelope: Omit<VaultEnvelope, 'sig'>): Uint8Array {
  const keys = Object.keys(envelope.keys).sort().flatMap(pub => [pub, envelope.keys[pub]])
  return sha256(lvCat(CONTEXT, envelope.sender, envelope.eph, envelope.nonce, envelope.ct, ...keys))
}

function wrapKey(shared: Uint8Array, eph: Uint8Array, recipient: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, eph, lvCat(WRAP, recipient), 32)
}

/** Seal [plaintext] from [sender] for [recipients] (base64 Ed25519 device keys); the sender is always one. */
export function sealVault(plaintext: string, sender: Identity, recipients: Iterable<string>): VaultEnvelope {
  if (Buffer.byteLength(plaintext) > VAULT_PLAINTEXT_BYTES) throw new Error('connections exceed the vault limit')
  const senderPub = b64e(sender.pub)
  const to = [...new Set([senderPub, ...recipients])]
  if (to.length > MAX_RECIPIENTS) throw new Error('too many machines to seal for')
  const content = randomBytes(32)
  const nonce = randomBytes(12)
  const ct = chacha20poly1305(content, nonce, utf8(CONTEXT + senderPub)).encrypt(utf8(plaintext))
  const ephPriv = x25519.utils.randomPrivateKey()
  const ephPub = x25519.getPublicKey(ephPriv)
  const keys: Record<string, string> = {}
  for (const pub of to) {
    const edPub = b64d(pub)
    if (edPub.length !== 32) continue
    let shared: Uint8Array
    try { shared = x25519.getSharedSecret(ephPriv, ed25519.utils.toMontgomery(edPub)) } catch { continue }
    keys[pub] = b64e(chacha20poly1305(wrapKey(shared, ephPub, edPub), ZERO_NONCE).encrypt(content))
  }
  const body = { v: 1 as const, sender: senderPub, eph: b64e(ephPub), nonce: b64e(nonce), ct: b64e(ct), keys }
  return { ...body, sig: b64e(sign(sender.priv, signed(body))) }
}

/**
 * Open [envelope] with [me]: null unless it is a well-formed envelope, signed by one of [trusted] (base64
 * device keys), and sealed for [me].
 */
export function openVault(envelope: unknown, me: Identity, trusted: ReadonlySet<string>): string | null {
  const e = envelope as Partial<VaultEnvelope> | null
  if (!e || e.v !== 1 || typeof e.sender !== 'string' || typeof e.eph !== 'string' || typeof e.nonce !== 'string'
    || typeof e.ct !== 'string' || e.ct.length > VAULT_CIPHERTEXT_CHARS || typeof e.sig !== 'string'
    || !e.keys || typeof e.keys !== 'object' || Array.isArray(e.keys) || Object.keys(e.keys).length > MAX_RECIPIENTS) return null
  if (!trusted.has(e.sender)) return null
  const keys = e.keys as Record<string, unknown>
  if (Object.values(keys).some(value => typeof value !== 'string')) return null
  const body = { v: 1 as const, sender: e.sender, eph: e.eph, nonce: e.nonce, ct: e.ct, keys: keys as Record<string, string> }
  try {
    if (!verify(b64d(e.sender), signed(body), b64d(e.sig))) return null
    const mine = b64e(me.pub)
    const wrapped = body.keys[mine]
    if (!wrapped) return null
    const ephPub = b64d(e.eph)
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(me.priv), ephPub)
    const content = chacha20poly1305(wrapKey(shared, ephPub, me.pub), ZERO_NONCE).decrypt(b64d(wrapped))
    const plain = chacha20poly1305(content, b64d(e.nonce), utf8(CONTEXT + e.sender)).decrypt(b64d(e.ct))
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}
