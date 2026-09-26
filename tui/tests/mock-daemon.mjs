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
const DEMO = process.env.MOCK_DEMO === '1'
const project = (a, name, branch) => ({ ...a, project: { name, cwd: `/home/dev/${name}`, root: `/home/dev/${name}`, branch } })
const agents = DEMO ? {
  [LOCAL]: [
    project(agent(randomUUID(), 'Fix flaky login test', 'claude'), 'webapp', 'fix/login-flake'),
    project(agent(randomUUID(), 'Add rate limiting to the API', 'codex'), 'api', 'feat/rate-limit'),
    project(agent(randomUUID(), 'Refactor billing service', 'claude'), 'billing', 'refactor/invoices'),
    project(agent(randomUUID(), 'Release notes 2.4', 'claude', 'stopped'), 'webapp', 'main'),
  ],
  [REMOTE]: [
    project(agent(randomUUID(), 'Train tokenizer on the new corpus', 'codex'), 'ml-lab', 'exp/tokenizer-v3'),
    project(agent(randomUUID(), 'gpu-box shell', 'terminal'), 'ml-lab', 'main'),
  ],
} : {
  [LOCAL]: [agent(randomUUID(), 'Mock Claude', 'claude'), agent(randomUUID(), 'Mock Codex', 'codex'), agent(randomUUID(), 'Mock paused', 'claude', 'stopped')],
  [REMOTE]: [agent(randomUUID(), 'Remote shell', 'terminal')],
}
// What a demo pane shows: an agent mid-task, in colour.
const demoScreen = (a) => a.engine === 'terminal'
  ? `\x1bc\x1b[32mdev@gpu-box\x1b[0m:\x1b[34m~/ml-lab\x1b[0m$ nvidia-smi --query-gpu=name,utilization.gpu --format=csv\r\nname, utilization.gpu [%]\r\nNVIDIA RTX 4090, 97 %\r\nNVIDIA RTX 4090, 95 %\r\n\x1b[32mdev@gpu-box\x1b[0m:\x1b[34m~/ml-lab\x1b[0m$ `
  : `\x1bc\x1b[1m\x1b[38;5;208m✳ ${a.name}\x1b[0m\r\n\r\n\x1b[2m> ${a.name.toLowerCase()}\x1b[0m\r\n\r\n\x1b[38;5;208m⏺\x1b[0m Reading \x1b[1msrc/${a.project.name}/handler.ts\x1b[0m\r\n\x1b[38;5;208m⏺\x1b[0m Running \x1b[1mnpm test -- ${a.project.name}\x1b[0m\r\n  \x1b[32m✓\x1b[0m 41 passed  \x1b[31m✗\x1b[0m 1 failed\r\n\x1b[38;5;208m⏺\x1b[0m The failure is a race in the session refresh — the token is read\r\n  before the refresh promise settles. Fixing it and re-running.\r\n\r\n\x1b[2m────────────────────────────────────────\x1b[0m\r\n\x1b[1m❯\x1b[0m `
const question = (machine) => {
  const a = agents[machine]?.find((x) => x.name.startsWith('Add rate limiting'))
  return a && { type: 'commander_question', agentId: a.id, dbSessionId: a.sessionId, payload: { requestId: 'q-demo', questions: [{ q: 'Rate limit per API key or per IP?', options: ['Per API key', 'Per IP', 'Both'] }] } }
}
// The demo's desk: the tabs a window opens with — three harnesses side by side, two more in tabs.
const demoPane = (machineId, start) => ({ machineId, agentId: agents[machineId].find((x) => x.name.startsWith(start)).id })
const desk = DEMO ? { revision: 1, tabs: [
  { id: 'demo-1', name: 'Fix flaky login test', panes: [demoPane(LOCAL, 'Fix flaky'), demoPane(LOCAL, 'Add rate'), demoPane(REMOTE, 'gpu-box')], layout: { presets: { 3: 'mainAndStack' } } },
  { id: 'demo-2', name: 'Refactor billing service', panes: [demoPane(LOCAL, 'Refactor billing')], layout: {} },
  { id: 'demo-3', name: 'Train tokenizer on the new corpus', panes: [demoPane(REMOTE, 'Train tokenizer')], layout: {} },
] } : { revision: 1, tabs: [] }
// The dial's side of the daemon, for the e2e: what the windows told it (the ring, the tabs, the
// focus, spoken-task replies, messages sent), and every local window to push dial frames at.
const dial = { said: {}, replies: [], messages: [] }
const windows = new Set()

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: body })) }
const server = http.createServer((req, res) => {
  if (req.url === '/api/status') return json(res, { machineId: LOCAL, signedIn: true, version: 'mock' })
  if (req.url === '/api/machines') return json(res, { machines: [
    { machineId: LOCAL, name: DEMO ? 'studio' : 'mock-local', status: 'running' },
    { machineId: REMOTE, name: DEMO ? 'gpu-box' : 'mock-remote', status: 'running' },
  ] })
  if (req.url === '/test/dial' && req.method === 'GET') return json(res, dial)
  if (req.url === '/test/dial' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { for (const ws of windows) ws.send(body); json(res, { windows: windows.size }) })
    return
  }
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
      send('connected', { machineId: machine, transport: 'local', localProtocolVersion: 1 })
      // This machine's own connections are the daemon's windows (backend.sendLocal's audience).
      if (machine === LOCAL) {
        windows.add(ws)
        ws.on('close', () => windows.delete(ws))
        send('dial_status', { attached: true, fw: '1.0.0-mock' })
      }
      if (DEMO) {
        const asked = question(machine)
        if (asked) setTimeout(() => ws.send(JSON.stringify(asked)), 300)
        let busy = agents[machine].filter((x) => x.status === 'active' && x.engine !== 'terminal' && !x.name.startsWith('Add rate'))
        const beat = setInterval(() => busy.forEach((x) => send('turn_heartbeat', { agentId: x.id, sessionId: x.sessionId })), 2000)
        // The billing refactor finishes its turn a few seconds in (done, until you look at it).
        const finished = busy.find((x) => x.name.startsWith('Refactor billing'))
        const finish = finished && setTimeout(() => { busy = busy.filter((x) => x !== finished); send('turn_ended', { agentId: finished.id, sessionId: finished.sessionId }) }, 5000)
        ws.on('close', () => { clearInterval(beat); clearTimeout(finish) })
        setTimeout(() => busy.forEach((x) => send('turn_heartbeat', { agentId: x.id, sessionId: x.sessionId })), 200)
      }
      return
    }
    const reply = (body) => send(`${type}_result`, { requestId: payload.requestId, ...body })
    switch (type) {
      case 'agents_list': return reply({ agents: agents[machine].filter((a) => payload.includeStopped || a.status !== 'stopped') })
      case 'models_list': return reply({ models: [{ id: 'runtime-v1:x:claude:opus@high', displayName: 'Opus / High' }, { id: 'runtime-v1:x:claude:sonnet@high', displayName: 'Sonnet / High' }] })
      case 'dsh_list': return reply({ dsh: [] })
      case 'fs_list_dir': return reply({ path: '/home/demo', entries: [] })
      // What tmux says a pane runs and where (the real daemon asks its tmux; here, fixed).
      case 'terminal_info': return reply({ command: 'zsh', path: '/home/demo/src', pid: 4242, tty: '/dev/ttys042' })
      // The e2e reads which harnesses were deleted (a killed pane's shell goes with it).
      case 'agent_delete': dial.deleted = [...(dial.deleted || []), payload.agentId]; return reply({ agent: agents[machine][0], deleted: true })
      case 'agent_update': case 'agent_resume': case 'agent_restart': return reply({ agent: agents[machine][0], deleted: true })
      case 'agent_create': {
        const created = agent(randomUUID(), `Mock ${payload.engine}`, payload.engine)
        agents[machine].push(created)
        return reply({ agent: created })
      }
      case 'route_task': {
        // `sure: …` routes to the first harness here with confidence, `unsure: …` offers it, else none.
        const text = String(payload.text || '')
        const pick = agents[LOCAL][0]
        const confidence = text.startsWith('sure:') ? 0.95 : 0.4
        if (!text.startsWith('sure:') && !text.startsWith('unsure:')) return send('route_result', { requestId: payload.requestId, candidates: [], reason: 'mock' })
        return send('route_result', { requestId: payload.requestId, agentId: pick.id, machineId: LOCAL, name: pick.name, confidence,
          candidates: [{ agentId: pick.id, machineId: LOCAL, name: pick.name, machine: 'mock-local', engine: pick.engine, confidence }] })
      }
      case 'app_panes': case 'app_swarms': case 'app_focus': case 'app_unread': case 'agent_seen':
        dial.said[type] = { machine, ...payload }
        return
      case 'voice_route_reply': dial.replies.push(payload); return
      case 'message': dial.messages.push({ machine, ...payload }); return
      case 'terminal_open': {
        const target = agents[machine].find((a) => a.id === payload.agentId)
        if (!target || target.status !== 'active') return send('terminal_error', { requestId: payload.requestId, code: 'TERMINAL_AGENT_NOT_FOUND' })
        const streamId = randomUUID()
        streams.set(streamId, { seq: 1, agent: target })
        send('terminal_ready', { requestId: payload.requestId, streamId, agentId: target.id, readOnly: false })
        ws.send(frame(3, streamId, 0, Buffer.from(DEMO ? demoScreen(target) : `\x1bc${target.name} (mock)\r\n$ `), [payload.cols, payload.rows]))
        return
      }
      case 'terminal_close': streams.delete(payload.streamId); return
      case 'terminal_resize': {
        // A demo pane redraws at its new size, as the agent in it would: a keyframe of that size.
        const stream = streams.get(payload.streamId)
        if (DEMO && stream) ws.send(frame(3, payload.streamId, stream.seq++, Buffer.from(demoScreen(stream.agent)), [payload.cols, payload.rows]))
        return
      }
      default: return // acks, alive, resize, focus: nothing to do
    }
  })
})
server.listen(port, '127.0.0.1', () => console.log(`mock daemon on ${port}`))
