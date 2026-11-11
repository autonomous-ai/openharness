/**
 * The bridge's pipe on Windows (task #2162, from Reed's review of #2605): MCP clients and Harness's own calls reach the bridge
 * over a pipe whose every request proves a token and whose every answer proves it back, never over the port another account
 * can hold from boot. A Unix socket named `harness-<id>` stands for the pipe here, as in the daemon pipe's specs.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pipeRequest } from '../windows/pipeClient.js'
import { bridgePipeRecord, readBridgePipe } from './agents.js'
import { serveBridgePipe } from './bridge.js'
import { Store, writePrivate } from './store.js'

let home: string, vault: Store
const closers: Array<() => unknown> = []
beforeEach(() => {
  // Short: a socket has to fit.
  home = mkdtempSync(join('/tmp', 'bp-'))
  vault = new Store(join(home, 'c'), { HOME: home })
})
afterEach(async () => { for (const close of closers.splice(0)) await close(); rmSync(home, { recursive: true, force: true }) })

const pipePath = (): string => {
  mkdirSync(join(home, 'p'), { recursive: true })
  return join(home, 'p', `harness-${randomBytes(16).toString('hex')}`)
}

async function upstream(): Promise<{ url: string; heard: string[] }> {
  const heard: string[] = []
  const server: Server = createServer((request, response) => {
    let raw = ''
    request.on('data', part => { raw += part })
    request.on('end', () => {
      heard.push(raw)
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    })
  })
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  closers.push(() => new Promise(done => { server.closeAllConnections(); server.close(done) }))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, heard }
}

const served = async (): Promise<string> => {
  const path = pipePath()
  const listening = await serveBridgePipe(vault, path)
  closers.push(() => listening.close())
  return path
}

describe('the bridge\'s pipe', () => {
  it('refuses a request that does not prove the token: it reaches no connection', async () => {
    const fake = await upstream()
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: fake.url, headers: {} } })
    const path = await served()
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ socketPath: path, method: 'POST', path: '/local/linear/mcp', headers: { 'content-type': 'application/json' } },
        (answer) => { answer.resume(); resolve(answer.statusCode ?? 0) })
      request.on('error', reject)
      request.end('{"jsonrpc":"2.0","id":1,"method":"tools/call"}')
    })
    expect(status).toBe(401)
    expect(fake.heard).toEqual([])
  })

  it('takes a request that proves the token to the connection, and its answer proves the token back', async () => {
    const fake = await upstream()
    vault.save('linear', { access_token: 't', source: 'dcr', mcp_entry: { url: fake.url, headers: {} } })
    await served()
    const target = readBridgePipe(vault)!
    // pipeRequest refuses an answer without the proof: this one is the bridge's.
    const answer = await pipeRequest(target, { method: 'POST', path: '/local/linear/mcp',
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
    expect(answer.status).toBe(200)
    expect(fake.heard).toEqual(['{"jsonrpc":"2.0","id":1,"method":"tools/list"}'])
  })

  it('records the pipe, the process serving it and the token, in the vault\'s private folder', async () => {
    const path = await served()
    const record = vault.file('bridge-pipe.json')
    expect(bridgePipeRecord(vault)).toBe(join(vault.root, 'bridge-pipe.json'))
    expect(record).toEqual({ pipe: path, pid: process.pid, token: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(readBridgePipe(vault)).toEqual({ pipe: path, token: Buffer.from(String(record.token), 'hex') })
  })

  it('a new token each start: what was heard of one opens nothing at the next', async () => {
    await served()
    const first = vault.file('bridge-pipe.json').token
    await served()
    expect(vault.file('bridge-pipe.json').token).not.toBe(first)
  })
})

describe('reading the bridge\'s pipe', () => {
  const write = (record: Record<string, unknown>): void => {
    writePrivate(bridgePipeRecord(vault), { pipe: pipePath(), pid: process.pid, token: 'ab'.repeat(32), ...record })
  }

  it('is nothing with no record', () => {
    expect(readBridgePipe(vault)).toBeNull()
  })

  it('is nothing once the process that served it is gone: any account can make a pipe of its name then', () => {
    const exited = spawnSync(process.execPath, ['-e', '']).pid!
    write({ pid: exited })
    expect(readBridgePipe(vault)).toBeNull()
  })

  it('is nothing when that process id is another account\'s now: one that took it since', () => {
    write({})
    // What process.kill(pid, 0) throws for another account's process.
    expect(readBridgePipe(vault, () => false)).toBeNull()
    expect(readBridgePipe(vault, () => true)).not.toBeNull()
  })

  it('is nothing for a name that is not a Harness pipe, a short token or no pid', () => {
    for (const record of [{ pipe: join(home, 'elsewhere') }, { token: 'ab' }, { token: 'zz'.repeat(32) }, { pid: 0 }, { pid: '1' }]) {
      write(record)
      expect(readBridgePipe(vault), JSON.stringify(record)).toBeNull()
    }
  })

  it('on Windows is only a local pipe: never a file, nor another computer\'s pipe, which would carry this user\'s NTLM sign-in', () => {
    const id = 'a'.repeat(32), runs = () => true
    write({ pipe: `\\\\.\\pipe\\harness-${id}` })
    expect(readBridgePipe(vault, runs, 'win32')).not.toBeNull()
    for (const pipe of [`\\\\host\\pipe\\harness-${id}`, pipePath(), `\\\\.\\pipe\\harness-${id}x`]) {
      write({ pipe })
      expect(readBridgePipe(vault, runs, 'win32'), pipe).toBeNull()
    }
  })
})
