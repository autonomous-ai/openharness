/**
 * Regenerates src/lib/windows/__fixtures__/pipe-auth-vectors.json: the vectors both halves of the Windows pipe's
 * credential are held to. The daemon's half is lib/windows/pipeAuth.ts, checked in pipeAuth.spec.ts; the desktop
 * app's is desktop/lib/ws/windows_pipe_auth.dart, checked in desktop/test/windows_pipe_auth_test.dart, which reads
 * this same file from cli/ rather than a copy, so the two cannot drift. Deterministic: fixed tokens, pipe names and
 * nonce tails. Run from cli/: `npx tsx scripts/gen-pipe-auth-vectors.ts`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeAuthValue, pipeIdOf, pipeProofValue } from '../src/lib/windows/pipeAuth.js'

const pipe = (id: string): string => `\\\\.\\pipe\\harness-${id}`
const cases = [
  { token: Buffer.from(Array.from({ length: 32 }, (_, i) => i)), pipe: pipe('0123456789abcdef'.repeat(2)), nonceTail: 'fedcba9876543210'.repeat(2) },
  { token: Buffer.alloc(32, 0xff), pipe: pipe('a'.repeat(32)), nonceTail: '0'.repeat(32) },
  { token: Buffer.from(`${'5f'.repeat(16)}${'c3'.repeat(16)}`, 'hex'), pipe: pipe('9e107d9d372bb6826bd81d3542a419d6'), nonceTail: 'e4d909c290d0fb1ca068ffaddf22cbd0' },
]

const vectors = cases.map(({ token, pipe, nonceTail }) => {
  const pipeId = pipeIdOf(pipe)
  if (!pipeId) throw new Error(`${pipe} is not a Harness pipe`)
  const nonce = pipeId + nonceTail
  return { token: token.toString('hex'), pipe, pipeId, nonceTail, nonce, auth: pipeAuthValue(token, nonce), proof: pipeProofValue(token, nonce) }
})

writeFileSync(join(import.meta.dirname, '../src/lib/windows/__fixtures__/pipe-auth-vectors.json'), `${JSON.stringify({ vectors }, null, 2)}\n`)
