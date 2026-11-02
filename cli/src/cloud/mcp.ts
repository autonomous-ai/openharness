/**
 * The smallest MCP client the cloud agents need: initialize, list tools, call one, over streamable HTTP
 * (a reply is JSON or an event stream). Written here rather than taken from the SDK, which brings zod into
 * the process (leanEntry.spec.ts) for three requests.
 */
import { CloudError } from './types.js'

const PROTOCOL = '2025-06-18'

export interface McpTool { name: string; inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } }

/** The JSON-RPC message answering `id` in a reply, JSON or an event stream. */
export function replyTo(id: number, contentType: string, body: string): Record<string, unknown> | null {
  const candidates: string[] = contentType.includes('text/event-stream')
    ? body.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean)
    : [body]
  for (const candidate of candidates) {
    try {
      const message = JSON.parse(candidate) as Record<string, unknown>
      if (message.id === id) return message
    } catch { /* Not JSON: a keep-alive or a comment. */ }
  }
  return null
}

export class McpClient {
  private session: string | null = null
  private ready: Promise<void> | null = null
  private next = 1

  constructor(private readonly url: string, private readonly name: string, private readonly send: typeof fetch = (input, init) => fetch(input, init)) {}

  private async post(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; type: string; body: string; session: string | null }> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const answer = await this.send(this.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL,
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
      },
      body: JSON.stringify(message),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch(() => { throw new CloudError('UNREACHABLE', `${this.name} could not be reached. Try again.`) })
    return { status: answer.status, type: answer.headers.get('content-type') ?? '', body: await answer.text(), session: answer.headers.get('mcp-session-id') }
  }

  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      const id = this.next++
      const answer = await this.post({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Harness', version: '1' } } }, 20_000)
      this.check(answer.status, answer.body)
      this.session = answer.session
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, 20_000)
    })().catch((error) => { this.ready = null; throw error })
    return this.ready
  }

  private check(status: number, body: string): void {
    if (status === 401 || status === 403) throw new CloudError('NOT_CONNECTED', `${this.name} needs to be connected again in Connections.`)
    if (status === 404 && /not connected/i.test(body)) throw new CloudError('NOT_CONNECTED', `${this.name} is not connected. Connect it in Connections.`)
    if (status >= 400) throw new CloudError('CLOUD_FAILED', `${this.name} answered ${status}.`)
  }

  /** One request, after initializing; a session the server forgot (404) is opened again, once. */
  async request(method: string, params: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal, again = true): Promise<Record<string, unknown>> {
    await this.initialize()
    const id = this.next++
    const answer = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal)
    if (answer.status === 404 && this.session && again) {
      this.session = null
      this.ready = null
      return this.request(method, params, timeoutMs, signal, false)
    }
    this.check(answer.status, answer.body)
    const reply = replyTo(id, answer.type, answer.body)
    const error = reply?.error as { message?: unknown } | undefined
    if (!reply || error) throw new CloudError('CLOUD_FAILED', `${this.name}: ${typeof error?.message === 'string' ? error.message.slice(0, 200) : 'no answer.'}`)
    return (reply.result ?? {}) as Record<string, unknown>
  }

  async tools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {})
    return Array.isArray(result.tools) ? result.tools as McpTool[] : []
  }

  /** A tool's result, as JSON when its text is JSON, else `{ text }`. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.request('tools/call', { name: tool, arguments: args }, timeoutMs, signal)
    const text = (Array.isArray(result.content) ? result.content as { type?: string; text?: string }[] : [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
    if (result.isError === true) throw new CloudError('CLOUD_FAILED', `${this.name}: ${text.slice(0, 300) || 'the request failed.'}`)
    if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, unknown>
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* Plain text: the answer itself. */ }
    return { text }
  }
}
