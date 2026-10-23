/**
 * A stand-in daemon on the daemon's own pipe code, for the desktop app's real-pipe test
 * (desktop/integration_test/windows_pipe_test.dart). Built from the daemon's pieces, as daemonPipe.real.spec.ts is:
 * lib/localSocket.ts's authenticated pipe, localWsServer.ts's local WebSocket on it, and the token and record the
 * core writes (pipeAuth.ts `ensureDaemonToken`, daemonEndpoint.ts `saveDaemonPort`). Beside it, a squatter: a plain
 * HTTP server on another harness-<id> pipe that answers everything, its 101 included, with a proof that is not the
 * token's — whatever took a dead daemon's name.
 *
 * On Windows both are named pipes. Elsewhere they are Unix sockets named like one in the data folder, as the CLI's
 * own tests stand a pipe in, so the script can be tried on a Mac.
 *
 * Run from cli/: node --import tsx scripts/windows-pipe-test-server.ts <throwaway data folder> <port>
 * It prints one JSON line once everything listens — { pipe, squatter, tcpPort, machineId } — and stops when its stdin
 * closes. It refuses port 18473: the real daemon's.
 */
import { randomBytes, randomInt } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { attachLocalWsServer, type LocalWsBackend } from '../src/localWsServer.js'
import { saveDaemonPort } from '../src/lib/daemonEndpoint.js'
import { listenLocalSocket } from '../src/lib/localSocket.js'
import { ensureDaemonToken, newPipePath, PIPE_PROOF_HEADER } from '../src/lib/windows/pipeAuth.js'

const [dataDir, portText] = process.argv.slice(2)
const port = Number(portText)
if (!dataDir || !Number.isInteger(port) || port < 28000 || port > 28999 || process.env.ADAPTER_DATA_DIR !== dataDir) {
  console.error('usage: windows-pipe-test-server.ts <throwaway data folder> <port 28000-28999> (ADAPTER_DATA_DIR must name the throwaway folder)')
  process.exit(2)
}

const machineId = 'pipe-test-machine'
const pipeName = (): string => process.platform === 'win32' ? newPipePath() : join(dataDir, `harness-${randomBytes(16).toString('hex')}`)
const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const token = ensureDaemonToken(dataDir)
const pipePath = pipeName()
const pipe = await listenLocalSocket((req, res) => {
  const route = `${req.method} ${(req.url ?? '').split('?')[0]}`
  if (route === 'POST /api/auth/handoff') json(res, 200, { success: true, data: { code: 'hnh_pipe_test', expiresIn: 90 } })
  else if (route === 'GET /api/status') json(res, 200, { pid: process.pid })
  else json(res, 404, { error: 'NOT_FOUND' })
}, pipePath, { token })

// The loopback port, with the same local WebSocket: the app's fallback.
const backend: LocalWsBackend = { registerLocalClient: () => true, unregisterLocalClient: async () => {}, handleLocalFrame: () => {}, handleLocalBinary: async () => {} }
const tcp = http.createServer((_req, res) => json(res, 404, { error: 'NOT_FOUND' }))
// Use a different, disposable recorded port, exercising the desktop's saved-port route too.
for (let attempt = 0; ; attempt++) {
  const candidate = 28000 + (port - 28000 + 1 + randomInt(999)) % 1000
  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject)
      tcp.listen(candidate, '127.0.0.1', () => { tcp.off('error', reject); resolve() })
    })
    break
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 19) throw error
  }
}
const local = attachLocalWsServer(tcp, { machineId, backend, localSocketServer: pipe.server })
const tcpPort = (tcp.address() as AddressInfo).port
saveDaemonPort(dataDir, port, tcpPort, { pipe: pipePath, pid: process.pid })

const wrongProof = '0'.repeat(64)
const squatterPath = pipeName()
const squatter = http.createServer((_req, res) => {
  res.setHeader(PIPE_PROOF_HEADER, wrongProof)
  json(res, 200, { success: true, data: { code: 'squatted', expiresIn: 90 } })
})
const squatterWs = new WebSocketServer({ noServer: true })
squatterWs.on('headers', (headers) => headers.push(`${PIPE_PROOF_HEADER}: ${wrongProof}`))
squatter.on('upgrade', (req, socket, head) => squatterWs.handleUpgrade(req, socket, head, (ws) => {
  ws.send(JSON.stringify({ type: 'connected', payload: { machineId } }))
}))
await new Promise<void>((resolve) => squatter.listen(squatterPath, resolve))

console.log(JSON.stringify({ pipe: pipePath, squatter: squatterPath, tcpPort, machineId }))

process.stdin.resume()
process.stdin.on('end', () => {
  for (const ws of squatterWs.clients) ws.terminate()
  squatterWs.close()
  squatter.close()
  local.close()
  tcp.close()
  void pipe.close().then(() => process.exit(0))
})
