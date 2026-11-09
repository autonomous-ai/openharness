/** Agents talking to each other in their project's channel (Swarm v4), on the real native protocol: the real master, core and
 * Swarm service, a private tmux, fake engines and a loopback server in place of the backend. An agent posts with `harness
 * super-tab post` from its own pane and is heard by name: the post is stored once, and an @Name in it is typed into the named
 * agent's pane once, whether that agent is idle, busy or not running (owner, 2026-11-09: "i dont see any agent to agent chat"). */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { object } from '../src/superTabs/wire.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { overOldRoutes } from './harness/swarmReads.js'

const ME: FakeMachine = { machineId: 'd7'.repeat(16), computerId: 'e2e-channel-computer', name: 'Fixture', token: 'e2e-channel-token' }
const TAB = 'fixture-tab', OTHER_TAB = 'second-tab', CHANNEL = 'channel'
let daemon: IsolatedDaemon | undefined, backend: FakeBackend | undefined
const clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(client => client.close())
  await daemon?.close(); daemon = undefined
  await backend?.close(); backend = undefined
})
const idFor = (harnessId: string) => createHash('sha256').update(JSON.stringify([ME.machineId, harnessId])).digest('hex').slice(0, 24)

/** One daemon, signed in to a loopback server that holds the Swarm's roster for this machine, the posts it was sent (stored once
 *  under their operation id, as the real server does) and the deliveries waiting for each agent. */
async function boot() {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME)
  const d = await IsolatedDaemon.create({ submissionGate: true, env: {
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
    // The Swarm is on, whatever the run was started with (`HARNESS_SWARM=off npm run test:e2e`): a Swarm role is refused with it off.
    HARNESS_SWARM: '',
  } }); daemon = d
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-80).join('\n')))
  /** The agents the Swarm lists for this machine, by Swarm. */
  const rosters = new Map<string, Array<Record<string, any>>>([[TAB, []], [OTHER_TAB, []]])
  const stored = new Map<string, Record<string, any>>()
  const requests: Array<{ tab: string; operationId: string; asAgentId: string; command: Record<string, any> }> = []
  const deliveries: Array<Record<string, any>> = []
  relay.superTabs = overOldRoutes(async (method, raw, body) => {
    const url = new URL(raw, relay.httpUrl), path = url.pathname
    if (path === `/api/super-tabs/hosts/${ME.machineId}/pools` || path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: [] }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) {
      return { data: [...rosters].flatMap(([tabId, agents]) => agents.map(agent => ({ tabId, agent, observers: [] }))) }
    }
    const tab = /^\/api\/super-tabs\/([^/]+)$/.exec(path)
    if (tab && method === 'GET') {
      return { data: { revision: 1, state: { id: tab[1], agents: rosters.get(tab[1]!) ?? [], conversations: [{ id: CHANNEL, kind: 'channel', title: 'Pilot', agentIds: [] }],
        projects: [{ id: 'lead', name: 'Pilot', leadConversationId: CHANNEL }] } } }
    }
    if (path.endsWith('/messages')) return { data: { messages: [] } }
    const posted = /^\/api\/super-tabs\/([^/]+)\/commands$/.exec(path)
    if (posted && method === 'POST') {
      const command = object(body.command)
      if (command.type !== 'message.send') throw new Error(`Unexpected command ${String(command.type)}`)
      requests.push({ tab: posted[1]!, operationId: body.operationId, asAgentId: body.asAgentId, command })
      // The server's limit, and its refusal of an operation id used for other words.
      if (String(command.text).trim().length > 32_000) return { status: 400, error: { code: 'VALIDATION_ERROR', message: 'text: String must contain at most 32000 character(s)' } }
      const before = stored.get(body.operationId)
      if (before && JSON.stringify(before) !== JSON.stringify(command)) return { status: 409, error: { code: 'OPERATION_REUSED', message: 'This operation id was used for another request.' } }
      stored.set(body.operationId, command)
      return { data: { result: {} } }
    }
    const delivery = /\/agents\/([^/]+)\/deliveries(?:\/([^/]+))?$/.exec(path)
    if (delivery) {
      const open = deliveries.filter(value => value.agentId === delivery[1])
      if (method === 'GET') return { data: delivery[2] ? open.find(value => value.id === delivery[2]) : open.filter(value => value.status !== 'delivered') }
      const value = open.find(item => item.id === delivery[2])
      if (!value) throw new Error('Unknown delivery')
      if (value.claimId && value.claimId !== body.claimId) throw new Error('Claim changed')
      if (body.type === 'claim') { value.claimId = body.claimId; value.claims = (value.claims ?? 0) + 1; return { data: { message: value.message } } }
      value.status = body.uncertain ? 'uncertain' : 'delivered'
      value.receipt = body.receipt
      return { data: {} }
    }
    throw new Error(`Unexpected request ${method} ${raw}`)
  })
  await d.start()
  const client = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(client)
  const cwd = join(d.projectsDir, 'project'); mkdirSync(cwd, { recursive: true })
  const make = async (name: string) => {
    // A start made while the daemon is still confirming the engine's native hooks is held, and answered as it is made again.
    const made = await until(`${name} to be created`, async () => {
      // Started as + New agent starts one (desktop/lib/super_tabs/new_agent.dart), with its Swarm role: its launch carries the team's basics,
      // and the host tells it nothing of them.
      const answer = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, swarmRole: 'dev' }, 90_000)
      return answer.error === 'NATIVE_LAUNCH_HELD' ? null : answer
    }, 90_000, 1_000)
    expect(made.error, JSON.stringify(made)).toBeUndefined()
    const row = (await client.request('agents_list')).agents.find((agent: Record<string, any>) => agent.id === made.agent.id)
    return { harnessId: made.agent.id as string, memberId: idFor(made.agent.id), pane: row.tmuxPane as string, name }
  }
  type Made = Awaited<ReturnType<typeof make>>
  const member = (agent: Made) => ({ id: agent.memberId, machineId: ME.machineId, harnessId: agent.harnessId, displayName: agent.name })
  const where = { port: d.port, dataDir: d.dataDir, machineId: ME.machineId, harnessPane: true }
  /** `harness super-tab ...` run in [agent]'s own pane: the daemon names the caller from the pane, as it does for a real one. */
  async function run(agent: Made, args: string[], stdin?: string) {
    let printed = ''
    const code = await superTabCommand(args, { where: () => where, pane: agent.pane, print: text => { printed = text },
      ...(stdin === undefined ? {} : { stdin: () => stdin, terminal: () => false }) })
    return { code, answer: JSON.parse(printed) as Record<string, any> }
  }
  const prompts = () => { try { return readFileSync(join(d.root, 'submitted-prompts'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string) } catch { return [] } }
  return { d, client, rosters, stored, requests, deliveries, make, member, run, prompts }
}

it('stores an agent\'s post in its channel once, from its own pane, whatever it says and however many Swarms it is in', async () => {
  const f = await boot()
  const pip = await f.make('Pip'), mira = await f.make('Mira')
  f.rosters.get(TAB)!.push(f.member(pip))
  const sent = (operationId: string) => f.requests.filter(request => request.operationId === operationId)

  // With its Swarm named, and with it left out (the one Swarm it is in): the same post as itself, with the words as written.
  const named = await f.run(pip, ['--tab', TAB, 'post', CHANNEL, 'free: Pip', 'post-named'])
  expect(named.code, JSON.stringify(named.answer)).toBe(0)
  const bare = await f.run(pip, ['post', CHANNEL, 'Juno, 14:05: free: Pip', 'post-bare'])
  expect(bare.code, JSON.stringify(bare.answer)).toBe(0)
  expect(f.requests.map(request => [request.tab, request.operationId, request.asAgentId, request.command])).toEqual([
    [TAB, 'post-named', pip.memberId, { type: 'message.send', conversationId: CHANNEL, text: 'free: Pip', replyTo: null, recipientIds: [] }],
    [TAB, 'post-bare', pip.memberId, { type: 'message.send', conversationId: CHANNEL, text: 'Juno, 14:05: free: Pip', replyTo: null, recipientIds: [] }],
  ])

  // The same post again, as an agent does when it was not told it went: the same request, so the server keeps one.
  const again = await f.run(pip, ['post', CHANNEL, 'Juno, 14:05: free: Pip', 'post-bare'])
  expect(again.code, JSON.stringify(again.answer)).toBe(0)
  expect(sent('post-bare')).toHaveLength(2)
  expect(sent('post-bare')[1]).toEqual(sent('post-bare')[0])
  expect([...f.stored.keys()]).toEqual(['post-named', 'post-bare'])
  // The same id for other words is the server's refusal, said as it said it.
  const reused = await f.run(pip, ['post', CHANNEL, 'other words', 'post-bare'])
  expect(reused.code).toBe(1)
  expect(reused.answer).toMatchObject({ error: 'OPERATION_REUSED', operationId: 'post-bare' })

  // What it says arrives as it said it: unicode, quotes, shell characters and newlines; a post of 32,000 characters whole.
  const words = 'Pip: ✅ shipped 👨‍👩‍👧‍👦 🇻🇳 שלום مرحبا 日本語 é "double" \'single\' $(not run) `ticks` \\ back\nand a second line\n\n    indented'
  const unicode = await f.run(pip, ['post', CHANNEL, words, 'post-unicode'])
  expect(unicode.code, JSON.stringify(unicode.answer)).toBe(0)
  expect(f.stored.get('post-unicode')!.text).toBe(words)
  const full = 'x'.repeat(32_000)
  expect((await f.run(pip, ['post', CHANNEL, full, 'post-full'])).code).toBe(0)
  expect(f.stored.get('post-full')!.text).toBe(full)
  // The message on stdin with `-`, which no shell quoting can split.
  expect((await f.run(pip, ['post', CHANNEL, '-', 'post-stdin'], `${words}\n`)).code).toBe(0)
  expect(f.stored.get('post-stdin')!.text).toBe(words)

  // Past the server's 32,000 characters the server says so, and nothing is stored or cut.
  const over = await f.run(pip, ['post', CHANNEL, 'y'.repeat(32_001), 'post-over'])
  expect(over.code).toBe(1)
  expect(over.answer).toMatchObject({ error: 'VALIDATION_ERROR', operationId: 'post-over' })
  expect(f.stored.has('post-over')).toBe(false)
  // Far past what the daemon's own socket takes, the agent hears a reason, not silence.
  const huge = await f.run(pip, ['post', CHANNEL, '-', 'post-huge'], 'z'.repeat(3_000_000))
  expect(huge.code).toBe(1)
  expect(String(huge.answer.error), JSON.stringify(huge.answer)).not.toBe('')
  expect(f.stored.has('post-huge')).toBe(false)

  // An agent in two Swarms names one; with its Swarm named it posts there.
  f.rosters.get(OTHER_TAB)!.push(f.member(pip))
  const both = await f.run(pip, ['post', CHANNEL, 'which one?', 'post-both'])
  expect(both.code).toBe(1)
  expect(both.answer).toMatchObject({ error: 'SWARM_AMBIGUOUS', detail: `This agent is in 2 Swarms: name one with --tab (${TAB}, ${OTHER_TAB}).` })
  expect(f.stored.has('post-both')).toBe(false)
  const other = await f.run(pip, ['--tab', OTHER_TAB, 'post', CHANNEL, 'this one', 'post-other'])
  expect(other.code, JSON.stringify(other.answer)).toBe(0)
  expect(sent('post-other')[0]).toMatchObject({ tab: OTHER_TAB })

  // An agent in no Swarm has nothing to post to, whether it names one or not.
  const lost = await f.run(mira, ['post', CHANNEL, 'hello', 'post-lost'])
  expect(lost.code).toBe(1)
  expect(lost.answer).toMatchObject({ error: 'INVALID_REQUEST' })
  const lostNamed = await f.run(mira, ['--tab', TAB, 'post', CHANNEL, 'hello', 'post-lost-named'])
  expect(lostNamed.code).toBe(1)
  expect(lostNamed.answer).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
  expect(f.stored.has('post-lost') || f.stored.has('post-lost-named')).toBe(false)
}, 300_000)

it('types an @Name mention from another agent into the named agent once: idle, busy, and not running', async () => {
  const f = await boot()
  const pip = await f.make('Pip'), juno = await f.make('Juno'), kai = await f.make('Kai')
  // Zed is the Swarm's, on this machine's roster, but its session is not running here (stopped, or the machine was off).
  const away = { harnessId: 'zed-session-not-running', memberId: idFor('zed-session-not-running'), pane: '%99', name: 'Zed' }
  for (const agent of [pip, juno, kai, away]) f.rosters.get(TAB)!.push(f.member(agent))
  // The Swarm's service runs in a process of its own, started when the core is asked for it.
  expect(await f.client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  const mention = (to: typeof pip, id: string, text: string) => {
    const row = { id: `delivery-${id}`, agentId: to.memberId, conversationId: CHANNEL, status: 'queued', claimId: null,
      message: { id: `message-${id}`, conversationId: CHANNEL, author: { kind: 'agent', id: pip.memberId, name: 'Pip' }, text, recipientIds: [to.memberId],
        createdAt: '2026-11-09T09:00:00.000Z' } }
    f.deliveries.push(row)
    return row
  }

  // Idle: typed once, as Pip wrote it and told where and how to answer; no more reads of it however long the host looks.
  const idle = mention(juno, 'idle', '@Juno can you review #4?')
  await until('Juno\'s delivery acknowledged', () => idle.status === 'delivered' || null, 60_000, 250)
  const typed = f.prompts()
  expect(typed).toHaveLength(1)
  // Told where it is and who wrote it, and the command that answers in the channel's thread: Juno's own, naming Pip.
  expect(typed[0]).toMatch(new RegExp(`^In the project chat of Pilot \\(conversation ${CHANNEL}\\)\\.\\n\\n@Pip, to you:\\n@Juno can you review #4\\?\\n\\n`
    + `Answer: .* super-tab .* --tab '${TAB}' --agent '${juno.memberId}' post '${CHANNEL}' 'your message' UNIQUE_OPERATION_ID --reply-to 'message-idle' --to '${pip.memberId}'$`))
  expect(idle.claims).toBe(1)

  // Busy: typed into the running turn, once, and acknowledged before that turn ends.
  const turn = f.client.next(frame => frame.type === 'turn_started' && frame.agentId === kai.harnessId && !frame.replay)
  f.client.send('message', { agentId: kai.harnessId, content: '!slow 15000' })
  await turn
  const ended = () => f.client.frames.filter(frame => frame.type === 'turn_ended' && frame.agentId === kai.harnessId && !frame.replay).length
  const before = ended()
  const busy = mention(kai, 'busy', '@Kai the build is red, can you look?')
  await until('Kai\'s delivery acknowledged', () => busy.status === 'delivered' || null, 60_000, 250)
  expect(ended(), 'typed and acknowledged while the turn still runs').toBe(before)
  expect(f.prompts().filter(prompt => prompt.includes('the build is red'))).toHaveLength(1)
  expect(busy.claims).toBe(1)

  // Not running: its session is not on this machine, so nothing is claimed or typed for it, and the mention waits where the server
  // keeps it for the next time it runs.
  const waiting = mention(away, 'waiting', '@Zed are you there?')
  await new Promise(resolve => setTimeout(resolve, 6_000))
  expect(waiting).toMatchObject({ status: 'queued', claimId: null })
  expect(f.prompts().some(prompt => prompt.includes('are you there'))).toBe(false)
}, 300_000)
