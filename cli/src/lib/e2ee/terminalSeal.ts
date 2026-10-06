/**
 * Sealing and opening the terminal's binary frames, with a session's key: the gateway's half of
 * lib/terminalBinary.ts, which frames them. Apart from it so that the core, which frames bytes for the
 * windows on this computer, loads no cipher (docs/design/2026-10-06-core-boundary-next.md, step 10).
 */
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { aeadOpen, aeadSeal, utf8 } from './core.js'
import {
  decodeTerminalPlain,
  encodeTerminalPlain,
  flagsFor,
  MAGIC,
  maxCiphertextBytesFor,
  parseTerminalBinaryEnvelope,
  TERMINAL_BINARY_HEADER_BYTES,
  TERMINAL_BINARY_VERSION,
  type TerminalBinaryClear,
} from '../terminalBinary.js'

const TERMINAL_KEY_INFO = utf8('harness-terminal-binary-v3')

/** Keep binary terminal nonces independent from JSON control-frame nonces. */
export function deriveTerminalBinaryKey(sessionKey: Uint8Array): Uint8Array {
  return hkdf(sha256, sessionKey, new Uint8Array(), TERMINAL_KEY_INFO, 32)
}

export function sealTerminalBinary(key: Uint8Array, counter: number, frame: TerminalBinaryClear): Uint8Array | null {
  if (!Number.isSafeInteger(counter) || counter < 0) return null
  const plaintext = encodeTerminalPlain(frame)
  if (!plaintext) return null
  const flags = flagsFor(frame)
  const header = new Uint8Array(TERMINAL_BINARY_HEADER_BYTES)
  header.set(MAGIC, 0)
  header[4] = TERMINAL_BINARY_VERSION
  header[5] = frame.kind
  header[6] = flags
  const view = new DataView(header.buffer)
  view.setBigUint64(8, BigInt(counter), false)
  const ciphertext = aeadSeal(key, counter, header.subarray(0, 16), plaintext)
  if (ciphertext.length > maxCiphertextBytesFor(frame.kind)) return null
  view.setUint32(16, ciphertext.length, false)
  const out = new Uint8Array(header.length + ciphertext.length)
  out.set(header)
  out.set(ciphertext, header.length)
  return out
}

export function openTerminalBinary(key: Uint8Array, raw: Uint8Array): { counter: number; frame: TerminalBinaryClear } | null {
  const envelope = parseTerminalBinaryEnvelope(raw)
  if (!envelope) return null
  const plaintext = aeadOpen(key, envelope.counter, envelope.aad, envelope.ciphertext)
  if (!plaintext) return null
  const frame = decodeTerminalPlain(envelope.kind, envelope.flags, plaintext)
  return frame ? { counter: envelope.counter, frame } : null
}

