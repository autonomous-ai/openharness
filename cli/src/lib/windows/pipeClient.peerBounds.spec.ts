import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { listenLocalSocket, pipeProofOf } from '../localSocket.js'
import { PIPE_PROOF_HEADER } from './pipeAuth.js'
import { pipeWebSocket } from './pipeClient.js'

it('applies a component receive limit before delivering an authenticated oversized frame', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'peer-'))
  const pipe = join(folder, `harness-${randomBytes(16).toString('hex')}`)
  const token = randomBytes(32)
  const listener = await listenLocalSocket((_req, res) => { res.writeHead(404).end() }, pipe, { token })
  const server = new WebSocketServer({ noServer: true })
  server.on('headers', (headers, req) => { headers.push(`${PIPE_PROOF_HEADER}: ${pipeProofOf(req)}`) })
  listener.server.on('upgrade', (req, socket, head) => {
    if (!socket.destroyed) server.handleUpgrade(req, socket, head, ws => { ws.send('x'.repeat(256)) })
  })
  const socket = pipeWebSocket({ pipe, token }, '/device-peer/v1/devices', { maxPayload: 64 })
  try {
    const seen = await new Promise<string>(resolve => {
      socket.once('message', () => resolve('oversized frame delivered'))
      socket.once('error', error => resolve((error as NodeJS.ErrnoException).code ?? 'error'))
    })
    expect(seen).toBe('WS_ERR_UNSUPPORTED_MESSAGE_LENGTH')
  } finally {
    socket.terminate()
    for (const peer of server.clients) peer.terminate()
    server.close()
    await listener.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
