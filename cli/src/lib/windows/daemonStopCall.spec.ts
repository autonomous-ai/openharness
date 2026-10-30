import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenLocalSocket } from '../localSocket.js'
import { newPipePath } from './pipeAuth.js'
import { pipeRequest, PipeUnproven, type PipeReply, type PipeTarget } from './pipeClient.js'
import { askDaemonToStop, DAEMON_STOP_PATH, STOP_CALL_TIMEOUT_MS } from './daemonStopCall.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A real pipe on Windows; elsewhere a Unix socket with a pipe's name (as in pipeClient.spec.ts). */
function endpoint(): string {
  if (process.platform === 'win32') return newPipePath()
  const dir = mkdtempSync('/tmp/hstop-')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, `harness-${randomBytes(16).toString('hex')}`)
}

const target: PipeTarget = { pipe: `\\\\.\\pipe\\harness-${'a'.repeat(32)}`, token: Buffer.alloc(32, 7) }
const reply = (status: number): PipeReply => ({ status, headers: {}, body: '{}' })

describe('harness stop over the pipe', () => {
  it('posts the stop as a local control call to the pipe daemonPipe found, and takes 202 as yes', async () => {
    const request = vi.fn(async () => reply(202))
    await expect(askDaemonToStop({ pipe: async () => target, request })).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(target, {
      method: 'POST', path: DAEMON_STOP_PATH, headers: { 'x-adapter-local': '1' }, timeoutMs: STOP_CALL_TIMEOUT_MS, maxBytes: 4_096,
    })
    await expect(askDaemonToStop({ pipe: async () => target, request: async () => reply(403) })).resolves.toBe(false)
  })

  it('asks nothing without a pipe, and takes no for an unproven answer, nothing listening, or a timeout', async () => {
    const request = vi.fn(async () => reply(202))
    await expect(askDaemonToStop({ pipe: async () => null, request })).resolves.toBe(false)
    await expect(askDaemonToStop({ pipe: async () => { throw new Error('unreadable record') }, request })).resolves.toBe(false)
    expect(request).not.toHaveBeenCalled()
    for (const error of [new PipeUnproven(target.pipe), Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }), new Error('The operation was aborted due to timeout')]) {
      await expect(askDaemonToStop({ pipe: async () => target, request: async () => { throw error } })).resolves.toBe(false)
    }
  })

  it('is taken only by the daemon that holds the token, on a real listener', async () => {
    const pipe = endpoint(), token = randomBytes(32)
    const asked: string[] = []
    const server = await listenLocalSocket((req, res) => {
      asked.push(`${req.method} ${req.url} ${req.headers['x-adapter-local']}`)
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }, pipe, { token })
    cleanup.push(server.close)
    await expect(askDaemonToStop({ pipe: async () => ({ pipe, token }), request: pipeRequest })).resolves.toBe(true)
    expect(asked).toEqual([`POST ${DAEMON_STOP_PATH} 1`])
    // Another token: the daemon answers 401 without the proof, and the handler never runs.
    await expect(askDaemonToStop({ pipe: async () => ({ pipe, token: randomBytes(32) }), request: pipeRequest })).resolves.toBe(false)
    expect(asked).toHaveLength(1)
  })
})
