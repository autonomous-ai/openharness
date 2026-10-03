// Isolated protocol fixture for workspace-controls.py. No credentials, devices, agent CLIs,
// or remote connections are used. Its HTTP control API is restricted to disposable test ports.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chmodSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../cli/package.json'))
const { WebSocketServer } = require('ws')
const port = Number(process.argv[2])
const home = process.env.HOME || ''
if (!(port >= 19920 && port <= 19929) || !/^\/(?:private\/)?tmp\/hn-workspace-/.test(home)) throw new Error('unsafe workspace fixture')
const LOCAL = 'workspace0000000000000000000001', REMOTE = 'workspace0000000000000000000002'
const stamp = new Date().toISOString()
const makeAgent = (id, name, engine, cwd = '/work/alpha') => ({ id, sessionId: `session-${id}`, createdAt: stamp,
  updatedAt: stamp, name, engine, status: 'active', closeSupported: true, canPauseAndResume: true,
  terminal: { available: true }, launch: { state: 'ready' }, permissionMode: 'readOnly',
  selectedModel: `runtime-v1:${id}:${engine}:${engine === 'codex' ? 'gpt-6-astra' : 'opus'}@high`,
  project: { name: cwd.split('/').pop(), cwd, root: cwd, branch: 'feature/mouse' } })
const agents = { [LOCAL]: [makeAgent('alpha', 'Alpha task', 'codex'), makeAgent('beta', 'Beta task', 'claude')],
  [REMOTE]: [makeAgent('gamma', 'Gamma remote task', 'codex', '/work/remote')] }
const ref = (machineId, agentId) => ({ machineId, agentId })
let desk = { revision: 1, tabs: [
  { id: 'workspace', name: 'Workspace', nameIsCustom: true, panes: [ref(LOCAL, 'alpha'), ref(LOCAL, 'beta')], layout: {} },
  { id: 'remote', name: 'Remote', nameIsCustom: true, panes: [ref(REMOTE, 'gamma')], layout: {} },
] }
const settings = brightness => ({ brightness, character: 2, face: 360, muted: false, quiet: false,
  straightTitle: false, focusFace: true, scrollReversed: false, round: true, voiceLang: 'en' })
const device = brightness => ({ attached: true, id: 'same-usb', mac: 'AA:BB:CC', fw: '1.0.0-fixture', hw: 'cst9217+axp2101', settings: settings(brightness) })
const hardware = { [LOCAL]: { revision: 1, devices: [device(40)] }, [REMOTE]: { revision: 1, devices: [device(70)] } }
const status = machine => ({ attached: hardware[machine].devices.some(d => d.attached), devices: hardware[machine].devices })
const state = { requests: [], inputs: [], operations: [], deskAttempts: [], deskOwners: [], currentLocal: LOCAL, visibleMachines: [LOCAL, REMOTE], activities: { alpha: 'idle', beta: 'working', gamma: 'idle' },
  closeFailure: null, closeDelay: 0, pruneOnClose: false, loseCreateReply: false, deviceConfirm: true, deviceDelay: 1500, modelDelay: 0, deskFailures: 0, deskNoops: 0 }
const peers = new Set(), receipts = new Map()
function send(ws, type, payload) { if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload })) }
function broadcast(machine, type, payload) { for (const p of peers) if (!machine || p.machine === machine) send(p.ws, type, payload) }
function deskChanged() { desk.revision++; broadcast(state.currentLocal, 'desk_changed', { revision: desk.revision }) }
function json(res, data, code = 200) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: code === 200, data })) }
async function body(req) { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {} }
const signedIn = () => { try { return JSON.parse(readFileSync(join(home, 'account.json'), 'utf8')).loggedIn === true } catch { return false } }

const server = http.createServer(async (req, res) => {
  if (req.url === '/test' && req.method === 'GET') return json(res, { ...state, agents, desk, hardware, local: state.currentLocal, remote: REMOTE, peers: [...peers].map(p => p.machine) })
  if (req.url === '/test' && req.method === 'POST') {
    const update = await body(req)
    if (update.action === 'identity') {
      if (!/^workspace0+[34]$/.test(update.machine)) throw new Error('unsafe fixture identity')
      const previous = state.currentLocal
      agents[update.machine] = update.keepLocal ? agents[previous] : [makeAgent('other-account', 'Other account task', 'codex', '/work/other')]
      hardware[update.machine] = structuredClone(hardware[previous])
      state.currentLocal = update.machine; state.visibleMachines = [update.machine]
      desk = { revision: 1, tabs: update.keepLocal ? [] : [{ id: 'other-account-tab', name: 'Other account', nameIsCustom: true, panes: [ref(update.machine, 'other-account')], layout: {} }] }
      for (const peer of peers) peer.ws.terminate()
    } else if (update.action === 'machines') {
      state.visibleMachines = update.remote ? [state.currentLocal, REMOTE] : [state.currentLocal]
      broadcast(state.currentLocal, 'machines_changed', {})
    } else if (update.action === 'desk-refresh') deskChanged()
    else if (update.action === 'disconnect') { for (const peer of peers) if (peer.machine === update.machine) peer.ws.terminate() }
    else if (update.action === 'activity') state.activities[update.agent] = update.activity
    else if (update.action === 'device') {
      Object.assign(hardware[update.machine].devices[0], update.patch)
      hardware[update.machine].revision++
      broadcast(update.machine, 'harness_devices_changed', { status: status(update.machine), revision: hardware[update.machine].revision })
    } else if (update.action === 'terminal-mouse') for (const peer of peers) for (const [streamId, stream] of peer.streams) {
      peer.ws.send(frame(2, streamId, stream.seq++, Buffer.from('\x1b[?1000h\x1b[?1006h')))
    } else if (update.action === 'config') for (const [key, value] of Object.entries(update.patch || {})) {
      if (['closeFailure', 'closeDelay', 'pruneOnClose', 'loseCreateReply', 'deviceConfirm', 'deviceDelay', 'modelDelay', 'deskFailures', 'deskNoops'].includes(key)) state[key] = value
    }
    return json(res, { ok: true })
  }
  if (req.url === '/api/status') return json(res, { machineId: state.currentLocal, computerId: LOCAL, signedIn: signedIn(), version: 'workspace-fixture' })
  if (req.url === '/api/machines') return json(res, { machines: state.visibleMachines.map(machineId => ({ machineId, name: machineId === state.currentLocal ? 'Studio' : 'Remote', status: 'running' })) })
  if (req.url === '/api/auth/me') return json(res, { user: signedIn() ? { id: state.currentLocal, email: state.currentLocal.endsWith('4') ? 'other@example.test' : 'review@example.test' } : null })
  if (req.url === '/api/desk' && req.method === 'GET') return json(res, desk)
  if (req.url === '/api/desk/ops') {
    const { ops = [] } = await body(req); state.deskAttempts.push(ops)
    state.deskOwners.push({ machine: state.currentLocal, ops })
    if (state.deskFailures > 0) { state.deskFailures--; return json(res, { error: 'FIXTURE_OFFLINE' }, 503) }
    if (state.deskNoops > 0 && ops.some(op => op.op === 'pane.add')) { state.deskNoops--; return json(res, desk) }
    state.operations.push(...ops)
    const tab = id => desk.tabs.find(t => t.id === id)
    for (const op of ops) {
      if (op.op === 'tab.create' && !tab(op.id)) desk.tabs.splice(Math.min(op.index ?? desk.tabs.length, desk.tabs.length), 0, { id: op.id, name: op.name, nameIsCustom: !!op.nameIsCustom, panes: [], layout: {} })
      if (op.op === 'tab.close') desk.tabs = desk.tabs.filter(t => t.id !== op.id)
      if (op.op === 'tab.rename' && tab(op.id)) Object.assign(tab(op.id), { name: op.name, nameIsCustom: !!op.nameIsCustom })
      if (op.op === 'tab.layout' && tab(op.id)) tab(op.id).layout = op.layout
      if (op.op === 'pane.add') { const t = tab(op.tabId); if (t && !t.panes.some(p => p.machineId === op.machineId && p.agentId === op.agentId)) t.panes.splice(Math.min(op.index ?? t.panes.length, t.panes.length), 0, ref(op.machineId, op.agentId)) }
      if (op.op === 'pane.remove' && tab(op.tabId)) tab(op.tabId).panes = tab(op.tabId).panes.filter(p => p.machineId !== op.machineId || p.agentId !== op.agentId)
    }
    deskChanged(); return json(res, desk)
  }
  json(res, { error: 'NOT_FOUND' }, 404)
})

function frame(kind, streamId, seq, bytes, size) {
  const meta = Buffer.alloc(kind === 3 ? 28 : 24)
  Buffer.from(streamId.replaceAll('-', ''), 'hex').copy(meta)
  meta.writeBigUInt64BE(BigInt(seq), 16)
  if (size) { meta.writeUInt16BE(size[0], 24); meta.writeUInt16BE(size[1], 26) }
  const payload = Buffer.concat([meta, bytes]), header = Buffer.from([0x48, 0x54, 0x52, 0x4c, 1, kind, 0, 0, 0, 0, 0, 0])
  header.writeUInt32BE(payload.length, 8); return Buffer.concat([header, payload])
}
const wss = new WebSocketServer({ server, path: '/api/local-ws' })
wss.on('connection', ws => {
  const peer = { ws, machine: null, streams: new Map() }; peers.add(peer)
  ws.on('close', () => peers.delete(peer))
  ws.on('message', (raw, binary) => {
    if (binary) {
      const bytes = Buffer.from(raw); if (bytes.length < 36) return
      const streamId = bytes.subarray(12, 28).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
      const stream = peer.streams.get(streamId); if (!stream) return
      const text = bytes.subarray(36).toString(); state.inputs.push({ machine: peer.machine, agent: stream.agent, text })
      ws.send(frame(2, streamId, stream.seq++, Buffer.from(text.replace(/\r/g, '\r\n$ ')))); return
    }
    const { type, payload = {} } = JSON.parse(String(raw))
    if (type === 'machine_select') {
      if (!state.visibleMachines.includes(payload.machineId)) return ws.close(4403, 'fixture machine mismatch')
      peer.machine = payload.machineId
      send(ws, 'connected', { machineId: peer.machine, transport: 'local', localProtocolVersion: 1 })
      if (peer.machine === state.currentLocal) send(ws, 'dial_status', status(peer.machine))
      return
    }
    if (!peer.machine) return
    const machine = peer.machine, roster = agents[machine], target = roster.find(a => a.id === payload.agentId)
    const reply = data => send(ws, `${type}_result`, { requestId: payload.requestId, ...data })
    state.requests.push({ machine, type, payload })
    switch (type) {
      case 'agents_list': return reply({ agents: roster.filter(a => payload.includeStopped || a.status !== 'stopped') })
      case 'fs_list_dir': return reply({ path: payload.path || '/work', entries: [{ name: 'alpha', isDir: true }, { name: 'remote', isDir: true }] })
      case 'git_project_info': return reply({ isGit: true, branch: 'feature/mouse', branches: [{ name: 'main', ref: 'refs/heads/main', remote: false }] })
      case 'git_pull_request': return reply({ status: 'none' })
      case 'theme_set': return reply({ ok: true })
      case 'dsh_list': return reply({ dsh: [] })
      case 'codex_profiles_list': return reply({ profiles: [] })
      case 'models_list': return reply({ models: [] })
      case 'session_search': return reply({ hits: [], ready: true, indexed: 0, pending: 0 })
      case 'usage_read': return reply({ providers: [] })
      case 'api_connections': return reply({ connections: [], presets: [] })
      case 'grid_fleet_models_list': return reply({ models: [{ id: 'fixture-qwen', name: 'Fixture local model', state: 'running', canStop: true, quant: 'Q4_K_M', app: 'Grid' }], supportsDownload: true })
      case 'grid_models_list': return reply({ supportsModelLaunch: true, localModelEngines: ['codex', 'claude'], grids: [{ name: 'Studio', own: true, models: [{ id: 'fixture-qwen', node: 'Studio' }] }] })
      case 'agent_retarget': {
        if (!target) return reply({ error: 'AGENT_NOT_FOUND' })
        target.grid = { model: payload.gridModel, baseUrl: 'http://fixture.invalid/v1' }
        return setTimeout(() => { broadcast(machine, 'agent_synced', { agent: target }); reply({ ok: true }) }, state.modelDelay)
      }
      case 'agent_recent': return reply({ agentId: payload.agentId, asks: ['Preserve the current project.'], events: [{ kind: 'summary', text: 'The project is ready for the next step.' }] })
      case 'agent_handoff_prepare': return reply({ agentId: payload.agentId, degraded: [], file: `.harness/handoff/${payload.agentId}-${payload.changeId}.md`, cwd: target?.project.cwd, gitRepo: true })
      case 'agent_close': {
        if (!target || target.sessionId !== payload.sessionId || target.createdAt !== payload.createdAt) return reply({ error: 'SESSION_CHANGED' })
        const activity = state.activities[target.id] || 'idle'
        if (payload.mode === 'inspect') return reply({ activity, closed: target.status === 'stopped' })
        if (state.closeFailure) return reply({ error: state.closeFailure, detail: 'Fixture could not save this conversation' })
        if (payload.mode === 'idle' && activity !== 'idle') return reply({ error: 'SESSION_NOT_IDLE', activity })
        target.status = 'stopped'; target.terminal.available = false
        broadcast(machine, 'agent_deleted', { agentId: target.id })
        if (state.pruneOnClose) { for (const tab of desk.tabs) tab.panes = tab.panes.filter(p => p.agentId !== target.id); desk.tabs = desk.tabs.filter(t => t.panes.length); deskChanged() }
        return setTimeout(() => reply({ closed: true, activity }), state.closeDelay)
      }
      case 'agent_create': {
        if (receipts.has(payload.creationId)) return reply(receipts.get(payload.creationId))
        const made = makeAgent(randomUUID(), payload.name || `New ${payload.engine}`, payload.engine, payload.cwd)
        made.permissionMode = payload.permissionMode; roster.push(made)
        const receipt = { creationId: payload.creationId, state: 'created', agent: made }; receipts.set(payload.creationId, receipt)
        if (state.loseCreateReply) { state.loseCreateReply = false; return ws.terminate() }
        return reply(receipt)
      }
      case 'agent_create_status': return reply(receipts.get(payload.creationId) || { creationId: payload.creationId, state: 'missing' })
      case 'harness_devices_list': return reply({ status: status(machine), revision: hardware[machine].revision })
      case 'harness_device_settings': {
        const d = hardware[machine].devices.find(d => d.id === payload.id)
        if (!d?.attached || d.updating) return reply({ error: 'DEVICE_OFFLINE' })
        reply({ ok: true, status: status(machine), revision: hardware[machine].revision })
        if (state.deviceConfirm) setTimeout(() => {
          if (!d.attached || d.updating) return
          Object.assign(d.settings, payload.patch); hardware[machine].revision++
          broadcast(machine, 'harness_devices_changed', { status: status(machine), revision: hardware[machine].revision })
        }, state.deviceDelay)
        return
      }
      case 'terminal_open': {
        if (!target || target.status === 'stopped') return send(ws, 'terminal_error', { requestId: payload.requestId, code: 'TERMINAL_AGENT_NOT_FOUND' })
        const id = randomUUID(), screen = `\x1bc${target.name} terminal\r\nThis is a disposable test harness.\r\n\r\n$ `
        peer.streams.set(id, { agent: target.id, screen, seq: 1 })
        send(ws, 'terminal_ready', { requestId: payload.requestId, streamId: id, agentId: target.id, readOnly: false })
        return ws.send(frame(3, id, 0, Buffer.from(screen), [payload.cols, payload.rows]))
      }
      case 'terminal_resize': {
        const s = peer.streams.get(payload.streamId)
        if (s) ws.send(frame(3, payload.streamId, s.seq++, Buffer.from(s.screen), [payload.cols, payload.rows]))
        return
      }
      case 'terminal_close': peer.streams.delete(payload.streamId); return
      default: if (payload.requestId) reply({ error: 'UNSUPPORTED' })
    }
  })
})
const socketDir = join(home, '.harness/cli/data')
if (!resolve(socketDir).startsWith(resolve(home) + '/')) throw new Error('unsafe socket directory')
mkdirSync(socketDir, { recursive: true, mode: 0o700 })
const socketPath = join(socketDir, `daemon-${port}.sock`)
try { unlinkSync(socketPath) } catch (e) { if (e.code !== 'ENOENT') throw e }
const privateServer = http.createServer(server.listeners('request')[0])
privateServer.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)))
privateServer.listen(socketPath, () => { chmodSync(socketPath, 0o600); server.listen(port, '127.0.0.1') })
