// The devices' pipe on Windows (docs/plans/2026-11-19-dial-windows-design.md, "The devices pipe's API"). Any account
// can create a pipe of a dead process's name, so reaching it proves nothing: each request sends
// `<nonce>.<HMAC-SHA256(token, 0x01 ‖ nonce)>`, and only an answer carrying HMAC-SHA256(token, 0x00 ‖ nonce) is read.
// A copy of cli/src/lib/windows/pipeAuth.ts's, since a plugin imports nothing of the CLI: the vectors that file's tests
// read pin both.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** A pipe on this computer named harness-<32 hex>: never a file, nor `\\host\pipe\…`, a connection to another one. */
export const PIPE = /^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/
/** The devices' token as link prints it, 32 bytes in lowercase hex; a proof is written the same way. */
export const TOKEN = /^[0-9a-f]{64}$/
// The id that ends the pipe's name, or the name of a Unix socket the tests serve in its place.
const PIPE_ID = /(?:^|[\\/])harness-([0-9a-f]{32})$/

function mac(token: string, separator: number, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')
}

/** A nonce for one request: the pipe's id, so an auth taken by whatever squats on the name opens no other pipe, then
 *  128 random bits. */
export function pipeNonce(pipe: string, random: (bytes: number) => Buffer = randomBytes): string {
  const id = PIPE_ID.exec(pipe)?.[1]
  if (!id) throw new Error(`${pipe} is not a Harness pipe`)
  return id + random(16).toString('hex')
}

/** The request's `x-harness-auth` for `nonce`. */
export function pipeAuth(token: string, nonce: string): string {
  return `${nonce}.${mac(token, 0x01, nonce)}`
}

/** Whether an answer's `x-harness-proof` proves the token for `nonce`. */
export function pipeProven(proof: unknown, token: string, nonce: string): boolean {
  return typeof proof === 'string' && TOKEN.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(mac(token, 0x00, nonce), 'hex'))
}
