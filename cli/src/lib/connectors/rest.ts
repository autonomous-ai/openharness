/**
 * A connector's REST surface served to agents as MCP tools, as the Grid app does (connector_bridge.dart,
 * rest_invoker.dart, rest_encoders.dart, rest_entry.dart). Some services have no MCP server the grant can
 * use (Gmail with only gmail.send, Google Drive, Calendar, Figma) but a REST API that works with the token:
 * the gateway sends their `rest_entry` (tools, each one HTTP request template) and the bridge answers
 * `tools/list` and `tools/call` from it. No service is named here: everything specific is in the entry.
 */
import { randomUUID } from 'node:crypto'
import { ConnectorError, type Token } from './store.js'

export type Transport = 'mcp' | 'rest' | 'none'
export interface RestAuth { in: string, name: string, format: string }
export interface RestParam { type: string, required?: boolean, description?: string }
export interface RestRequest {
  method: string
  url: string
  query?: Record<string, string>
  json?: unknown
  multipart?: Record<string, unknown>
}
export interface RestTool { name: string, description?: string, params: Record<string, RestParam>, request: RestRequest }
export interface RestEntry { auth: RestAuth, tools: RestTool[] }
export interface RestResult { ok: boolean, text: string }

const TIMEOUT_MS = 30_000
const MAX_TOOLS = 64
const NAME = /^[A-Za-z0-9_-]{1,64}$/
/** The transformations a request body may name, and nothing else: an unknown one is refused, not guessed. */
export const ENCODERS = new Set(['rfc2822_base64url', 'base64url'])

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const str = (value: unknown, fallback = ''): string => typeof value === 'string' && value ? value : fallback

function cleanRequest(raw: unknown): RestRequest | null {
  const entry = record(raw)
  if (!entry || typeof entry.url !== 'string') return null
  // https only: the credential rides on this request, and the gateway may not downgrade it.
  let url: URL
  try { url = new URL(entry.url) } catch { return null }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null
  const query: Record<string, string> = {}
  for (const [name, value] of Object.entries(record(entry.query) ?? {})) if (typeof value === 'string') query[name] = value
  const request: RestRequest = { method: str(entry.method, 'GET').toUpperCase(), url: entry.url }
  if (Object.keys(query).length) request.query = query
  if (entry.json !== undefined && entry.json !== null) request.json = entry.json
  const multipart = record(entry.multipart)
  if (multipart) request.multipart = multipart
  return request
}

function cleanTool(raw: unknown): RestTool | null {
  const entry = record(raw)
  if (!entry || typeof entry.name !== 'string' || !NAME.test(entry.name)) return null
  const request = cleanRequest(entry.request)
  if (!request) return null
  const params: Record<string, RestParam> = {}
  for (const [name, value] of Object.entries(record(entry.params) ?? {})) {
    const param = record(value) ?? {}
    params[name] = { type: str(param.type, 'string'), ...(param.required === true ? { required: true } : {}), ...(str(param.description) ? { description: param.description as string } : {}) }
  }
  return { name: entry.name, ...(str(entry.description) ? { description: entry.description as string } : {}), params, request }
}

/**
 * A rest_entry as the gateway sends it, or null when it has no usable tool. Lenient, as Grid is: a tool
 * this version cannot read drops itself and the others still work.
 */
export function cleanRestEntry(raw: unknown): RestEntry | null {
  const entry = record(raw)
  if (!entry || !Array.isArray(entry.tools)) return null
  const tools = entry.tools.slice(0, MAX_TOOLS).map(cleanTool).filter((tool): tool is RestTool => tool !== null)
  if (!tools.length) return null
  const auth = record(entry.auth) ?? {}
  return { auth: { in: str(auth.in, 'header'), name: str(auth.name, 'Authorization'), format: str(auth.format, 'Bearer {access_token}') }, tools }
}

/** How agents reach this connection. The gateway's word wins when the entry it names came with it. */
export function transport(token: Token): Transport {
  if (token.transport === 'none') return 'none'
  if (token.transport === 'rest' && token.rest_entry) return 'rest'
  if (token.mcp_entry) return 'mcp'
  return token.rest_entry ? 'rest' : 'none'
}

export function inputSchema(tool: RestTool): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(tool.params).map(([name, param]) => [name, { type: param.type, ...(param.description ? { description: param.description } : {}) }])),
    required: Object.entries(tool.params).filter(([, param]) => param.required).map(([name]) => name),
  }
}

/** `{name}` replaced by that argument; one left out becomes empty, never the literal `{cc}`. */
function substitute(template: string, args: Record<string, unknown>, urlSafe = false): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = args[name]
    if (value === undefined || value === null) return ''
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    return urlSafe ? encodeURIComponent(raw) : raw
  })
}

const base64Url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')

/** One header line: CR/LF stripped (header injection), non-ASCII as an RFC 2047 encoded-word. */
function headerValue(raw: string): string {
  const clean = raw.replace(/[\r\n]/g, ' ').trim()
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** An RFC 2822 message from to / cc / subject / body, UTF-8 throughout, CRLF line ends. */
function rfc2822(fields: Record<string, unknown>): string {
  const field = (name: string): string => typeof fields[name] === 'string' ? fields[name] as string : ''
  const headers = [
    `To: ${headerValue(field('to'))}`,
    ...(field('cc') ? [`Cc: ${headerValue(field('cc'))}`] : []),
    `Subject: ${headerValue(field('subject'))}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64',
  ]
  const body = (Buffer.from(field('body'), 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

export function encode(name: string, fields: Record<string, unknown>): string {
  if (name === 'rfc2822_base64url') return base64Url(rfc2822(fields))
  if (name === 'base64url') return base64Url(typeof fields.value === 'string' ? fields.value : '')
  throw new ConnectorError(`This connection asked for an encoding this version of Harness does not know ("${name}"). Update Harness.`)
}

/** A body template filled in: strings substituted, a map naming `$encode` handed to that encoder. */
function fill(template: unknown, args: Record<string, unknown>): unknown {
  if (typeof template === 'string') return substitute(template, args)
  if (Array.isArray(template)) return template.map(item => fill(item, args))
  const map = record(template)
  if (!map) return template
  const filled = Object.fromEntries(Object.entries(map).filter(([name]) => name !== '$encode').map(([name, value]) => [name, fill(value, args)]))
  return typeof map.$encode === 'string' ? encode(map.$encode, filled) : filled
}

function buildUrl(request: RestRequest, args: Record<string, unknown>): URL {
  // Path values percent-encoded: a model-written `../` or `?` must not reach another endpoint.
  const url = new URL(substitute(request.url, args, true))
  for (const [name, template] of Object.entries(request.query ?? {})) {
    // An optional parameter left out is absent, not empty: `timeMin=` is a 400 from Google.
    const value = substitute(template, args)
    if (value) url.searchParams.set(name, value)
  }
  return url
}

/** RFC 2387 multipart/related: a JSON metadata part, then the content. */
function multipartBody(boundary: string, filled: unknown): string {
  const parts = record(filled) ?? {}
  const contentType = str(parts.content_type, 'text/plain')
  return `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(parts.metadata ?? {})}\r\n`
    + `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${typeof parts.content === 'string' ? parts.content : ''}\r\n--${boundary}--`
}

function detail(body: string): string {
  try {
    const decoded = record(JSON.parse(body))
    const error = decoded?.error
    const message = record(error) ? record(error)!.message : (decoded?.message ?? decoded?.detail)
    if (typeof message === 'string' && message) return `: ${message}`
  } catch { /* Not JSON: an HTML error page helps nobody in a chat. */ }
  return '.'
}

/** A status a person can act on. 401 and 403 mean opposite things: signed out, versus never allowed. */
function failure(status: number, body: string): string {
  const more = detail(body)
  if (status === 401) return `The connection needs signing in again${more}`
  if (status === 403) return `This account doesn't have permission for that. Reconnect it in harness connections and grant the extra access${more}`
  if (status === 404) return `Not found — check the id or key that was used${more}`
  if (status === 429) return `The service is rate-limiting this account. Try again shortly${more}`
  if (status >= 500) return `The service had an error (${status})${more}`
  return `The service refused the request (${status})${more}`
}

/** One tool call: the model's arguments into the tool's HTTP request, with the token in the entry's header. */
export async function invoke(entry: RestEntry, tool: RestTool, token: Token, args: Record<string, unknown>): Promise<RestResult> {
  const missing = Object.entries(tool.params).filter(([name, param]) => param.required && (args[name] === undefined || args[name] === null || String(args[name]).trim() === '')).map(([name]) => name)
  if (missing.length) return { ok: false, text: `Missing required argument${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.` }
  // Refused rather than guessed: a credential somewhere the service did not ask for it is worse.
  if (entry.auth.in !== 'header') return { ok: false, text: `This connection needs a credential placed somewhere this version of Harness does not support ("${entry.auth.in}").` }
  let url: URL
  const headers: Record<string, string> = {
    [entry.auth.name]: substitute(entry.auth.format, { access_token: token.access_token ?? '', token_type: token.token_type ?? 'Bearer' }),
    Accept: 'application/json', 'User-Agent': 'Harness-Connections',
  }
  let body: string | undefined
  try {
    url = buildUrl(tool.request, args)
    if (tool.request.multipart) {
      const boundary = `harness-${randomUUID()}`
      headers['Content-Type'] = `multipart/related; boundary=${boundary}`
      body = multipartBody(boundary, fill(tool.request.multipart, args))
    } else if (tool.request.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(fill(tool.request.json, args))
    }
  } catch (error) {
    return { ok: false, text: error instanceof ConnectorError ? error.message : `Couldn't build the request: ${(error as Error).message}` }
  }
  let response: Response
  let text: string
  try {
    response = await fetch(url, { method: tool.request.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
    text = await response.text()
  } catch (error) {
    // The kind, not the message: a message can carry the full URL.
    return { ok: false, text: `Couldn't reach the service (${(error as Error).name}).` }
  }
  if (response.ok) return { ok: true, text: text || '{}' }
  return { ok: false, text: failure(response.status, text) }
}

/**
 * One JSON-RPC message for a REST-backed connection; null for a notification (no reply). `entry` is read
 * per call, `fresh` renews the token first, so a token renewed a moment ago is the one used.
 */
export async function answer(message: unknown, entry: () => RestEntry | null, fresh: () => Promise<Token>): Promise<Record<string, unknown> | null> {
  const payload = record(message)
  if (!payload) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }
  const id = payload.id
  // A notification (notifications/initialized) takes no reply: answering it is a protocol error.
  if (id === undefined || id === null) return null
  const params = record(payload.params) ?? {}
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const toolError = (text: string) => reply({ content: [{ type: 'text', text }], isError: true })
  switch (payload.method) {
    case 'initialize':
      return reply({
        // Echo the client's version: disagreeing fails the handshake.
        protocolVersion: str(params.protocolVersion, '2025-03-26'),
        capabilities: { tools: {} }, serverInfo: { name: 'harness-connector-bridge', version: '1' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: (entry()?.tools ?? []).map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: inputSchema(tool) })) })
    case 'tools/call': {
      let token: Token
      try { token = await fresh() } catch (error) { return toolError((error as Error).message) }
      const current = entry()
      const tool = current?.tools.find(item => item.name === params.name)
      if (!current || !tool) return toolError(`This connection has no tool called "${String(params.name)}".`)
      const result = await invoke(current, tool, token, record(params.arguments) ?? {})
      // A failed call is a result with isError, not a JSON-RPC error: the model reads it and can act.
      return reply({ content: [{ type: 'text', text: result.text }], isError: !result.ok })
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(payload.method)}` } }
  }
}
