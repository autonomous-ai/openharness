// Snapshot the desk as ⌘B sends it (desktop/lib/state/task_route.dart taskRouteChoices + warmTaskRoute):
// every connected machine; live sessions and stopped ones active in the last 7 days that can resume
// (claude/codex with a sessionId); never terminals. Each with its last 2 asks and its last 3 turn recaps
// (recap || text, each ≤140, joined " / "), as agent_recent n:3, its machine and its conversation.
// Reads this computer's daemon (127.0.0.1:18473) and the machines it reaches; changes nothing.
// usage: node scripts/route-eval/collect.mjs <desk.json>
import { writeFileSync } from 'node:fs'
const AUTO = /^(?:(?:harness|agent)-[1-9]\d*|.+ harness \d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?)$/
const machines = JSON.parse(await (await fetch('http://127.0.0.1:18473/api/machines')).text())
const rows = (machines.data ?? machines).machines ?? machines.data ?? machines
const live = rows.filter((m) => (m.online ?? m.status) === 'running' || m.online === true)
const out = []
for (const m of live) {
  const machineId = m.machineId ?? m.id
  const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
  const pending = new Map(); let n = 0
  const opened = await Promise.race([new Promise((r) => { ws.onopen = () => r(true) }), new Promise((r) => setTimeout(() => r(false), 5000))])
  if (!opened) { console.log('no connection to', m.name); continue }
  ws.onmessage = (e) => { if (typeof e.data !== 'string') return; const msg = JSON.parse(e.data); const r = pending.get(msg.payload?.requestId); if (r) { pending.delete(msg.payload.requestId); r(msg.payload) } }
  const ask = (type, payload = {}, ms = 8000) => new Promise((resolve) => { const requestId = `p${++n}`; pending.set(requestId, resolve); ws.send(JSON.stringify({ type, payload: { ...payload, requestId } })); setTimeout(() => resolve({}), ms) })
  ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } }))
  await new Promise((r) => setTimeout(r, 1000))
  const agents = (await ask('agents_list', { includeStopped: true })).agents ?? []
  const week = Date.now() - 7 * 86400000
  const picked = []
  for (const a of agents) {
    if (!a.engine || a.engine === 'terminal') continue
    const at = Date.parse(a.updatedAt ?? '') || 0
    const stopped = a.status === 'stopped'
    if (stopped && !((a.engine === 'claude' || a.engine === 'codex') && a.sessionId && at > week)) continue
    picked.push({ a, at, stopped })
  }
  await Promise.all(picked.map(async ({ a, at, stopped }) => {
    const recent = await ask('agent_recent', { agentId: a.id, n: 3 }, 4000)
    const turns = (recent.events ?? []).map((e) => (e.recap ?? e.text ?? '')).filter((t) => typeof t === 'string').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3)
    const name = AUTO.test(a.name ?? '') ? (a.title?.trim() || 'Untitled Pane') : a.name
    out.push({ id: `${machineId}\n${a.id}`, name, machine: m.name, engine: a.engine, at,
      asks: (recent.asks ?? []).filter((s) => typeof s === 'string' && s).slice(0, 2),
      ...(turns.length ? { about: turns.map((t) => t.length <= 140 ? t : t.slice(0, 140)).join(' / ') } : {}),
      ...(stopped ? { stoppedAgoMs: Math.max(0, Date.now() - at) } : {}),
      folder: a.project?.cwd ?? '', ...(a.sessionId ? { conversation: a.sessionId } : {}) })
  }))
  console.log(m.name, picked.length)
  ws.close()
}
out.sort((a, b) => (b.at || 0) - (a.at || 0))
writeFileSync(process.argv[2], JSON.stringify(out, null, 1))
console.log('total', out.length, '→ offered', Math.min(40, out.length))
process.exit(0)
