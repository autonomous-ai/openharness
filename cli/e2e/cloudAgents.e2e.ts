/**
 * Cloud agents on the real daemon (docs/design/2026-10-11-cloud-agents.md), against a fake of Devin's v3 API
 * shaped as its documentation says, reached through a key-only connection and the Connections bridge exactly
 * as a person's Devin key would be. Never the real Devin.
 *
 * A window makes a Devin Cloud harness with New Harness's request (`agent_create`); the cloud experiment starts
 * only then; the harness is listed with no pane; Devin's question reaches the window as any agent's does, and
 * the answer goes to Devin; Devin's pull request reaches the frame; Stop archives the session; and the harness
 * is watched again after the daemon restarts.
 */
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as netServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { Store } from '../src/lib/connectors/store.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const freePort = (): Promise<number> => new Promise((resolve) => {
  const probe = netServer().listen(0, '127.0.0.1', () => {
    const port = (probe.address() as { port: number }).port
    probe.close(() => resolve(port))
  })
})

/** Devin's v3 sessions: one session, which asks which branch, then finishes with a pull request. */
class FakeDevin {
  server: Server | null = null
  base = ''
  auth: string[] = []
  seen: string[] = []
  created: Record<string, unknown>[] = []
  sent: string[] = []
  archived = 0
  status = 'running'
  /** Null when Devin sent no `status_detail`, so a later read can drop one that was there. */
  detail: string | null = 'working'
  /** A test's status stands: the scripted question and finish do not replace it. */
  hold = false
  private messages: Array<{ event_id: string; source: string; message: string; created_at: string }> = []
  private pulls: Array<{ pr_url: string; pr_state: string }> = []

  async start(): Promise<this> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
        this.auth.push(String(request.headers.authorization))
        this.seen.push(`${request.method} ${request.url}`)
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {}
        const url = new URL(request.url!, 'http://x')
        const reply = (json: unknown, status = 200) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json))
        const session = () => ({ session_id: 'devin-e2e', url: 'https://app.devin.ai/sessions/devin-e2e', status: this.status, status_detail: this.detail,
          pull_requests: this.pulls, tags: [], org_id: 'org-e2e', created_at: 't', updated_at: 't', acus_consumed: 0 })
        if (url.pathname === '/v3/self') return reply({ org_id: 'org-e2e', principal_type: 'service_user' })
        if (request.method === 'POST' && url.pathname === '/v3/organizations/org-e2e/sessions') { this.created.push(body); return reply(session()) }
        if (request.method === 'GET' && url.pathname === '/v3/organizations/org-e2e/sessions/devin-e2e') {
          // Its first look finds Devin asking. `running` so a session that started `new` can still be waiting.
          if (!this.hold && !this.messages.length) {
            this.status = 'running'
            this.detail = 'waiting_for_user'
            this.messages.push({ event_id: 'e1', source: 'devin', message: 'Which branch should I base it on?', created_at: '2026-10-11T10:01:00Z' })
          }
          return reply(session())
        }
        if (request.method === 'GET' && url.pathname.endsWith('/messages')) {
          const after = Number(url.searchParams.get('after') ?? 0)
          return reply({ items: this.messages.slice(after), end_cursor: String(this.messages.length), has_next_page: false })
        }
        if (request.method === 'POST' && url.pathname.endsWith('/messages')) {
          this.sent.push(String(body.message))
          if (!this.hold) {
            this.detail = 'finished'
            this.messages.push({ event_id: `e${this.messages.length + 1}`, source: 'devin', message: 'Opened #42. Tests pass.', created_at: '2026-10-11T10:03:00Z' })
            this.pulls = [{ pr_url: 'https://github.com/acme/api/pull/42', pr_state: 'open' }]
          }
          return reply({})
        }
        if (request.method === 'POST' && url.pathname.endsWith('/archive')) { this.archived += 1; this.status = 'suspended'; this.detail = 'user_request'; return reply(session()) }
        return reply({ detail: 'not found' }, 404)
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server!.address() as { port: number }).port}`
    return this
  }

  close(): Promise<void> {
    return new Promise((resolve) => { if (!this.server) return resolve(); this.server.closeAllConnections(); this.server.close(() => resolve()) })
  }
}

const cloudStarts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service cloud started/g)].length

describe('cloud agents on the real daemon', () => {
  let daemon: IsolatedDaemon | undefined
  let devin: FakeDevin | undefined
  afterEach(async () => {
    await daemon?.close(); daemon = undefined
    await devin?.close(); devin = undefined
  })

  it('a Devin Cloud harness: made, listed with no pane, asked, answered, finished with its pull request, stopped, and watched again after a restart', async () => {
    const fake = devin = await new FakeDevin().start()
    const port = await freePort()
    const d = daemon = await IsolatedDaemon.create({ env: {
      HARNESS_CONNECTIONS_PORT: String(port), HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      // Devin here is the fake: the key is found by where it points, as the person's would be at api.devin.ai.
      HARNESS_CLOUD_ENDPOINTS: JSON.stringify({ 'devin-cloud': devin.base }),
    } })
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}\n---- devin saw\n${fake.seen.join('\n')}`) })
    // The person's Devin key, as `harness connections add-key Devin <url>` saves it: for Harness, never for an agent.
    const vault = new Store(join(d.root, 'home', '.harness', 'connections'))
    mkdirSync(vault.root, { recursive: true, mode: 0o700 })
    vault.save('devin', { access_token: 'cog_e2e', token_type: 'Bearer', source: 'custom', label: 'Devin', transport: 'none', api_entry: { origin: devin.base } })
    await d.start()
    const client = await LocalClient.connect(d)
    fake.status = 'new'
    fake.detail = null

    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    expect(cloudStarts(d), 'an experiment no one asked for').toBe(0)

    // The question can come within seconds of the harness being made: listened for from before.
    const asked = client.next((frame: Frame) => frame.type === 'commander_question', 60_000, 'Devin\'s question')
    const created = await client.request<{ agent?: Record<string, any>; error?: string; detail?: string }>('agent_create', {
      engine: 'devin-cloud', prompt: 'fix the flaky login test', repositoryUrl: 'https://github.com/acme/api', acuLimit: 2,
    }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = created.agent!
    expect(agent).toMatchObject({ engine: 'devin-cloud', location: 'cloud', tmuxPane: null, terminal: { available: false }, project: { remote: 'https://github.com/acme/api' } })
    expect(agent.cloud).toMatchObject({ state: 'starting', providerStatus: { status: 'new', detail: null } })
    expect(cloudStarts(d)).toBe(1)
    expect(devin.created).toEqual([{ prompt: 'fix the flaky login test', repos: ['acme/api'], max_acu_limit: 2, title: 'fix the flaky login test' }])
    // The key went to Devin and nowhere else: the daemon's log never has it.
    expect(new Set(devin.auth)).toEqual(new Set(['Bearer cog_e2e']))
    expect(d.log()).not.toContain('cog_e2e')

    const question = await asked
    expect(question).toMatchObject({ agentId: agent.id, payload: { questions: [{ q: 'Which branch should I base it on?', canText: true }] } })
    const listed = (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {})).agents.find((row) => row.id === agent.id)
    expect(listed).toMatchObject({ location: 'cloud', cloud: { place: "Devin's cloud", state: 'needs_input', providerStatus: { status: 'running', detail: 'waiting_for_user' } } })

    const finished = client.next((frame: Frame) => frame.type === 'agent_synced' && frame.payload?.agent?.id === agent.id && frame.payload.agent.cloud?.state === 'idle', 60_000, 'the harness to finish')
    // Answered as the dial and the windows answer any agent's question: under the question's own id.
    const answered = client.next((frame: Frame) => frame.type === 'question_response_result' && frame.payload?.requestId === question.payload.requestId, 30_000, 'the answer\'s result')
    client.send('question_response', { requestId: question.payload.requestId, agentId: agent.id, answers: { answer: 'main' } })
    expect((await answered).payload).toMatchObject({ ok: true })
    expect(devin.sent).toEqual(['main'])
    const done = (await finished).payload.agent
    expect(done.cloud.links).toContainEqual({ label: 'Pull request #42', url: 'https://github.com/acme/api/pull/42' })
    expect(done.cloud).toMatchObject({ state: 'idle', providerStatus: { status: 'running', detail: 'finished' } })

    const transcript = await client.request<{ messages: Array<{ from: string; text: string }> }>('cloud_transcript', { agentId: agent.id })
    expect(transcript.messages.map((message) => [message.from, message.text])).toEqual([
      ['person', 'fix the flaky login test'], ['agent', 'Which branch should I base it on?'], ['person', 'main'], ['agent', 'Opened #42. Tests pass.'],
    ])
    // Asleep, and a stop by request, stay stopped. A message in the transcript does not make either one finished.
    fake.hold = true
    fake.status = 'suspended'
    fake.detail = 'inactivity'
    fake.messages.push({ event_id: 'e-sleep', source: 'devin', message: 'Still working through the tests.', created_at: '2026-10-11T10:04:00Z' })
    const slept = client.next((frame: Frame) => frame.type === 'agent_synced' && frame.payload?.agent?.id === agent.id && frame.payload.agent.cloud?.providerStatus?.detail === 'inactivity', 60_000, 'asleep after inactivity')
    expect(await client.request('cloud_send', { agentId: agent.id, text: 'are you still there?' })).toMatchObject({ ok: true })
    expect((await slept).payload.agent.cloud).toMatchObject({ state: 'stopped', activity: 'Devin went to sleep after inactivity.', providerStatus: { status: 'suspended', detail: 'inactivity' } })
    fake.detail = 'user_request'
    const halted = client.next((frame: Frame) => frame.type === 'agent_synced' && frame.payload?.agent?.id === agent.id && frame.payload.agent.cloud?.providerStatus?.detail === 'user_request', 60_000, 'stopped by request')
    expect(await client.request('cloud_send', { agentId: agent.id, text: 'stop there' })).toMatchObject({ ok: true })
    expect((await halted).payload.agent.cloud).toMatchObject({ state: 'stopped', activity: 'The session was stopped by request.', providerStatus: { status: 'suspended', detail: 'user_request' } })

    expect(await client.request('agent_delete', { agentId: agent.id })).toMatchObject({ deleted: true })
    expect(devin.archived).toBe(1)

    // A restart: the saved harness wakes the experiment, and the window lists it again (stopped).
    client.close()
    await d.restart()
    const again = await LocalClient.connect(d)
    const back = await until('the harness to be listed again', async () =>
      (await again.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents.find((row) => row.id === agent.id) ?? null, 60_000, 500)
    expect(back).toMatchObject({ status: 'stopped', location: 'cloud' })
    // A local stop is not Devin's last report: the saved harness does not keep the status from before it.
    expect(back.cloud).not.toHaveProperty('providerStatus')
    again.close()
  }, 240_000)

  it('a Fo harness: through the bridge\'s MCP address, its reply waited for, its choices asked, and Stop said as Fo has none', async () => {
    // Fo's MCP server's Fo profile: replies as an event stream, sessions by header, the reply waited for.
    const calls: Array<{ tool: string; args: Record<string, unknown>; key: string }> = []
    let replies = 0
    const fo = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
        const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } }
        const send = (result: unknown, headers: Record<string, string> = {}) => response.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
          .end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
        if (message.method === 'initialize') return send({}, { 'mcp-session-id': 'fo-session' })
        if (!message.id) return response.writeHead(202).end()
        if (message.method === 'tools/list') return send({ tools: [
          { name: 'ask_fo', inputSchema: { properties: { message: { type: 'string' }, conversation_id: { type: 'string' } }, required: ['message'] } },
          { name: 'get_fo_reply', inputSchema: { properties: { conversation_id: { type: 'string' } } } },
        ] })
        calls.push({ tool: message.params!.name, args: message.params!.arguments, key: String(request.headers['x-api-key']) })
        const text = message.params!.name === 'ask_fo'
          ? (calls.length === 1 ? { status: 'working', conversation_id: 'c1', message: 'Looking for a barber' } : { status: 'done', reply: 'Booked for 9:30.', conversation_id: 'c1' })
          : (++replies === 1 ? { status: 'working', message: 'Calling Hair Lab' } : { status: 'done', reply: 'They have two times.\n1) 9:30\n2) 11:00\nWhich one?' })
        send({ content: [{ type: 'text', text: JSON.stringify(text) }] })
      })
    })
    await new Promise<void>((resolve) => fo.listen(0, '127.0.0.1', resolve))
    const foBase = `http://127.0.0.1:${(fo.address() as { port: number }).port}`
    try {
      const port = await freePort()
      const d = daemon = await IsolatedDaemon.create({ env: { HARNESS_CONNECTIONS_PORT: String(port), HARNESS_CLOUD_ENDPOINTS: JSON.stringify({ fo: `${foBase}/fo` }) } })
      onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}\n---- fo saw\n${JSON.stringify(calls)}`) })
      const vault = new Store(join(d.root, 'home', '.harness', 'connections'))
      mkdirSync(vault.root, { recursive: true, mode: 0o700 })
      // As Add custom saves Fo with its key as a header.
      vault.save('fo', { source: 'custom', label: 'Fo', mcp_entry: { url: `${foBase}/fo`, headers: { 'X-API-Key': 'wak_e2e' } } })
      await d.start()
      const client = await LocalClient.connect(d)
      const asked = client.next((frame: Frame) => frame.type === 'commander_question', 90_000, 'Fo\'s question')
      const created = await client.request<{ agent?: Record<string, any>; error?: string }>('agent_create', { engine: 'fo', prompt: 'book a haircut saturday morning near me' }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      const agent = created.agent!
      expect(agent).toMatchObject({ engine: 'fo', location: 'cloud', project: null, cloud: { place: "Fo's cloud" } })
      const question = await asked
      expect(question).toMatchObject({ agentId: agent.id, payload: { questions: [{ q: 'They have two times.\n1) 9:30\n2) 11:00\nWhich one?', options: ['9:30', '11:00'] }] } })
      expect(calls.map((call) => call.tool)).toEqual(['ask_fo', 'get_fo_reply', 'get_fo_reply'])
      expect(new Set(calls.map((call) => call.key))).toEqual(new Set(['wak_e2e']))
      const answered = client.next((frame: Frame) => frame.type === 'question_response_result' && frame.payload?.requestId === question.payload.requestId, 30_000, 'the answer\'s result')
      client.send('question_response', { requestId: question.payload.requestId, agentId: agent.id, answers: { answer: '9:30' } })
      expect((await answered).payload).toMatchObject({ ok: true })
      expect(calls.at(-1)).toMatchObject({ tool: 'ask_fo', args: { message: '9:30', conversation_id: 'c1' } })
      const booked = await until('Fo\'s booking', async () => {
        const transcript = await client.request<{ messages: Array<{ from: string; text: string }> }>('cloud_transcript', { agentId: agent.id })
        return transcript.messages.some((message) => message.text === 'Booked for 9:30.') ? transcript : null
      }, 30_000, 500)
      expect(booked.messages.map((message) => message.from)).toEqual(['person', 'agent', 'person', 'agent'])
      expect(await client.request('agent_delete', { agentId: agent.id })).toEqual(expect.objectContaining({ deleted: true, detail: 'Fo keeps working on its own.' }))
      expect(d.log()).not.toContain('wak_e2e')
      client.close()
    } finally {
      fo.closeAllConnections()
      fo.close()
    }
  }, 240_000)

  it('refuses a cloud agent that is not connected, in words a person reads', async () => {
    const port = await freePort()
    const d = daemon = await IsolatedDaemon.create({ env: { HARNESS_CONNECTIONS_PORT: String(port) } })
    await d.start()
    const client = await LocalClient.connect(d)
    const refused = await client.request('agent_create', { engine: 'cursor-cloud', prompt: 'x', repositoryUrl: 'https://github.com/acme/api' }, 90_000)
    expect(refused).toMatchObject({ error: 'NOT_CONNECTED', detail: expect.stringContaining('harness connections add-key Cursor') })
    const agents = await client.request<{ agents: Array<{ id: string; name: string; connected: boolean }> }>('cloud_agents', {})
    expect(agents.agents.map((row) => [row.id, row.connected])).toEqual([['fo', false], ['devin-cloud', false], ['cursor-cloud', false]])
    client.close()
  }, 180_000)
})
