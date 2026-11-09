/** A person's message in their agent's own 1:1 chat, on the real native protocol: the real master, core and Swarm service in their
 * own process, a private tmux and fake engines, and a loopback server in place of the backend. The agent is typed exactly what
 * its person typed, and when its turn ends the host posts the answer as the agent, once, or one line saying it could not (anh
 * Dee, 2026-11-09: "it's a 1:1 conversation, why can't it be just the exact prompt?"). */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { object } from '../src/superTabs/wire.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
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

it.each(['claude', 'codex'] as const)('types %s what its person typed, and posts its answer into their chat once its turn ends', async engine => {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME)
  const d = await IsolatedDaemon.create({ submissionGate: true, env: {
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
  } }); daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-120).join('\n')))
  const agents: Array<Record<string, any>> = []
  const posts: Array<Record<string, any>> = []
  const deliveries: Array<Record<string, any>> = []
  /** Every request the host made of the Swarm to build a delivery for the agent (its reads as the agent). */
  const reads: string[] = []
  relay.superTabs = overOldRoutes(async (method, raw, body) => {
    const url = new URL(raw, relay.httpUrl), path = url.pathname
    if (path === `/api/super-tabs/hosts/${ME.machineId}/pools` || path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: [] }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: agents.map(agent => ({ tabId: TAB, agent, observers: [] })) }
    if (path === `/api/super-tabs/${TAB}`) {
      if (url.searchParams.get('asAgentId')) reads.push(raw)
      return { data: { revision: 1, state: { id: TAB, agents, conversations: [] } } }
    }
    if (path.endsWith('/messages')) { reads.push(raw); return { data: { messages: [] } } }
    if (path === `/api/super-tabs/${TAB}/commands`) {
      const command = object(body.command)
      if (command.type !== 'message.send') throw new Error(`Unexpected command ${String(command.type)}`)
      posts.push(body)
      // The server turns the answer to the sixth message away for good.
      if (body.operationId === 'reply-delivery-six') return { status: 403, error: { code: 'FORBIDDEN', message: 'Not allowed.' } }
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
      value.status = body.uncertain ? 'uncertain' : 'delivered'
      value.receipt = body.receipt
      return { data: {} }
    }
    throw new Error(`Unexpected request ${method} ${raw}`)
  })
  await d.start()
  const client = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(client)
  const cwd = join(d.projectsDir, 'project'); mkdirSync(cwd, { recursive: true })
  // As Desktop's + New agent starts it: with its Swarm role. An agent with none is one its person attached, which the host
  // tells the team's basics once, and reads its Swarm to do so (#3642): that is not what this test is about.
  const agent = await client.request('agent_create', { engine, cwd, bypassPermission: true, swarmRole: 'dev' }, 90_000)
  expect(agent.error, JSON.stringify(agent)).toBeUndefined()
  const memberId = idFor(agent.agent.id)
  agents.push({ id: memberId, machineId: ME.machineId, harnessId: agent.agent.id, chatId: CHAT, displayName: 'Mia' })
  // The Swarm's service runs in a process of its own, started when the core is asked for it.
  expect(await client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  const prompts = () => { try { return readFileSync(join(d.root, 'submitted-prompts'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string) } catch { return [] } }

  const typed = 'Please say hello to the team, then wait.'
  const person = { kind: 'person', id: 'ken', name: 'Ken' }
  const ask = (id: string, text: string, fields: Record<string, unknown> = {}) => {
    const row = { id: `delivery-${id}`, agentId: memberId, conversationId: CHAT, status: 'queued', claimId: null,
      message: { id: `message-${id}`, conversationId: CHAT, author: person, text, ...fields } }
    deliveries.push(row)
    return row
  }
  const first = ask('one', typed)
  await until('the native input acknowledgement', () => first.status === 'delivered' || null, 60_000, 250)
  // Exactly what its person typed, once: no place line, no context lines, no header and no Answer line.
  expect(prompts()).toEqual([typed])
  await until('the host to post the answer into the chat', () => posts.length >= 1 || null, 60_000, 100)
  expect(posts).toEqual([{ operationId: 'reply-delivery-one', asAgentId: memberId,
    command: { type: 'message.send', conversationId: CHAT, text: `answer 1: ${typed}`, replyTo: null, answers: 'message-one', recipientIds: [] } }])
  // Its chat is named by its roster row, so nothing of the Swarm was read to type it.
  expect(reads).toEqual([])

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
  ask('six', 'A last one, whose answer the server will not take.')
  await until('the line that tells its person', () => posts.length >= 7 || null, 90_000, 100)
  expect(posts.slice(5).map(post => post.operationId)).toEqual(['reply-delivery-six', 'dropped-reply-delivery-six'])
  expect(posts[6]).toEqual({ operationId: 'dropped-reply-delivery-six', asAgentId: memberId,
    command: { type: 'message.send', conversationId: CHAT, text: 'Mia\'s answer could not be posted.', replyTo: null, answers: 'message-six', recipientIds: [] } })
  expect(posts).toHaveLength(7)
  // And the journal keeps no words of anybody's.
  const journal = readFileSync(join(d.dataDir, 'super-tabs', `host-${ME.machineId}.json`), 'utf8')
  expect(journal).not.toContain(typed)
  expect(journal).not.toContain('In the thread')
}, 300_000)
