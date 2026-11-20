// The extension's copy of the devices pipe's credential, held to the vectors the CLI's and Desktop's halves are held to:
// the CLI's own file, never a copy, so the three cannot drift.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PIPE, TOKEN, pipeAuth, pipeNonce, pipeProven } from './pipeAuth'

interface Vector { token: string; pipe: string; pipeId: string; nonceTail: string; nonce: string; auth: string; proof: string }

const { vectors } = JSON.parse(
  readFileSync(new URL('../../../cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json', import.meta.url), 'utf8')
) as { vectors: Vector[] }

describe('pipeAuth', () => {
  it.each(vectors.map((vector) => [vector.pipeId, vector]))('matches the shared vector of %s', (_id, vector) => {
    expect([PIPE.test(vector.pipe), TOKEN.test(vector.token)]).toEqual([true, true])
    expect(pipeNonce(vector.pipe, () => Buffer.from(vector.nonceTail, 'hex'))).toBe(vector.nonce)
    expect(pipeAuth(vector.token, vector.nonce)).toBe(vector.auth)
    expect(pipeProven(vector.proof, vector.token, vector.nonce)).toBe(true)
  })

  it('a proof with one digit changed, none, or one that is not hex is not proven', () => {
    const [{ token, nonce, proof }] = vectors
    const changed = `${proof.slice(0, -1)}${proof.endsWith('0') ? '1' : '0'}`
    for (const wrong of [changed, undefined, 'zz']) expect([wrong, pipeProven(wrong, token, nonce)]).toEqual([wrong, false])
  })

  it("a nonce is the pipe's id, then 128 random bits: never the same twice", () => {
    const pipe = '\\\\.\\pipe\\harness-0123456789abcdef0123456789abcdef'
    const [first, second] = [pipeNonce(pipe), pipeNonce(pipe)]
    expect(first).toMatch(/^0123456789abcdef0123456789abcdef[0-9a-f]{32}$/)
    // `.not` is not in the types this folder is checked with (vscodeExtensionTypes.spec.ts).
    expect(second === first).toBe(false)
  })
})
