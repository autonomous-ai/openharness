/**
 * Shared tabs across accounts, step 1a (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md),
 * on the real process layout: the real backend, two accounts, and one real daemon per account with Agent Messages in
 * the edge host (the default harnessd layout, not HARNESSD_SERVICES=none). The unit seams once hid a messages process
 * that could not reach the backend at all (the final review of 1a, 2026-10-15); this runs every hop for real: the
 * messages process's backend allowlist and account query, the gateway's tab keys and relay sockets, the backend's
 * share routes and /api/agent-messages-ws, the session handshake and the roster's signature.
 *
 * Step 1b (docs/plans/2026-10-15-shared-tabs-1b-delivery.md, Task D1) on the same layout: the pin reaching the member's
 * second computer, `harness send` both ways across accounts, a message waiting for a computer that is off and delivered
 * once it is back, a member removed while a message to them waits, read-only observation and its end, the tab's tasks
 * through a stub `gh`, and the in-core layout (HARNESSD_SERVICES=none), the only place the core's own wiring of tab
 * frames to Agent Messages runs.
 *
 * Needs the backend's in-memory Mongo and Redis (HARNESS_E2E_SERVICES_DIR, see harness/realBackend.ts).
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { resolveBinaryOnPath } from '../src/lib/binaryOnPath.js'
import { b64d, fingerprint } from '../src/lib/e2ee/core.js'
import { parseRoster, type Roster } from '../src/messages/roster.js'
import { LocalClient } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { account, signIn, startRealBackend, type Account, type RealBackend } from './harness/realBackend.js'

const exec = promisify(execFile)
const alice = account('alice'), bob = account('bob')
/** Step 1b's accounts: new ones, so 1a's tab and machines are not in their way, named as 1a's are. An account's label is
 *  its email's local part, which headers (`alice's account`) and prefixes (`bob/api`) show. */
const named = (name: string, domain: string): Account => ({ ...account(name), email: `${name}@${domain}.spike.invalid` })
const alice1b = named('alice', 'delivery'), bob1b = named('bob', 'delivery')
const aliceCore = named('alice', 'incore'), bobCore = named('bob', 'incore')
const aliceAct = named('alice', 'activity'), bobAct = named('bob', 'activity')
const times: string[] = []
let backend: RealBackend
type Side = { who: Account; d: IsolatedDaemon; machineId: string; client: LocalClient }

const tail = (text: string, lines = 200) => text.split('\n').slice(-lines).join('\n')
/** An `agent_messages` request through the daemon's local socket, answered without the echoed requestId. */
const am = async (s: Side, payload: Record<string, unknown>, ms = 45_000) => {
  const { requestId: _, ...answer } = await s.client.request<Record<string, any>>('agent_messages', payload, ms)
  return answer
}
const shares = async (s: Side) => {
  const r = await am(s, { action: 'shares' })
  if (r.error) throw new Error(`${s.who.name} shares: ${JSON.stringify(r)}`)
  return r as { rosters: Roster[]; invites: Array<Record<string, string>>; pending: unknown[]; notices: unknown[]; alerts: unknown }
}
const rosterOf = async (s: Side, id: string) => (await shares(s)).rosters.find((r) => r.sharedTabId === id) ?? null
const harnessKeys = (r: Roster | null) => (r?.harnesses ?? []).map((h) => `${h.machineId}/${h.agentId}`).sort()

/** `harness settings`, as the person turns a switch: through the daemon to the account. */
const settings = (d: IsolatedDaemon, body: Record<string, boolean>) => fetch(`http://127.0.0.1:${d.port}/api/agent-settings`, {
  method: 'PATCH', headers: { 'x-adapter-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function create(s: Side, folder: string): Promise<Record<string, any>> {
  const cwd = join(s.d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await s.client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  return until(`${folder} to bind its conversation`, async () => {
    const agents = (await s.client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
    const agent = agents.find((a) => a.id === created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
}

/** The daemon's processes: the master's children, by pid and command line. */
async function processes(d: IsolatedDaemon): Promise<string[]> {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,command='])
  const rows = stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean) as RegExpMatchArray[]
  return rows.filter((r) => Number(r[2]) === d.pid).map((r) => `${r[1]} ${r[3].slice(0, 220)}`)
}

/** The backend's stored share, as `GET /api/agent-messages/shares` answers it under an account. */
const storedShare = async (a: Account, id: string) =>
  ((await backend.api(a, '/api/agent-messages/shares')).body?.data?.shares ?? []).find((s: Record<string, any>) => s.sharedTabId === id) as Record<string, any> | undefined

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('shared tabs across accounts (step 1a), real processes', () => {
  beforeAll(async () => { backend = await startRealBackend([alice, bob, alice1b, bob1b, aliceCore, bobCore, aliceAct, bobAct], (l) => times.push(l)) }, 180_000)
  afterAll(async () => {
    console.log('timings', times.join(' | '))
    if (process.env.SHARED_TABS_TIMINGS_FILE) appendFileSync(process.env.SHARED_TABS_TIMINGS_FILE, `${times.join(' | ')}\n`)
    await backend?.stop()
  })

  it('shares a tab, invites, accepts with the owner\'s fingerprint, adds a member\'s harness over the relay, and leaves, stops and shares again', async () => {
    const sides: Side[] = []
    onTestFailed(() => {
      for (const s of sides) console.log(`---- ${s.who.name}'s daemon log (master, core, edge host, gateway)\n${tail(s.d.log(), 250)}`)
      try { console.log(`---- backend log ${backend.logPath}\n${tail(readFileSync(backend.logPath, 'utf8'), 150)}`) } catch { /* gone */ }
    })
    const mark = (label: string, since: number) => times.push(`${label} ${Date.now() - since}ms`)

    // 1. One daemon per account, in the default layout.
    let t = Date.now()
    for (const who of [alice, bob]) {
      const s = await signIn(backend, who)
      sides.push({ who, d: s.daemon, machineId: s.machineId, client: s.client })
    }
    const [A, B] = sides
    mark('sign in both', t)
    for (const s of sides) {
      await until(`${s.who.name}: Agent Messages to connect from the edge host`, () => /\[services\] messages connected/.test(s.d.log()) || null, 60_000, 200)
      expect(s.d.env.HARNESSD_SERVICES, 'the default layout').toBeUndefined()
      expect(s.d.log()).toMatch(/\[harnessd\] service edge started/)
      expect(s.d.log(), 'no process of its own').not.toMatch(/\[harnessd\] service messages started/)
      const ps = await processes(s.d)
      times.push(`${s.who.name} processes: ${ps.join(' || ')}`)
      const lines = s.d.log().split('\n').filter((l) => /service (edge|gateway|messages) started|messages connected|\[harnessd\] core started/.test(l))
      times.push(`${s.who.name} evidence: ${lines.slice(0, 8).join(' || ')}`)
    }

    // 2. Agent Messages on for both accounts, through each daemon to the account.
    t = Date.now()
    for (const s of sides) {
      const on = await settings(s.d, { agentMessages: true })
      expect(on.status, await on.clone().text()).toBe(200)
      const exp = await backend.api(s.who, '/api/experimental-settings')
      expect(exp.body?.data?.features?.agent_messages, JSON.stringify(exp.body)).toBe(true)
      await until(`${s.who.name}: shared tabs to answer`, async () => !(await am(s, { action: 'shares' })).error || null, 30_000, 300)
    }
    mark('agent messages on', t)

    // 3. Alice: a harness in a desk tab, the tab shared, Bob invited.
    const a1 = await create(A, 'alice-lead')
    const desk = await backend.api(alice, '/api/desk/ops', 'POST', { ops: [
      { op: 'tab.create', id: 'app', name: 'app' }, { op: 'pane.add', tabId: 'app', machineId: A.machineId, agentId: a1.id }] })
    expect(desk.status, JSON.stringify(desk.body)).toBe(200)
    const dir = await backend.api(alice, '/api/agent-messages')
    expect(dir.body.data.tabs.find((tab: Record<string, any>) => tab.id === 'app')?.panes).toEqual([{ machineId: A.machineId, agentId: a1.id }])
    t = Date.now()
    const shared = await am(A, { action: 'share_tab', tabId: 'app', name: 'app' })
    expect(shared.error, JSON.stringify(shared)).toBeUndefined()
    const sharedTabId = String(shared.sharedTabId)
    expect(sharedTabId).toMatch(/^[a-f0-9]{24}$/)
    mark('share_tab', t)
    const first = await rosterOf(A, sharedTabId)
    expect(harnessKeys(first)).toEqual([`${A.machineId}/${a1.id}`])
    t = Date.now()
    const invited = await am(A, { action: 'share_invite', sharedTabId, emails: [bob.email], days: 7 })
    expect(invited, JSON.stringify(invited)).toMatchObject({ invited: [bob.email], refused: [] })
    mark('share_invite', t)

    // 4. Bob: the invitation, accepted, with the fingerprint of Alice's machine key.
    const invitation = await until('bob to see the invitation', async () =>
      (await shares(B)).invites.find((i) => i.sharedTabId === sharedTabId) ?? null, 20_000, 300)
    expect(invitation.ownerEmail).toBe(alice.email)
    t = Date.now()
    const accepted = await am(B, { action: 'share_accept', inviteId: invitation.id })
    expect(accepted.error, JSON.stringify(accepted)).toBeUndefined()
    mark('share_accept', t)
    const ownerBlob = await storedShare(alice, sharedTabId)
    const ownerRoster = parseRoster(String(ownerBlob?.roster?.body))
    expect(ownerRoster?.owner.machineId).toBe(A.machineId)
    const ownerFp = fingerprint(b64d(ownerRoster!.owner.machinePublicKey))
    expect(accepted).toEqual({ sharedTabId, fingerprint: ownerFp })
    times.push(`fingerprint ${ownerFp}`)

    // 5. Bob's harness, asked of Alice's computer over the relay; twice at once, applied once.
    const b1 = await create(B, 'bob-api')
    const harness = { machineId: B.machineId, agentId: b1.id, name: 'bob-api', engine: 'claude' }
    t = Date.now()
    const [add1, add2] = await Promise.all([am(B, { action: 'share_add', sharedTabId, harness }), am(B, { action: 'share_add', sharedTabId, harness })])
    expect(add1, JSON.stringify(add1)).toEqual({ queued: true })
    expect(add2, JSON.stringify(add2)).toEqual({ queued: true })
    const want = [`${A.machineId}/${a1.id}`, `${B.machineId}/${b1.id}`].sort()
    const converged = await until('both daemons to hold the same roster with both harnesses', async () => {
      const [ra, rb] = [await rosterOf(A, sharedTabId), await rosterOf(B, sharedTabId)]
      return ra && rb && ra.version === rb.version && JSON.stringify(harnessKeys(ra)) === JSON.stringify(want)
        && JSON.stringify(harnessKeys(rb)) === JSON.stringify(want) ? { ra, rb } : null
    }, 90_000, 300)
    mark('share_add converged', t)
    times.push(`roster v${converged.ra.version} members ${converged.ra.members.map((m) => m.email).join(',')}`)
    expect(converged.ra.members.map((m) => m.email)).toEqual([bob.email])
    expect(converged.rb.members).toEqual(converged.ra.members)
    expect(converged.ra.harnesses.filter((h) => h.agentId === b1.id)).toHaveLength(1)
    expect((await shares(B)).pending).toEqual([])

    // 6a. The backend holds the roster as an opaque signed blob, the same one for the member.
    const memberBlob = await storedShare(bob, sharedTabId)
    expect(typeof memberBlob?.roster?.body).toBe('string')
    expect(typeof memberBlob?.roster?.signature).toBe('string')
    expect(parseRoster(memberBlob!.roster.body)?.version).toBe(converged.ra.version)
    expect(memberBlob!.version).toBe(converged.ra.version)

    // 6b. The same harness added again changes nothing.
    const again = await am(B, { action: 'share_add', sharedTabId, harness })
    expect(again).toEqual({ queued: true })
    await new Promise((settle) => setTimeout(settle, 4_000))
    for (const s of sides) {
      const r = await rosterOf(s, sharedTabId)
      expect(r?.version, `${s.who.name}'s roster after a second add`).toBe(converged.ra.version)
      expect(r!.harnesses.filter((h) => h.agentId === b1.id)).toHaveLength(1)
    }

    // 6c. Bob leaves: Alice's next roster has neither him nor his harness, and Bob holds none.
    t = Date.now()
    expect(await am(B, { action: 'share_leave', sharedTabId })).toEqual({ ok: true })
    expect(await rosterOf(B, sharedTabId)).toBeNull()
    const afterLeave = await until('alice\'s roster to drop bob and his harness', async () => {
      const r = await rosterOf(A, sharedTabId)
      return r && r.version > converged.ra.version && JSON.stringify(harnessKeys(r)) === JSON.stringify([`${A.machineId}/${a1.id}`])
        && r.members.length === 0 ? r : null
    }, 60_000, 300)
    mark('share_leave reflected', t)
    times.push(`after leave v${afterLeave.version}`)

    // 6d. Stop, then share again: the version only grows.
    t = Date.now()
    expect(await am(A, { action: 'share_stop', sharedTabId })).toEqual({ ok: true })
    expect(await rosterOf(A, sharedTabId)).toBeNull()
    const again2 = await am(A, { action: 'share_tab', tabId: 'app', name: 'app' })
    expect(again2.error, JSON.stringify(again2)).toBeUndefined()
    const reshared = await rosterOf(A, String(again2.sharedTabId))
    expect(reshared, 'a roster held for the tab shared again').not.toBeNull()
    expect(reshared!.version).toBeGreaterThan(afterLeave.version)
    expect(reshared!.members).toEqual([])
    mark('stop + share again', t)
    times.push(`shared again ${again2.sharedTabId === sharedTabId ? 'same id' : 'new id'} v${reshared!.version}`)

    // Where it ran: killing Alice's edge host cuts Agent Messages' link to the core, with the edge's other services.
    const edge = (await processes(A.d)).find((p) => / harnessd-edge\b/.test(p) || /__service.*edge/.test(p))
    expect(edge, 'an edge host process').toBeDefined()
    const from = A.d.log().length
    process.kill(Number(edge!.split(' ')[0]), 'SIGKILL')
    await until('messages to disconnect with the edge host', () => /\[services\] messages disconnected/.test(A.d.log().slice(from)) || null, 20_000, 100)
    const cut = A.d.log().slice(from).split('\n').filter((l) => /\[services\] \w+ disconnected|service edge (started|exited|stopped)/.test(l))
    times.push(`edge ${edge!.split(' ')[0]} killed: ${cut.slice(0, 16).join(' || ')}`)
    expect(cut.some((l) => /\[services\] workspaces disconnected/.test(l)), 'the edge host\'s other services went with it').toBe(true)
    await until('messages to connect again from a new edge host', () => /\[services\] messages connected/.test(A.d.log().slice(from)) || null, 30_000, 200)
    // Step 1b's tests run beside each other after this one: these daemons have nothing more to do.
    for (const s of sides) await s.d.close()
  }, 420_000)

  // The two 1b runs share nothing but the backend, and each waits out a member's five-minute hold (step 4): side by side,
  // the file takes one hold's time instead of two.
  it.concurrent('step 1b: the pin reaches a second computer, messages cross accounts both ways and wait for a computer that is off, observation ends with membership, and the tab\'s tasks come from gh', async ({ expect, onTestFailed }) => {
    const sides: Side[] = []
    onTestFailed(() => failureLogs('1b', sides))
    const mark = (label: string, since: number) => times.push(`1b ${label} ${Date.now() - since}ms`)
    // Alice's daemon runs the tab's tasks with a stub gh, which a test runner's VITEST would refuse (messages/tasks.ts).
    const { A, B, lead, api, sharedTabId } = await sharedPair(alice1b, bob1b, '1b', sides, { owner: { VITEST: '' } })
    expect(A.d.env.HARNESSD_SERVICES, 'the default layout').toBeUndefined()

    // 1. Bob's second computer takes the pin from his first (A2), and adds a harness of its own.
    let t = Date.now()
    const two = await signIn(backend, bob1b, { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', VITEST: '' }, withoutGh)
    const B2: Side = { who: bob1b, d: two.daemon, machineId: two.machineId, client: two.client }
    sides.push(B2)
    const held = await rosterOf(A, sharedTabId)
    const taken = await until('bob\'s second computer to hold the roster, pinned from his first', async () => {
      const r = await rosterOf(B2, sharedTabId)
      return r && r.version >= held!.version ? r : null
    }, 90_000, 500)
    expect(taken.owner.machinePublicKey).toBe(held!.owner.machinePublicKey)
    mark('second computer pinned', t)
    const web = await create(B2, 'bob-web')
    t = Date.now()
    expect(await am(B2, { action: 'share_add', sharedTabId, harness: { machineId: B2.machineId, agentId: web.id, name: 'web', engine: 'claude' } })).toEqual({ queued: true })
    const three = [`${A.machineId}/${lead.id}`, `${B.machineId}/${api.id}`, `${B2.machineId}/${web.id}`].sort()
    await until('all three computers to hold the roster with the second computer\'s harness', async () => {
      const rs = await Promise.all([A, B, B2].map((s) => rosterOf(s, sharedTabId)))
      return rs.every((r) => r && r.version === rs[0]!.version && JSON.stringify(harnessKeys(r)) === JSON.stringify(three)) || null
    }, 90_000, 500)
    mark('second computer added web', t)

    // 2. `harness send` from a real pane, both ways: each reaches the other's conversation under a header naming the
    // sender's account, and the sender sees it delivered.
    const leadName = (await rosterOf(B, sharedTabId))!.harnesses.find((h) => h.agentId === lead.id)!.name
    t = Date.now()
    const there = await sendFrom(A, lead, 'bob/api', 'Which port does the checkout service listen on?')
    expect(there.error, JSON.stringify(there)).toBeUndefined()
    await delivered(A, String(there.id))
    const heard = await until('the message in bob\'s api conversation', () => prompts(B, api).find((p) => p.includes(`[${there.id} from `)) ?? null, 30_000, 300)
    expect(heard).toMatch(new RegExp(`\\[${there.id} from [^\\]]* · alice's account · Claude Code · [^\\]]+\\]`))
    expect(heard).toContain('Which port does the checkout service listen on?')
    mark('alice → bob/api delivered', t)
    t = Date.now()
    const back = await sendFrom(B, api, `alice/${leadName}`, 'Port 8443, behind the gateway.')
    expect(back.error, JSON.stringify(back)).toBeUndefined()
    await delivered(B, String(back.id))
    const answer = await until('the answer in alice\'s lead conversation', () => prompts(A, lead).find((p) => p.includes(`[${back.id} from `)) ?? null, 30_000, 300)
    expect(answer).toMatch(new RegExp(`\\[${back.id} from [^\\]]* · bob's account · Claude Code · [^\\]]+\\]`))
    mark('bob → alice delivered', t)
    // 1c: Alice's lead works on a turn; Bob's window hears it working (Bob's api is in the roster, so his computer is in
    // the tab for Alice's daemon to tell), and `share_who` gives the harness's project. The delivered message's own turn
    // is shorter than the 5 s tick that tells the tab, so the turn is a longer one (the fake engine's `!work`).
    t = Date.now()
    const sinceBack = B.client.frames.length
    A.client.send('message', { agentId: lead.id, content: '!work 12', requestId: randomUUID() })
    const working = await B.client.waitFor((f) => f.type === 'shared_activity' && f.payload?.agentId === lead.id && f.payload?.state === 'working',
      20_000, 'Alice\'s harness working, seen by Bob', sinceBack)
    expect(working.payload).toMatchObject({ sharedTabId, machineId: A.machineId, agentId: lead.id, state: 'working' })
    expect(working.payload?.validForMs).toBeGreaterThan(0)
    mark('shared_activity working', t)
    const who = await am(B, { action: 'share_who', sharedTabId })
    expect(who.error, JSON.stringify(who)).toBeUndefined()
    expect(who.harnesses.find((h: Record<string, any>) => h.machineId === A.machineId && h.agentId === lead.id), JSON.stringify(who))
      .toMatchObject({ project: '1b-lead' })

    // 3. Bob's computer off: the message waits in Alice's outbox; Bob's computer back: delivered, once.
    t = Date.now()
    await B.d.stop()
    const waiting = await sendFrom(A, lead, 'bob/api', 'Ping while your computer is off.')
    expect(waiting.error, JSON.stringify(waiting)).toBeUndefined()
    const queued = await until('the message to wait for bob\'s computer', async () => {
      const s = await statusOf(A, String(waiting.id))
      return s?.state === 'queued' && /away/.test(String(s.reason)) ? s : null
    }, 40_000, 500)
    times.push(`1b waiting: ${queued.reason}`)
    expect(await statusOf(A, String(waiting.id))).toMatchObject({ state: 'queued' })
    await B.d.start()
    await connectedAgain(B)
    await delivered(A, String(waiting.id), 120_000)
    mark('outbox delivered after restart', t)
    // Long enough for another round of the outbox and the status asks: still one copy.
    await new Promise((settle) => setTimeout(settle, 12_000))
    expect(prompts(B, api).filter((p) => p.includes(`[${waiting.id} from `)), 'delivered exactly once').toHaveLength(1)
    expect((await am(B, { action: 'history' })).messages.filter((m: { id: string }) => m.id === waiting.id)).toHaveLength(1)

    // 7. The tab's tasks with a stub gh first on Alice's PATH; with no gh at all on the second computer's.
    const calls = join(A.d.root, 'gh-calls.log')
    writeFileSync(join(A.d.root, 'bin', 'gh'), cannedGh(sharedTabId, calls), { mode: 0o755 })
    const tasks = await am(A, { action: 'share_tasks', sharedTabId })
    expect(tasks.error, JSON.stringify(tasks)).toBeUndefined()
    expect(tasks.rows).toEqual([{ repo: 'acme/shop', issue: 7, title: 'Fix the checkout total', url: 'https://github.com/acme/shop/issues/7', state: 'open',
      assignee: { account: 'bob', harness: 'api' }, pr: { number: 9, url: 'https://github.com/acme/shop/pull/9', state: 'Open', ci: 'passing', autoMerge: false, mergeState: 'CLEAN', mergedAt: '' }, updatedAt: '2026-10-15T10:00:00Z' }])
    expect(tasks.truncated).toBe(false)
    expect(readFileSync(calls, 'utf8').trim().split('\n').sort()).toEqual([
      'pr view https://github.com/acme/shop/pull/9 --json statusCheckRollup,state,isDraft,mergedAt,autoMergeRequest,mergeStateStatus',
      `search issues harness-tab:${sharedTabId} --match body --limit 100 --json number,title,state,url,repository,body,updatedAt`,
      `search prs harness-tab:${sharedTabId} --match body --limit 100 --json number,state,url,repository,body,isDraft`,
    ])
    expect(await am(B2, { action: 'share_tasks', sharedTabId })).toMatchObject({ error: 'GH_MISSING' })

    // 5. Observation: Alice's harness is shared read-only with Bob; Bob's terminal stream from it, and no input.
    t = Date.now()
    const grant = await until('bob\'s listing to show alice\'s harness', async () => (await listing(B)).find((g) => g.agentId === lead.id) ?? null, 60_000, 500)
    mark('observer grant listed', t)
    const watch = await LocalClient.connect(B.d, { tcp: true, machineId: A.machineId, shareId: grant.id })
    expect(watch.frames.find((f) => f.type === 'connected')?.payload?.readOnly).toBe(true)
    const requestId = randomUUID()
    const ready = watch.next((f) => f.type === 'terminal_ready' && f.payload?.requestId === requestId, 30_000, 'terminal_ready')
    watch.send('terminal_open', { requestId, protocolVersion: 3, agentId: lead.id, cols: 120, rows: 40 })
    expect((await ready).payload?.readOnly).toBe(true)
    await watch.waitForBinary(() => true, 30_000, 'the terminal\'s first frame')
    expect((await watch.request('message', { agentId: lead.id, content: 'typed by an observer' })).error).toBe('VIEW_ONLY')

    // 4 (and 5's end). The second computer off, a message to its harness waits; Bob removed from the tab: his view of
    // Alice's harness closes at once, his listing drops it, and the message fails NOT_IN_TAB after the hold.
    await B2.d.stop()
    const stranded = await sendFrom(A, lead, 'bob/web', 'Still there?')
    expect(stranded.error, JSON.stringify(stranded)).toBeUndefined()
    await until('the message to wait for the second computer', async () => {
      const s = await statusOf(A, String(stranded.id))
      return s?.state === 'queued' && /away/.test(String(s.reason)) || null
    }, 40_000, 500)
    const roster = await rosterOf(A, sharedTabId)
    const bobId = roster!.members.find((m) => m.email === bob1b.email)!.accountId
    const removed = Date.now()
    expect(await am(A, { action: 'share_remove_member', sharedTabId, accountId: bobId })).toEqual({ ok: true })
    await until('bob\'s view of alice\'s harness to close', () => watch.closed || null, 5_000, 50)
    // 1c: the notice that Bob was removed is kept on disk: it is listed, survives his messages process restarting, and is
    // gone once dismissed.
    const removedNotice = await until('bob\'s removed notice', async () =>
      ((await shares(B)).notices as Array<Record<string, any>>).find((n) => n.kind === 'removed' && n.sharedTabId === sharedTabId) ?? null, 30_000, 300)
    expect(typeof removedNotice.id).toBe('string')
    const edgeB = (await processes(B.d)).find((p) => / harnessd-edge\b/.test(p) || /__service.*edge/.test(p))
    expect(edgeB, 'an edge host process').toBeDefined()
    const fromB = B.d.log().length
    process.kill(Number(edgeB!.split(' ')[0]), 'SIGKILL')
    await until('bob\'s messages to disconnect with the edge host', () => /\[services\] messages disconnected/.test(B.d.log().slice(fromB)) || null, 20_000, 100)
    await until('bob\'s messages to connect again', () => /\[services\] messages connected/.test(B.d.log().slice(fromB)) || null, 30_000, 200)
    const kept = await until('the removed notice after the restart', async () =>
      ((await shares(B)).notices as Array<Record<string, any>>).find((n) => n.id === removedNotice.id) ?? null, 30_000, 300)
    expect(kept.kind).toBe('removed')
    expect(await am(B, { action: 'share_notice_dismiss', id: removedNotice.id })).toEqual({ ok: true })
    expect(((await shares(B)).notices as Array<Record<string, any>>).some((n) => n.id === removedNotice.id), 'dismissed').toBe(false)
    times.push(`1b observer closed ${watch.closeCode} after ${Date.now() - removed}ms`)
    expect(watch.closeCode).toBe(4403)
    await until('bob\'s listing to drop alice\'s harness', async () => !(await listing(B)).some((g) => g.agentId === lead.id) || null, 15_000, 300)
    times.push(`1b listing dropped after ${Date.now() - removed}ms`)
    await holdThenNotInTab(A, String(stranded.id), removed, '1b')
  }, 1_200_000)

  // Tab Activity (docs/plans/2026-10-16-tab-activity.md, Task A5): a leader and tasks in every tab, and a summary of what a
  // harness does, on the real layout. core/main.ts is outside unit coverage, so this is the one proof a real daemon's
  // core produces the summary.
  it.concurrent('tab activity: a leader in an unshared tab, its tasks kept through sharing, a leader changed from another computer reaching the member, and a working harness\'s summary', async ({ expect, onTestFailed }) => {
    const sides: Side[] = []
    onTestFailed(() => failureLogs('activity', sides))
    const mark = (label: string, since: number) => times.push(`activity ${label} ${Date.now() - since}ms`)
    let t = Date.now()
    for (const who of [aliceAct, bobAct]) {
      const s = await signIn(backend, who, { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', VITEST: '' })
      sides.push({ who, d: s.daemon, machineId: s.machineId, client: s.client })
    }
    const [A, B] = sides
    mark('sign in both', t)
    for (const s of sides) {
      const on = await settings(s.d, { agentMessages: true })
      expect(on.status, await on.clone().text()).toBe(200)
      await until(`${s.who.name}: shared tabs to answer`, async () => !(await am(s, { action: 'shares' })).error || null, 30_000, 300)
    }
    // Each daemon's gh answers for whatever tab key it is asked for, as a task of that tab, and notes its calls.
    const calls = { A: join(A.d.root, 'gh-calls.log'), B: join(B.d.root, 'gh-calls.log') }
    writeFileSync(join(A.d.root, 'bin', 'gh'), keyedGh(calls.A), { mode: 0o755 })
    writeFileSync(join(B.d.root, 'bin', 'gh'), keyedGh(calls.B), { mode: 0o755 })

    // 1. Two harnesses of Alice's in an unshared tab; the leader set through the backend route: both notes say so.
    const lead = await create(A, 'activity-lead')
    const worker = await create(A, 'activity-worker')
    const desk = await backend.api(aliceAct, '/api/desk/ops', 'POST', { ops: [
      { op: 'tab.create', id: 'app', name: 'app' },
      { op: 'pane.add', tabId: 'app', machineId: A.machineId, agentId: lead.id },
      { op: 'pane.add', tabId: 'app', machineId: A.machineId, agentId: worker.id }] })
    expect(desk.status, JSON.stringify(desk.body)).toBe(200)
    t = Date.now()
    const set = await backend.api(aliceAct, '/api/agent-messages/tabs/app', 'PATCH', { leader: { machineId: A.machineId, agentId: lead.id } })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    const noteOf = async (s: Side, agent: Record<string, any>, includes: string) => until(`${agent.id}'s note to say ${includes.slice(0, 40)}`, async () => {
      const r = await am(s, { action: 'send', pane: agent.tmuxPane })
      return !r.error && String(r.roster).includes(includes) ? r : null
    }, 30_000, 500)
    const leadNote = await noteOf(A, lead, 'You lead this tab.')
    const workerNote = await noteOf(A, worker, ' leads this tab. Take work from it')
    const leadName = /^(.*) leads this tab\./m.exec(String(workerNote.roster))?.[1]
    expect(leadName, String(workerNote.roster)).toBeTruthy()
    expect(String(leadNote.roster)).not.toContain('leads this tab. Take work')
    // Both notes carry the marker, with the key the tab would be shared under and this account's concrete label.
    const key = /harness-tab:([a-f0-9]{24})/.exec(String(leadNote.roster))?.[1]
    expect(key, String(leadNote.roster)).toBeDefined()
    for (const n of [leadNote, workerNote]) expect(String(n.roster)).toContain(`assignee:alice/<harness>`)
    expect((await backend.api(aliceAct, '/api/agent-messages')).body.data.tabs.find((tab: Record<string, any>) => tab.id === 'app')?.leader)
      .toEqual({ machineId: A.machineId, agentId: lead.id })
    mark('leader and notes', t)

    // 2. A task made before sharing is the tab's: listed by tab id, then again after sharing, for the owner and the member.
    const before = await am(A, { action: 'share_tasks', tabId: 'app' })
    expect(before.error, JSON.stringify(before)).toBeUndefined()
    expect(before.rows).toHaveLength(1)
    expect(before.rows[0]).toMatchObject({ repo: 'acme/shop', issue: 7, title: 'Fix the checkout total', assignee: { account: 'alice', harness: 'lead' } })
    expect(readFileSync(calls.A, 'utf8')).toContain(`search issues harness-tab:${key} `)
    t = Date.now()
    const shared = await am(A, { action: 'share_tab', tabId: 'app', name: 'app' })
    expect(shared.error, JSON.stringify(shared)).toBeUndefined()
    const sharedTabId = String(shared.sharedTabId)
    expect(sharedTabId, 'the key a tab is shared under is the one its tasks already carried').toBe(key)
    const sinceInvite = B.client.frames.length
    expect(await am(A, { action: 'share_invite', sharedTabId, emails: [bobAct.email], days: 7 })).toMatchObject({ invited: [bobAct.email] })
    await B.client.waitFor((f) => f.type === 'shared_tabs_changed', 15_000, 'shared_tabs_changed after an invitation', sinceInvite)
    const invitation = await until('the invitation', async () => (await shares(B)).invites.find((i) => i.sharedTabId === sharedTabId) ?? null, 20_000, 300)
    expect((await am(B, { action: 'share_accept', inviteId: invitation.id })).error).toBeUndefined()
    const api = await create(B, 'activity-api')
    expect(await am(B, { action: 'share_add', sharedTabId, harness: { machineId: B.machineId, agentId: api.id, name: 'api', engine: 'claude' } })).toEqual({ queued: true })
    const want = [`${A.machineId}/${lead.id}`, `${A.machineId}/${worker.id}`, `${B.machineId}/${api.id}`].sort()
    await until('both daemons to hold the roster with all three harnesses', async () => {
      const [ra, rb] = [await rosterOf(A, sharedTabId), await rosterOf(B, sharedTabId)]
      return ra && rb && ra.version === rb.version && JSON.stringify(harnessKeys(ra)) === JSON.stringify(want) && JSON.stringify(harnessKeys(rb)) === JSON.stringify(want) || null
    }, 90_000, 300)
    mark('shared, invited, member added', t)
    const after = await am(A, { action: 'share_tasks', sharedTabId })
    expect(after.error, JSON.stringify(after)).toBeUndefined()
    expect(after.rows, 'the same task after sharing').toEqual(before.rows)
    const bobs = await am(B, { action: 'share_tasks', sharedTabId })
    expect(bobs.error, JSON.stringify(bobs)).toBeUndefined()
    expect(bobs.rows, 'the member lists the same task').toEqual(before.rows)
    expect(readFileSync(calls.B, 'utf8')).toContain(`search issues harness-tab:${sharedTabId} `)

    // 3. The leader changed from "another computer" (the backend route): the sharing computer re-signs the roster, and the
    // member's roster names the new leader, after first naming the one the tab had.
    const leaderOf = async (s: Side) => (await rosterOf(s, sharedTabId))?.leader ?? null
    await until('bob\'s roster to name the first leader', async () => (await leaderOf(B))?.agentId === lead.id || null, 30_000, 500)
    t = Date.now()
    const moved = await backend.api(aliceAct, '/api/agent-messages/tabs/app', 'PATCH', { leader: { machineId: A.machineId, agentId: worker.id } })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    const newLeader = await until('bob\'s roster to name the new leader', async () => {
      const l = await leaderOf(B)
      return l?.agentId === worker.id ? l : null
    }, 30_000, 500)
    expect(newLeader).toEqual({ machineId: A.machineId, agentId: worker.id })
    mark('leader change reached the member', t)

    // 4. Alice's lead works on a turn: Bob's window hears it working with a summary of the prompt, and so does `tab_activity`.
    t = Date.now()
    const sinceWork = B.client.frames.length
    A.client.send('message', { agentId: lead.id, content: '!work 12 refactor the parser', requestId: randomUUID() })
    const seen = await B.client.waitFor((f) => f.type === 'shared_activity' && f.payload?.agentId === lead.id && f.payload?.state === 'working' && typeof f.payload?.summary === 'string',
      40_000, 'Alice\'s working harness with a summary, seen by Bob', sinceWork)
    expect(seen.payload).toMatchObject({ sharedTabId, machineId: A.machineId, agentId: lead.id, state: 'working' })
    expect(String(seen.payload?.summary)).toContain('refactor the parser')
    expect(String(seen.payload?.summary).length).toBeLessThanOrEqual(120)
    mark('summary reached the member\'s window', t)
    const own = await until('tab_activity to give the working harness its summary', async () => {
      const r = await am(A, { action: 'tab_activity', tabId: 'app' })
      const row = (r.harnesses as Array<Record<string, any>> | undefined)?.find((h) => h.agentId === lead.id)
      return row?.state === 'working' && row.summary ? r : null
    }, 20_000, 500)
    expect(String(own.harnesses.find((h: Record<string, any>) => h.agentId === lead.id).summary)).toContain('refactor the parser')
    expect(own.harnesses.map((h: Record<string, any>) => h.agentId).sort()).toEqual([lead.id, worker.id, api.id].sort())
    const theirs = await am(B, { action: 'tab_activity', tabId: sharedTabId })
    expect(theirs.error, JSON.stringify(theirs)).toBeUndefined()
    expect(String(theirs.harnesses.find((h: Record<string, any>) => h.agentId === lead.id)?.summary ?? ''), 'the member\'s own tab_activity').toContain('refactor the parser')
  }, 420_000)

  it.concurrent('step 1b in the core\'s process (HARNESSD_SERVICES=none): messages cross accounts both ways, and a removed member\'s waits fail NOT_IN_TAB', async ({ expect, onTestFailed }) => {
    const sides: Side[] = []
    onTestFailed(() => failureLogs('in-core', sides))
    const none = { HARNESSD_SERVICES: 'none' }
    const { A, B, lead, api, sharedTabId } = await sharedPair(aliceCore, bobCore, 'in-core', sides, { owner: none, member: none })
    for (const s of sides) {
      expect(s.d.env.HARNESSD_SERVICES).toBe('none')
      expect(s.d.log(), 'no edge host: every service in the core').not.toMatch(/\[harnessd\] service edge started/)
    }
    // 2. Both ways, heard through the core's own wiring of tab frames.
    const leadName = (await rosterOf(B, sharedTabId))!.harnesses.find((h) => h.agentId === lead.id)!.name
    const there = await sendFrom(A, lead, 'bob/api', 'In-core: which port?')
    expect(there.error, JSON.stringify(there)).toBeUndefined()
    await delivered(A, String(there.id))
    expect(await until('the message in bob\'s api conversation', () => prompts(B, api).find((p) => p.includes(`[${there.id} from `)) ?? null, 30_000, 300))
      .toMatch(new RegExp(`\\[${there.id} from [^\\]]* · alice's account · Claude Code · [^\\]]+\\]`))
    const back = await sendFrom(B, api, `alice/${leadName}`, 'In-core: 8443.')
    expect(back.error, JSON.stringify(back)).toBeUndefined()
    await delivered(B, String(back.id))
    expect(await until('the answer in alice\'s lead conversation', () => prompts(A, lead).find((p) => p.includes(`[${back.id} from `)) ?? null, 30_000, 300))
      .toMatch(new RegExp(`\\[${back.id} from [^\\]]* · bob's account · Claude Code · [^\\]]+\\]`))
    // 4. Bob's computer off, a message waits; Bob removed: it fails NOT_IN_TAB after the hold.
    await B.d.stop()
    const stranded = await sendFrom(A, lead, 'bob/api', 'In-core: still there?')
    expect(stranded.error, JSON.stringify(stranded)).toBeUndefined()
    await until('the message to wait for bob\'s computer', async () => {
      const s = await statusOf(A, String(stranded.id))
      return s?.state === 'queued' && /away/.test(String(s.reason)) || null
    }, 40_000, 500)
    const bobId = (await rosterOf(A, sharedTabId))!.members.find((m) => m.email === bobCore.email)!.accountId
    const removed = Date.now()
    expect(await am(A, { action: 'share_remove_member', sharedTabId, accountId: bobId })).toEqual({ ok: true })
    await holdThenNotInTab(A, String(stranded.id), removed, 'in-core')
  }, 1_200_000)
})

/** messages/service.ts HELD_OUTSIDE_MS: how long a message for a harness no tab carries any more waits before it fails. */
const HOLD_MS = 5 * 60_000

/** Two accounts, one daemon each, Agent Messages on, the owner's lead in a desk tab shared with the member, who accepted
 *  and added a harness named `api`: 1a's steps, as the 1b steps start from them. */
async function sharedPair(owner: Account, member: Account, label: string, sides: Side[],
  env: { owner?: Record<string, string>; member?: Record<string, string> } = {}) {
  let t = Date.now()
  for (const [who, extra] of [[owner, env.owner], [member, env.member]] as const) {
    const s = await signIn(backend, who, { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', ...extra })
    sides.push({ who, d: s.daemon, machineId: s.machineId, client: s.client })
  }
  const [A, B] = sides
  times.push(`${label} sign in both ${Date.now() - t}ms`)
  for (const s of [A, B]) {
    const on = await settings(s.d, { agentMessages: true })
    expect(on.status, await on.clone().text()).toBe(200)
    await until(`${s.who.name}: shared tabs to answer`, async () => !(await am(s, { action: 'shares' })).error || null, 30_000, 300)
  }
  const lead = await create(A, `${label}-lead`)
  const desk = await backend.api(owner, '/api/desk/ops', 'POST', { ops: [
    { op: 'tab.create', id: 'app', name: 'app' }, { op: 'pane.add', tabId: 'app', machineId: A.machineId, agentId: lead.id }] })
  expect(desk.status, JSON.stringify(desk.body)).toBe(200)
  const shared = await am(A, { action: 'share_tab', tabId: 'app', name: 'app' })
  expect(shared.error, JSON.stringify(shared)).toBeUndefined()
  const sharedTabId = String(shared.sharedTabId)
  // 1c: the member's window hears of the invitation (`shared_tabs_changed`), and the invitation names the tab.
  const sinceInvite = B.client.frames.length
  expect(await am(A, { action: 'share_invite', sharedTabId, emails: [member.email], days: 7 })).toMatchObject({ invited: [member.email] })
  await B.client.waitFor((f) => f.type === 'shared_tabs_changed', 15_000, 'shared_tabs_changed after an invitation', sinceInvite)
  const invitation = await until(`${label}: the invitation`, async () => (await shares(B)).invites.find((i) => i.sharedTabId === sharedTabId) ?? null, 20_000, 300)
  expect(invitation.tabName, 'the invitation names the tab').toBe('app')
  const accepted = await am(B, { action: 'share_accept', inviteId: invitation.id })
  expect(accepted.error, JSON.stringify(accepted)).toBeUndefined()
  const api = await create(B, `${label}-api`)
  t = Date.now()
  expect(await am(B, { action: 'share_add', sharedTabId, harness: { machineId: B.machineId, agentId: api.id, name: 'api', engine: 'claude' } })).toEqual({ queued: true })
  const want = [`${A.machineId}/${lead.id}`, `${B.machineId}/${api.id}`].sort()
  await until(`${label}: both daemons to hold the roster with both harnesses`, async () => {
    const [ra, rb] = [await rosterOf(A, sharedTabId), await rosterOf(B, sharedTabId)]
    return ra && rb && ra.version === rb.version && JSON.stringify(harnessKeys(ra)) === JSON.stringify(want) && JSON.stringify(harnessKeys(rb)) === JSON.stringify(want) || null
  }, 90_000, 300)
  times.push(`${label} share_add converged ${Date.now() - t}ms`)
  return { A, B, lead, api, sharedTabId }
}

/** `harness send` from an agent's pane: the request `harness send <to> "text"` makes of its daemon. */
const sendFrom = (s: Side, agent: Record<string, any>, to: string, text: string) => am(s, { action: 'send', pane: agent.tmuxPane, to: [to], text })
const statusOf = async (s: Side, id: string) =>
  ((await am(s, { action: 'history' })).messages as Array<{ id: string; statuses: Array<Record<string, any>> }> | undefined)?.find((m) => m.id === id)?.statuses[0] ?? null
const delivered = (s: Side, id: string, ms = 60_000) => until(`${id} to be delivered`, async () => {
  const status = await statusOf(s, id)
  return status?.state === 'delivered' ? status : null
}, ms, 500)

/** What was typed into an agent's conversation: the user prompts its (fake) engine wrote to its transcript. */
function prompts(s: Side, agent: Record<string, any>): string[] {
  const projects = join(s.d.root, 'claude', 'projects')
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${agent.sessionId}.jsonl`)
    if (!existsSync(file)) continue
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        const record = JSON.parse(line)
        return record.type === 'user' && typeof record.message?.content === 'string' ? [record.message.content as string] : []
      } catch { return [] }
    })
  }
  return []
}

/** A daemon started again: signed in and connected to the backend, with a new client. */
async function connectedAgain(s: Side): Promise<void> {
  await until(`${s.who.name}: connected again`, async () => (await (await fetch(`http://127.0.0.1:${s.d.port}/api/status`,
    { headers: { 'x-adapter-local': '1' } })).json()).connected === true, 60_000, 200)
  s.client = await LocalClient.connect(s.d, { machineId: s.machineId })
}

/** The harnesses other accounts share with this one, as the daemon lists them (`GET /api/harness-shares`). */
async function listing(s: Side): Promise<Array<{ id: string; agentId: string }>> {
  const body = await (await fetch(`http://127.0.0.1:${s.d.port}/api/harness-shares`, { headers: { 'x-adapter-local': '1' } })).json()
  return ((body?.data?.machines ?? []) as Array<{ shares: Array<{ id: string; agentId: string }> }>).flatMap((m) => m.shares)
}

/** A message whose recipient was removed waits HOLD_MS, saying why, then fails NOT_IN_TAB. */
async function holdThenNotInTab(A: Side, id: string, removed: number, label: string): Promise<void> {
  const held = await until(`${label}: ${id} held as not in a tab`, async () => {
    const s = await statusOf(A, id)
    return s?.state === 'queued' && /not in a tab with the sender/.test(String(s.reason)) ? s : null
  }, 30_000, 500)
  times.push(`${label} held after ${Date.now() - removed}ms: ${held.reason}`)
  const failed = await until(`${label}: ${id} to fail NOT_IN_TAB`, async () => {
    const s = await statusOf(A, id)
    return s?.state === 'failed' ? s : null
  }, HOLD_MS + 90_000, 2_000)
  const waited = Date.now() - removed
  times.push(`${label} NOT_IN_TAB after ${waited}ms: ${failed.reason}`)
  expect(failed).toMatchObject({ state: 'failed', code: 'NOT_IN_TAB' })
  expect(waited, 'failed only after the hold').toBeGreaterThanOrEqual(HOLD_MS - 15_000)
}

/**
 * A daemon with no `gh` at all: the forbidding stub removed, and a PATH of the test's own bin folder, a folder holding
 * only tmux, and the system's folders. Homebrew's folder, where tmux and the developer's gh both live, is not on it, so
 * the daemon finds tmux there and never adopts that folder (lib/tmuxOnPath.ts prepends tmux's folder to PATH when tmux
 * is missing).
 */
async function withoutGh(d: IsolatedDaemon): Promise<void> {
  const tmux = resolveBinaryOnPath('tmux', d.env)
  if (!tmux) throw new Error('tmux is required')
  const tools = join(d.root, 'tools')
  mkdirSync(tools, { recursive: true })
  symlinkSync(tmux, join(tools, 'tmux'))
  rmSync(join(d.root, 'bin', 'gh'))
  d.env.PATH = [join(d.root, 'bin'), tools, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')
  const found = d.env.PATH.split(':').filter((dir) => existsSync(join(dir, 'gh')))
  if (found.length) throw new Error(`a gh is on the PATH meant to have none: ${found.join(', ')}`)
}

/** A `gh` with canned answers for the three calls a shared tab's tasks make (messages/tasks.ts), each noted in [log];
 *  any other call fails loudly. An issue that only mentions the id, without the marker, is in the search and not a task. */
function cannedGh(id: string, log: string): string {
  const issues = JSON.stringify([
    { number: 7, title: 'Fix the checkout total', state: 'OPEN', url: 'https://github.com/acme/shop/issues/7', repository: { nameWithOwner: 'acme/shop' },
      body: `Totals are off.\n<!-- harness-tab:${id} assignee:bob/api -->`, updatedAt: '2026-10-15T10:00:00Z' },
    { number: 8, title: 'Mentions the tab', state: 'OPEN', url: 'https://github.com/acme/shop/issues/8', repository: { nameWithOwner: 'acme/shop' },
      body: `See harness-tab:${id} for context.`, updatedAt: '2026-10-15T11:00:00Z' }])
  const prs = JSON.stringify([{ number: 9, state: 'OPEN', url: 'https://github.com/acme/shop/pull/9', repository: { nameWithOwner: 'acme/shop' },
    body: `Closes #7\n<!-- harness-tab:${id} assignee:bob/api -->`, isDraft: false }])
  const view = JSON.stringify({ state: 'OPEN', isDraft: false, mergedAt: null, autoMergeRequest: null, mergeStateStatus: 'CLEAN', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] })
  return `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  "search issues harness-tab:${id} --match body --limit 100 --json number,title,state,url,repository,body,updatedAt") cat <<'JSON'
${issues}
JSON
  ;;
  "search prs harness-tab:${id} --match body --limit 100 --json number,state,url,repository,body,isDraft") cat <<'JSON'
${prs}
JSON
  ;;
  "pr view https://github.com/acme/shop/pull/9 --json statusCheckRollup,state,isDraft,mergedAt,autoMergeRequest,mergeStateStatus") cat <<'JSON'
${view}
JSON
  ;;
  *) echo "the test's gh was called in a way it has no answer for: $*" >&2; exit 98 ;;
esac
`
}

/** A `gh` that answers any tab's issue search with one task of that tab (the key is read from the call) and no pull
 *  requests, noting each call in [log]; any other call fails loudly. */
function keyedGh(log: string): string {
  return `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  "search issues harness-tab:"*" --match body --limit 100 --json number,title,state,url,repository,body,updatedAt")
    id="\${3#harness-tab:}"
    printf '[{"number":7,"title":"Fix the checkout total","state":"OPEN","url":"https://github.com/acme/shop/issues/7","repository":{"nameWithOwner":"acme/shop"},"body":"Totals are off.\\\\n<!-- harness-tab:%s assignee:alice/lead -->","updatedAt":"2026-10-15T10:00:00Z"}]\\n' "$id"
  ;;
  "search prs harness-tab:"*" --match body --limit 100 --json number,state,url,repository,body,isDraft") echo '[]' ;;
  *) echo "the test's gh was called in a way it has no answer for: $*" >&2; exit 98 ;;
esac
`
}

function failureLogs(label: string, sides: Side[]): void {
  for (const s of sides) console.log(`---- ${label}: ${s.who.name}'s daemon ${s.machineId.slice(0, 8)} log\n${tail(s.d.log(), 250)}`)
  try { console.log(`---- backend log ${backend.logPath}\n${tail(readFileSync(backend.logPath, 'utf8'), 150)}`) } catch { /* gone */ }
}
