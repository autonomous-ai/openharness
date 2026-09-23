// End-to-end check of Harness Monitor's Pause/Resume against a RUNNING daemon, over its loopback WS
// — the same transport the desktop app uses — for this machine or one it relays to (a docker box).
//
//   npx tsx scripts/pause-resume-e2e.mts <machineId> [label] [engine]
//
// Pause is `agent_delete` (stop, conversation saved first) and Resume is `agent_resume`, exactly as
// the desktop sends them. The engine defaults to `terminal`, which every machine has; pass another
// (`opencode`, `claude`, …) to exercise a real conversation. What this proves:
//
//   * `agents_list` carries `resumeMode` for the engine — the capability the desktop words its
//     button from, and the thing that used to be an allow-list copied into the client.
//   * Pause archives the row: it comes back in the list as `status: stopped`, still carrying
//     `resumeMode`, so the paused row can still offer Resume.
//   * Resume brings it back on the same pane/folder, and says whether it reopened the conversation
//     (`resumed`) rather than failing when it could not.
//
// A relayed machine runs every frame through the daemon's E2EE envelope, so passing against a
// docker box is what proves the remote half. Leaves nothing behind on a pass.
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'

const machineId = process.argv[2]
const label = process.argv[3] ?? machineId?.slice(0, 8)
const engine = process.argv[4] ?? 'terminal'
if (!machineId) throw new Error('machineId required')
const log = (m: string) => console.log(`[${label}] ${new Date().toISOString().slice(11, 19)} ${m}`)
const fail = (m: string): never => { console.error(`[${label}] FAIL ${m}`); process.exit(1) }

const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')
const frames: Array<Record<string, any>> = []
const waiters: Array<{ test: (f: Record<string, any>) => boolean; resolve: (f: Record<string, any>) => void }> = []
ws.on('close', (code, reason) => log(`ws closed ${code} ${reason.toString()}`))
ws.on('message', (raw, isBinary) => {
  if (isBinary) return
  const f = JSON.parse(raw.toString()) as Record<string, any>
  frames.push(f)
  for (const w of [...waiters]) if (w.test(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f) }
})
const send = (type: string, payload: Record<string, unknown>) => ws.send(JSON.stringify({ type, payload }))
const waitFor = (test: (f: Record<string, any>) => boolean, ms = 20_000, what = 'frame'): Promise<Record<string, any>> =>
  new Promise((resolve, reject) => {
    const hit = frames.find(test)
    if (hit) return resolve(hit)
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms)
    waiters.push({ test, resolve: (f) => { clearTimeout(t); resolve(f) } })
  })
const rpc = async (type: string, payload: Record<string, unknown>, ms = 60_000) => {
  const requestId = randomUUID()
  send(type, { requestId, ...payload })
  const r = await waitFor((f) => f.type === `${type}_result` && f.payload?.requestId === requestId, ms, `${type}_result`)
  return r.payload as Record<string, any>
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rowOf = async (agentId: string): Promise<Record<string, any> | undefined> => {
  const list = await rpc('agents_list', { includeStopped: true })
  return (list.agents as any[]).find((a) => a.id === agentId)
}
/** The list is refreshed by the daemon's own scans; a state change is not instant. */
const pollRow = async (agentId: string, want: (row: Record<string, any> | undefined) => boolean, ms: number, what: string) => {
  const until = Date.now() + ms
  let last: Record<string, any> | undefined
  while (Date.now() < until) {
    last = await rowOf(agentId)
    if (want(last)) return last
    await sleep(1000)
  }
  return fail(`${what} did not happen within ${ms}ms · last row: ${JSON.stringify(last)}`)
}

await new Promise<void>((resolve) => ws.on('open', () => resolve()))
send('machine_select', { machineId, localProtocolVersion: 1 })
await waitFor((f) => f.type === 'connected', 20_000, 'connected')
log(`connected · engine=${engine}`)

const cwd = process.env.E2E_CWD ?? '/tmp'
// A first prompt, because an engine that has not been spoken to has no conversation to archive —
// and then the pause/resume under test is only ever the fresh path. `E2E_PROMPT=` (empty) skips it.
const prompt = engine === 'terminal' ? undefined : (process.env.E2E_PROMPT ?? 'reply with the single word: ok')
const created = await rpc('agent_create', { engine, cwd, bypassPermission: true, ...(prompt ? { prompt } : {}) }, 60_000)
if (created.error) fail(`agent_create → ${created.error} ${created.detail ?? ''}`)
const agentId: string = created.agent.id
log(`created ${engine} ${agentId.slice(0, 8)} · resumeMode=${created.agent.resumeMode}`)
if (!created.agent.resumeMode) fail('agent_create result carries no resumeMode — the daemon is older than this check')

let live = await pollRow(agentId, (r) => !!r && r.status !== 'stopped', 45_000, 'agent appears live')
// Give the engine a moment to bind a conversation, so the pause has one to archive and the resume
// takes the exact-conversation path rather than the fresh one. Not fatal if it never does: pausing
// an engine that never bound is a case in its own right, and the resume says `resumed: false`.
if (engine !== 'terminal') {
  const until = Date.now() + Number(process.env.E2E_BIND_MS ?? 45_000)
  while (Date.now() < until && !(live?.sessionId)) {
    await sleep(2000)
    live = await rowOf(agentId)
  }
  if (!live?.sessionId) log('no conversation bound yet — this run exercises the fresh-resume path')
}
log(`live · status=${live!.status} resumeMode=${live!.resumeMode} sessionId=${(live!.sessionId ?? '').slice(0, 8) || '-'}`)
if (live!.resumeMode !== created.agent.resumeMode) fail(`resumeMode changed between create and list: ${created.agent.resumeMode} → ${live!.resumeMode}`)
const wantedConversation = !!live!.sessionId && live!.resumeMode === 'conversation'

// ── Pause ────────────────────────────────────────────────────────────────────
const stopped = await rpc('agent_delete', { agentId }, 60_000)
if (stopped.error) fail(`agent_delete (pause) → ${stopped.error} ${stopped.detail ?? ''}`)
log('paused')
const archived = await pollRow(agentId, (r) => r?.status === 'stopped', 45_000, 'row archives as stopped')
log(`archived · resumeMode=${archived!.resumeMode} sessionId=${(archived!.sessionId ?? '').slice(0, 8) || '-'}`)
if (!archived!.resumeMode) fail('the paused row lost resumeMode — the desktop would grey out Resume')

// ── Resume ───────────────────────────────────────────────────────────────────
const creationId = randomUUID()
let resumed = await rpc('agent_resume', { agentId, creationId }, 120_000)
// A resume that outlives its reply is checked the way the desktop checks it.
for (let i = 0; resumed.state === 'unconfirmed' && i < 20; i++) {
  await sleep(3000)
  resumed = await rpc('agent_create_status', { creationId }, 60_000)
}
if (resumed.error) fail(`agent_resume → ${resumed.error} ${resumed.detail ?? ''}`)
log(`resumed · state=${resumed.state} resumed=${resumed.resumed} sessionId=${(resumed.agent?.sessionId ?? '').slice(0, 8) || '-'}`)
// The promise the button makes. A shell is exempt from the second half: `resumed` there means the
// pane came back, which is the whole of what a shell resume is (`resumeAgentService`'s terminal
// branch), and `resumeMode: 'shell'` is what already tells a client there is no conversation.
if (wantedConversation && resumed.resumed !== true) fail(`a recorded conversation was not reopened (resumed=${resumed.resumed})`)
if (!wantedConversation && live!.resumeMode !== 'shell' && resumed.resumed === true) {
  fail('claimed to reopen a conversation that was never recorded')
}
const back = await pollRow(agentId, (r) => !!r && r.status !== 'stopped', 60_000, 'row comes back live')
if (back!.cwd && live!.cwd && back!.cwd !== live!.cwd) fail(`came back in another folder: ${live!.cwd} → ${back!.cwd}`)
log(`back · status=${back!.status} cwd=${back!.cwd} resumeMode=${back!.resumeMode}`)

// ── Clean up ─────────────────────────────────────────────────────────────────
const removed = await rpc('agent_delete', { agentId }, 60_000)
if (removed.error) log(`cleanup agent_delete → ${removed.error} (left behind: ${agentId})`)
log('PASS')
ws.close()
process.exit(0)
