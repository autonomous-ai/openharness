// A stand-in for the Harness daemon, for driving harness-tui with nothing real behind it: fake
// machines, fake harnesses, and terminals that echo what is typed. Fuzzing and end-to-end checks run
// against this — never against a daemon whose agents are somebody's real work.
//
//   node tui/tests/mock-daemon.mjs 18999 &
//   PORT=18999 HARNESS_TUI_DESK=off tui/target/release/harness-tui
//
// Needs the `ws` package (cli/node_modules has it). Speaks just enough of local-ws + terminal
// protocol v3 (cli/src/lib/terminalStreamManager.ts, terminalBinary.ts) for the TUI.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '../../cli/package.json'))
const { WebSocketServer } = require('ws')

const port = Number(process.argv[2] || 18999)
const LOCAL = 'mock0000000000000000000000000001'
const REMOTE = 'mock0000000000000000000000000002'
const now = new Date().toISOString()
const agent = (id, name, engine, status = 'active') => ({
  id, sessionId: `s-${id}`, name, title: null, status, launch: { state: 'ready' }, createdAt: now, updatedAt: now,
  engine, selectedModel: `runtime-v1:${id}:${engine}:default@auto`, terminal: { available: status === 'active' },
  project: { name: 'demo', cwd: '/home/demo/demo', root: '/home/demo/demo', branch: 'main' },
})
const agents = {
  [LOCAL]: [agent(randomUUID(), 'Mock Claude', 'claude'), agent(randomUUID(), 'Mock Codex', 'codex'), agent(randomUUID(), 'Mock paused', 'claude', 'stopped')],
  [REMOTE]: [agent(randomUUID(), 'Remote shell', 'terminal')],
}
const desk = { revision: 1, tabs: [] }

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: body })) }
const server = http.createServer((req, res) => {
  if (req.url === '/api/status') return json(res, { machineId: LOCAL, signedIn: true, version: 'mock' })
  if (req.url === '/api/machines') return json(res, { machines: [
    { machineId: LOCAL, name: 'mock-local', status: 'running' },
    { machineId: REMOTE, name: 'mock-remote', status: 'running' },
  ] })
  if (req.url === '/api/desk' && req.method === 'GET') return json(res, desk)
  if (req.url === '/api/desk/ops') { desk.revision++; return json(res, desk) }
  res.writeHead(404); res.end('{}')
})

// HTRL framing — see tui/src/proto.rs.
const uuidBytes = (id) => Buffer.from(id.replaceAll('-', ''), 'hex')
function frame(kind, streamId, seq, bytes, size) {
  const meta = Buffer.alloc(kind === 3 ? 28 : 24)
  uuidBytes(streamId).copy(meta, 0)
  meta.writeBigUInt64BE(BigInt(seq), 16)
  if (size) { meta.writeUInt16BE(size[0], 24); meta.writeUInt16BE(size[1], 26) }
  const payload = Buffer.concat([meta, bytes])
  const head = Buffer.from([0x48, 0x54, 0x52, 0x4c, 1, kind, 0, 0, 0, 0, 0, 0])
  head.writeUInt32BE(payload.length, 8)
  return Buffer.concat([head, payload])
}

const wss = new WebSocketServer({ server, path: '/api/local-ws' })
wss.on('connection', (ws) => {
  let machine = null
  const streams = new Map() // streamId → { seq, agent }
  const send = (type, payload) => ws.send(JSON.stringify({ type, payload }))
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const bytes = Buffer.from(raw)
      if (bytes.length < 36) return
      const streamId = bytes.subarray(12, 28).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
      const stream = streams.get(streamId)
      if (!stream) return
      // Echo: what was typed comes back as output, Enter as a new prompt line.
      const text = bytes.subarray(36).toString('utf8').replace(/\r/g, '\r\n$ ')
      ws.send(frame(2, streamId, stream.seq++, Buffer.from(text)))
      return
    }
    const { type, payload = {} } = JSON.parse(String(raw))
    if (type === 'machine_select') {
      machine = payload.machineId
      if (!agents[machine]) return ws.close(4403, 'machine mismatch')
      return send('connected', { machineId: machine, transport: 'local', localProtocolVersion: 1 })
    }
    const reply = (body) => send(`${type}_result`, { requestId: payload.requestId, ...body })
    switch (type) {
      case 'agents_list': return reply({ agents: agents[machine].filter((a) => payload.includeStopped || a.status !== 'stopped') })
      case 'models_list': return reply({ models: [{ id: 'runtime-v1:x:claude:opus@high', displayName: 'Opus / High' }, { id: 'runtime-v1:x:claude:sonnet@high', displayName: 'Sonnet / High' }] })
      case 'dsh_list': return reply({ dsh: [] })
      case 'fs_list_dir': return reply({ path: '/home/demo', entries: [] })
      case 'agent_update': case 'agent_delete': case 'agent_resume': case 'agent_restart': return reply({ agent: agents[machine][0], deleted: true })
      case 'agent_create': {
        const created = agent(randomUUID(), `Mock ${payload.engine}`, payload.engine)
        agents[machine].push(created)
        return reply({ agent: created })
      }
      case 'route_task': return send('route_result', { requestId: payload.requestId, candidates: [], reason: 'mock' })
      case 'terminal_open': {
        const target = agents[machine].find((a) => a.id === payload.agentId)
        if (!target || target.status !== 'active') return send('terminal_error', { requestId: payload.requestId, code: 'TERMINAL_AGENT_NOT_FOUND' })
        const streamId = randomUUID()
        streams.set(streamId, { seq: 1, agent: target })
        send('terminal_ready', { requestId: payload.requestId, streamId, agentId: target.id, readOnly: false })
        ws.send(frame(3, streamId, 0, Buffer.from(`\x1bc${target.name} (mock)\r\n$ `), [payload.cols, payload.rows]))
        return
      }
      case 'terminal_close': streams.delete(payload.streamId); return
      default: return // acks, alive, resize, focus: nothing to do
    }
  })
})
server.listen(port, '127.0.0.1', () => console.log(`mock daemon on ${port}`))
