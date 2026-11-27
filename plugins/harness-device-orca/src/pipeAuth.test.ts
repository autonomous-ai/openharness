// The pipe's auth against the vectors the CLI's own pipeAuth.spec.ts reads, so every copy agrees byte for byte.
import { assert, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import { PIPE, pipeAuth, pipeNonce, pipeProven, TOKEN } from './pipeAuth'

type Vector = { token: string; pipe: string; pipeId: string; nonceTail: string; nonce: string; auth: string; proof: string }
const VECTORS = new URL('../../../cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json', import.meta.url)
const { vectors } = JSON.parse(readFileSync(VECTORS, 'utf8')) as { vectors: Vector[] }

test('each shared vector: its nonce, its auth and its proof', () => {
  assert.ok(vectors.length > 0)
  for (const v of vectors) {
    assert.equal(pipeNonce(v.pipe, () => Buffer.from(v.nonceTail, 'hex')), v.nonce)
    assert.equal(pipeAuth(v.token, v.nonce), v.auth)
    assert.equal(pipeProven(v.proof, v.token, v.nonce), true)
  }
})

test("a proof with one digit changed, none, one that is no hex, and the auth's own HMAC are not proven", () => {
  for (const v of vectors) {
    const changed = `${v.proof[0] === '0' ? '1' : '0'}${v.proof.slice(1)}`
    const authMac = v.auth.slice(v.auth.indexOf('.') + 1)
    for (const proof of [changed, undefined, 'zz', authMac]) assert.equal(pipeProven(proof, v.token, v.nonce), false, String(proof))
  }
})

test('a nonce is the pipe id, then 128 random bits: a new one each time', () => {
  const v = vectors[0]
  const one = pipeNonce(v.pipe)
  assert.match(one, new RegExp(`^${v.pipeId}[0-9a-f]{32}$`))
  assert.notEqual(pipeNonce(v.pipe), one)
})

test("a Unix socket named harness-<id>, as the tests serve, gives its id; any other name has no nonce", () => {
  const v = vectors[0]
  assert.equal(pipeNonce(`/tmp/hdo-x/harness-${v.pipeId}`, () => Buffer.from(v.nonceTail, 'hex')), v.nonce)
  for (const name of ['\\\\.\\pipe\\other', `\\\\.\\pipe\\harness-${v.pipeId}0`, '/tmp/devices.sock']) assert.throws(() => pipeNonce(name), /is not a Harness pipe/)
})

test('PIPE takes only a pipe on this computer named harness-<32 hex>, TOKEN only 64 lowercase hex digits', () => {
  const v = vectors[0]
  assert.ok(PIPE.test(v.pipe))
  for (const pipe of [`\\\\srv\\pipe\\harness-${v.pipeId}`, `/tmp/harness-${v.pipeId}`, `${v.pipe}0`, v.pipe.toUpperCase()]) assert.equal(PIPE.test(pipe), false, pipe)
  assert.ok(TOKEN.test(v.token))
  for (const token of [v.token.slice(1), `${v.token}0`, v.token.toUpperCase()]) assert.equal(TOKEN.test(token), false, token)
})
