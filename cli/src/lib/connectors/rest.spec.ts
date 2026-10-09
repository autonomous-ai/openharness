/**
 * REST tools served as MCP (rest.ts), with the gateway's real Gmail / Drive / Calendar / Figma shapes and a
 * stubbed fetch: never a real provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bridgeKey, sync, type Agent } from './agents.js'
import { createBridge } from './bridge.js'
import { tokenFrom } from './gateway.js'
import { answer, cleanRestEntry, encode, invoke, transport, type RestEntry } from './rest.js'
import { Store, type Token } from './store.js'

const GMAIL = {
  auth: { in: 'header', name: 'Authorization', format: 'Bearer {access_token}' },
  tools: [
    { name: 'gmail_identity', description: 'Who is signed in.', request: { method: 'GET', url: 'https://www.googleapis.com/oauth2/v3/userinfo' } },
    { name: 'gmail_send', description: 'Send an email.', params: { to: { type: 'string', required: true, description: 'Recipient' }, subject: { type: 'string', required: true }, body: { type: 'string', required: true } },
      request: { method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', json: { raw: { $encode: 'rfc2822_base64url', to: '{to}', subject: '{subject}', body: '{body}' } } } },
  ],
}
const DRIVE = {
  tools: [
    { name: 'google_drive_read_file', params: { file_id: { type: 'string', required: true } }, request: { method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/{file_id}', query: { alt: 'media' } } },
    { name: 'google_drive_list_files', params: { query: { type: 'string' }, page_size: { type: 'integer' } },
      request: { method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', query: { q: '{query}', pageSize: '{page_size}', orderBy: 'modifiedTime desc' } } },
    { name: 'google_drive_create_file', params: { name: { type: 'string', required: true }, content: { type: 'string', required: true }, content_type: { type: 'string' } },
      request: { method: 'POST', url: 'https://www.googleapis.com/upload/drive/v3/files', query: { uploadType: 'multipart' }, multipart: { metadata: { name: '{name}' }, content: '{content}', content_type: '{content_type}' } } },
  ],
}
const FIGMA = { auth: { in: 'header', name: 'X-Figma-Token', format: '{access_token}' }, tools: [{ name: 'figma_identity', request: { url: 'https://api.figma.com/v1/me' } }] }

const entryOf = (raw: unknown): RestEntry => cleanRestEntry(raw)!
const token: Token = { access_token: 'ya29.secret', token_type: 'Bearer', source: 'gateway' }

let fetchMock: ReturnType<typeof vi.fn>
const sent = () => fetchMock.mock.calls.at(-1) as [URL, RequestInit]
function reply(status: number, body = '') { fetchMock.mockResolvedValueOnce(new Response(body || null, { status })) }

beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('reading a rest_entry', () => {
  it('keeps the usable tools and fills the defaults', () => {
    const entry = entryOf({ tools: [...DRIVE.tools, { name: 'downgraded', request: { url: 'http://www.googleapis.com/x' } }, { name: 'bad name!', request: { url: 'https://x.example' } },
      { name: 'no_url', request: {} }, { name: 'unparsable', request: { url: 'https://' } }, { name: 'with_user', request: { url: 'https://me:pw@x.example' } }, 'junk', { name: 'odd', params: { x: 'junk' }, request: { url: 'https://x.example', query: { n: 1 }, multipart: [] } }] })
    expect(entry.auth).toEqual({ in: 'header', name: 'Authorization', format: 'Bearer {access_token}' })
    expect(entry.tools.map(tool => tool.name)).toEqual(['google_drive_read_file', 'google_drive_list_files', 'google_drive_create_file', 'odd'])
    expect(entry.tools[3]).toEqual({ name: 'odd', params: { x: { type: 'string' } }, request: { method: 'GET', url: 'https://x.example' } })
    expect(entry.tools[0].request).toEqual({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/{file_id}', query: { alt: 'media' } })
  })

  it('is no entry without a usable tool', () => {
    for (const raw of [undefined, null, [], {}, { tools: {} }, { tools: [{ name: 'x', request: { url: 'http://x.example' } }] }]) expect(cleanRestEntry(raw)).toBeNull()
  })

  it('arrives from the gateway and survives the store, the token never filled in', () => {
    const vault = new Store(mkdtempSync(join(tmpdir(), 'rest-store-')))
    try {
      const got = tokenFrom({ access_token: 'ya29.secret', refresh: true, rest_entry: GMAIL, transport: 'rest', mcp_entry: null })
      expect(got).toMatchObject({ transport: 'rest', rest_entry: { auth: GMAIL.auth } })
      expect(JSON.stringify(got.rest_entry)).not.toContain('ya29')
      vault.save('gmail', got)
      expect(vault.token('gmail')!.rest_entry!.tools.map(tool => tool.name)).toEqual(['gmail_identity', 'gmail_send'])
      expect(vault.status('gmail', 'Gmail', vault.token('gmail')).tools).toBe(true)
      expect(tokenFrom({ access_token: 'a', transport: 'sideways', rest_entry: 'x' })).not.toHaveProperty('transport')
      vault.save('plain', { access_token: 'a', transport: 'none' })
      expect(vault.token('plain')).toMatchObject({ transport: 'none' })
      expect(vault.status('plain', 'Plain', vault.token('plain')).tools).toBe(false)
    } finally { rmSync(vault.root, { recursive: true, force: true }) }
  })
})

describe('which way agents reach a connection', () => {
  const mcp = { url: 'https://mcp.example/mcp', headers: {} }
  const rest = entryOf(GMAIL)
  it('follows the gateway when what it names came with it, and infers otherwise', () => {
    expect(transport({ transport: 'none', mcp_entry: mcp })).toBe('none')
    expect(transport({ transport: 'rest', mcp_entry: mcp, rest_entry: rest })).toBe('rest')
    expect(transport({ transport: 'rest', mcp_entry: mcp })).toBe('mcp')
    expect(transport({ mcp_entry: mcp, rest_entry: rest })).toBe('mcp')
    expect(transport({ transport: 'mcp', rest_entry: rest })).toBe('rest')
    expect(transport({ access_token: 'a' })).toBe('none')
  })
})

describe('encoders', () => {
  it('writes an RFC 2822 message Gmail accepts, safe from header injection, Vietnamese intact', () => {
    const raw = encode('rfc2822_base64url', { to: 'a@example.com\r\nBcc: evil@example.com', cc: 'c@example.com', subject: 'Chào bạn', body: 'Xin chào'.repeat(20) })
    expect(raw).not.toMatch(/[+/=]/)
    const message = Buffer.from(raw, 'base64url').toString('utf8')
    const [head, body] = message.split('\r\n\r\n')
    expect(head.split('\r\n')).toEqual(['To: a@example.com  Bcc: evil@example.com', 'Cc: c@example.com', `Subject: =?UTF-8?B?${Buffer.from('Chào bạn').toString('base64')}?=`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'])
    expect(body.split('\r\n').every(line => line.length <= 76)).toBe(true)
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Xin chào'.repeat(20))
    expect(Buffer.from(encode('rfc2822_base64url', { to: 5 }), 'base64url').toString()).toContain('To: \r\nSubject: \r\n')
  })

  it('base64url, and refuses one it does not know', () => {
    expect(encode('base64url', { value: 'hi?>' })).toBe(Buffer.from('hi?>').toString('base64url'))
    expect(encode('base64url', {})).toBe('')
    expect(() => encode('rot13', {})).toThrow('does not know ("rot13")')
  })
})

describe('calling a tool', () => {
  const gmail = entryOf(GMAIL)
  const drive = entryOf({ ...DRIVE, auth: GMAIL.auth })
  const tool = (entry: RestEntry, name: string) => entry.tools.find(item => item.name === name)!

  it('sends Gmail a message with the token in the entry\'s header', async () => {
    reply(200, '{"id":"m1"}')
    const result = await invoke(gmail, tool(gmail, 'gmail_send'), token, { to: 'a@example.com', subject: 'Hi', body: 'Hello' })
    expect(result).toEqual({ ok: true, text: '{"id":"m1"}' })
    const [url, init] = sent()
    expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer ya29.secret', 'Content-Type': 'application/json' } })
    const raw = JSON.parse(init.body as string).raw
    expect(Buffer.from(raw, 'base64url').toString()).toContain('To: a@example.com\r\nSubject: Hi\r\n')
  })

  it('checks required arguments before anything is sent', async () => {
    expect(await invoke(gmail, tool(gmail, 'gmail_send'), token, { to: ' ', subject: null })).toEqual({ ok: false, text: 'Missing required arguments: to, subject, body.' })
    expect((await invoke(drive, tool(drive, 'google_drive_read_file'), token, {})).text).toBe('Missing required argument: file_id.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('encodes path values, leaves out empty query values, and fills other auth formats', async () => {
    reply(200)
    expect(await invoke(drive, tool(drive, 'google_drive_read_file'), token, { file_id: '../../about?x=1' })).toEqual({ ok: true, text: '{}' })
    expect(String(sent()[0])).toBe('https://www.googleapis.com/drive/v3/files/..%2F..%2Fabout%3Fx%3D1?alt=media')
    reply(200, '[]')
    await invoke(drive, tool(drive, 'google_drive_list_files'), token, { page_size: 5 })
    expect(String(sent()[0])).toBe('https://www.googleapis.com/drive/v3/files?pageSize=5&orderBy=modifiedTime+desc')
    const figma = entryOf(FIGMA)
    reply(200, '{}')
    await invoke(figma, figma.tools[0], { access_token: 'figd' }, {})
    expect(sent()[1]).toMatchObject({ method: 'GET', headers: { 'X-Figma-Token': 'figd' } })
    expect(sent()[1].body).toBeUndefined()
  })

  it('uploads to Drive as multipart/related', async () => {
    reply(200, '{"id":"f1"}')
    await invoke(drive, tool(drive, 'google_drive_create_file'), token, { name: 'notes.txt', content: 'hello', content_type: 'text/markdown' })
    const [url, init] = sent()
    expect(String(url)).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart')
    const boundary = /boundary=(.+)$/.exec((init.headers as Record<string, string>)['Content-Type'])![1]
    expect(init.body).toBe(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"notes.txt"}\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\nhello\r\n--${boundary}--`)
    const bare = entryOf({ tools: [{ name: 'up', params: {}, request: { method: 'post', url: 'https://x.example/u', multipart: { content: 7 } } }] })
    reply(200)
    await invoke(bare, bare.tools[0], { access_token: 'a' }, {})
    expect(sent()[1].method).toBe('POST')
    expect(sent()[1].body).toMatch(/\r\n\r\n\{\}\r\n--[^\r]+\r\nContent-Type: text\/plain\r\n\r\n\r\n/)
  })

  it('says what went wrong in words a person can act on', async () => {
    const identity = tool(gmail, 'gmail_identity')
    const cases: [number, string, string][] = [
      [401, '{"error":{"message":"Invalid Credentials"}}', 'The connection needs signing in again: Invalid Credentials'],
      [403, '{"message":"Insufficient scope"}', "This account doesn't have permission for that. Reconnect it in harness connections and grant the extra access: Insufficient scope"],
      [404, '{"detail":"No file"}', 'Not found — check the id or key that was used: No file'],
      [429, '<html>slow down</html>', 'The service is rate-limiting this account. Try again shortly.'],
      [503, '{"error":"down"}', 'The service had an error (503).'],
      [418, '[]', 'The service refused the request (418).'],
    ]
    for (const [status, body, text] of cases) {
      reply(status, body)
      expect(await invoke(gmail, identity, token, {})).toEqual({ ok: false, text })
    }
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo https://www.googleapis.com/?key=x'), { name: 'TypeError' }))
    expect(await invoke(gmail, identity, token, {})).toEqual({ ok: false, text: "Couldn't reach the service (TypeError)." })
  })

  it('refuses rather than guesses', async () => {
    const query = entryOf({ ...GMAIL, auth: { in: 'query' } })
    expect((await invoke(query, query.tools[0], token, {})).text).toContain('("query")')
    const odd = entryOf({ tools: [{ name: 'x', request: { method: 'POST', url: 'https://x.example', json: { a: { $encode: 'rot13' } } } }] })
    expect((await invoke(odd, odd.tools[0], token, {})).text).toContain('does not know ("rot13")')
    const broken = entryOf({ tools: [{ name: 'y', params: { host: {} }, request: { url: 'https://{host}' } }] })
    expect((await invoke(broken, broken.tools[0], token, {})).text).toMatch(/^Couldn't build the request: /)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fills nested bodies: lists, numbers and objects as given', async () => {
    const cal = entryOf({ tools: [{ name: 'c', params: {}, request: { method: 'POST', url: 'https://x.example', json: { summary: '{s}', start: { dateTime: '{t}' }, tags: ['{s}', 3], n: 1, none: null } } }] })
    reply(200, '{}')
    await invoke(cal, cal.tools[0], {}, { s: 'Họp', t: { at: 1 } })
    expect(JSON.parse(sent()[1].body as string)).toEqual({ summary: 'Họp', start: { dateTime: '{"at":1}' }, tags: ['Họp', 3], n: 1, none: null })
    expect(sent()[1].headers).toMatchObject({ Authorization: 'Bearer ' })
  })
})

describe('answering MCP', () => {
  const entry = entryOf(GMAIL)
  const ask = (message: unknown, fresh: () => Promise<Token> = async () => token, current: RestEntry | null = entry) => answer(message, () => current, fresh)

  it('introduces itself and lists the tools', async () => {
    expect(await ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).toEqual({ jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'harness-connector-bridge', version: '1' } } })
    expect((await ask({ id: 2, method: 'initialize' }))!.result).toMatchObject({ protocolVersion: '2025-03-26' })
    expect(await ask({ id: 3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
    const listed = (await ask({ id: 4, method: 'tools/list' }))!.result as { tools: Record<string, unknown>[] }
    expect(listed.tools[0]).toEqual({ name: 'gmail_identity', description: 'Who is signed in.', inputSchema: { type: 'object', properties: {}, required: [] } })
    expect(listed.tools[1].inputSchema).toEqual({ type: 'object', properties: { to: { type: 'string', description: 'Recipient' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] })
    expect(await ask({ id: 5, method: 'tools/list' }, undefined, null)).toEqual({ jsonrpc: '2.0', id: 5, result: { tools: [] } })
    expect(((await ask({ id: 6, method: 'tools/list' }, undefined, entryOf({ tools: [{ name: 'n', request: { url: 'https://x.example' } }] })))!.result as { tools: unknown[] }).tools[0]).toMatchObject({ description: '' })
  })

  it('calls a tool with the fresh token; a failure is a result the model reads', async () => {
    reply(200, '{"sub":"1"}')
    expect(await ask({ id: 7, method: 'tools/call', params: { name: 'gmail_identity', arguments: {} } }, async () => ({ access_token: 'renewed' })))
      .toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '{"sub":"1"}' }], isError: false } })
    expect(sent()[1].headers).toMatchObject({ Authorization: 'Bearer renewed' })
    expect((await ask({ id: 8, method: 'tools/call', params: { name: 'gmail_send' } }))!.result).toEqual({ content: [{ type: 'text', text: 'Missing required arguments: to, subject, body.' }], isError: true })
    expect((await ask({ id: 9, method: 'tools/call', params: { name: 'gmail_read' } }))!.result).toMatchObject({ content: [{ text: 'This connection has no tool called "gmail_read".' }], isError: true })
    expect((await ask({ id: 10, method: 'tools/call', params: { name: 'gmail_identity' } }, async () => { throw new Error('Reconnect it.') }))!.result)
      .toMatchObject({ content: [{ text: 'Reconnect it.' }], isError: true })
  })

  it('takes no notification as a request and refuses what is not one', async () => {
    expect(await ask({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await ask({ id: null, method: 'ping' })).toBeNull()
    expect(await ask([1])).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } })
    expect(await ask({ id: 'x', method: 'resources/list' })).toEqual({ jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'Method not found: resources/list' } })
  })
})

describe('through the bridge', () => {
  let home: string
  let vault: Store
  let port: number
  let key: string
  const closers: (() => void)[] = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'rest-bridge-'))
    vault = new Store(join(home, 'connections'))
    vault.save('gmail', tokenFrom({ access_token: 'ya29.secret', rest_entry: GMAIL, transport: 'rest' }))
    key = bridgeKey(vault)
    const bridge = createBridge(vault, { key: () => String(vault.file('bridge.json').key) })
    await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
    port = (bridge.address() as { port: number }).port
    closers.push(() => { bridge.close(); bridge.closeAllConnections() })
  })
  afterEach(() => { while (closers.length) closers.pop()!(); rmSync(home, { recursive: true, force: true }) })

  function send(method: string, body = ''): Promise<{ status: number, headers: Record<string, unknown>, body: string }> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: `/${key}/gmail/mcp`, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk)).on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      })
      request.on('error', reject).end(body)
    })
  }

  it('is the MCP server for a REST-backed connection', async () => {
    const listed = await send('POST', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    expect(listed.status).toBe(200)
    expect(listed.headers['content-type']).toBe('application/json')
    expect(JSON.parse(listed.body).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['gmail_identity', 'gmail_send'])
    reply(200, '{"email":"me@example.com"}')
    const called = JSON.parse((await send('POST', '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"gmail_identity"}}')).body)
    expect(called.result).toEqual({ content: [{ type: 'text', text: '{"email":"me@example.com"}' }], isError: false })
    expect(sent()[1].headers).toMatchObject({ Authorization: 'Bearer ya29.secret' })
    expect((await send('POST', '{"jsonrpc":"2.0","method":"notifications/initialized"}')).status).toBe(202)
    expect(JSON.parse((await send('POST', '{oops')).body).error.code).toBe(-32700)
    expect(JSON.parse((await send('POST')).body).error.code).toBe(-32700)
    const stream = await send('GET')
    expect([stream.status, stream.headers.allow]).toEqual([405, 'POST'])
  })

  it('says so when the connection went away mid-session', async () => {
    const renewing = vi.spyOn(vault, 'token')
    renewing.mockImplementation(code => code === 'gmail' && renewing.mock.calls.length > 2 ? undefined : Store.prototype.token.call(vault, code))
    const called = JSON.parse((await send('POST', '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gmail_identity"}}')).body)
    expect(called.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('no longer connected') }] })
  })

  it('gives agents the connection like any MCP one', () => {
    const applied: Record<string, string>[] = []
    const agent = { name: 'fake', installed: () => true, apply: (wanted: Record<string, string>) => { applied.push(wanted); return Object.keys(wanted) } } as unknown as Agent
    sync(vault, { HOME: home }, [agent])
    expect(Object.keys(applied[0])).toEqual(['gmail'])
  })
})
