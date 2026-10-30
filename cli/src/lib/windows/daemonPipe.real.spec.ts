// The daemon's pipe on a real Windows named pipe: its API and local WS, each request proving the token, found by
// the record the core writes. Credentials that are links are refused. Windows only; the Windows workflow runs it with
// src/lib/windows, and on the VM:
//   cli/scripts/windows-pty-e2e/vm-sync.sh --cli
//   ssh admin@192.168.65.3 "cd /d C:\work\oh\cli && npx vitest run src/lib/windows --maxWorkers=1"
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { attachLocalWsServer, type LocalWsBackend, type LocalWsServer } from '../../localWsServer.js'
import { localDaemonCall, localDaemonStatus, saveDaemonPort } from '../daemonEndpoint.js'
import { hookCredentialPath, readHookCredential } from '../hookAuth.js'
import { listenLocalSocket } from '../localSocket.js'
import { daemonPipe } from './daemonPipe.js'
import { daemonTokenPath, ensureDaemonToken, newPipeNonce, newPipePath, PIPE_AUTH_HEADER, pipeAuthValue, pipeProven, readDaemonToken } from './pipeAuth.js'
import { pipeRequest } from './pipeClient.js'

const WINDOWS = process.platform === 'win32'
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function profileDir(): string {
  // %TEMP% is in the profile: the state roots (secureState.ts) take it.
  const dir = mkdtempSync(join(tmpdir(), 'hpipe-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const backend: LocalWsBackend = {
  registerLocalClient: () => true, unregisterLocalClient: async () => {}, handleLocalFrame: () => {}, handleLocalBinary: async () => {},
}

describe.skipIf(!WINDOWS)('the daemon pipe on Windows', () => {
  it('serves the API and the local WS to callers that prove the token, as the core records it', async () => {
    const dir = profileDir()
    const token = ensureDaemonToken(dir)
    expect(readDaemonToken(dir)!.equals(token)).toBe(true)
    const pipePath = newPipePath()
    const pipe = await listenLocalSocket((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ pid: process.pid })) }, pipePath, { token })
    const tcp = http.createServer((_req, res) => res.end())
    await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
    const local: LocalWsServer = attachLocalWsServer(tcp, { machineId: 'machine-1', backend, localSocketServer: pipe.server })
    cleanup.push(pipe.close, () => new Promise<void>((resolve) => tcp.close(() => resolve())), local.close)
    saveDaemonPort(dir, 19418, 24567, { pipe: pipePath, pid: process.pid })

    // The real liveness: this pid, and the process table when harness-pty is there (HARNESS_PTY_BIN in the workflow).
    const target = await daemonPipe(dir, 19418)
    expect(target?.pipe).toBe(pipePath)
    expect(await localDaemonStatus(dir, 19418)).toEqual({ pid: process.pid })
    const viaPipe = await localDaemonCall(dir, 19418, 'GET', '/api/status', undefined,
      { tcpPort: 1, fetch: (async () => { throw new Error('TCP was used') }) as typeof fetch })
    expect(await viaPipe.json()).toEqual({ pid: process.pid })
    expect((await pipeRequest(target!, { method: 'GET', path: '/x' })).status).toBe(200)

    const nonce = newPipeNonce(pipePath)
    const ws = new WebSocket('ws://localhost/api/local-ws', { createConnection: () => net.connect(pipePath), headers: { [PIPE_AUTH_HEADER]: pipeAuthValue(token, nonce) } })
    const upgraded = await new Promise<http.IncomingMessage>((resolve, reject) => { ws.once('upgrade', resolve); ws.once('error', reject) })
    expect(pipeProven(upgraded.headers, token, nonce)).toBe(true)
    ws.close()
    const stranger = new WebSocket('ws://localhost/api/local-ws', { createConnection: () => net.connect(pipePath) })
    await expect(new Promise((resolve, reject) => { stranger.once('open', resolve); stranger.once('error', reject) })).rejects.toThrow()
  })

  it('refuses a second listener on a pipe name that is in use', async () => {
    const pipePath = newPipePath()
    const first = await listenLocalSocket((_req, res) => res.end(), pipePath, { token: Buffer.alloc(32, 1) })
    cleanup.push(first.close)
    await expect(listenLocalSocket((_req, res) => res.end(), pipePath, { token: Buffer.alloc(32, 2) })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('refuses a hook credential or a token that is a link', (context) => {
    const dir = profileDir(), elsewhere = profileDir()
    writeFileSync(join(elsewhere, 'target'), `${'A'.repeat(43)}\n`)
    try {
      symlinkSync(join(elsewhere, 'target'), hookCredentialPath(dir), 'file')
      symlinkSync(join(elsewhere, 'target'), daemonTokenPath(dir), 'file')
    } catch (error) {
      // A file link needs Developer Mode or an elevated token; GitHub's runners have one.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip()
      throw error
    }
    expect(readHookCredential(dir)).toBeNull()
    expect(readDaemonToken(dir)).toBeNull()
  })
})
