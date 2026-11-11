/** A person's message in their agent's own 1:1 chat, on the real native protocol: the real master, core and Swarm service in their
 * own process, a private tmux and fake engines, and a loopback server in place of the backend. The agent is typed exactly what
 * its person typed, and when its turn ends the host posts the answer as the agent, once, or one line saying it could not (anh
 * Dee, 2026-11-09: "it's a 1:1 conversation, why can't it be just the exact prompt?"). An agent its person attached, which has no
 * Swarm role, is the same, and is told the team's basics once besides (#3642). Each message is answered by its own turn, even when
 * the engine queued a second one behind the first and the host heard neither end until both were over. */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { SWARM_BASICS } from '../src/lib/swarmSkills.js'
import { object } from '../src/superTabs/wire.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FAKE_ACCOUNT, FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { overOldRoutes } from './harness/swarmReads.js'

const ME: FakeMachine = { machineId: 'c9'.repeat(16), computerId: 'e2e-agent-chat-computer', name: 'Fixture', token: 'e2e-agent-chat-token' }
const TAB = 'fixture-tab', CHAT = 'chat'
let daemon: IsolatedDaemon | undefined, backend: FakeBackend | undefined
const clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(client => client.close())
  await daemon?.close(); daemon = undefined
  await backend?.close(); backend = undefined
})
const idFor = (harnessId: string) => createHash('sha256').update(JSON.stringify([ME.machineId, harnessId])).digest('hex').slice(0, 24)

/** A daemon with one [engine] agent whose roster row names its chat, started with its Swarm role or ([attached]) as one its person
 *  attached, and the Swarm service started: what its host asked of the backend is recorded, and a post of the operations in
 *  `refuse` is turned away for good. */
async function begin(engine: 'claude' | 'codex', attached = false) {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME)
  // Signed in as its person: their own messages in its chat are theirs (`GET /api/auth/me`).
  relay.me = { id: FAKE_ACCOUNT, email: 'ken@example.test' }
  const d = await IsolatedDaemon.create({ submissionGate: true, env: {
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
    // The Swarm is on, whatever the run was started with (`HARNESS_SWARM=off npm run test:e2e`): a Swarm role is refused with it off.
    HARNESS_SWARM: '',
    // The Swarm's process is held still for a while in some of these, which the master must not read as a hang.
    HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '300000',
  } }); daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => {
    console.log(d.log().split('\n').slice(-120).join('\n'))
    // And what each engine wrote: the transcripts the daemon read.
    for (const root of [d.engineConfig.codexHome, join(d.root, 'claude')]) {
      let files: string[] = []
      try { files = (readdirSync(root, { recursive: true }) as string[]).filter(name => name.endsWith('.jsonl')) } catch { /* none */ }
      for (const name of files) console.log(`${name}\n${readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean).slice(-24).map(line => line.slice(0, 220)).join('\n')}`)
    }
  })
  const agents: Array<Record<string, any>> = []
  const posts: Array<Record<string, any>> = []
  /** What the host told the agent about the team (its skills notice), apart from the answers it posted. */
  const told: Array<Record<string, any>> = []
  const deliveries: Array<Record<string, any>> = []
  const refuse = new Set<string>()
  /** Every request the host made of the Swarm to build a delivery for the agent (its reads as the agent). */
  const reads: string[] = []
  relay.superTabs = overOldRoutes(async (method, raw, body) => {
    const url = new URL(raw, relay.httpUrl), path = url.pathname
    if (path === `/api/super-tabs/hosts/${ME.machineId}/pools` || path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: [] }
    // A server from before the Leads conversation was removed still names it in each row (backend read/hostRows.ts sends null now).
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: agents.map(agent => ({ tabId: TAB, agent, observers: [], leadsConversationId: 'leads' })) }
    if (path === `/api/super-tabs/${TAB}`) {
      if (url.searchParams.get('asAgentId')) reads.push(raw)
      return { data: { revision: 1, state: { id: TAB, agents, conversations: [] } } }
    }
    if (path.endsWith('/messages')) { reads.push(raw); return { data: { messages: [] } } }
    if (path === `/api/super-tabs/${TAB}/commands`) {
      const command = object(body.command)
      if (command.type !== 'message.send') throw new Error(`Unexpected command ${String(command.type)}`)
      if (String(body.operationId).startsWith('skill-')) { told.push(body); return { data: { result: {} } } }
      posts.push(body)
      if (refuse.has(body.operationId)) return { status: 403, error: { code: 'FORBIDDEN', message: 'Not allowed.' } }
      return { data: { result: {} } }
    }
    const delivery = /\/agents\/([^/]+)\/deliveries(?:\/([^/]+))?$/.exec(path)
    if (delivery) {
      const open = deliveries.filter(value => value.agentId === delivery[1])
      if (method === 'GET') return { data: delivery[2] ? open.find(value => value.id === delivery[2]) : open.filter(value => value.status !== 'delivered') }
      const value = open.find(item => item.id === delivery[2])
      if (!value) throw new Error('Unknown delivery')
      if (value.claimId && value.claimId !== body.claimId) throw new Error('Claim changed')
      if (body.type === 'claim') { value.claimId = body.claimId; return { data: { message: value.message } } }
      // The notice a delivery held 30 s posts (host.ts reportWithheld) is no acknowledgement.
      if (body.type === 'hold') return { data: {} }
      value.status = body.uncertain ? 'uncertain' : 'delivered'
      value.receipt = body.receipt
      return { data: {} }
    }
    throw new Error(`Unexpected request ${method} ${raw}`)
  })
  await d.start()
  const client = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(client)
  const cwd = join(d.projectsDir, 'project'); mkdirSync(cwd, { recursive: true })
  // As Desktop's + New agent starts it: with its Swarm role. An agent with none is one its person attached (Desktop's Attach):
  // the host tells it the team's basics once, in the chat its roster row names, and reads nothing to do so (#3642, #3654).
  const agent = await client.request('agent_create', { engine, cwd, bypassPermission: true, ...(attached ? {} : { swarmRole: 'dev' }) }, 90_000)
  expect(agent.error, JSON.stringify(agent)).toBeUndefined()
  const memberId = idFor(agent.agent.id)
  agents.push({ id: memberId, machineId: ME.machineId, harnessId: agent.agent.id, chatId: CHAT, displayName: 'Mia' })
  // The Swarm's service runs in a process of its own, started when the core is asked for it.
  expect(await client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  const prompts = () => { try { return readFileSync(join(d.root, 'submitted-prompts'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string) } catch { return [] } }
  // Its person: the account this machine is signed in to.
  const person = { kind: 'person', id: FAKE_ACCOUNT, name: 'Ken' }
  const ask = (id: string, text: string, fields: Record<string, unknown> = {}) => {
    const row = { id: `delivery-${id}`, agentId: memberId, conversationId: CHAT, status: 'queued', claimId: null,
      message: { id: `message-${id}`, conversationId: CHAT, author: person, text, ...fields } }
    deliveries.push(row)
    return row
  }
  /** The turns of the agent that have ended, live. */
  const ended = () => client.frames.filter(frame => frame.type === 'turn_ended' && frame.agentId === agent.agent.id && !frame.replay).length
  return { d, client, agent, memberId, posts, told, reads, refuse, prompts, ask, ended, person, deliveries }
}

it.each([['claude', false], ['codex', false], ['claude', true]] as const)('types %s what its person typed, and posts its answer into their chat once its turn ends (attached: %s)', async (engine, attached) => {
  const { d, client, agent, memberId, posts, told, reads, refuse, prompts, ask, person, deliveries } = await begin(engine, attached)
  const typed = 'Please say hello to the team, then wait.'
  const first = ask('one', typed)
  await until('the native input acknowledgement', () => first.status === 'delivered' || null, 60_000, 250)
  // Exactly what its person typed, once: no place line, no context lines, no header and no Answer line.
  expect(prompts()).toEqual([typed])
  await until('the host to post the answer into the chat', () => posts.length >= 1 || null, 60_000, 100)
  expect(posts).toEqual([{ operationId: 'reply-delivery-one', asAgentId: memberId,
    command: { type: 'message.send', conversationId: CHAT, text: `answer 1: ${typed}`, replyTo: null, answers: 'message-one', recipientIds: [] } }])
  // Its chat is named by its roster row, so nothing of the Swarm was read to type it, nor to tell it anything.
  expect(reads).toEqual([])
  if (attached) {
    // The one thing the host wrote besides its answers is the basics, only for the agent to read, in its own chat: never anything
    // to type what its person typed.
    await until('the basics told to the attached agent', () => told.length >= 1 || null, 60_000, 100)
    expect(told).toEqual([{ operationId: expect.stringMatching(/^skill-/), asAgentId: memberId, command: { type: 'message.send', conversationId: CHAT,
      replyTo: null, recipientIds: [memberId], text: SWARM_BASICS, agentOnly: true, notice: 'skills' } }])
  }

  // A second message is its own turn, answered under its own operation, in its own thread when it is in one.
  const second = ask('two', 'And once more, in the thread.', { thread: 'message-one', replyTo: 'message-one' })
  await until('the second answer', () => posts.length >= 2 || null, 60_000, 100)
  expect(prompts()).toEqual([typed, 'And once more, in the thread.'])
  expect(posts[1]).toEqual({ operationId: 'reply-delivery-two', asAgentId: memberId,
    command: { type: 'message.send', conversationId: CHAT, text: 'answer 2: And once more, in the thread.', replyTo: 'message-two', recipientIds: [] } })
  await until('the second native input acknowledgement', () => second.status === 'delivered' || null, 30_000, 100)

  // A turn its person typed in the terminal is not a reply to anything: nothing is posted for it, and the message after it is
  // answered as its own, so the next post is its.
  client.send('message', { agentId: agent.agent.id, content: 'typed in the terminal' })
  await until('the terminal turn to end', () => client.frames.filter(frame => frame.type === 'turn_ended' && frame.agentId === agent.agent.id && !frame.replay).length >= 3 || null, 60_000, 100)
  ask('three', 'One last thing.')
  await until('the third answer', () => posts.length >= 3 || null, 60_000, 100)
  expect(posts.map(post => post.operationId)).toEqual(['reply-delivery-one', 'reply-delivery-two', 'reply-delivery-three'])
  expect(posts[2]!.command).toMatchObject({ text: 'answer 4: One last thing.', answers: 'message-three' })

  // Two messages that queue behind a running turn are each their own turn, and their answers follow in the order they were sent.
  const busy = client.next(frame => frame.type === 'turn_started' && frame.agentId === agent.agent.id && !frame.replay)
  client.send('message', { agentId: agent.agent.id, content: '!slow 2000' })
  await busy
  ask('four', 'First of the queued.')
  ask('five', 'Second of the queued.')
  await until('both queued answers', () => posts.length >= 5 || null, 90_000, 100)
  expect(posts.slice(3).map(post => post.operationId)).toEqual(['reply-delivery-four', 'reply-delivery-five'])
  expect(posts.slice(3).map(post => post.command.text)).toEqual(['answer 6: First of the queued.', 'answer 7: Second of the queued.'])
  expect(posts.slice(3).map(post => post.command.answers)).toEqual(['message-four', 'message-five'])
  expect(posts).toHaveLength(5)

  // An answer the server turns away is not lost without a word: its person is told in the chat, once, by the agent's name.
  refuse.add('reply-delivery-six')
  ask('six', 'A last one, whose answer the server will not take.')
  await until('the line that tells its person', () => posts.length >= 7 || null, 90_000, 100)
  expect(posts.slice(5).map(post => post.operationId)).toEqual(['reply-delivery-six', 'dropped-reply-delivery-six'])
  expect(posts[6]).toEqual({ operationId: 'dropped-reply-delivery-six', asAgentId: memberId,
    command: { type: 'message.send', conversationId: CHAT, text: 'Mia\'s answer could not be posted.', replyTo: null, answers: 'message-six', recipientIds: [] } })
  expect(posts).toHaveLength(7)

  // Words of every script come back as they were typed; an answer that follows a tool call is the answer, not what was said before
  // it; and one longer than a message takes is cut with an ellipsis, never in the middle of an emoji.
  const next = Number(/^answer (\d+):/.exec(posts[5]!.command.text)![1]) + 1
  const words = 'Ship it 🚀 — naïve café 日本語 مرحبا é'
  ask('seven', words)
  await until('the answer in every script', () => posts.length >= 8 || null, 90_000, 100)
  expect(posts[7]!.command.text).toBe(`answer ${next}: ${words}`)
  ask('eight', '!tool echo hi')
  await until('the answer after a tool call', () => posts.length >= 9 || null, 90_000, 100)
  expect(posts[8]!.command.text).toBe(`answer ${next + 1}: !tool echo hi`)
  const prefix = `answer ${next + 2}: `
  const long = `${'a'.repeat(31_998 - prefix.length)}😀${'tail'.repeat(10)}`
  ask('nine', long)
  await until('the cut answer', () => posts.length >= 10 || null, 120_000, 100)
  // Ten quick turns by now: the short-turn guard holds the agent's automatic input, and never its person's own message.
  expect(d.log()).toMatch(/\[turn-guard\] loop/)
  expect(d.log()).not.toMatch(/withheld: team_waiting_control/)
  expect(posts[9]!.command.text).toBe(`${`${prefix}${long}`.slice(0, 31_998)}…`)
  expect(posts).toHaveLength(10)

  // A compaction in the middle of a turn is no new turn: it is answered once, as one.
  ask('ten', '!compactmid')
  await until('the answer of a turn that compacted', () => posts.length >= 11 || null, 90_000, 100)
  expect(posts[10]!.command.text).toBe(`answer ${next + 3}: !compactmid`)
  expect(posts).toHaveLength(11)
  // The basics are told once over the whole run, the host's passes between the eleven messages included; a Swarm agent is told none.
  expect(told).toHaveLength(attached ? 1 : 0)
  // And the journal keeps no words of anybody's.
  const journal = readFileSync(join(d.dataDir, 'super-tabs', `host-${ME.machineId}.json`), 'utf8')
  expect(journal).not.toContain(typed)
  expect(journal).not.toContain('In the thread')

  // A message queued in the room that server calls the Leads conversation is typed like any other, not withheld: this host
  // reads no Leads conversation of a row. On Claude Code alone: Codex's fake pane is too short for a message that is not in the
  // agent's chat, whose place line and Answer line hide its composer, and the host then holds its Enter (host.spec.ts covers it).
  if (engine === 'claude') {
    const oldRoom = { id: 'delivery-old-room', agentId: memberId, conversationId: 'leads', status: 'queued', claimId: null as string | null,
      message: { id: 'message-old-room', conversationId: 'leads', author: person, text: 'A line in the old Leads room.' } }
    deliveries.push(oldRoom)
    await until('the old room message to be typed and acknowledged', () => oldRoom.status === 'delivered' || null, 90_000, 100)
    expect(prompts().some(prompt => prompt.includes('A line in the old Leads room.'))).toBe(true)
  }
}, 300_000)

// The engine takes a second message into its queue while the first turn runs, and starts it the moment the first ends: its prompt and
// its answer are in the transcript before the Swarm's process, held here from before the first end until after the second, hears
// either. Each message is still answered by its own turn: the first is neither dropped nor answered with the second's words.
it.each(['claude', 'codex'] as const)('answers each of two messages from its own turn, %s, when the host hears neither end until both are over', async engine => {
  const { d, posts, prompts, ask, ended } = await begin(engine)
  const service = [...d.log().matchAll(/\[harnessd\] service superTabs started \(pid (\d+)\)/g)].at(-1)?.[1]
  expect(service, 'the Swarm service\'s process').toBeDefined()
  const before = ended()
  const slow = '!slow 15000', queued = 'And this, queued behind it.'
  const first = ask('one', slow)
  await until('the first typed', () => first.status === 'delivered' || null, 60_000, 100)
  ask('two', queued)
  await until('the second typed into the engine that is busy', () => prompts().includes(queued) || null, 60_000, 100)
  expect(ended(), 'the first turn is still running').toBe(before)
  // From here the host hears nothing: the first turn ends, the engine starts the second at once and answers it.
  process.kill(Number(service), 'SIGSTOP')
  try {
    await until('both turns to be over', () => ended() >= before + 2 || null, 60_000, 100)
  } finally { process.kill(Number(service), 'SIGCONT') }
  await until('both answers', () => posts.length >= 2 || null, 60_000, 100)
  expect(posts.map(post => post.operationId)).toEqual(['reply-delivery-one', 'reply-delivery-two'])
  expect(posts.map(post => post.command.text)).toEqual([`answer 1: ${slow}`, `answer 2: ${queued}`])
  expect(posts.map(post => post.command.answers)).toEqual(['message-one', 'message-two'])
  expect(posts).toHaveLength(2)
}, 300_000)

// The same, for two messages of the very same words: only the turn tells them apart, so each is answered by its own, and the
// second's answer is never the first's.
it.each(['claude', 'codex'] as const)('answers two messages of the same words each from its own turn, %s, when the host hears neither end until both are over', async engine => {
  const { d, posts, prompts, ask, ended } = await begin(engine)
  const service = [...d.log().matchAll(/\[harnessd\] service superTabs started \(pid (\d+)\)/g)].at(-1)?.[1]
  expect(service, 'the Swarm service\'s process').toBeDefined()
  const before = ended()
  const same = '!slow 12000'
  const first = ask('one', same)
  await until('the first typed', () => first.status === 'delivered' || null, 60_000, 100)
  ask('two', same)
  await until('the second typed into the engine that is busy', () => prompts().filter(prompt => prompt === same).length === 2 || null, 60_000, 100)
  expect(ended(), 'the first turn is still running').toBe(before)
  process.kill(Number(service), 'SIGSTOP')
  try {
    await until('both turns to be over', () => ended() >= before + 2 || null, 60_000, 100)
  } finally { process.kill(Number(service), 'SIGCONT') }
  await until('both answers', () => posts.length >= 2 || null, 60_000, 100)
  expect(posts.map(post => post.operationId)).toEqual(['reply-delivery-one', 'reply-delivery-two'])
  expect(posts.map(post => post.command.text)).toEqual([`answer 1: ${same}`, `answer 2: ${same}`])
  expect(posts.map(post => post.command.answers)).toEqual(['message-one', 'message-two'])
  expect(posts).toHaveLength(2)
}, 300_000)

// Codex says what it is about to do in messages of their own, its commentary, ahead of its answer; its transcript reader leaves them out
// of what a turn said, and so does the reply: the answer alone.
it('posts the answer of a Codex turn without what it said on the way', async () => {
  const { posts, ask } = await begin('codex')
  const said = '!commentary look at the build'
  ask('one', said)
  await until('the answer', () => posts.length >= 1 || null, 90_000, 100)
  expect(posts.map(post => post.command.text)).toEqual([`answer 1: ${said}`])
  expect(posts).toHaveLength(1)
}, 300_000)

// The core restarts in the middle of the turn: it picks the turn up at attach and never saw its first part, so what the turn answered is
// read from the transcript when it ends, and still posted.
it.each(['claude', 'codex'] as const)('answers the message of a turn the core was restarted in the middle of, %s, when that turn ends', async engine => {
  const { d, memberId, posts, ask } = await begin(engine)
  const slow = '!slow 30000'
  const first = ask('one', slow)
  await until('the first typed', () => first.status === 'delivered' || null, 60_000, 100)
  const cores = d.coresStarted()
  process.kill(d.corePid()!, 'SIGKILL')
  await until('the master to start another core', () => d.coresStarted() > cores || null, 60_000, 200)
  await until('the answer, posted when the turn ends', () => posts.length >= 1 || null, 150_000, 250)
  expect(posts).toEqual([{ operationId: 'reply-delivery-one', asAgentId: memberId,
    command: { type: 'message.send', conversationId: CHAT, text: `answer 1: ${slow}`, replyTo: null, answers: 'message-one', recipientIds: [] } }])
}, 300_000)

// A turn its person interrupts is not answered, and says so in the host's log; the same words sent again are answered under the new
// message, never under the stopped one, and the message after it as ever.
it.each(['claude', 'codex'] as const)('posts no reply for a turn its person interrupted, %s, and answers the same words sent again under the new message', async engine => {
  const { d, client, agent, memberId, posts, ask } = await begin(engine)
  const same = '!slow 20000'
  const first = ask('one', same)
  await until('the first typed', () => first.status === 'delivered' || null, 60_000, 100)
  // A cancel from the app ends no turn for the windows, which read the agent as idle; the host is told the turn was interrupted.
  const idle = client.next(frame => frame.type === 'agent_activity' && frame.agentId === agent.agent.id && frame.payload?.activity?.state === 'idle', 60_000, 'the agent to read as idle')
  client.send('cancel', { agentId: agent.agent.id })
  await idle
  // Until the engine itself has taken the interrupt: a message sent in the same breath can reach the pane before the key does.
  await until('the engine to take the interrupt', async () => (await d.capture(agent.agent.tmuxPane)).includes('(interrupted)') || null, 30_000, 100)
  await until('the host to say it posts nothing', () => d.log().includes(`No reply posted for delivery delivery-one of agent ${memberId}: its turn was interrupted.`) || null, 30_000, 100)
  expect(posts).toEqual([])
  ask('two', same)
  await until('the answer of the same words sent again', () => posts.length >= 1 || null, 90_000, 250)
  expect(posts).toEqual([{ operationId: 'reply-delivery-two', asAgentId: memberId,
    command: { type: 'message.send', conversationId: CHAT, text: `answer 2: ${same}`, replyTo: null, answers: 'message-two', recipientIds: [] } }])
  ask('three', 'After the interrupt.')
  await until('the next answer', () => posts.length >= 2 || null, 60_000, 100)
  expect(posts[1]).toMatchObject({ operationId: 'reply-delivery-three', command: { text: 'answer 3: After the interrupt.', answers: 'message-three' } })
  expect(posts).toHaveLength(2)
}, 300_000)
