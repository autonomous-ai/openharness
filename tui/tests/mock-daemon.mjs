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
import { chmodSync, readFileSync, unlinkSync } from 'node:fs'

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
const dial = { said: {}, replies: [], messages: [], daemon: [], acts: [], zooOps: [], zooReads: 0 }
// How many of each request the windows made (GET /test/counts), for tests of what hn asks.
const counts = {}
const windows = new Set()
// The questions open on this computer, as the daemon keeps them: replayed to a window as it
// connects, then their ids (commander_questions_open).
const openQs = new Map()
let demoAsked = false

// The account's zoo (daemons/README.md, "The zoo"), as backend/src/lib/zoo.ts keeps it — just enough
// of its rules for hn: habits grant the first egg, a hatch draws MOCK_HATCH (tim) with serial 42, a
// daemon you own merges as a duplicate (+150 xp, levels on rules.bond.levels), consent and pair.
// MOCK_ZOO: `egg` (the first egg waiting, the default), `tim` (tim paired, watching), `nest` (one
// habit, no egg), `signedout` (401, as harnessd answers with no account), `off` (the daemons switched
// off on the server: 404), `disabled` (the same switch as `{ enabled: false }`).
const ROSTER = JSON.parse(readFileSync(join(here, '../../daemons/roster.json'), 'utf8'))
let ZOO_MODE = process.env.MOCK_ZOO || 'egg'
const today = new Date().toISOString().slice(0, 10)
const zooDoc = { revision: 1, zoo: { daemons: [], eggs: [], pair: null, autonomy: 'watch', consent: null, habits: [], firstEgg: false, setupEgg: false, pity: 0, easter: [],
  progress: { turns: 12, days: { [today]: 3 }, weeks: [], nights: [], machines: [], marathon: [], history: [], held: [], batches: [], lessons: [] } } }
if (ZOO_MODE === 'egg') Object.assign(zooDoc.zoo, { habits: ['turn', 'split', 'find'], firstEgg: true, eggs: [{ id: 'egg-1', kind: 'first', grantedAt: now }] })
if (ZOO_MODE === 'nest') Object.assign(zooDoc.zoo, { habits: ['split'] })
if (ZOO_MODE === 'tim') Object.assign(zooDoc.zoo, { habits: ['turn', 'split', 'find'], firstEgg: true, pair: 'tim', consent: { watching: true, at: now },
  daemons: [{ id: 'tim', hatchedAt: '2026-09-26', egg: 'first', shiny: false, bond: 1, xp: 60, version: '0.1', serial: 42 }], eggs: [{ id: 'egg-2', kind: 'turn', grantedAt: now }] })
const levelOf = (xp) => ROSTER.rules.bond.levels.filter((at) => xp >= at).length - 1
const versionOf = (level) => Object.entries(ROSTER.rules.bondForVersion).filter(([, at]) => level >= at).map(([v]) => v).pop()
let eggs = 10
function applyZoo(ops) {
  const zoo = zooDoc.zoo
  const out = { hatched: [], grants: [], levelUps: [] }
  let changed = false
  const grant = (kind) => { const egg = { id: `egg-${++eggs}`, kind, grantedAt: new Date().toISOString() }; zoo.eggs.push(egg); out.grants.push({ kind, eggId: egg.id }) }
  for (const op of ops) {
    dial.zooOps.push(op)
    if (op.op === 'zoo.habit' && ROSTER.rules.firstEgg.habits.some((h) => h.key === op.key) && !zoo.habits.includes(op.key)) {
      zoo.habits.push(op.key); changed = true
      if (!zoo.firstEgg && zoo.habits.includes('turn') && zoo.habits.length >= ROSTER.rules.firstEgg.need) { zoo.firstEgg = true; grant('first') }
      else if (zoo.firstEgg && !zoo.setupEgg && zoo.habits.length >= ROSTER.rules.setupEgg.need) { zoo.setupEgg = true; grant('setup') }
    }
    if (op.op === 'zoo.hatch') {
      const egg = zoo.eggs.find((e) => e.id === op.eggId)
      if (!egg) continue
      zoo.eggs = zoo.eggs.filter((e) => e !== egg); changed = true
      const id = process.env.MOCK_HATCH || 'tim'
      const shiny = process.env.MOCK_SHINY === '1'
      const mine = zoo.daemons.find((d) => d.id === id)
      if (mine) {
        const before = mine.bond
        mine.xp += ROSTER.rules.duplicateXp; mine.dupes = (mine.dupes || 0) + 1; if (shiny) mine.shiny = true
        mine.bond = levelOf(mine.xp); mine.version = versionOf(mine.bond)
        out.hatched.push({ eggId: egg.id, daemonId: id, shiny, duplicate: true, xp: ROSTER.rules.duplicateXp })
        if (mine.bond > before) out.levelUps.push({ id, level: mine.bond, version: mine.version })
      } else {
        zoo.daemons.push({ id, hatchedAt: today, egg: egg.kind, shiny, bond: 0, xp: 0, version: '0.1', serial: 42 })
        out.hatched.push({ eggId: egg.id, daemonId: id, shiny, serial: 42 })
        if (!zoo.pair) zoo.pair = id
      }
    }
    if (op.op === 'zoo.consent') { zoo.consent = { watching: op.watching === true, at: new Date().toISOString() }; if (op.watching) zoo.autonomy = 'watch'; changed = true }
    if (op.op === 'zoo.pair' && zoo.daemons.some((d) => d.id === op.id)) { zoo.pair = op.id; changed = true }
    if (op.op === 'zoo.nickname') { const d = zoo.daemons.find((x) => x.id === op.id); if (d) { d.nickname = op.nickname || undefined; changed = true } }
  }
  if (changed) {
    zooDoc.revision++
    for (const ws of windows) ws.send(JSON.stringify({ type: 'zoo_changed', payload: { revision: zooDoc.revision } }))
  }
  return { ...zooDoc, ...out }
}
const signedOut = (res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, error: { code: 'NOT_SIGNED_IN', message: 'Not signed in' } })) }

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: body })) }
const handler = (req, res) => {
  // The e2e flips the server's daemons switch (POST /test/zoo-mode?mode=off), as HARNESS_DAEMONS would.
  if (req.url.startsWith('/test/zoo-mode') && req.method === 'POST') { ZOO_MODE = new URL(req.url, 'http://x').searchParams.get('mode') || 'egg'; return json(res, { mode: ZOO_MODE }) }
  if (req.url === '/api/zoo' && req.method === 'GET') dial.zooReads++
  if (req.url.startsWith('/api/zoo') && ZOO_MODE === 'off') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } })) }
  if (req.url.startsWith('/api/zoo') && ZOO_MODE === 'disabled') return json(res, { enabled: false })
  if (req.url === '/api/zoo' && req.method === 'GET') return ZOO_MODE === 'signedout' ? signedOut(res) : json(res, zooDoc)
  if (req.url === '/api/zoo/ops' && req.method === 'POST') {
    if (ZOO_MODE === 'signedout') return signedOut(res)
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { let ops = []; try { ops = JSON.parse(body || '{}').ops || [] } catch {} ; json(res, applyZoo(ops)) })
    return
  }
  if (req.url === '/api/status') return json(res, { machineId: LOCAL, signedIn: true, version: 'mock' })
  if (req.url === '/api/machines') return json(res, { machines: [
    { machineId: LOCAL, name: DEMO ? 'studio' : 'mock-local', status: 'running' },
    { machineId: REMOTE, name: DEMO ? 'gpu-box' : 'mock-remote', status: 'running' },
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
    req.on('end', () => {
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
}
const server = http.createServer(handler)

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

// harnessd's Unix socket beside the port (cli/src/lib/localSocket.ts), in ADAPTER_DATA_DIR when the
// test gives one: a connection over it is this user's (trusted); the pair brain's frames are taken
// only there (LOCAL_SOCKET_REQUIRED over TCP), as the real daemon takes them.
const wss = new WebSocketServer({ noServer: true })
const upgrade = (trusted) => (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== '/api/local-ws') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, trusted))
}
server.on('upgrade', upgrade(false))
if (process.env.ADAPTER_DATA_DIR) {
  const sockPath = join(process.env.ADAPTER_DATA_DIR, `daemon-${port}.sock`)
  try { unlinkSync(sockPath) } catch {}
  const local = http.createServer(handler)
  local.on('upgrade', upgrade(true))
  local.on('error', (e) => console.error(`no socket at ${sockPath}: ${e.message}`))
  local.listen(sockPath, () => { try { chmodSync(sockPath, 0o600) } catch {} })
  process.on('exit', () => { try { unlinkSync(sockPath) } catch {} })
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0))
}
wss.on('connection', (ws, req, trusted) => {
  let machine = null
  const streams = new Map() // streamId → { seq, agent }
  const shown = new Map() // a daemon line's id → when this connection said it drew it
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
      stream.screen += text
      ws.send(frame(2, streamId, stream.seq++, Buffer.from(text)))
      return
    }
    const { type, payload = {} } = JSON.parse(String(raw))
    // The pair brain's frames (daemons/BRAIN.md "Security"): only over the socket; a key only on a
    // line this connection acknowledged as drawn at least 400 ms before.
    if (type.startsWith('daemon_')) {
      dial.daemon.push({ type, trusted: !!trusted, machine, at: Date.now(), ...payload })
      const result = { daemon_act: 'daemon_act_result', daemon_talk: 'daemon_talk_result', daemon_confirm: 'daemon_confirm_result' }[type]
      const answer = (body) => result && send(result, { requestId: payload.requestId, ...(type === 'daemon_act' ? { id: payload.id } : {}), ...(type === 'daemon_confirm' ? { kind: payload.kind, nonce: payload.nonce } : {}), ...body })
      if (!trusted) return answer({ ok: false, error: 'LOCAL_SOCKET_REQUIRED' })
      if (type === 'daemon_shown') { shown.set(payload.id, Date.now()); return }
      if (type === 'daemon_presence') return
      if (type === 'daemon_talk') {
        answer({ ok: true, started: true, agentId: 'pair-harness', cost: 'each talk is a turn of your own engine' })
        setTimeout(() => send('daemon_say', { id: `pair-say-${Date.now()}`, about: { machineId: LOCAL, agentId: '' }, mood: 'say', from: 'pair', line: `heard you: ${payload.text}`, actions: [], ttlMs: 5200 }), 150)
        return
      }
      const key = type === 'daemon_confirm' ? `confirm:${payload.nonce}` : payload.id
      const at = shown.get(type === 'daemon_confirm' ? payload.id ?? key : payload.id) ?? shown.get(key)
      if (at === undefined) return answer({ ok: false, error: 'NOT_SHOWN' })
      if (Date.now() - at < 400) return answer({ ok: false, error: 'TOO_SOON' })
      if (type === 'daemon_confirm') return answer({ ok: true, accepted: payload.accept === true })
      dial.acts.push({ id: payload.id, choice: payload.choice })
      answer({ ok: true, machineId: LOCAL })
      send('daemon_unsay', { id: payload.id, reason: 'answered' })
      return
    }
    if (type === 'machine_select') {
      machine = payload.machineId
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
      case 'dsh_list': return reply({ dsh: [] })
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
      case 'fs_list_dir': return reply({ path: '/home/demo', entries: [] })
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
      case 'agent_create': {
        dial.created = [...(dial.created || []), payload]
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
        const target = agents[machine].find((a) => a.id === payload.agentId)
        if (!target || target.status !== 'active') return send('terminal_error', { requestId: payload.requestId, code: 'TERMINAL_AGENT_NOT_FOUND' })
        const streamId = randomUUID()
        // MOCK_BANNER: bytes a terminal prints before its prompt (a test's colours, say).
        const banner = (process.env.MOCK_BANNER || '').replace(/\\e/g, '\x1b').replace(/\\r\\n/g, '\r\n')
        // MOCK_PLAIN: a terminal that is only its prompt.
        const screen = DEMO ? demoScreen(target) : process.env.MOCK_PLAIN ? '\x1bc$ ' : `\x1bc${target.name} (mock)\r\n${banner}$ `
        streams.set(streamId, { seq: 1, agent: target, screen })
        send('terminal_ready', { requestId: payload.requestId, streamId, agentId: target.id, readOnly: false })
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
server.listen(port, '127.0.0.1', () => console.log(`mock daemon on ${port}`))
