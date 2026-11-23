// The devices pipe's credential (cli/src/lib/windows/pipeAuth.ts), in a copy of the extension's own: it is bundled
// alone and imports nothing of the CLI. Reaching a pipe's name proves nothing on Windows (any account can open it, or take
// it once the devices are gone), so each request proves the token and each answer proves it back; the token never
// travels. Held to the CLI's vectors (pipe-auth-vectors.json). VS Code 1.75's Node 16: nothing newer is used.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** A pipe on this computer named harness-<id>: not a file, and not `\\host\pipe\…`, a connection to another computer. */
export const PIPE = /^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/
/** The devices' token as link prints it. A proof has the same shape. */
export const TOKEN = /^[0-9a-f]{64}$/
export const AUTH_HEADER = 'x-harness-auth'
export const PROOF_HEADER = 'x-harness-proof'

// The id that ends the name: a pipe's, or in the tests on macOS and Linux the Unix socket's that stands in for one.
const PIPE_ID = /(?:^|[\\/])harness-([0-9a-f]{32})$/

/** A nonce for one request: the pipe's id, so an auth taken by whatever held a dead pipe's name opens no other, then 128
 *  random bits. */
export function pipeNonce(pipe: string, random: (bytes: number) => Buffer = randomBytes): string {
  const id = PIPE_ID.exec(pipe)?.[1]
  if (id === undefined) throw new Error('not a Harness pipe')
  return id + random(16).toString('hex')
}

/** The request's `x-harness-auth`. */
export function pipeAuth(token: string, nonce: string): string {
  return `${nonce}.${mac(token, 0x01, nonce)}`
}

/** Whether an answer's `x-harness-proof` is the token's for that nonce: only the devices, who hold it, can give it. */
export function pipeProven(proof: unknown, token: string, nonce: string): boolean {
  return typeof proof === 'string' && TOKEN.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(mac(token, 0x00, nonce), 'hex'))
}

function mac(token: string, separator: number, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')
}
