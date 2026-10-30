// The daemon's pipe as its clients find and call it (daemonPipe.ts, daemonEndpoint.ts `localDaemonStatus` and
// `localDaemonCall`). On Windows these are real pipes (\\.\pipe\harness-<id>), and the Windows workflow runs this
// file with src/lib/windows; elsewhere Unix sockets named alike.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localDaemonCall, localDaemonStatus, saveDaemonPort } from '../daemonEndpoint.js'
import { listenLocalSocket } from '../localSocket.js'
import { daemonPipe } from './daemonPipe.js'
import { ensureDaemonToken, newPipePath } from './pipeAuth.js'
import { PipeUnproven } from './pipeClient.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** A data folder for the token: /tmp's short path where sockets need one, the temp folder (in the profile) on Windows. */
function pipeDir(): string {
  const dir = mkdtempSync(process.platform === 'win32' ? join(tmpdir(), 'hpipe-') : '/tmp/hn-owner-')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A pipe name nothing has taken: a real one on Windows, a socket in [dir] elsewhere. */
function pipeName(dir: string): string {
  return process.platform === 'win32' ? newPipePath() : join(dir, `harness-${randomBytes(16).toString('hex')}`)
}

describe('the daemon over its Windows pipe', () => {
  const alive = { alive: () => true }
  /** A data folder as the Windows core leaves it: a token, a record naming its pipe and pid, and the pipe served. */
  async function windowsDaemon(handler: Parameters<typeof listenLocalSocket>[0], port = 19418) {
    const dir = pipeDir()
    const token = ensureDaemonToken(dir)
    const pipe = pipeName(dir)
    const server = await listenLocalSocket(handler, pipe, { token })
    cleanup.push(server.close)
    saveDaemonPort(dir, port, 24567, { pipe, pid: process.pid })
    return { dir, token, pipe, port }
  }
  const options = { platform: 'win32' as const, pipe: (dir: string, port: number) => daemonPipe(dir, port, alive) }

  it('is found by its record and token, unless its process is proven gone', async () => {
    const { dir, token, pipe, port } = await windowsDaemon((_req, res) => res.end('{}'))
    const found = await daemonPipe(dir, port, alive)
    expect(found?.pipe).toBe(pipe)
    expect(found?.token.equals(token)).toBe(true)
    expect(await daemonPipe(dir, port, { alive: () => false })).toBeNull()
    expect(await daemonPipe(dir, port + 1, alive)).toBeNull()
    saveDaemonPort(dir, port, 24567)
    expect(await daemonPipe(dir, port, alive)).toBeNull()
    expect(await daemonPipe(pipeDir(), port, alive)).toBeNull()
  })

  it('answers status over the pipe, and nothing for an answer without the proof', async () => {
    const { dir, port } = await windowsDaemon((_req, res) => res.end(JSON.stringify({ machineId: 'account-a' })))
    expect(await localDaemonStatus(dir, port, options)).toEqual({ machineId: 'account-a' })
    expect(await localDaemonStatus(pipeDir(), port, options)).toBeNull()
    const foreign = await localDaemonStatus(dir, port, { platform: 'win32', pipe: async (d, p) => ({ ...(await daemonPipe(d, p, alive))!, token: randomBytes(32) }) })
    expect(foreign).toBeNull()
  })

  it('makes control calls over the pipe, falls back to TCP only where nothing is there, and never after an unproven answer', async () => {
    let got = ''
    const { dir, port, pipe } = await windowsDaemon((req, res) => {
      got = `${req.method} ${req.url} ${req.headers['x-adapter-local']}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const tcp = vi.fn(async () => new Response('{"tcp":true}', { status: 200 }))
    const call = (o: Partial<Parameters<typeof localDaemonCall>[5]> = {}) =>
      localDaemonCall(dir, port, 'POST', '/api/pair', { code: '1' }, { ...options, tcpPort: 1, fetch: tcp as typeof fetch, ...o })
    const over = await call()
    expect(await over.json()).toEqual({ ok: true })
    expect(got).toBe('POST /api/pair 1')
    expect(tcp).not.toHaveBeenCalled()
    // No pipe to reach: as on every other OS.
    expect(await (await call({ pipe: async () => null })).json()).toEqual({ tcp: true })
    expect(await (await call({ platform: 'darwin' })).json()).toEqual({ tcp: true })
    // A recorded pipe nothing listens on any more.
    const gone = pipeName(pipeDir())
    expect(await (await call({ pipe: async () => ({ pipe: gone, token: randomBytes(32) }) })).json()).toEqual({ tcp: true })
    expect(tcp).toHaveBeenCalledTimes(3)
    await expect(call({ pipe: async () => ({ pipe, token: randomBytes(32) }) })).rejects.toBeInstanceOf(PipeUnproven)
    expect(tcp).toHaveBeenCalledTimes(3)
  })
})
