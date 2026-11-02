/**
 * `harness connections mcp <code> --socket <path>`: what an MCP client runs to reach a connection (follow-up of audit H1,
 * docs/plans/2026-11-02-connections-bridge-stdio-shim-plan.md). A client on a loopback address talks to whoever holds that port,
 * so another account that took it could read its tool calls and feed false answers to the owner's running agents. This talks
 * stdio to the client and HTTP to the bridge over its 0600 socket. It holds no key, as reaching that socket is the credential,
 * and it never falls back to a port: with the socket gone the daemon is down, and the client is told so.
 *
 * The client's stream is newline-delimited JSON-RPC (MCP's stdio transport). Each message becomes one POST of MCP's HTTP
 * transport, whose answer is JSON or an event stream. `initialize` goes first and alone: its answer names the session the rest
 * carry. A service's own unprompted stream (GET) is not opened, so `notifications/*_changed` are not relayed.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { SOCKET_KEY } from './bridge.js'

const NOT_RUNNING = 'Harness is not running on this computer, so this connection cannot be reached. Start it and try again.'
const UNREADABLE = 'The connection\'s answer could not be read. Try again.'

interface Message { id?: unknown; method?: unknown; result?: { protocolVersion?: unknown } }

export async function runMcpShim(code: string, socket: string, input: Readable, output: Writable): Promise<void> {
  const say = (message: unknown): void => { output.write(`${JSON.stringify(message)}\n`) }
  const refuse = (id: unknown, code: number, message: string): void => say({ jsonrpc: '2.0', id, error: { code, message } })
  let session: string | undefined
  let version: string | undefined
  const running = new Set<Promise<void>>()

  /** One answer: JSON, or an event stream whose every `data` is a message of its own. */
  const relay = (answer: IncomingMessage, sent: Message): Promise<void> => new Promise((resolve, reject) => {
    const header = answer.headers['mcp-session-id']
    if (typeof header === 'string') session = header
    const streaming = String(answer.headers['content-type'] ?? '').includes('text/event-stream')
    let held = ''
    let answered = false
    const take = (raw: string): void => {
      const message = JSON.parse(raw) as Message
      answered ||= message.id === sent.id
      if (sent.method === 'initialize' && typeof message.result?.protocolVersion === 'string') version = message.result.protocolVersion
      say(message)
    }
    /** An event ends at a blank line; its `data:` lines joined are its message. */
    const events = (): void => {
      for (let at = held.search(/\r?\n\r?\n/); at >= 0; at = held.search(/\r?\n\r?\n/)) {
        const event = held.slice(0, at)
        held = held.slice(at).replace(/^\r?\n\r?\n/, '')
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (data) take(data)
      }
    }
    answer.setEncoding('utf8')
    answer.on('data', (chunk: string) => { held += chunk; if (streaming) events() })
    answer.on('error', reject)
    answer.on('end', () => {
      try {
        if (streaming) { held += '\n\n'; events() }
        else if (held.trim() && (answer.statusCode ?? 500) < 300) take(held)
        else if ((answer.statusCode ?? 500) >= 300 && sent.id !== undefined) {
          // The bridge's refusal names no request: this one is what it answers.
          let reason = `The connection answered ${answer.statusCode}.`
          try { reason = (JSON.parse(held) as { error?: { message?: string } }).error?.message ?? reason } catch { /* not its JSON */ }
          refuse(sent.id, -32001, reason)
          answered = true
        }
        // A client would wait for ever on a request nothing answered.
        if (sent.id !== undefined && !answered) refuse(sent.id, -32001, UNREADABLE)
        resolve()
      } catch (error) { reject(error as Error) }
    })
  })

  const post = (raw: string, sent: Message): Promise<void> => new Promise(resolve => {
    const failed = (reason: string): void => { if (sent.id !== undefined) refuse(sent.id, -32001, reason); resolve() }
    const request = httpRequest({ socketPath: socket, method: 'POST', path: `/${SOCKET_KEY}/${encodeURIComponent(code)}/mcp`,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...session ? { 'mcp-session-id': session } : {}, ...version ? { 'mcp-protocol-version': version } : {} } },
    answer => { relay(answer, sent).then(resolve, () => failed(UNREADABLE)) })
    request.on('error', () => failed(NOT_RUNNING))
    request.end(raw)
  })

  let first: Promise<void> | null = null
  for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
    if (!raw.trim()) continue
    let sent: Message
    try {
      sent = JSON.parse(raw) as Message
      if (!sent || typeof sent !== 'object') throw new Error('not a message')
    } catch { refuse(null, -32700, 'That line is not JSON.'); continue }
    // `initialize` alone: nothing else goes until its answer has named the session. Its notification goes in order too.
    if (first) await first
    const send = post(raw, sent)
    if (sent.method === 'initialize' || typeof sent.id === 'undefined') first = send
    running.add(send)
    void send.finally(() => { running.delete(send) })
  }
  await Promise.all(running)
}
