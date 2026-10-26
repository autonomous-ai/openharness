// Reference: the isolated run behind #1751 (final review, Critical 1): a person's private chat delivered into a real PM
// terminal, then every way of watching that session refused. Not part of any suite; kept so its output can be traced.
// It needs the local backend recipe (groups 3 and 6) running first, on loopback: MongoDB replica set on 127.0.0.1:27117,
// Redis on :16379, the backend of this branch on :18085, and a fake sign-in on :18990 that knows these four tokens:
// local-owner-token (owner@local.test, id local-owner), local-alice-token, local-bob-token, local-carol-token (the same
// pattern). It starts one isolated daemon from the CLI's end-to-end harness (throwaway home and data, private tmux, fake
// Claude Code engine, a free port; never 18473, the everyday daemon's) and never reaches any host but 127.0.0.1. From cli/:
//
//   npx vitest run --root ../docs/performance --globals --testTimeout 600000 2026-10-27-pm-confidential-isolated-run.test.mts
//
// Any failed check fails the run.
import '../../cli/vitest.setup.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { until } from '../../cli/e2e/harness/daemon.ts'
import { signIn, type Account, type RealBackend } from '../../cli/e2e/harness/realBackend.ts'
import { superTabCommand } from '../../cli/src/superTabs/command.ts'
import { observerSource } from '../../cli/src/superTabs/observers.ts'

const B = 'http://127.0.0.1:18085'
const person = (name: string): Account => ({ name, token: `local-${name}-token`, id: `local-${name}`, email: `${name}@local.test` })
const [owner, alice, bob, carol] = ['owner', 'alice', 'bob', 'carol'].map(person) as [Account, Account, Account, Account]
const CONFIG = { engine: 'claude', model: 'sonnet', effort: 'high', contextWindow: null, engineVersion: null }
const FIXTURE_KEYS = { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential' }
const SECRET = 'Only for the PM: the launch slips a week.'

async function api(a: Account, path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`${B}${path}`, { method, headers: { authorization: `Bearer ${a.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: r.status, body: json }
}
const backend: RealBackend = { url: B, wsUrl: 'ws://127.0.0.1:18085', logPath: '', api, stop: async () => {} }
const failed: string[] = []
// Straight to stdout: the CLI's test setup keeps console output of a passing test to itself.
const say = (line: string) => { process.stdout.write(`${line}\n`) }
const check = (name: string, pass: boolean, detail: unknown) => {
  if (!pass) failed.push(name)
  say(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail).slice(0, 600)}`)
}

it('delivers a private chat into a real PM terminal, then refuses every way of watching that session', async () => {
  const side = await signIn(backend, owner, FIXTURE_KEYS)
  const created = async (folder: string) => {
    const cwd = join(side.daemon.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const made = await side.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: false }, 90_000)
    if (made.error) throw new Error(`${folder}: ${JSON.stringify(made)}`)
    return until(`${folder} to bind its conversation`, async () => {
      const agents = (await side.client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      const agent = agents.find(a => a.id === made.agent.id)
      return agent?.sessionId && agent.status === 'active' ? agent : null
    }, 60_000, 500)
  }
  const pmSession = await created('pm'), builderSession = await created('builder')
  say(`isolated daemon on port ${side.daemon.port}, machine ${side.machineId}; PM session ${pmSession.id}, Builder session ${builderSession.id}`)

  // Swarm A: Alice and Bob read its public project; the PM runs on the owner's machine (neither Alice's nor Bob's).
  const tab = (await api(owner, '/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Isolated C1' })).body.data.id as string
  const run = async (a: Account, command: Record<string, unknown>, tabId = tab) => api(a, `/api/super-tabs/${tabId}/commands`, 'POST', { operationId: randomUUID(), command })
  for (const reader of [alice, bob]) {
    const invite = await run(owner, { type: 'invite.create', email: reader.email, role: 'collaborator', conversationId: 'lead' })
    await run(reader, { type: 'invite.accept', inviteId: invite.body.data.result.inviteId })
  }
  const pm = (await run(owner, { type: 'agent.add', conversationId: 'lead', machineId: side.machineId, harnessId: pmSession.id, name: 'PM', configuration: CONFIG, lead: true })).body.data.result.agentId as string
  await run(owner, { type: 'agent.add', conversationId: 'lead', machineId: side.machineId, harnessId: builderSession.id, name: 'Builder', configuration: CONFIG, lead: false })
  // The PM joins as a launched agent does, which starts its machine's Swarm host.
  let joined = ''
  const status = await superTabCommand(['--tab', tab, '--agent', pm, 'status'],
    { where: () => ({ port: side.daemon.port, dataDir: side.daemon.dataDir, machineId: side.machineId }), print: text => { joined = text } })
  check('the PM joins and its host starts', status === 0, { status, out: joined.slice(0, 120) })

  // Shares made before the chat, through the real share route: Bob's from this Swarm, Carol's the ordinary way.
  const share = async (recipient: Account, agentId: string, superTabId: string | null) => {
    const id = randomUUID()
    const r = await api(owner, `/api/harness-shares/${id}`, 'PUT', { superTabId, machineId: side.machineId, agentId, recipientEmail: recipient.email,
      name: 'PM', engine: 'claude', ownerPublicKey: randomBytes(32).toString('base64'), expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    return { id, status: r.status }
  }
  const bobsShare = await share(bob, pmSession.id, tab), carolsShare = await share(carol, pmSession.id, null), carolsBuilderShare = await share(carol, builderSession.id, null)
  check('shares made before the chat (Bob from the Swarm, Carol ordinary, and a Builder control)', [bobsShare, carolsShare, carolsBuilderShare].every(s => s.status === 200),
    [bobsShare.status, carolsShare.status, carolsBuilderShare.status])

  // Alice's private chat with the PM, and her secret.
  // The Swarm knows each person by the backend's own user id: read Alice's from the member list.
  const members = (await api(owner, `/api/super-tabs/${tab}/parts`)).body.data.members as Array<{ data: { id: string; email: string } }>
  const aliceId = members.find(m => m.data.email === alice.email)!.data.id
  const opened = await run(alice, { type: 'conversation.create', title: 'Chat with PM', brief: '', checks: [], audience: { personIds: [aliceId] } })
  check('Alice opens her private chat with the PM', opened.status === 200, { status: opened.status, error: opened.body?.error })
  const chat = opened.body.data.result.conversationId as string
  const sent = await run(alice, { type: 'message.send', conversationId: chat, text: SECRET, replyTo: null, recipientIds: [] })
  check('Alice posts her secret in her private chat with the PM', sent.status === 200, { status: sent.status })

  // It arrives in the PM's real terminal: its host claims the delivery and types it in. The machine's owner reads that screen.
  let screen = ''
  await until('the secret on the PM\'s screen', async () => {
    const asked = await run(owner, { type: 'agent.screen', agentId: pm, scrollback: 200 })
    if (asked.status !== 200) { screen = JSON.stringify(asked.body); return null }
    const read = await api(owner, `/api/super-tabs/${tab}/terminal/${asked.body.data.result.requestId}`)
    screen = String(read.body?.data?.text ?? JSON.stringify(read.body))
    return screen.includes(SECRET) ? screen : null
  }, 120_000, 2_000).catch(() => null)
  check('the secret arrived in the PM\'s terminal (read by its machine\'s owner)', screen.includes(SECRET),
    screen.split('\n').filter(line => line.includes('launch slips')).slice(0, 3))

  // 1. The machine's roster lists nobody to watch the PM, and marks its session confidential.
  const form = await api(owner, `/api/super-tabs/hosts/${side.machineId}/changes?full=1`)
  const rows = (form.body.data.tabs.find((t: any) => t.tabId === tab)?.roster ?? []) as Array<Record<string, any>>
  const pmRow = rows.find(r => r.agent?.id === pm), builderRow = rows.find(r => r.agent?.harnessId === builderSession.id)
  check('roster: the PM has no observers and is confidential', pmRow?.observers?.length === 0 && pmRow?.confidential === true,
    { observers: pmRow?.observers, confidential: pmRow?.confidential })
  check('roster: the Builder keeps its observers (control)', (builderRow?.observers ?? []).length >= 2, builderRow?.observers?.map((o: any) => o.email))

  // 2. The backend no longer lists the earlier shares to their recipients; the Builder's still opens.
  // What each recipient's share list holds, by session. Bob also holds the Builder share his roster entry gives him (the host's own).
  const listed = async (a: Account) => ((await api(a, '/api/harness-shares')).body.data.machines as Array<any>)
    .flatMap(m => m.shares.map((s: any) => ({ id: s.id, session: s.agentId === pmSession.id ? 'PM' : s.agentId === builderSession.id ? 'Builder' : s.agentId })))
  const bobs = await listed(bob), carols = await listed(carol)
  check('backend: Bob\'s earlier Swarm share is refused', !bobs.some(s => s.id === bobsShare.id), { refused: bobsShare.id, listed: bobs })
  check('backend: Carol\'s earlier ordinary share is refused', !carols.some(s => s.id === carolsShare.id), { refused: carolsShare.id, listed: carols })
  check('backend: Carol\'s ordinary share of the Builder still opens (control)', carols.some(s => s.id === carolsBuilderShare.id), { opens: carolsBuilderShare.id })

  // 3. The CLI host's cache refuses both shares of the PM's session.
  const cache = observerSource(side.daemon.dataDir, () => side.machineId)
  const cacheBob = cache.allows({ tab: `super:${tab}`, agentId: pmSession.id, recipientEmail: bob.email } as never)
  const cacheCarol = cache.allows({ tab: null, agentId: pmSession.id, recipientEmail: carol.email } as never)
  check('CLI cache: the PM\'s Swarm share and ordinary share are refused', !cacheBob && !cacheCarol, { swarm: cacheBob, ordinary: cacheCarol })

  // 4. Bob may not read or type into the PM's terminal.
  const peek = await run(bob, { type: 'agent.screen', agentId: pm, scrollback: 200 })
  const typed = await run(bob, { type: 'agent.input', agentId: pm, text: 'history' })
  check('terminal: Bob cannot read or type into the PM', peek.status === 403 && typed.status === 403,
    { screen: [peek.status, peek.body?.error?.code], input: [typed.status, typed.body?.error?.code] })

  // 5. No second Swarm may register the PM's session.
  const other = (await api(owner, '/api/super-tabs', 'POST', { operationId: randomUUID(), name: 'Another Swarm' })).body.data.id as string
  const again = await run(owner, { type: 'agent.add', conversationId: 'lead', machineId: side.machineId, harnessId: pmSession.id, name: 'PM again', configuration: CONFIG, lead: false }, other)
  check('another Swarm cannot register the PM\'s session', again.status === 409 && again.body?.error?.code === 'SESSION_CONFIDENTIAL',
    { status: again.status, code: again.body?.error?.code })

  await side.daemon.stop()
  if (failed.length) throw new Error(`Failed: ${failed.join('; ')}`)
})
