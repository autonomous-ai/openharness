// Positive E2E for the relay default-deny gate (OH-1 / OH-10): the requests that used to cross the relay
// in the clear still work once they go sealed. Drives the local daemon over its loopback WS — the same
// transport the desktop uses — against a machine it relays to, so every frame goes through this
// daemon's `relayClient` envelope and the far daemon's gate.
//
//   E2E_BOX=machine-remote-1 npx tsx scripts/relay-sealed-e2e.mts <machineId> [label]
//
// A request refused with E2EE_REQUIRED means one end is older than strictDown (or wraps wrong).
// With E2E_BOX set, a typed `message` is also proven to reach the far daemon's handler, by its log.
// Leaves nothing behind: the dsh_install points at a port nothing listens on and the agent is removed.
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const machineId = process.argv[2]
const label = process.argv[3] ?? machineId?.slice(0, 8)
const box = process.env.E2E_BOX
if (!machineId) throw new Error('machineId required')
const log = (m: string) => console.log(`[${label}] ${m}`)
let failures = 0
const check = (ok: boolean, m: string) => { log(`${ok ? 'ok  ' : 'FAIL'} ${m}`); if (!ok) failures++ }

const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
const frames: Array<Record<string, any>> = []
ws.on('message', (raw, isBinary) => { if (!isBinary) frames.push(JSON.parse(raw.toString())) })
await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
const send = (type: string, payload: Record<string, unknown>) => ws.send(JSON.stringify({ type, payload }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (test: (f: Record<string, any>) => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = frames.find(test)
    if (hit) return hit
    await sleep(100)
  }
  return null
}
const rpc = async (type: string, payload: Record<string, unknown>, ms = 60_000) => {
  const requestId = randomUUID()
  send(type, { requestId, ...payload })
  const r = await waitFor((f) => f.type === `${type}_result` && f.payload?.requestId === requestId, ms)
  return (r?.payload ?? { error: 'TIMEOUT' }) as Record<string, any>
}

send('machine_select', { machineId, localProtocolVersion: 1 })
if (!await waitFor((f) => f.type === 'connected', 20_000)) { log('FAIL not connected'); process.exit(2) }
log('connected')

const list = await rpc('dsh_list', {})
check(Array.isArray(list.dsh), `dsh_list → ${list.error ?? `${list.dsh?.length} harnesses`}`)
const probe = await rpc('engines_probe', {})
check(Array.isArray(probe.engines), `engines_probe → ${probe.error ?? `${probe.engines?.length} engines`}`)
const grid = await rpc('grid_models_list', {})
check(grid.error !== 'E2EE_REQUIRED' && grid.error !== 'TIMEOUT', `grid_models_list → ${grid.error ?? 'answered'}`)
const retarget = await rpc('agent_retarget', { agentId: 'relay-sealed-e2e', clearGrid: true })
check(retarget.error === 'AGENT_NOT_FOUND', `agent_retarget (unknown agent) → ${retarget.error ?? 'ok'} (reached the handler)`)
const install = await rpc('dsh_install', { url: 'https://127.0.0.1:1/relay-sealed-e2e.git' })
check(install.error === 'CLONE_FAILED', `dsh_install (dead url) → ${install.error ?? 'ok'} (reached the handler)`)

// A typed turn, sealed. A shell agent has no agent process to type into, so the proof is the far
// daemon's own `[msg] recv` line: the gate opened the frame and handed it to the message handler.
const created = await rpc('agent_create', { engine: 'terminal', cwd: '/tmp' })
if (created.error) { check(false, `agent_create → ${created.error}`) } else {
  const agentId: string = created.agent.id
  const recvCount = () => box
    ? Number(execFileSync('docker', ['exec', box, 'sh', '-c', 'grep -ac "\\[msg\\]  recv" ~/.harness/cli/data/harness.log || true'], { encoding: 'utf8' }).trim())
    : 0
  const before = recvCount()
  send('message', { agentId, content: 'echo relay-sealed-e2e' })
  if (box) {
    let after = before
    for (let i = 0; i < 20 && after === before; i++) { await sleep(500); after = recvCount() }
    check(after > before, `message → ${after > before ? 'received by the far daemon' : 'never reached the message handler'}`)
  } else {
    log('skip message check (set E2E_BOX to read the box log)')
  }
  const removed = await rpc('agent_delete', { agentId })
  if (removed.error) log(`cleanup agent_delete → ${removed.error} (left behind: ${agentId})`)
}

ws.close()
log(failures ? `FAIL ${failures} check(s)` : 'PASS')
process.exit(failures ? 1 : 0)
