import { createServer } from 'node:http'

/**
 * A stand-in for the Messages API that drives the real Claude Code through a fixed list of tool calls and reads back what
 * Claude Code answered to each (lib/buddyGuard.claude.spec.ts, lib/buddyGuard.wide.claude.spec.ts).
 */
export interface Call { name: string; input: Record<string, unknown> }
export interface Result { is_error?: boolean; content: string }

/** Answers Claude Code's requests in the Messages API's streaming shape: each tool call in turn, then "done". [started]
 *  runs once, at the conversation's first request: Claude Code is up by then, and has run nothing yet. */
export function fakeModel(calls: Call[], started: () => void = () => {}) {
  const results = new Map<string, Result>()
  const bodies: string[] = []
  const startedAt: string[][] = []
  let step = 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      if (!request.url?.startsWith('/v1/messages') || request.url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return
      }
      bodies.push(body)
      const json = JSON.parse(body || '{}')
      const last = json.messages?.at(-1)
      if (!startedAt.length && Array.isArray(json.tools) && json.tools.length > 0) { startedAt.push([]); started() }
      for (const block of Array.isArray(last?.content) ? last.content : []) {
        if (block.type !== 'tool_result') continue
        const content = typeof block.content === 'string' ? block.content
          : (block.content as { text?: string }[]).map((part) => part.text ?? '').join('')
        results.set(block.tool_use_id, { is_error: block.is_error, content })
      }
      // Only the conversation itself has tools; Claude Code's own side requests (a title, a summary) get plain text.
      const main = Array.isArray(json.tools) && json.tools.length > 0
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { id: `msg_${step}`, type: 'message', role: 'assistant', model: json.model,
        content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      if (main && step < calls.length) {
        const call = calls[step++]
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step}`, name: call.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } })
      } else {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      }
      send('message_stop', { type: 'message_stop' })
      response.end()
    })
  })
  return { server, results, bodies, started: () => startedAt.length > 0, id: (call: Call) => `toolu_${calls.indexOf(call) + 1}` }
}

