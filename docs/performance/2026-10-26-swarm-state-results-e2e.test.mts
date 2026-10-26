// Reference: the isolated end-to-end run behind docs/performance/2026-10-26-swarm-state-results.md ("Isolated end to
// end"), #1726 group 6. Not part of any suite; kept so its figures can be traced. It needs group 3's local backend
// recipe running first (MongoDB replica set on 127.0.0.1:27117, Redis on :16379, the fake sign-in on :18990, the backend
// on :18085). The fake sign-in must know the three tokens below: the recipe's owner and peer, plus an outsider
// (local-outsider-token, outsider@local.test). It uses port 18086 for its counting proxy. It starts one isolated daemon from
// the CLI's end-to-end harness (throwaway home and data, private tmux, a free port; never 18473, the everyday daemon's)
// and never reaches any host but 127.0.0.1. From cli/:
//
//   E2E_OUT=<file.json> npx vitest run --root ../docs/performance --globals --testTimeout 900000 \
//     2026-10-26-swarm-state-results-e2e.test.mts
//
// E2E_QUICK=1 skips the 31 s and 60 s waits (no idle read past the overlap, short host-tick windows).
// The CLI's test isolation must load before anything else: it gives this run its own home and data folders.
import '../../cli/vitest.setup.ts'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IsolatedDaemon, until } from '../../cli/e2e/harness/daemon.ts'
import { LocalClient } from '../../cli/e2e/harness/client.ts'

const B = 'http://127.0.0.1:18085', PROXY = 18086
const OWNER = 'local-owner-token', PEER = 'local-peer-token', OUTSIDER = 'local-outsider-token'
const out = process.env.E2E_OUT!
const QUICK = process.env.E2E_QUICK === '1'
const results: Record<string, unknown> = {}
const ok = (name: string, pass: boolean, detail: unknown) => { results[name] = { pass, detail }; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail).slice(0, 400)}`) }

async function api(token: string, path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`${B}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, bytes: Buffer.byteLength(text), body: json }
}
const command = async (token: string, tab: string, cmd: unknown, asAgentId?: string) => {
  const r = await api(token, `/api/super-tabs/${tab}/commands`, 'POST', { operationId: randomUUID(), command: cmd, ...(asAgentId ? { asAgentId } : {}) })
  if (!r.body?.success) throw new Error(`command failed ${JSON.stringify(cmd).slice(0, 120)}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.data
}

// The proxy: counts each host-form reply (bytes, and whether it carried rows) the daemon reads.
interface HostRead { at: number; method: string; full: boolean; bytes: number; tabsWithRows: number; unchanged: number }
let hostReads: HostRead[] = []
const otherPaths: Record<string, { count: number; bytes: number }> = {}
const proxy = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const upstream = httpRequest({ host: '127.0.0.1', port: 18085, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:18085' } }, up => {
      const body: Buffer[] = []
      up.on('data', c => body.push(c))
      up.on('end', () => {
        const buf = Buffer.concat(body), path = (req.url ?? '').split('?')[0]!
        if (/^\/api\/super-tabs\/hosts\/[^/]+\/changes$/.test(path)) {
          let tabs: any[] = []
          try { tabs = JSON.parse(buf.toString()).data?.tabs ?? [] } catch {}
          hostReads.push({ at: Date.now(), method: req.method!, full: /full=1/.test(req.url ?? '') || /"full":true/.test(Buffer.concat(chunks).toString()),
            bytes: buf.byteLength, tabsWithRows: tabs.filter(t => Array.isArray(t.roster)).length, unchanged: tabs.filter(t => t.unchanged).length })
        } else {
          const key = `${req.method} ${path.replace(/[0-9a-f]{24}/g, ':id')}`
          otherPaths[key] = { count: (otherPaths[key]?.count ?? 0) + 1, bytes: (otherPaths[key]?.bytes ?? 0) + buf.byteLength }
        }
        res.writeHead(up.statusCode!, up.headers)
        res.end(buf)
      })
    })
    upstream.on('error', e => { res.writeHead(502).end(String(e)) })
    upstream.end(Buffer.concat(chunks))
  })
})
proxy.on('upgrade', (req, socket, head) => {
  const up = connect(18085, '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${k === 'host' ? '127.0.0.1:18085' : v}`).join('\r\n')}\r\n\r\n`)
    if (head.length) up.write(head)
    up.pipe(socket); socket.pipe(up)
  })
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy())
})
declare const test: (name: string, body: () => Promise<void>, timeout: number) => void
test('isolated end to end', async () => {
await new Promise<void>(r => proxy.listen(PROXY, '127.0.0.1', r))

let daemon: IsolatedDaemon | null = null
try {
  // Seed: the owner's machine is the daemon's computer.
  const computerId = randomUUID().replaceAll('-', '')
  const machineId = (await api(OWNER, '/api/machines/resolve-computer', 'POST', { computerId, label: 'G6 isolated machine' })).body.data.machine.machineId as string
  const tab = (await api(OWNER, '/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'G6 local Swarm' })).body.data.id as string
  const configuration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  const lead = (await command(OWNER, tab, { type: 'agent.add', conversationId: 'lead', machineId, harnessId: 'g6-lead-harness', name: 'Lead', lead: true, configuration })).result.agentId as string
  const invite = (await command(OWNER, tab, { type: 'invite.create', email: 'peer@local.test', role: 'collaborator', conversationId: 'lead' })).result.inviteId as string
  await command(PEER, tab, { type: 'invite.accept', inviteId: invite })
  const work = (await command(OWNER, tab, { type: 'conversation.create', title: 'Shared work', brief: 'A shared group.', checks: [] })).result.conversationId as string
  const builder = (await command(OWNER, tab, { type: 'agent.add', conversationId: work, machineId, harnessId: 'g6-builder-harness', name: 'Builder', lead: false, configuration })).result.agentId as string
  for (let i = 0; i < 30; i++) await command(OWNER, tab, { type: 'conversation.create', title: `Filler ${i}`, brief: 'x'.repeat(400), checks: [] })
  const ownerLoad = await api(OWNER, `/api/super-tabs/${tab}/parts`)
  const ownerId = ownerLoad.body.data.members.find((m: any) => m.data.email === 'owner@local.test').data.id as string
  const privateId = (await command(OWNER, tab, { type: 'conversation.create', title: 'Owner only', brief: 'Private note.', checks: [], audience: { personIds: [ownerId] } })).result.conversationId as string
  Object.assign(results, { tab, machineId, lead, builder, work, privateId })

  // 1. First load.
  const first = await api(OWNER, `/api/super-tabs/${tab}/parts`)
  const groupIds = (load: any) => load.body.data.groups.map((g: any) => g.key)
  ok('first load', first.status === 200 && first.body.data.format === 2 && groupIds(first).includes(work) && groupIds(first).includes(privateId),
    { bytes: first.bytes, groups: first.body.data.groups.length, agents: first.body.data.agents.length, members: first.body.data.members.length })

  // 2. Change reads: an idle read after the overlap is small; then a second client's post shows up.
  const peerFirst = await api(PEER, `/api/super-tabs/${tab}/parts`)
  ok('private conversation absent for a non-audience reader: first load', !groupIds(peerFirst).includes(privateId) && groupIds(peerFirst).includes(work),
    { peerGroups: peerFirst.body.data.groups.length, ownerGroups: first.body.data.groups.length })
  const privateOne = await api(PEER, `/api/super-tabs/${tab}/groups/${privateId}`)
  ok('private conversation absent for a non-audience reader: one group', privateOne.status === 404, { status: privateOne.status })
  const privateMessages = await api(PEER, `/api/super-tabs/${tab}/conversations/${privateId}/messages`)
  ok('private conversation absent for a non-audience reader: messages', privateMessages.status >= 400, { status: privateMessages.status })
  console.log('waiting 31 s for the change-read overlap to pass')
  await new Promise(r => setTimeout(r, QUICK ? 0 : 31_000))
  // The first change read resends what changed in the 30 s before the first load (the overlap); the next one is idle.
  const catchUp = await api(OWNER, `/api/super-tabs/${tab}/changes?cursor=${first.body.data.cursor}`)
  const idle = await api(OWNER, `/api/super-tabs/${tab}/changes?cursor=${catchUp.body.data.cursor}`)
  ok('change read, idle', idle.status === 200 && idle.body.data.reload === false && idle.body.data.groups.length === 0,
    { bytes: idle.bytes, catchUpBytes: catchUp.bytes, firstLoadBytes: first.bytes })
  const posted = await command(PEER, tab, { type: 'message.send', conversationId: work, text: 'Hello from the second client.', replyTo: null, recipientIds: [] })
  const changed = await api(OWNER, `/api/super-tabs/${tab}/changes?cursor=${idle.body.data.cursor}`)
  const messages = await api(OWNER, `/api/super-tabs/${tab}/conversations/${work}/messages`)
  ok('a post from a second client appears', groupIds(changed).includes(work) && JSON.stringify(messages.body).includes('Hello from the second client.'),
    { bytes: changed.bytes, groupsSent: changed.body.data.groups.length, parts: posted.parts })
  // A private post: the owner's change read carries it, the peer's does not.
  const peerCursor = (await api(PEER, `/api/super-tabs/${tab}/parts`)).body.data.cursor
  await new Promise(r => setTimeout(r, QUICK ? 0 : 31_000))
  const peerIdle = await api(PEER, `/api/super-tabs/${tab}/changes?cursor=${peerCursor}`)
  await command(OWNER, tab, { type: 'message.send', conversationId: privateId, text: 'Owner only note.', replyTo: null, recipientIds: [] })
  const peerChanged = await api(PEER, `/api/super-tabs/${tab}/changes?cursor=${peerIdle.body.data.cursor}`)
  ok('private conversation absent for a non-audience reader: changes after a private post', !groupIds(peerChanged).includes(privateId) && !JSON.stringify(peerChanged.body).includes(privateId),
    { groupsSent: peerChanged.body.data.groups.length })
  const outsider = await api(OUTSIDER, `/api/super-tabs/${tab}/parts`)
  ok('a non-member cannot read the Swarm', outsider.status === 403 || outsider.status === 404, { status: outsider.status })

  // 3. Old routes answer 426 UPDATE_REQUIRED.
  const old = await Promise.all([`/api/super-tabs`, `/api/super-tabs/${tab}`, `/api/super-tabs/hosts/${machineId}`, `/api/super-tabs/hosts/${machineId}/pools`,
    `/api/super-tabs/hosts/${machineId}/assignments`].map(async path => { const r = await api(OWNER, path); return { path, status: r.status, code: r.body?.error?.code } }))
  ok('old routes answer 426 UPDATE_REQUIRED', old.every(r => r.status === 426 && r.code === 'UPDATE_REQUIRED'), old)

  // 4. An isolated daemon signed in as the owner, through the counting proxy.
  daemon = await IsolatedDaemon.create({ env: { ADAPTER_COMPUTER_ID: computerId, BACKEND_WS_URL: `ws://127.0.0.1:${PROXY}`, WEB_URL: `http://127.0.0.1:${PROXY}`,
    HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200' } })
  if (daemon.port === 18473) throw new Error('refusing the everyday daemon port')
  writeFileSync(join(daemon.root, 'auth/session.json'), JSON.stringify({ version: 1, accessToken: OWNER, refreshToken: 'x', autonomousEnv: 'prod', computerId, machineId,
    expiresAt: Date.now() + 3_600_000, updatedAt: Date.now() }), { mode: 0o600 })
  await daemon.start()
  await until('daemon connected', async () => (await (await fetch(`http://127.0.0.1:${daemon!.port}/api/status`, { headers: daemon!.localHeaders() })).json()).connected === true, 60_000, 200)
  ok('isolated daemon connected', true, { port: daemon.port, root: daemon.root })
  // The agents were added before the daemon signed in, so nothing woke its Swarm host: wake it as the e2e suites do.
  const local = await LocalClient.connect(daemon, { machineId })
  ok('host woken', (await local.request('super_tabs', { action: 'wake' }) as { ok?: boolean }).ok === true, {})
  local.close()
  await until('first host form read', async () => hostReads.length > 0, 60_000, 200)
  const fullForm = hostReads.find(r => r.full && r.tabsWithRows > 0)
  // Let the minute's full read settle, then measure idle and active windows of 60 s each.
  await new Promise(r => setTimeout(r, 5_000))
  const window = async (label: string, during?: () => Promise<void>) => {
    hostReads = []
    const started = Date.now(), timer = during ? setInterval(() => { during().catch(e => console.log('post failed', e)) }, 5_000) : null
    await new Promise(r => setTimeout(r, QUICK ? 3_000 : 60_000))
    if (timer) clearInterval(timer)
    const reads = hostReads.filter(r => r.at >= started)
    const total = reads.reduce((s, r) => s + r.bytes, 0)
    return { label, reads: reads.length, avgBytes: Math.round(total / Math.max(1, reads.length)), maxBytes: Math.max(...reads.map(r => r.bytes)),
      withRows: reads.filter(r => r.tabsWithRows > 0).length, full: reads.filter(r => r.full).length, posts: label === 'active' ? 12 : 0,
      methods: [...new Set(reads.map(r => r.method))] }
  }
  const idleTick = await window('idle')
  let n = 0
  const activeTick = await window('active', async () => { await command(OWNER, tab, { type: 'message.send', conversationId: work, text: `Lead note ${n++}`, replyTo: null, recipientIds: [builder] }, lead) })
  ok('host tick bytes with etag', idleTick.reads > 30 && activeTick.reads > 30 && activeTick.methods.includes('POST'),
    { fullFormBytes: fullForm?.bytes ?? null, idle: idleTick, active: activeTick })

  results.otherDaemonReads = otherPaths
} catch (error) {
  console.log('ERROR', (error as Error).stack)
  throw error
} finally {
  await daemon?.close().catch(() => {})
  proxy.closeAllConnections(); proxy.close()
  writeFileSync(out, JSON.stringify(results, null, 2))
}
}, 900_000)
