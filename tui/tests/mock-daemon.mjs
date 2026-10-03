// A stand-in for the Harness daemon, for driving harness-tui with nothing real behind it: fake
// machines, fake harnesses, and terminals that echo what is typed. Fuzzing and end-to-end checks run
// against this — never against a daemon whose agents are somebody's real work.
//
//   export HOME="$(mktemp -d /tmp/hn-mock.XXXXXX)" ADAPTER_DATA_DIR=
//   node tui/tests/mock-daemon.mjs 18999 &
//   PORT=18999 HARNESS_TUI_DESK=off tui/target/release/harness-tui
//
// Needs the `ws` package (cli/node_modules has it). Speaks just enough of local-ws + terminal
// protocol v3 (cli/src/lib/terminalStreamManager.ts, terminalBinary.ts) for the TUI.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'

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
    { ...project(agent(randomUUID(), 'Upgrade React to 19', 'claude'), 'webapp', 'react-19'), launch: { state: 'failed', error: 'START_TIMEOUT', detail: 'The agent did not start within 60 seconds.' } },
  ],
} : {
  [LOCAL]: [agent(randomUUID(), 'Mock Claude', 'claude'), agent(randomUUID(), 'Mock Codex', 'codex'), agent(randomUUID(), 'Mock paused', 'claude', 'stopped')],
  [REMOTE]: [agent(randomUUID(), 'Remote shell', 'terminal')],
}
if (process.env.MOCK_PROJECT_SEARCH === '1') {
  // A large local history must not keep remote folders out of the project picker.
  for (let i = 0; i < 70; i++) {
    const older = new Date(Date.parse(now) - (i + 1) * 60_000).toISOString()
    agents[LOCAL].push(project({ ...agent(`project-search-${i}`, `Local project ${i}`, 'codex'), createdAt: older, updatedAt: older },
      `autonomous-harness-2026-${String(i).padStart(3, '0')}`, 'main'))
  }
}
if (process.env.MOCK_SHARED_LAYOUT === '1') {
  for (let i = 1; i <= 9; i++) agents[LOCAL].push(agent(`shared-layout-${i}`, `Shared pane ${i}`, 'terminal'))
}

// Opt-in viewer fixtures, so the normal terminal roster and its tests keep their identities.
if (process.env.MOCK_VIEWER === '1') {
  agents[LOCAL].push({ ...agent('mock-blender', 'Mock Blender', 'claude'), dsh: 'autonomous/blender',
    viewerName: '3D Viewer', viewerUrl: `http://127.0.0.1:${port}/test-viewer?file=model.glb` })
  agents[REMOTE].push({ ...agent('remote-blender', 'Remote Blender', 'claude'), dsh: 'autonomous/blender',
    viewerName: '3D Viewer', viewerUrl: 'http://127.0.0.1:19679/?file=model.glb' })
}
if (process.env.MOCK_VIEWER_EDGES === '1') {
  agents[LOCAL].push(
    { ...agent('waiting-viewer', 'Waiting Viewer', 'claude'), viewerName: '3D Viewer' },
    { ...agent('failed-viewer', 'Failed Viewer', 'claude'), viewerError: 'Renderer could not start' },
    { ...agent('unsafe-viewer', 'Unsafe Viewer', 'claude'), viewerName: 'Viewer', viewerUrl: 'javascript:alert(1)' },
    { ...agent('quoted-viewer', 'Quoted " viewer; $(false)', 'claude'), viewerName: 'Viewer', viewerUrl: `http://127.0.0.1:${port}/test-viewer?x=a&y=b` },
    { ...agent('mock-blender-extended', 'Mock Blender Extended', 'claude'), viewerName: 'Viewer' },
    { ...agent('duplicate-local', 'Duplicate Viewer', 'claude'), viewerName: 'Viewer' },
  )
  agents[REMOTE].push({ ...agent('duplicate-remote', 'Duplicate Viewer', 'claude'), viewerName: 'Viewer' })
}
// Claude Code and Codex conversations on this machine that Harness did not start (session_search's
// `external` hits): two closed, one still open in a terminal (not to be opened twice).
const HOUR = 3_600_000
const EXTERNAL = [
  { sessionId: 'ext-claude-leadership', engine: 'claude', title: 'Design AI leadership team', cwd: '/home/demo/src/org', origin: 'claude-desktop', open: false, lastAt: Date.now() - 50 * HOUR,
    turns: [['Draft the roles for an AI leadership team', 'Here are five roles: a head of research, …'], ['Add hiring order', 'Hire the head of research first, then …']] },
  { sessionId: 'ext-codex-nfc', engine: 'codex', title: 'Continue NFC device chat', cwd: '/home/demo/src/nfc', origin: 'vscode', open: false, lastAt: Date.now() - 5 * HOUR,
    turns: [['Why does the NFC reader drop the first tap?', 'The reader sleeps after 30 s; the first tap wakes it.'], ['Keep it awake while the app is open', 'Done: a keep-alive ping every 20 s.']] },
  { sessionId: 'ext-codex-retry', engine: 'codex', title: 'Fix the flaky retry test', cwd: '/home/demo/src/api', origin: 'cli', open: true, lastAt: Date.now() - 10 * 60_000,
    turns: [['The retry test fails one run in ten', 'It races the backoff timer; fake the clock.']] },
]
// session_search's hits: every word of the query in a harness's name or an external conversation's
// title or turns, the words marked; no words: the external ones worked on in [from, to].
function searchHits(machine, query, from, to) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  const mark = (text) => words.reduce((t, w) => t.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), (m) => `\u0002${m}\u0003`), text)
  const hits = []
  const pool = machine === LOCAL ? EXTERNAL : []
  for (const x of pool) {
    const text = [x.title, ...x.turns.flat()].join(' ').toLowerCase()
    if (words.length ? !words.every((w) => text.includes(w)) : (from && x.lastAt < from) || (to && x.lastAt > to)) continue
    const turn = words.length ? x.turns.findIndex(([a, b]) => words.some((w) => (a + ' ' + b).toLowerCase().includes(w))) : -1
    const snippet = turn >= 0 ? mark(x.turns[turn].join(' — ')) : mark(x.title)
    hits.push({ sessionId: x.sessionId, agentId: '', engine: x.engine, turn, at: x.lastAt, lastAt: x.lastAt, field: turn >= 0 ? 'ask' : 'name', snippet, together: true, score: 0.5,
      external: { title: x.title, cwd: x.cwd, origin: x.origin, open: x.open } })
  }
  if (words.length) for (const a of agents[machine] || []) {
    const text = `${a.name} ${(RECAPS[a.name] || []).join(' ')}`.toLowerCase()
    if (!words.every((w) => text.includes(w))) continue
    hits.push({ sessionId: a.sessionId, agentId: a.id, engine: a.engine, turn: 0, at: Date.now() - HOUR, lastAt: Date.now() - HOUR, field: 'ask', snippet: mark(RECAPS[a.name]?.[1] || a.name), together: true, score: 0.8 })
  }
  return hits
}

// MOCK_FLEET=N: N more harnesses across both machines, for a fleet the size people run — each
// working, idle or finishing turns on its own clock.
const FLEET = Number(process.env.MOCK_FLEET || 0)
const TASKS = ['Fix the flaky checkout test', 'Add pagination to /orders', 'Upgrade to Node 22', 'Write the 2.5 release notes', 'Profile the image resizer',
  'Port the CLI to Rust', 'Triage the crash reports', 'Refactor the auth middleware', 'Add dark mode to settings', 'Speed up the CI cache', 'Translate the docs to Spanish',
  'Remove the legacy billing API', 'Harden the upload endpoint', 'Tune the search ranking', 'Migrate the queue to SQS', 'Fix the memory leak in workers']
const PROJECTS = [['webapp', 'main'], ['api', 'develop'], ['billing', 'refactor/invoices'], ['ml-lab', 'exp/tokenizer-v3'], ['infra', 'ci-cache'], ['docs', 'i18n']]
// What the daemon keeps of each: tokens, the lines it changed, the pull requests it made.
if (DEMO) for (const [i, a] of Object.values(agents).flat().entries()) {
  if (a.engine === 'terminal') continue
  a.tokenUsage = { totalTokens: [1_240_000, 356_000, 88_400, 12_000, 2_900_000, 640_000, 45_000][i % 7], updatedAt: now }
  a.outputStats = { linesAdded: [340, 12, 88, 0, 1200, 45, 3][i % 7], linesRemoved: [52, 3, 20, 0, 400, 9, 1][i % 7], pullRequestsCreated: i % 3 === 0 ? 1 : 0, updatedAt: now }
}
// The pull requests for their branches (git_pull_request), and each one's last recap and ask
// (agent_recent), as the daemon keeps them.
const PRS = { 'fix/login-flake': { number: 4812, state: 'Open' }, 'feat/rate-limit': { number: 4807, state: 'Draft' }, 'refactor/invoices': { number: 4790, state: 'Merged' } }
const RECAPS = { 'Refactor billing service': ['Invoices use Decimal; 3 tests added', 'Move invoices off floats'], 'Train tokenizer on the new corpus': ['Tokenizer v3 trained to step 1200; loss 1.84', 'Train the v3 tokenizer on the new corpus'] }
for (let i = 0; i < FLEET; i++) {
  const [name, branch] = PROJECTS[i % PROJECTS.length]
  const a = project(agent(randomUUID(), `${TASKS[i % TASKS.length]}${i >= TASKS.length ? ` (${Math.floor(i / TASKS.length) + 1})` : ''}`, i % 3 === 2 ? 'codex' : 'claude'), name, `${branch}${i >= PROJECTS.length ? `-${i}` : ''}`)
  agents[i % 2 ? REMOTE : LOCAL].push(a)
}
// A turn's steps, as an agent's events carry them (tool_start with its tool and input).
const STEPS = [
  { tool: 'Read', input: { file_path: 'src/app/handler.ts' } },
  { tool: 'Grep', input: { pattern: 'refreshToken' } },
  { tool: 'Bash', input: { command: 'npm test -- --watch=false', description: 'Run the unit tests' } },
  { tool: 'Edit', input: { file_path: 'src/app/session.ts' } },
  { tool: 'TodoWrite', input: { todos: [{ content: 'Reproduce the flake', status: 'completed' }, { content: 'Fix the race', activeForm: 'Fixing the race in the token refresh', status: 'in_progress' }, { content: 'Add a regression test', status: 'pending' }] } },
  { tool: 'Task', input: { description: 'Explore the auth module', subagent_type: 'Explore' } },
]
const DID = ['Fixed the token-refresh race; all 42 tests pass.', 'Invoices now use Decimal; 3 tests added.', 'Pagination added to /orders, with tests.', 'Node 22 builds green; two deprecated calls replaced.']
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
// How many of each request the windows made (GET /test/counts), for tests of what hn asks.
const counts = {}
const windows = new Set()
// Opt-in faults for reconnect.py. No real daemon or agent is involved.
// Controlled desk latency/failures for layout reconciliation tests, on private ports only.
const layoutTest = process.env.MOCK_LAYOUT === '1'
if (layoutTest && !(port >= 19800 && port <= 19809)) throw new Error('unsafe layout test port')
const layoutFaults = { delays: [], failures: [], writes: [] }
const reconnect = process.env.MOCK_RECONNECT === '1'
if (reconnect && !(port >= 19780 && port <= 19789)) throw new Error('unsafe reconnect test port')
const creationReceipts = new Map()
const connections = new Map()
const opens = []
const inputs = []
const readOnly = new Set()
let nextConnection = 0
// The questions open on this computer, as the daemon keeps them: replayed to a window as it
// connects, then their ids (commander_questions_open).
const openQs = new Map()
let demoAsked = false

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: body })) }
const server = http.createServer((req, res) => {
  if (layoutTest && req.url === '/test/layout') {
    if (req.method === 'GET') return json(res, layoutFaults)
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const f = JSON.parse(body)
      for (const key of ['delays', 'failures']) if (Array.isArray(f[key])) layoutFaults[key] = f[key]
      json(res, layoutFaults)
    })
    return
  }
  if (reconnect && req.url === '/test/reconnect') {
    if (req.method === 'GET') return json(res, { opens, inputs, counts, connections: [...connections.values()].map(c => ({
      id: c.id, machine: c.machine, streams: [...c.streams].map(([id, s]) => ({ id, agent: s.agent.id })),
    })) })
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const f = JSON.parse(body)
      if (f.action === 'watch') readOnly.add(f.agent)
      for (const c of connections.values()) {
        if (f.machine && c.machine !== f.machine) continue
        if (f.action === 'hang') c.hang = true
        if (f.action === 'disconnect') c.ws.terminate()
        if (f.action === 'close') for (const [id, s] of c.streams) {
          if (f.agent && s.agent.id !== f.agent) continue
          c.streams.delete(id)
          c.ws.send(JSON.stringify({ type: 'terminal_closed', payload: { streamId: id, reason: f.reason,
            ...(f.takenBy ? { takenBy: { name: f.takenBy } } : {}) } }))
        }
      }
      json(res, { ok: true })
    })
    return
  }
  if (req.url === '/api/status') return json(res, { machineId: LOCAL, signedIn: true, version: 'mock', webUrl: process.env.MOCK_WEB_URL || 'https://harness.example' })
  if (req.url === '/api/machines') return json(res, { machines: [
    { machineId: LOCAL, name: process.env.MOCK_PROJECT_SEARCH === '1' ? 'M2' : DEMO ? 'studio' : 'mock-local', status: 'running' },
    { machineId: REMOTE, name: process.env.MOCK_PROJECT_SEARCH === '1' ? 'office' : DEMO ? 'gpu-box' : 'mock-remote', status: 'running' },
  ] })
  // Harnesses that finish a turn with no window watching: their transcripts change now
  // (tokenUsage.updatedAt), as the daemon would record (POST /test/finish?n=5).
  if (req.url.startsWith('/test/finish') && req.method === 'POST') {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') || 1)
    const fleet = Object.values(agents).flat().filter((a) => a.engine !== 'terminal' && a.status === 'active' && a.launch?.state !== 'failed').slice(0, n)
    const at = new Date().toISOString()
    for (const a of fleet) { a.tokenUsage = { totalTokens: (a.tokenUsage?.totalTokens || 0) + 1000, updatedAt: at }; a.finishedAway = true }
    return json(res, { finished: fleet.map((a) => a.name) })
  }
  if (req.url === '/test/counts') return json(res, counts)
  if (req.url === '/test/dial' && req.method === 'GET') return json(res, { ...dial, agents: Object.values(agents).flat().map((a) => ({ id: a.id, name: a.name, sessionId: a.sessionId })) })
  if (req.url === '/test/dial' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const f = JSON.parse(body)
        const rid = f?.payload?.requestId
        if (f?.type === 'commander_question' && rid) openQs.set(rid, f)
        if (f?.type === 'commander_question_close' && rid) openQs.delete(rid)
      } catch {}
      for (const ws of windows) ws.send(body)
      json(res, { windows: windows.size })
    })
    return
  }
  if (req.url === '/api/desk' && req.method === 'GET') return json(res, desk)
  if (req.url === '/api/desk/ops') {
    // Applied as the daemon's desk store applies them (MOCK_DESK=fixed: left as it is).
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      const delay = layoutTest ? (layoutFaults.delays.shift() || 0) : 0
      const failure = layoutTest ? (layoutFaults.failures.shift() || 0) : 0
      if (layoutTest) layoutFaults.writes.push(JSON.parse(body || '{}'))
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (failure) {
        res.writeHead(failure, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'injected desk failure' }))
        return
      }
      let ops = []
      try { ops = JSON.parse(body || '{}').ops || [] } catch {}
      if (process.env.MOCK_DESK === 'fixed') ops = []
      // MOCK_DESK=strict: a layout with a key the backend's schema does not know is refused
      // whole (400), as a backend from before layout.tmux refuses it.
      if (process.env.MOCK_DESK === 'strict' && ops.some((o) => o.op === 'tab.layout' && Object.keys(o.layout || {}).some((k) => !['presets', 'sizes'].includes(k)))) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid body' })); return
      }
      const tab = (id) => desk.tabs.find((t) => t.id === id)
      for (const op of ops) {
        if (op.op === 'tab.create' && !tab(op.id)) desk.tabs.splice(Math.min(op.index ?? desk.tabs.length, desk.tabs.length), 0, { id: op.id, name: op.name, nameIsCustom: !!op.nameIsCustom, panes: [], layout: {} })
        if (op.op === 'tab.close') desk.tabs = desk.tabs.filter((t) => t.id !== op.id)
        if (op.op === 'tab.move') { const t = tab(op.id); if (t) { desk.tabs = desk.tabs.filter((x) => x !== t); desk.tabs.splice(Math.min(op.index, desk.tabs.length), 0, t) } }
        if (op.op === 'tab.rename') { const t = tab(op.id); if (t) { t.name = op.name; t.nameIsCustom = !!op.nameIsCustom } }
        if (op.op === 'tab.layout') { const t = tab(op.id); if (t) t.layout = op.layout }
        if (op.op === 'pane.add') { const t = tab(op.tabId); if (t && !t.panes.some((p) => p.agentId === op.agentId)) t.panes.splice(Math.min(op.index ?? t.panes.length, t.panes.length), 0, { machineId: op.machineId, agentId: op.agentId }) }
        if (op.op === 'pane.move') { const t = tab(op.tabId); const at = t?.panes.findIndex((p) => p.machineId === op.machineId && p.agentId === op.agentId) ?? -1; if (at >= 0) { const [p] = t.panes.splice(at, 1); t.panes.splice(Math.max(0, Math.min(op.index, t.panes.length)), 0, p) } }
        if (op.op === 'pane.remove') { const t = tab(op.tabId); if (t) t.panes = t.panes.filter((p) => p.agentId !== op.agentId) }
      }
      desk.revision++
      // Every window told, as the daemon tells them (they fetch the desk again).
      if (ops.length) for (const ws of windows) { try { ws.send(JSON.stringify({ type: 'desk_changed', payload: { revision: desk.revision } })) } catch {} }
      json(res, desk)
    })
    return
  }
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
  const connection = { id: ++nextConnection, ws, streams, machine: null, hang: false }
  if (reconnect) {
    connections.set(connection.id, connection)
    ws.on('close', () => connections.delete(connection.id))
  }
  const send = (type, payload) => ws.send(JSON.stringify({ type, payload }))
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const bytes = Buffer.from(raw)
      if (bytes.length < 36) return
      const streamId = bytes.subarray(12, 28).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
      const stream = streams.get(streamId)
      if (!stream) return
      if (reconnect) inputs.push({ connection: connection.id, agent: stream.agent.id, text: bytes.subarray(36).toString() })
      // Echo: what was typed comes back as output, Enter as a new prompt line.
      const text = bytes.subarray(36).toString('utf8').replace(/\r/g, '\r\n$ ')
      stream.screen += text
      ws.send(frame(2, streamId, stream.seq++, Buffer.from(text)))
      return
    }
    const { type, payload = {} } = JSON.parse(String(raw))
    if (type === 'machine_select') {
      machine = payload.machineId
      connection.machine = machine
      if (!agents[machine]) return ws.close(4403, 'machine mismatch')
      send('connected', { machineId: machine, transport: 'local', localProtocolVersion: 1 })
      // This machine's own connections are the daemon's windows (backend.sendLocal's audience).
      if (machine === LOCAL) {
        windows.add(ws)
        ws.on('close', () => windows.delete(ws))
        send('dial_status', { attached: true, fw: '1.0.0-mock' })
        // The open questions in the same tick, as the daemon hands them over (d0047d1c).
        if (DEMO && !openQs.size && !demoAsked) { const asked = question(LOCAL); if (asked) openQs.set(asked.payload.requestId, asked); demoAsked = true }
        for (const f of openQs.values()) ws.send(JSON.stringify(f))
        send('commander_questions_open', { requestIds: [...openQs.keys()] })
      }
      if (DEMO) {
        const asked = machine === LOCAL ? null : question(machine)
        if (asked) setTimeout(() => ws.send(JSON.stringify(asked)), 300)
        const ev = (x, type, payload = {}) => ws.send(JSON.stringify({ type, agentId: x.id, dbSessionId: x.sessionId, payload: { agentId: x.id, sessionId: x.sessionId, ...payload } }))
        // Of the fleet, about half work; the rest are idle. Each working one steps through a turn.
        let busy = agents[machine].filter((x, i) => x.status === 'active' && x.engine !== 'terminal' && x.launch.state !== 'failed' && !x.name.startsWith('Add rate') && !x.finishedAway && (i < 6 || i % 2 === 0))
        let tick = 0
        const beat = setInterval(() => {
          tick++
          busy.forEach((x, i) => { ev(x, 'turn_heartbeat'); if ((tick + i) % 2 === 0) ev(x, 'tool_start', { id: `t${tick}`, ...STEPS[(tick + i) % STEPS.length] }) })
          // Every few seconds one of the fleet finishes its turn (its final message first).
          if (FLEET && tick % 3 === 0 && busy.length > 6) {
            const done = busy[6 + (tick % (busy.length - 6))]
            busy = busy.filter((x) => x !== done)
            ev(done, 'text_delta', { content: DID[tick % DID.length] + '\n\nDetails below.' })
            ev(done, 'turn_ended')
          }
        }, 2000)
        // The billing refactor finishes its turn a few seconds in (done, until you look at it).
        const finished = busy.find((x) => x.name.startsWith('Refactor billing'))
        const finish = finished && setTimeout(() => {
          busy = busy.filter((x) => x !== finished)
          ev(finished, 'text_delta', { content: '**Invoices now use Decimal**; 3 tests added.\n\nThe rounding in `total()` was the bug.' })
          ev(finished, 'turn_ended')
        }, 5000)
        ws.on('close', () => { clearInterval(beat); clearTimeout(finish) })
        setTimeout(() => busy.forEach((x) => { ev(x, 'turn_started', { userMessage: x.name }); ev(x, 'tool_start', { id: 't0', ...STEPS[0] }) }), 200)
      }
      return
    }
    const reply = (body) => send(`${type}_result`, { requestId: payload.requestId, ...body })
    counts[type] = (counts[type] || 0) + 1
    switch (type) {
      case 'agents_list': return reply({ agents: agents[machine].filter((a) => payload.includeStopped || a.status !== 'stopped') })
      case 'models_list': return reply({ models: [{ id: 'runtime-v1:x:claude:opus@high', displayName: 'Opus / High' }, { id: 'runtime-v1:x:claude:sonnet@high', displayName: 'Sonnet / High' }] })
      case 'git_project_info': return reply(process.env.MOCK_NEW_UI ? { isGit: !String(payload.path).includes('plain'), branch: 'main', branches: [
        { ref: 'refs/heads/main', name: 'main', remote: false },
        { ref: 'refs/heads/feature', name: 'feature', remote: false },
        { ref: 'refs/heads/already-open', name: 'already-open', remote: false, worktree: '/home/demo/worktrees/already-open' },
      ] } : { isGit: false })
      case 'grid_models_list': return reply({ supportsModelLaunch: true, localModelEngines: ['codex', 'claude'], grids: [
        { name: 'studio', own: true, models: [{ id: 'demo-model', node: 'studio' }] },
      ] })
      case 'codex_profiles_list': return reply({ profiles: [{ path: '/home/demo/.codex-work', label: 'Work' }] })
      case 'dsh_list': return reply({ dsh: process.env.MOCK_NEW_UI ? [{ id: 'example/blender', name: 'Blender', engine: 'codex', engines: ['codex', 'claude'], installed: true }] : [] })
      // The agent accounts' limits, as the vendors answer (MOCK_USAGE: Claude's 5-hour window, %).
      case 'usage_read': return reply({ providers: [
        { provider: 'claude', account: 'acct-claude', outcome: 'answered', httpStatus: 200, body: { five_hour: { utilization: Number(process.env.MOCK_USAGE || 42), resets_at: '2026-09-26T21:00:00Z' }, seven_day: { utilization: 18, resets_at: '2026-10-01T00:00:00Z' } } },
        { provider: 'codex', account: 'acct-codex', outcome: 'answered', httpStatus: 200, body: { rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000 }, secondary_window: { used_percent: 11, limit_window_seconds: 604800 } } } },
      ] })
      case 'git_pull_request': {
        const a = agents[machine].find((x) => x.id === payload.agentId)
        const pr = a && PRS[a.project.branch]
        return reply(pr ? { status: 'found', number: pr.number, state: pr.state, url: `https://github.com/demo/${a.project.name}/pull/${pr.number}` } : { status: 'none' })
      }
      case 'agent_recent': {
        const a = agents[machine].find((x) => x.id === payload.agentId)
        const r = a && RECAPS[a.name]
        return reply({ agentId: payload.agentId, events: r ? [{ kind: 'summary', recap: r[0], text: r[0] }] : [], asks: r ? [r[1]] : [] })
      }
      case 'fs_list_dir': return reply({ path: process.env.MOCK_NEW_UI ? (payload.path || '/home/demo') : '/home/demo', entries: process.env.MOCK_NEW_UI && !String(payload.path).endsWith('/projects') ? [{ name: 'projects', isDir: true }] : [] })
      // What tmux says a pane runs and where (the real daemon asks its tmux; here, fixed).
      case 'terminal_info': return reply({ command: 'zsh', path: '/home/demo/src', pid: 4242, tty: '/dev/ttys042' })
      // The e2e reads which harnesses were deleted (a killed pane's shell goes with it).
      case 'agent_delete': dial.deleted = [...(dial.deleted || []), payload.agentId]; return reply({ agent: agents[machine][0], deleted: true })
      case 'agent_update': case 'agent_resume': case 'agent_restart': return reply({ agent: agents[machine][0], deleted: true })
      case 'session_search': return reply({ hits: searchHits(machine, payload.query, payload.from, payload.to), indexed: 12, pending: 0, tookMs: 3 })
      case 'session_tail': {
        const x = EXTERNAL.find((e) => e.sessionId === payload.sessionId)
        const a = (agents[machine] || []).find((e) => e.sessionId === payload.sessionId)
        if (!x && !a) return reply({ error: 'NOT_INDEXED', sessionId: payload.sessionId })
        const turns = x ? x.turns : [[a.name, (RECAPS[a.name] || ['Working on it.'])[0]]]
        const rows = turns.map(([ask, answer], turn) => ({ turn, at: Date.now() - (turns.length - turn) * HOUR, ask, answer, tools: turn === 0 ? 'Read src/main.ts\nBash npm test' : '' }))
        return reply({ sessionId: payload.sessionId, rows, hasMore: false, total: rows.length, lastAt: x ? x.lastAt : Date.now(), lastAsk: rows[rows.length - 1], ...(x ? { external: { title: x.title, cwd: x.cwd, origin: x.origin, open: x.open } } : {}) })
      }
      case 'agent_create_status': {
        dial.creationChecks = [...(dial.creationChecks || []), payload]
        const receipt = creationReceipts.get(`${machine}:${payload.creationId}`)
        if (receipt?.pendingChecks) { receipt.pendingChecks--; return reply({ creationId: payload.creationId, state: 'pending' }) }
        return reply({ creationId: payload.creationId, ...(receipt?.outcome || { state: 'missing' }) })
      }
      case 'agent_create': {
        dial.created = [...(dial.created || []), payload]
        const receiptKey = `${machine}:${payload.creationId}`
        const { requestId: _requestId, creationId: _creationId, ...choices } = payload
        const fingerprint = JSON.stringify(choices)
        const previous = creationReceipts.get(receiptKey)
        if (process.env.MOCK_NEW_UI && previous) {
          if (previous.fingerprint !== fingerprint) return reply({ error: 'CREATION_CONFLICT' })
          return reply({ creationId: payload.creationId, ...previous.outcome })
        }
        // The daemon's wire contract uses branchMode, not its internal existingBranch flag.
        if (process.env.MOCK_NEW_UI && payload.branchName === 'feature' && payload.branchMode !== 'existing') {
          return reply({ error: 'BRANCH_EXISTS', detail: 'Select the existing branch using branchMode.' })
        }
        if (process.env.MOCK_NEW_UI === '1' && payload.projectName === 'fail-once') {
          // The real daemon persists known failures, including a prepared folder.
          // Reusing this receipt can NEVER make this request succeed.
          const outcome = { state: 'failed', failure: { code: 'ENGINE_UNAVAILABLE', detail: 'Fixture launch failure' }, preparedFolder: '/home/demo/fail-once' }
          creationReceipts.set(receiptKey, { fingerprint, outcome })
          return setTimeout(() => reply({ creationId: payload.creationId, ...outcome }), 150)
        }
        if (process.env.MOCK_NEW_UI === '1' && payload.projectName === 'unknown-launch') {
          const outcome = { state: 'unconfirmed' }
          creationReceipts.set(receiptKey, { fingerprint, outcome })
          return reply({ creationId: payload.creationId, ...outcome })
        }
        // Resuming a conversation Harness did not start: refused while it is open elsewhere.
        if (payload.resumeSessionId) {
          const x = EXTERNAL.find((e) => e.sessionId === payload.resumeSessionId)
          if (!x) return reply({ error: 'SESSION_NOT_FOUND', detail: 'That conversation is no longer on this machine.' })
          if (x.open) return reply({ error: 'SESSION_OPEN_ELSEWHERE', detail: 'It is open in another terminal.' })
          const resumed = { ...agent(randomUUID(), payload.name || x.title, x.engine), project: { name: x.cwd.split('/').pop(), cwd: x.cwd, root: x.cwd, branch: 'main' } }
          agents[machine].push(resumed)
          const at = EXTERNAL.indexOf(x); EXTERNAL.splice(at, 1)
          return reply({ agent: resumed })
        }
        const created = agent(randomUUID(), `Mock ${payload.engine}`, payload.engine)
        agents[machine].push(created)
        if (process.env.MOCK_NEW_UI === '1') {
          const outcome = { state: 'created', agent: created }
          creationReceipts.set(receiptKey, { fingerprint, outcome, pendingChecks: payload.projectName === 'lose-reply' ? 1 : 0 })
          if (payload.projectName === 'lose-reply') return ws.terminate()
          return reply({ creationId: payload.creationId, ...outcome })
        }
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
      // An answer: recorded, and the question closed, as the daemon closes it once it is keyed in.
      case 'question_response': {
        openQs.delete(payload.requestId)
        dial.answers = [...(dial.answers || []), payload]
        const a = agents[machine].find((x) => x.id === payload.agentId)
        send('commander_question_close', { requestId: payload.requestId, agentId: payload.agentId, dbSessionId: a?.sessionId })
        return
      }
      case 'terminal_open': {
        if (reconnect) opens.push({ connection: connection.id, machine, agent: payload.agentId, takeover: payload.takeover, hung: connection.hang, at: Date.now() })
        if (reconnect && connection.hang) return // WS still answers pings; application requests do not.
        if (reconnect && payload.takeover === true) readOnly.delete(payload.agentId)
        const target = agents[machine].find((a) => a.id === payload.agentId)
        if (!target || target.status !== 'active') return send('terminal_error', { requestId: payload.requestId, code: 'TERMINAL_AGENT_NOT_FOUND' })
        const streamId = randomUUID()
        // MOCK_BANNER: bytes a terminal prints before its prompt (a test's colours, say).
        const banner = (process.env.MOCK_BANNER || '').replace(/\\e/g, '\x1b').replace(/\\r\\n/g, '\r\n')
        // MOCK_PLAIN: a terminal that is only its prompt.
        const screen = DEMO ? demoScreen(target) : process.env.MOCK_PLAIN ? '\x1bc$ ' : `\x1bc${target.name} (mock)\r\n${banner}$ `
        streams.set(streamId, { seq: 1, agent: target, screen })
        send('terminal_ready', { requestId: payload.requestId, streamId, agentId: target.id, readOnly: reconnect && readOnly.has(target.id), heldBy: { name: 'test observer' } })
        ws.send(frame(3, streamId, 0, Buffer.from(screen), [payload.cols, payload.rows]))
        return
      }
      case 'terminal_close': streams.delete(payload.streamId); return
      case 'terminal_resize': {
        // A pane redraws at its new size, as the daemon's keyframe after a resize shows it: a demo
        // agent its screen, a terminal what it has printed, wrapped at the new width.
        const stream = streams.get(payload.streamId)
        if (stream) ws.send(frame(3, payload.streamId, stream.seq++, Buffer.from(DEMO ? demoScreen(stream.agent) : stream.screen), [payload.cols, payload.rows]))
        return
      }
      default: return // acks, alive, resize, focus: nothing to do
    }
  })
})
// Real native clients use an OS-user-owned socket. Tests supply a disposable HOME.
const mockHome = process.env.HOME || ''
if (!/^\/(?:private\/)?(?:tmp\/|var\/folders\/)/.test(mockHome)) throw new Error('mock-daemon requires a temporary HOME')
const socketDir = process.env.ADAPTER_DATA_DIR || join(mockHome, '.harness', 'cli', 'data')
if (!resolve(socketDir).startsWith(resolve(mockHome) + '/')) throw new Error('mock-daemon data must be inside its temporary HOME')
mkdirSync(socketDir, { recursive: true, mode: 0o700 })
const socketPath = join(socketDir, `daemon-${port}.sock`)
try { unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
const privateServer = http.createServer(server.listeners('request')[0])
privateServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
privateServer.listen(socketPath, () => {
  chmodSync(socketPath, 0o600)
  server.listen(port, '127.0.0.1', () => console.log(`mock daemon on ${port}`))
})
