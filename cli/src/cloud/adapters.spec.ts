/**
 * Each maker's adapter against a fake of its API, shaped as its documentation says: Devin's v3 sessions,
 * Cursor's v1 agents and runs, and Fo's MCP tools over streamable HTTP. Never a real maker.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionFor, connectionsBridge, endpointFor, refusal, type Bridge } from './bridge.js'
import { cursorAdapter, cursorLinks, cursorState, runResult } from './cursor.js'
import { DEFAULT_ACU_LIMIT, devinAdapter, devinLinks, devinState } from './devin.js'
import { foAdapter, questionIn, readReply, wordsParam } from './fo.js'
import { McpClient, replyTo } from './mcp.js'
import { CloudError } from './types.js'

const servers: Server[] = []
afterEach(() => { for (const server of servers.splice(0)) { server.close(); server.closeAllConnections() } })

type Answer = { status?: number; headers?: Record<string, string>; body: string }
async function serve(handler: (request: IncomingMessage, body: string) => Answer): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(chunk)).on('end', () => {
      const answer = handler(request, Buffer.concat(chunks).toString())
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers }).end(answer.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

/** A bridge whose API calls the test answers, in order, recording each. */
function apiBridge(answers: Array<{ status?: number; json: Record<string, unknown> }>) {
  const calls: Array<[string, string, unknown]> = []
  const bridge: Bridge = {
    connections: async () => [],
    mcpUrl: () => '',
    api: vi.fn(async (_code, method, path, body) => {
      calls.push([method, path, body])
      const next = answers.shift() ?? { json: {} }
      return { status: next.status ?? 200, json: next.json }
    }),
  }
  return { bridge, calls }
}

describe('the bridge', () => {
  it('lists connections and calls an API with nothing of its own to sign', async () => {
    const seen: string[] = []
    const base = await serve((request, body) => {
      seen.push(`${request.method} ${request.url} ${body}`)
      if (request.url === '/k/connections') return { body: JSON.stringify({ connections: [{ code: 'devin', api: 'https://api.devin.ai', state: 'connected' }] }) }
      if (request.url === '/k/devin/api/v3/self') return { body: '{"org_id":"org-1"}' }
      return { status: 500, body: 'not json' }
    })
    const bridge = connectionsBridge(() => `${base}/k`)
    expect(await bridge.connections()).toEqual([{ code: 'devin', api: 'https://api.devin.ai', state: 'connected' }])
    expect(await bridge.api('devin', 'GET', '/v3/self')).toEqual({ status: 200, json: { org_id: 'org-1' } })
    expect(await bridge.api('devin', 'POST', '/v3/other', { a: 1 })).toEqual({ status: 500, json: { raw: 'not json' } })
    expect(seen.at(-1)).toBe('POST /k/devin/api/v3/other {"a":1}')
    expect(bridge.mcpUrl('fo')).toBe(`${base}/k/fo/mcp`)
    const down = connectionsBridge(() => `${base}/missing`)
    await expect(down.connections()).rejects.toThrow('Connections is not running here.')
  })

  it('finds the connection that signs in each cloud agent by where it points', async () => {
    const connections = [
      { code: 'my-fo', name: 'Fo', mcp: 'https://mcp.api.wajo.ai/fo', api: null, state: 'connected' },
      { code: 'devin', name: 'Devin', mcp: null, api: 'https://api.devin.ai', state: 'reconnect' },
    ]
    const bridge = { connections: async () => connections } as unknown as Bridge
    expect((await connectionFor(bridge, 'fo')).code).toBe('my-fo')
    await expect(connectionFor(bridge, 'devin-cloud')).rejects.toThrow('needs to be connected again')
    await expect(connectionFor(bridge, 'cursor-cloud')).rejects.toThrow('add-key Cursor')
    await expect(connectionFor({ connections: async () => { throw new Error('down') } } as unknown as Bridge, 'fo')).rejects.toThrow('Connections is not running here')
  })

  it('finds a maker at another address when one is named for it', async () => {
    const env = { HARNESS_CLOUD_ENDPOINTS: JSON.stringify({ 'devin-cloud': 'http://127.0.0.1:9/x', fo: 'https://fo.example/fo', 'cursor-cloud': 'not a url' }) }
    expect(endpointFor('devin-cloud', env)).toEqual({ api: 'http://127.0.0.1:9' })
    expect(endpointFor('fo', env)).toEqual({ mcp: 'fo.example' })
    expect(endpointFor('cursor-cloud', env)).toEqual({ api: 'https://api.cursor.com' })
    expect(endpointFor('devin-cloud', { HARNESS_CLOUD_ENDPOINTS: '{' })).toEqual({ api: 'https://api.devin.ai' })
    expect(endpointFor('devin-cloud', {})).toEqual({ api: 'https://api.devin.ai' })
    const bridge = { connections: async () => [{ code: 'fake', name: 'Devin', mcp: null, api: 'http://127.0.0.1:9', state: 'connected' }] } as unknown as Bridge
    expect((await connectionFor(bridge, 'devin-cloud', env)).code).toBe('fake')
  })

  it('says a maker\'s refusal as a person reads it', () => {
    expect(refusal('Devin Cloud', 401, {}).code).toBe('NOT_CONNECTED')
    expect(refusal('Devin Cloud', 409, {}).message).toContain('still working')
    expect(refusal('Devin Cloud', 429, {}).code).toBe('RATE_LIMITED')
    expect(refusal('Devin Cloud', 400, { detail: 'bad repo' }).message).toBe('Devin Cloud answered 400: bad repo')
    expect(refusal('Devin Cloud', 500, { error: { message: 'boom' } }).message).toBe('Devin Cloud answered 500: boom')
    expect(refusal('Devin Cloud', 500, {}).message).toBe('Devin Cloud answered 500.')
  })
})

describe('Devin Cloud', () => {
  it('reads where a session is as Harness says it', () => {
    expect(['new', 'claimed', 'resuming'].map((status) => devinState(status, null))).toEqual(['starting', 'starting', 'starting'])
    expect(devinState('running', 'working')).toBe('working')
    expect(devinState('running', null)).toBe('working')
    expect(devinState('running', 'waiting_for_user')).toBe('needs_input')
    expect(devinState('running', 'waiting_for_approval')).toBe('needs_input')
    expect(devinState('running', 'finished')).toBe('idle')
    expect(devinState('exit', null)).toBe('idle')
    expect(devinState('error', null)).toBe('failed')
    expect(devinState('suspended', 'user_request')).toBe('stopped')
    expect(devinState('suspended', 'out_of_credits')).toBe('failed')
    expect(devinLinks({ url: 'https://app.devin.ai/s/1', pull_requests: [{ pr_url: 'https://github.com/a/b/pull/42' }, { pr_url: 'https://x/y' }, {}] }))
      .toEqual([{ label: 'Session', url: 'https://app.devin.ai/s/1' }, { label: 'Pull request #42', url: 'https://github.com/a/b/pull/42' }, { label: 'Pull request', url: 'https://x/y' }])
  })

  it('starts a session in the key\'s organization with a limit, and reads it a page at a time', async () => {
    const { bridge, calls } = apiBridge([
      { json: { org_id: 'org-1' } },
      { json: { session_id: 'devin-9', url: 'https://app.devin.ai/s/9', status: 'new' } },
      { json: { status: 'running', status_detail: 'waiting_for_user', url: 'https://app.devin.ai/s/9', pull_requests: [] } },
      { json: { items: [{ event_id: 'e1', source: 'user', message: 'fix it', created_at: 't0' }, { event_id: 'e2', source: 'devin', message: 'Which branch?', created_at: 't1' }], end_cursor: 'c1', has_next_page: true } },
      { json: { items: [], end_cursor: null, has_next_page: false } },
    ])
    const devin = devinAdapter(bridge, async () => 'devin')
    const started = await devin.start({ task: 'fix it', repository: 'acme/api', options: {} })
    expect(started).toEqual({ remote: { id: 'devin-9' }, links: [{ label: 'Session', url: 'https://app.devin.ai/s/9' }], update: { messages: [], state: 'starting', providerStatus: { status: 'new', detail: null } } })
    expect(calls[1]).toEqual(['POST', '/v3/organizations/org-1/sessions', { prompt: 'fix it', repos: ['acme/api'], max_acu_limit: DEFAULT_ACU_LIMIT, title: 'fix it' }])
    const update = await devin.poll({ id: 'devin-9' })
    expect(update).toMatchObject({ messages: [{ id: 'e2', text: 'Which branch?', at: 't1' }], state: 'needs_input', question: { text: 'Which branch?', choices: [] }, remote: { cursor: 'c1' }, providerStatus: { status: 'running', detail: 'waiting_for_user' } })
    expect(calls.slice(2).map(([method, path]) => `${method} ${path}`)).toEqual([
      'GET /v3/organizations/org-1/sessions/devin-9',
      'GET /v3/organizations/org-1/sessions/devin-9/messages?first=100',
      'GET /v3/organizations/org-1/sessions/devin-9/messages?first=100&after=c1',
    ])
  })

  it('says why a session went to sleep, takes words, archives on Stop, and refuses what Devin refuses', async () => {
    const { bridge, calls } = apiBridge([
      { json: { org_id: 'org-1' } },
      { json: { status: 'suspended', status_detail: 'usage_limit_exceeded' } },
      { json: { items: [] } },
      { json: {} },
      { json: {} },
      { status: 401, json: {} },
    ])
    const devin = devinAdapter(bridge, async () => 'devin')
    expect(await devin.poll({ id: 'd', cursor: 'c0' })).toMatchObject({ state: 'failed', activity: 'It reached its ACU limit.', question: null, remote: { cursor: 'c0' }, providerStatus: { status: 'suspended', detail: 'usage_limit_exceeded' } })
    await devin.send({ id: 'd' }, 'go on')
    await devin.stop!({ id: 'd' })
    expect(calls.slice(3)).toEqual([['POST', '/v3/organizations/org-1/sessions/d/messages', { message: 'go on' }], ['POST', '/v3/organizations/org-1/sessions/d/archive', undefined]])
    await expect(devin.poll({ id: 'd' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
  })

  it('refuses a key with no organization, and a session it was not given', async () => {
    await expect(devinAdapter(apiBridge([{ json: {} }]).bridge, async () => 'd').start({ task: 't', repository: null, options: { acuLimit: 2 } })).rejects.toThrow('refused the key')
    const { bridge, calls } = apiBridge([{ json: { org_id: 'o' } }, { json: {} }])
    await expect(devinAdapter(bridge, async () => 'd').start({ task: 't', repository: null, options: { acuLimit: 2 } })).rejects.toThrow('No session was made')
    expect(calls[1][2]).toEqual({ prompt: 't', max_acu_limit: 2, title: 't' })
    const waiting = apiBridge([{ json: { org_id: 'o' } }, { json: { status: 'running', status_detail: 'waiting_for_approval' } }, { json: { items: [] } }])
    // Waiting with nothing new said: the question already asked stands (the service asks one if none was).
    const polled = await devinAdapter(waiting.bridge, async () => 'd').poll({ id: 'x' })
    expect(polled.question).toBeUndefined()
    expect(polled).toMatchObject({ state: 'needs_input', providerStatus: { status: 'running', detail: 'waiting_for_approval' } })
  })

  it('keeps Devin\'s own status beside Harness\'s, and a stop is not a finished task', async () => {
    const steps: Array<{ status: string; detail?: string; state: string; activity: string | null }> = [
      { status: 'running', detail: 'working', state: 'working', activity: null },
      { status: 'running', detail: 'finished', state: 'idle', activity: null },
      { status: 'running', detail: 'waiting_for_user', state: 'needs_input', activity: null },
      { status: 'running', detail: 'waiting_for_approval', state: 'needs_input', activity: null },
      { status: 'suspended', detail: 'inactivity', state: 'stopped', activity: 'Devin went to sleep after inactivity.' },
      { status: 'suspended', detail: 'user_request', state: 'stopped', activity: 'The session was stopped by request.' },
      { status: 'suspended', detail: 'usage_limit_exceeded', state: 'failed', activity: 'It reached its ACU limit.' },
      { status: 'suspended', detail: 'out_of_quota', state: 'failed', activity: 'The Devin account is out of quota.' },
      { status: 'suspended', detail: 'payment_declined', state: 'failed', activity: 'Devin declined the payment.' },
      { status: 'error', state: 'failed', activity: null },
      { status: 'exit', state: 'idle', activity: null },
      { status: 'paused', detail: 'not_a_known_detail', state: 'working', activity: null },
    ]
    const answers: Array<{ json: Record<string, unknown> }> = [{ json: { org_id: 'org-1' } }]
    for (const step of steps) {
      answers.push({ json: { status: step.status, ...(step.detail ? { status_detail: step.detail } : {}) } })
      answers.push({ json: { items: [] } })
    }
    // A progress message on a stop, then an empty page: neither one is a finished task.
    answers.push({ json: { status: 'suspended', status_detail: 'user_request' } }, { json: { items: [{ event_id: 'e9', source: 'devin', message: 'I drafted a plan.', created_at: 't9' }] } })
    answers.push({ json: { status: 'suspended', status_detail: 'inactivity' } }, { json: { items: [] } })
    const devin = devinAdapter(apiBridge(answers).bridge, async () => 'devin')
    for (const step of steps) {
      expect(await devin.poll({ id: 'd' })).toMatchObject({
        state: step.state, activity: step.activity, providerStatus: { status: step.status, detail: step.detail ?? null },
      })
    }
    const said = await devin.poll({ id: 'd' })
    expect(said).toMatchObject({ state: 'stopped', activity: 'The session was stopped by request.', messages: [{ text: 'I drafted a plan.' }], providerStatus: { status: 'suspended', detail: 'user_request' } })
    expect(said.state).not.toBe('idle')
    expect(await devin.poll({ id: 'd' })).toMatchObject({ state: 'stopped', messages: [], activity: 'Devin went to sleep after inactivity.', providerStatus: { status: 'suspended', detail: 'inactivity' } })
  })
})

describe('Cursor Cloud', () => {
  it('reads a run as Harness says it', () => {
    expect(['CREATING', 'RUNNING', 'FINISHED', 'CANCELLED', 'ERROR', 'EXPIRED', 'OTHER'].map(cursorState)).toEqual(['starting', 'working', 'idle', 'stopped', 'failed', 'failed', 'working'])
    expect(runResult({ result: 'done' })).toBe('done')
    expect(runResult({ result: { summary: 'did it' } })).toBe('did it')
    expect(runResult({})).toBeNull()
    expect(cursorLinks({ url: 'https://cursor.com/agents/1' }, { git: { prUrl: 'https://github.com/a/b/pull/7' } }))
      .toEqual([{ label: 'Agent', url: 'https://cursor.com/agents/1' }, { label: 'Pull request #7', url: 'https://github.com/a/b/pull/7' }])
    expect(cursorLinks({ repos: [{ prUrl: 'https://x/pr' }] }, {})).toEqual([{ label: 'Pull request', url: 'https://x/pr' }])
  })

  it('starts an agent on a repository, tells a finished run once, and makes a run per follow-up', async () => {
    const { bridge, calls } = apiBridge([
      { json: { agent: { id: 'bc-1', url: 'https://cursor.com/agents/bc-1' }, run: { id: 'run-1', status: 'CREATING' } } },
      { json: { id: 'run-1', status: 'RUNNING' } },
      { json: { id: 'run-1', status: 'FINISHED', result: 'Fixed it.', git: { branch: 'cursor/fix', prUrl: 'https://github.com/acme/api/pull/3' }, updatedAt: 't2' } },
      { json: { id: 'bc-1', url: 'https://cursor.com/agents/bc-1' } },
      { json: { id: 'run-1', status: 'FINISHED', result: 'Fixed it.' } },
      { json: { id: 'bc-1' } },
      { json: { run: { id: 'run-2' } } },
      { json: {} },
    ])
    const cursor = cursorAdapter(bridge, async () => 'cursor')
    const started = await cursor.start({ task: 'fix it', repository: 'acme/api', options: { model: 'composer-2' } })
    expect(started.remote).toEqual({ id: 'bc-1', run: 'run-1' })
    expect(calls[0][2]).toEqual({ prompt: { text: 'fix it' }, repos: [{ url: 'https://github.com/acme/api' }], model: { id: 'composer-2' }, autoCreatePR: true })
    expect(await cursor.poll({ id: 'bc-1', run: 'run-1' })).toEqual({ messages: [], state: 'working', branch: undefined, links: undefined, remote: {} })
    const finished = await cursor.poll({ id: 'bc-1', run: 'run-1' })
    expect(finished).toMatchObject({ messages: [{ id: 'run-1-result', text: 'Fixed it.', at: 't2' }], state: 'idle', branch: 'cursor/fix', remote: { cursor: 'run-1' },
      links: [{ label: 'Agent', url: 'https://cursor.com/agents/bc-1' }, { label: 'Pull request #3', url: 'https://github.com/acme/api/pull/3' }] })
    expect((await cursor.poll({ id: 'bc-1', run: 'run-1', cursor: 'run-1' })).messages).toEqual([])
    expect(await cursor.send({ id: 'bc-1' }, 'also tests')).toEqual({ run: 'run-2' })
    await cursor.stop!({ id: 'bc-1', run: 'run-2' })
    expect(calls.at(-1)).toEqual(['POST', '/v1/agents/bc-1/runs/run-2/cancel', undefined])
    expect(await cursor.poll({ id: 'bc-1' })).toEqual({ messages: [] })
    await cursor.stop!({ id: 'bc-1' })
    expect(calls).toHaveLength(8)
  })

  it('refuses an agent it was not given, and a follow-up while busy', async () => {
    await expect(cursorAdapter(apiBridge([{ json: {} }]).bridge, async () => 'c').start({ task: 't', repository: null, options: {} })).rejects.toThrow('No agent was made')
    await expect(cursorAdapter(apiBridge([{ status: 409, json: { error: 'agent_busy' } }]).bridge, async () => 'c').send({ id: 'a' }, 'x')).rejects.toMatchObject({ code: 'BUSY' })
    expect(await cursorAdapter(apiBridge([{ json: {} }]).bridge, async () => 'c').send({ id: 'a' }, 'x')).toEqual({})
  })
})

/** Fo's MCP server, as its Fo profile behaves: replies as an event stream, sessions by header. */
async function fakeFo(script: { ask: Array<Record<string, unknown>>; reply: Array<Record<string, unknown>>; schema?: Record<string, unknown> }) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  let sessions = 0
  const base = await serve((request, body): Answer => {
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    if (message.method === 'initialize') return { headers: { 'mcp-session-id': `s${++sessions}` }, body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) }
    if (!message.id) return { status: 202, body: '' }
    if (request.headers['mcp-session-id'] !== `s${sessions}`) return { status: 404, body: 'session expired' }
    let result: Record<string, unknown>
    if (message.method === 'tools/list') {
      result = { tools: [
        { name: 'ask_fo', inputSchema: script.schema ?? { properties: { request: { type: 'string' }, conversation_id: { type: 'string' }, newConversation: { type: 'boolean' } }, required: ['request'] } },
        { name: 'get_fo_reply', inputSchema: { properties: { conversation_id: { type: 'string' }, request_id: { type: 'string' } } } },
      ] }
    } else {
      calls.push({ tool: message.params!.name!, args: message.params!.arguments! })
      const next = (message.params!.name === 'ask_fo' ? script.ask : script.reply).shift() ?? { status: 'working' }
      result = { content: [{ type: 'text', text: JSON.stringify(next) }] }
    }
    return { headers: { 'content-type': 'text/event-stream' }, body: `: ping\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n` }
  })
  return { base, calls, expire: () => { sessions += 1 } }
}

describe('Fo', () => {
  it('reads its tools\' parameters and its replies by what they mean', () => {
    expect(wordsParam({ name: 'ask_fo', inputSchema: { properties: { Message: { type: 'string' } } } })).toBe('Message')
    expect(wordsParam({ name: 'ask_fo', inputSchema: { properties: { ask: { type: 'string' } }, required: ['ask'] } })).toBe('ask')
    expect(wordsParam(undefined)).toBe('message')
    expect(readReply({ status: 'working', message: 'Calling Hair Lab', request_id: 'r1', conversation: { id: 'c1' } }))
      .toEqual({ working: true, text: null, ids: { request_id: 'r1', conversation_id: 'c1' }, progress: 'Calling Hair Lab' })
    expect(readReply({ status: 'done', reply: 'Booked.' })).toMatchObject({ working: false, text: 'Booked.', progress: null })
    expect(readReply({ text: 'Hi' })).toMatchObject({ working: false, text: 'Hi' })
    expect(questionIn('They have two times.\n\n1) 9:30\n2) 11:00\n3) neither\n\nWhich one?')).toEqual({ text: 'Which one?', choices: ['9:30', '11:00', 'neither'] })
    expect(questionIn('Booked for 9:30.')).toBeNull()
    // A question in Fo's words, with no choices, ends its turn: Fo chats, and most replies end with one.
    expect(questionIn('Hey! Did that trip ever get a destination?')).toBeNull()
    expect(questionIn('Which one?\n1) 9:30')).toBeNull()
    expect(questionIn('Options:\n- a\n- b')).toEqual({ text: 'Options:\n- a\n- b', choices: ['a', 'b'] })
  })

  it('asks, waits for the reply, and asks the person when Fo does', async () => {
    const fo = await fakeFo({
      ask: [{ status: 'working', conversation_id: 'c1', request_id: 'r1', message: 'Looking' }, { status: 'done', reply: 'Booked for 9:30.', conversation_id: 'c1' }],
      reply: [{ status: 'working', message: 'Calling Hair Lab' }, { status: 'done', reply: 'They have 9:30 or 11:00.\n1) 9:30\n2) 11:00\nWhich one?' }],
    })
    const client = new McpClient(`${fo.base}/fo`, 'Fo')
    const adapter = foAdapter(async () => client, () => new Date('2026-10-11T10:00:00Z'))
    const started = await adapter.start({ task: 'book a haircut', repository: null, options: {} })
    expect(started).toEqual({ remote: { id: 'c1', run: '{"request_id":"r1"}' }, links: [], update: { messages: [], state: 'working', activity: 'Looking' } })
    // A new harness is a new Fo conversation, never the person's current one.
    expect(fo.calls[0]).toEqual({ tool: 'ask_fo', args: { request: 'book a haircut', newConversation: true } })
    expect(await adapter.poll(started.remote)).toEqual({ messages: [], state: 'working', activity: 'Calling Hair Lab', waited: true })
    expect(fo.calls[1]).toEqual({ tool: 'get_fo_reply', args: { conversation_id: 'c1', request_id: 'r1' } })
    expect(await adapter.poll(started.remote)).toMatchObject({ state: 'needs_input', question: { text: 'They have 9:30 or 11:00.\n1) 9:30\n2) 11:00\nWhich one?', choices: ['9:30', '11:00'] }, remote: { run: undefined } })
    // An answer Fo gives at once is read on the next look.
    expect(await adapter.send({ id: 'c1' }, '9:30')).toEqual({ id: 'c1', run: undefined })
    expect(fo.calls.at(-1)).toEqual({ tool: 'ask_fo', args: { request: '9:30', conversation_id: 'c1' } })
    expect(adapter.answered!({ id: 'c1' })).toBe(true)
    expect(await adapter.poll({ id: 'c1' })).toMatchObject({ messages: [{ text: 'Booked for 9:30.' }], state: 'idle', question: null })
    expect(adapter.answered!({ id: 'c1' })).toBe(false)
    expect(await adapter.poll({ id: 'c1' })).toEqual({ messages: [] })
    expect(adapter.stop).toBeUndefined()
  })

  it('opens a session again when Fo forgot it, and says what failed', async () => {
    const fo = await fakeFo({ ask: [{ status: 'done', reply: 'Hi' }, { status: 'done', reply: 'Again' }], reply: [], schema: { properties: { message: { type: 'string' } } } })
    const client = new McpClient(`${fo.base}/fo`, 'Fo')
    const adapter = foAdapter(async () => client)
    expect((await adapter.start({ task: 'hello', repository: null, options: {} })).remote).toEqual({ id: 'current' })
    fo.expire()
    expect(await adapter.send({ id: 'current' }, 'again')).toEqual({ id: 'current', run: undefined })
    expect(fo.calls.at(-1)!.args).toEqual({ message: 'again' })
  })

  it('retries while Fo says its conversation is busy, then says so', async () => {
    let busy = 2
    const call = vi.fn(async (tool: string) => {
      if (tool === 'ask_fo' && busy-- > 0) throw new CloudError('CLOUD_FAILED', 'Fo: ask_fo: session busy with another run, retry')
      return { status: 'done', reply: 'Blue it is.', conversationId: 'c1' }
    })
    const mcp = { tools: async () => [{ name: 'ask_fo', inputSchema: { properties: { message: { type: 'string' }, conversationId: { type: 'string' } } } }], call } as unknown as McpClient
    const pauses: number[] = []
    const adapter = foAdapter(async () => mcp, () => new Date(), async (ms) => { pauses.push(ms) })
    expect(await adapter.send({ id: 'c1' }, 'Blue')).toEqual({ id: 'c1', run: undefined })
    expect(pauses).toEqual([3_000, 3_000])
    busy = 100
    await expect(adapter.send({ id: 'c1' }, 'Blue')).rejects.toMatchObject({ code: 'BUSY', message: 'Fo is still working. Send it again in a moment.' })
    call.mockImplementationOnce(async () => { throw new CloudError('CLOUD_FAILED', 'Fo: bad args') })
    busy = 0
    await expect(adapter.send({ id: 'c1' }, 'Blue')).rejects.toThrow('bad args')
  })

  it('refuses an MCP server with no ask_fo', async () => {
    const adapter = foAdapter(async () => ({ tools: async () => [], call: async () => ({}) }) as unknown as McpClient)
    await expect(adapter.start({ task: 't', repository: null, options: {} })).rejects.toThrow('no ask_fo')
    const failing = foAdapter(async () => ({ tools: async () => { throw new CloudError('NOT_CONNECTED', 'x') } }) as unknown as McpClient)
    await expect(failing.start({ task: 't', repository: null, options: {} })).rejects.toThrow('x')
  })
})

describe('the MCP client', () => {
  it('finds its answer in JSON or an event stream', () => {
    expect(replyTo(2, 'application/json', '{"jsonrpc":"2.0","id":2,"result":{}}')).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
    expect(replyTo(2, 'text/event-stream', 'data: {"id":1}\n\ndata: {"id":2,"result":{"a":1}}\n\n')).toEqual({ id: 2, result: { a: 1 } })
    expect(replyTo(2, 'application/json', 'nope')).toBeNull()
  })

  it('says a refused connection, an error and a failed tool as a person reads them', async () => {
    let mode = 'ok'
    const base = await serve((_request, body) => {
      const message = JSON.parse(body) as { id?: number; method: string }
      if (mode === 'refused') return { status: 401, body: '' }
      if (mode === 'missing') return { status: 404, body: '{"error":{"message":"Fo is not connected."}}' }
      if (mode === 'broken') return { status: 500, body: '' }
      if (message.method === 'initialize' || !message.id) return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) }
      if (mode === 'error') return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { message: 'bad args' } }) }
      if (mode === 'tool') return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'no such conversation' }] } }) }
      if (mode === 'structured') return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { structuredContent: { reply: 'hi' }, content: [] } }) }
      return { body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'plain words' }] } }) }
    })
    const client = new McpClient(base, 'Fo')
    expect(await client.call('ask_fo', {})).toEqual({ text: 'plain words' })
    expect(await client.tools()).toEqual([])
    mode = 'structured'
    expect(await client.call('ask_fo', {})).toEqual({ reply: 'hi' })
    mode = 'tool'
    await expect(client.call('ask_fo', {})).rejects.toThrow('Fo: no such conversation')
    mode = 'error'
    await expect(client.call('ask_fo', {})).rejects.toThrow('Fo: bad args')
    mode = 'broken'
    await expect(client.call('ask_fo', {})).rejects.toThrow('Fo answered 500.')
    for (const [given, said] of [['refused', 'connected again'], ['missing', 'not connected']]) {
      mode = given
      await expect(new McpClient(base, 'Fo').tools()).rejects.toThrow(said)
    }
    await expect(new McpClient('http://127.0.0.1:1/', 'Fo').tools()).rejects.toThrow('could not be reached')
  })
})
