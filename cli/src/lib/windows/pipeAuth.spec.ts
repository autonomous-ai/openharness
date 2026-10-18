import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkPipeAuth, isPipePath, newPipeNonce, newPipePath, NonceWindow, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeAuthValue, pipeIdOf,
  pipeProofValue, pipeProven,
} from './pipeAuth.js'

const token = Buffer.alloc(32, 7)
const hmac = (separator: number, nonce: string) =>
  createHmac('sha256', token).update(Buffer.of(separator)).update(nonce, 'utf8').digest('hex')

describe('pipe auth', () => {
  it('names its headers in lower case, as Node reads them', () => {
    expect([PIPE_AUTH_HEADER, PIPE_PROOF_HEADER]).toEqual(['x-harness-auth', 'x-harness-proof'])
  })

  it('authenticates with an HMAC of the nonce and proves with another', () => {
    const nonce = 'ab'.repeat(32)
    expect(pipeAuthValue(token, nonce)).toBe(`${nonce}.${hmac(0x01, nonce)}`)
    expect(pipeProofValue(token, nonce)).toBe(hmac(0x00, nonce))
    expect(pipeProofValue(token, nonce)).not.toBe(pipeAuthValue(token, nonce).split('.')[1])
  })

  it('refuses a proof offered as an auth: what the daemon answers opens nothing', () => {
    const id = 'a'.repeat(32)
    const nonce = newPipeNonce(`harness-${id}`)
    const seen = new NonceWindow()
    expect(checkPipeAuth(token, `${nonce}.${pipeProofValue(token, nonce)}`, seen, id)).toBeNull()
    expect(seen.size).toBe(0)
  })

  it('binds a nonce only to a whole pipe id: an empty, partial or malformed one refuses every auth', () => {
    const id = 'b'.repeat(32)
    const nonce = newPipeNonce(`harness-${id}`)
    const header = pipeAuthValue(token, nonce)
    const seen = new NonceWindow()
    for (const pipeId of ['', 'b', 'b'.repeat(31), 'b'.repeat(33), 'B'.repeat(32), `${'b'.repeat(31)}g`, nonce]) {
      expect(checkPipeAuth(token, header, seen, pipeId)).toBeNull()
    }
    expect(seen.size).toBe(0)
    expect(checkPipeAuth(token, header, seen, id)).toEqual({ nonce })
  })

  it('accepts an auth once, and only for the pipe whose id starts its nonce', () => {
    const id = 'c'.repeat(32)
    const nonce = newPipeNonce(`\\\\.\\pipe\\harness-${id}`)
    expect(nonce).toMatch(/^c{32}[0-9a-f]{32}$/)
    const seen = new NonceWindow()
    expect(checkPipeAuth(token, pipeAuthValue(token, nonce), seen, id)).toEqual({ nonce })
    expect(checkPipeAuth(token, pipeAuthValue(token, nonce), seen, id)).toBeNull()
    const other = newPipeNonce(`\\\\.\\pipe\\harness-${'d'.repeat(32)}`)
    expect(checkPipeAuth(token, pipeAuthValue(token, other), seen, id)).toBeNull()
    // No pipe named: any well-formed nonce.
    expect(checkPipeAuth(token, pipeAuthValue(token, other), seen)).toEqual({ nonce: other })
  })

  it('refuses a wrong token, a malformed header and none at all, and remembers none of them', () => {
    const seen = new NonceWindow()
    const nonce = newPipeNonce(`harness-${'e'.repeat(32)}`)
    const good = pipeAuthValue(token, nonce)
    for (const header of [undefined, '', 'x', nonce, `${nonce}.`, `${nonce}.${'0'.repeat(64)}`,
      pipeAuthValue(Buffer.alloc(32, 8), nonce), good.toUpperCase(), `${good} `, `${good}.00`]) {
      expect(checkPipeAuth(token, header, seen)).toBeNull()
    }
    expect(seen.size).toBe(0)
    expect(checkPipeAuth(token, good, seen)).toEqual({ nonce })
  })

  it('remembers a bounded number of nonces and forgets the oldest first', () => {
    const seen = new NonceWindow(2)
    expect(seen.admit('a')).toBe(true)
    expect(seen.admit('b')).toBe(true)
    expect(seen.admit('a')).toBe(false)
    expect(seen.admit('c')).toBe(true)
    expect(seen.size).toBe(2)
    expect(seen.admit('a')).toBe(true)
  })

  it('needs room for at least one nonce, counted whole', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new NonceWindow(capacity)).toThrow(/capacity/)
    }
    const one = new NonceWindow(1)
    expect(one.admit('a')).toBe(true)
    expect(one.admit('a')).toBe(false)
    expect(one.admit('b')).toBe(true)
    expect(one.size).toBe(1)
  })

  it('takes a proof from an answer\'s headers only when it is this token\'s for this nonce', () => {
    const nonce = newPipeNonce(`harness-${'f'.repeat(32)}`)
    expect(pipeProven({ [PIPE_PROOF_HEADER]: pipeProofValue(token, nonce) }, token, nonce)).toBe(true)
    for (const headers of [{}, { [PIPE_PROOF_HEADER]: pipeProofValue(Buffer.alloc(32, 9), nonce) },
      { [PIPE_PROOF_HEADER]: pipeAuthValue(token, nonce).split('.')[1] }, { [PIPE_PROOF_HEADER]: 'zz' }]) {
      expect(pipeProven(headers, token, nonce)).toBe(false)
    }
  })

  it('names a new pipe with 128 random bits each time, and reads its id back', () => {
    const a = newPipePath(), b = newPipePath()
    expect(a).toMatch(/^\\\\\.\\pipe\\harness-[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
    expect(pipeIdOf(a)).toBe(a.slice(-32))
    // A Unix socket with a pipe's name stands in for one in the tests.
    expect(pipeIdOf(`/tmp/x/harness-${'0'.repeat(32)}`)).toBe('0'.repeat(32))
    expect(pipeIdOf('\\\\.\\pipe\\other')).toBeNull()
    // The name must be harness-<id> itself, not one that ends with it.
    for (const name of [`\\\\.\\pipe\\evilharness-${'0'.repeat(32)}`, `/tmp/x/evilharness-${'0'.repeat(32)}`, `xharness-${'0'.repeat(32)}`]) {
      expect(pipeIdOf(name)).toBeNull()
      expect(() => newPipeNonce(name)).toThrow(/not a Harness pipe/)
    }
    expect(pipeIdOf(`harness-${'0'.repeat(32)}`)).toBe('0'.repeat(32))
    expect(() => newPipeNonce('/tmp/daemon.sock')).toThrow(/not a Harness pipe/)
  })

  it('takes as a Windows pipe only a local harness-<id> pipe, and off Windows a stand-in socket with that name', () => {
    const id = 'a'.repeat(32)
    expect(isPipePath(`\\\\.\\pipe\\harness-${id}`, 'win32')).toBe(true)
    expect(isPipePath(newPipePath(), 'win32')).toBe(true)
    // A file, another computer's pipe (dialling it is an SMB connection), or a name that only ends with harness-<id>.
    for (const path of [`C:\\x\\harness-${id}`, `\\\\host\\pipe\\harness-${id}`, `\\\\.\\pipe\\evilharness-${id}`,
      `\\\\.\\pipe\\x\\harness-${id}`, `//./pipe/harness-${id}`, `\\\\?\\pipe\\harness-${id}`, `\\\\.\\pipe\\harness-${id.toUpperCase()}`,
      `\\\\.\\pipe\\harness-${id}\n`, `/tmp/x/harness-${id}`]) {
      expect(isPipePath(path, 'win32')).toBe(false)
    }
    expect(isPipePath(`/tmp/x/harness-${id}`, 'darwin')).toBe(true)
    expect(isPipePath(`/tmp/x/evilharness-${id}`, 'linux')).toBe(false)
    expect(isPipePath('/tmp/daemon.sock', 'linux')).toBe(false)
  })
})

interface PipeAuthVector { token: string; pipe: string; pipeId: string; nonceTail: string; nonce: string; auth: string; proof: string }

// The fixture the desktop app's half is held to as well (desktop/test/windows_pipe_auth_test.dart reads this file).
// Regenerate it with `npx tsx scripts/gen-pipe-auth-vectors.ts` after a deliberate change to the credential.
describe('the shared pipe auth vectors', () => {
  const { vectors } = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'pipe-auth-vectors.json'), 'utf8')) as { vectors: PipeAuthVector[] }

  it('has vectors to check', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(3)
  })

  it.each(vectors)('$pipeId: the auth and the proof are this code\'s, and the daemon admits the auth once', (vector) => {
    const token = Buffer.from(vector.token, 'hex')
    expect(token.length).toBe(32)
    expect(isPipePath(vector.pipe, 'win32')).toBe(true)
    expect(pipeIdOf(vector.pipe)).toBe(vector.pipeId)
    expect(vector.nonce).toBe(vector.pipeId + vector.nonceTail)
    expect(pipeAuthValue(token, vector.nonce)).toBe(vector.auth)
    expect(pipeProofValue(token, vector.nonce)).toBe(vector.proof)
    expect(pipeProven({ [PIPE_PROOF_HEADER]: vector.proof }, token, vector.nonce)).toBe(true)
    const seen = new NonceWindow()
    expect(checkPipeAuth(token, vector.auth, seen, vector.pipeId)).toEqual({ nonce: vector.nonce })
    expect(checkPipeAuth(token, vector.auth, seen, vector.pipeId)).toBeNull()
  })
})
