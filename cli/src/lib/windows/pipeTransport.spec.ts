import { randomBytes } from 'node:crypto'
import http, { type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isTrustedLocal, listenLocalSocket, pipeProofOf, type LocalSocketServer } from '../localSocket.js'
import { newPipeNonce, newPipePath, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeAuthValue, pipeProofValue } from './pipeAuth.js'

const dirs: string[] = []
const opened: LocalSocketServer[] = []
afterEach(async () => {
  for (const server of opened.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A real pipe on Windows; elsewhere a Unix socket with a pipe's name, which the auth layer cannot tell apart. */
function endpoint(): string {
  if (process.platform === 'win32') return newPipePath()
  const dir = mkdtempSync('/tmp/hpipe-')
  dirs.push(dir)
  return join(dir, `harness-${randomBytes(16).toString('hex')}`)
}

function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path, path: '/x', headers, agent: false }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

function upgrade(path: string, headers: Record<string, string> = {}): Promise<IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: path, path: '/api/local-ws', agent: false,
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers } })
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.headers) })
    request.on('error', reject)
    request.end()
  })
}

describe('the daemon pipe', () => {
  it('serves a request that proves the token, trusts it, and answers with the proof', async () => {
    const path = endpoint(), token = randomBytes(32)
    let trusted: boolean | null = null
    opened.push(await listenLocalSocket((req, res) => { trusted = isTrustedLocal(req); res.end('hi') }, path, { token }))
    const nonce = newPipeNonce(path)
    const reply = await raw(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) })
    expect(reply).toMatchObject({ status: 200, body: 'hi' })
    expect(reply.headers[PIPE_PROOF_HEADER]).toBe(pipeProofValue(token, nonce))
    expect(trusted).toBe(true)
  })

  it('answers 401 to a request without auth, with another token, for another pipe or with a nonce used before', async () => {
    const path = endpoint(), token = randomBytes(32)
    let served = 0
    opened.push(await listenLocalSocket((_req, res) => { served++; res.end('hi') }, path, { token }))
    const used = newPipeNonce(path)
    expect((await raw(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, used) })).status).toBe(200)
    const refused: Array<Record<string, string>> = [{}, { [PIPE_AUTH_HEADER]: pipeAuthValue(randomBytes(32), newPipeNonce(path)) },
      { [PIPE_AUTH_HEADER]: pipeAuthValue(token, newPipeNonce(endpoint())) },
      { [PIPE_AUTH_HEADER]: pipeAuthValue(token, used) }]
    for (const headers of refused) {
      const reply = await raw(path, headers)
      expect(reply.status).toBe(401)
      expect(JSON.parse(reply.body)).toEqual({ error: 'PIPE_AUTH_REQUIRED' })
      expect(reply.headers[PIPE_PROOF_HEADER]).toBeUndefined()
    }
    expect(served).toBe(1)
  })

  it('drops an upgrade without auth before any other listener, and hands one with it on, trusted', async () => {
    const path = endpoint(), token = randomBytes(32)
    const pipe = await listenLocalSocket((_req, res) => res.end(), path, { token })
    opened.push(pipe)
    // Nothing else takes upgrades yet: even an authenticated one is closed, never left hanging.
    await expect(upgrade(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, newPipeNonce(path)) })).rejects.toThrow()
    const seen: Array<{ trusted: boolean; destroyed: boolean }> = []
    pipe.server.on('upgrade', (req: http.IncomingMessage, socket) => {
      seen.push({ trusted: isTrustedLocal(req), destroyed: socket.destroyed })
      if (!socket.destroyed) socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${PIPE_PROOF_HEADER}: ${pipeProofOf(req)}\r\n\r\n`)
    })
    await expect(upgrade(path)).rejects.toThrow()
    const nonce = newPipeNonce(path)
    expect((await upgrade(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) }))[PIPE_PROOF_HEADER]).toBe(pipeProofValue(token, nonce))
    expect(seen).toEqual([{ trusted: false, destroyed: true }, { trusted: true, destroyed: false }])
  })

  it('refuses to listen on a name that is not a Harness pipe', async () => {
    const id = randomBytes(16).toString('hex')
    let names = [`\\\\.\\pipe\\daemon`, `\\\\.\\pipe\\evilharness-${id}`]
    if (process.platform !== 'win32') {
      const dir = mkdtempSync('/tmp/hpipe-')
      dirs.push(dir)
      names = [join(dir, 'daemon.sock'), join(dir, `evilharness-${id}`)]
    }
    for (const name of names) {
      await expect(listenLocalSocket((_req, res) => res.end(), name, { token: randomBytes(32) })).rejects.toThrow(/not a Harness pipe name/)
    }
  })

  it('rejects a call without a token on a Harness pipe name, and a token shorter than 32 bytes', async () => {
    await expect(listenLocalSocket((_req, res) => res.end(), endpoint())).rejects.toThrow(/token/)
    await expect(listenLocalSocket((_req, res) => res.end(), endpoint(), { token: randomBytes(31) })).rejects.toThrow(/32 bytes/)
  })

  it('keeps the proof when the handler writes its own head', async () => {
    const path = endpoint(), token = randomBytes(32)
    opened.push(await listenLocalSocket((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') }, path, { token }))
    const nonce = newPipeNonce(path)
    const reply = await raw(path, { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) })
    expect(reply.status).toBe(200)
    expect(reply.headers[PIPE_PROOF_HEADER]).toBe(pipeProofValue(token, nonce))
  })

  it('over one kept-alive connection, serves an authenticated request and refuses the next without auth', async () => {
    const path = endpoint(), token = randomBytes(32)
    let served = 0
    opened.push(await listenLocalSocket((_req, res) => { served++; res.end('hi') }, path, { token }))
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const get = (headers: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
      const request = http.request({ socketPath: path, path: '/x', headers, agent }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      })
      request.on('error', reject)
      request.end()
    })
    try {
      expect(await get({ [PIPE_AUTH_HEADER]: pipeAuthValue(token, newPipeNonce(path)) })).toBe(200)
      expect(await get({})).toBe(401)
      expect(served).toBe(1)
    } finally {
      agent.destroy()
    }
  })
})
