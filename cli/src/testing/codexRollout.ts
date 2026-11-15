/**
 * A long Codex rollout for the specs and the end-to-end suite that measure a resume of one
 * (core/agents/launch.loop.spec.ts, e2e/resumeRepair.e2e.ts): what Codex writes, at length.
 */
import { closeSync, openSync, writeSync } from 'node:fs'

const record = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-11-15T08:00:00.000Z', type, payload }) + '\n'

/** Codex's first record, naming its session. */
export const codexSessionMeta = (id: string) => record('session_meta', { id, cwd: '/workspace', model_provider: 'openai' })

/**
 * About [bytes] appended to [file] as Codex writes a long conversation: messages, tool calls and their output, encrypted
 * reasoning, a 1.5 MB screenshot now and then, and last a relay's reasoning item with an id of its own, which a resume
 * must repair (engines/kit/resumeRepair.ts).
 */
export function appendCodexHistory(file: string, bytes: number): void {
  const fd = openSync(file, 'a')
  let written = 0
  const write = (line: string) => { written += writeSync(fd, line) }
  try {
    for (let i = 1; written < bytes; i++) {
      const kind = i % 10
      if (kind < 4) write(record('response_item', { type: 'message', role: kind % 2 ? 'user' : 'assistant', content: [{ type: 'output_text', text: 'word '.repeat(200 + i % 900) }] }))
      else if (kind < 6) write(record('response_item', { type: 'reasoning', id: `rs_${i}`, summary: [{ type: 'summary_text', text: 'thinking '.repeat(50) }], encrypted_content: 'g'.repeat(2000 + i % 3000) }))
      else if (kind < 8) write(record('response_item', { type: 'function_call_output', call_id: `call_${i}`, output: 'out\n'.repeat(500 + i % 5000) }))
      else if (kind === 8) write(record('event_msg', { type: 'token_count', info: { total: i } }))
      else write(record('response_item', { type: 'function_call', call_id: `call_${i}`, name: 'exec', arguments: JSON.stringify({ cmd: 'ls '.repeat(100) }) }))
      if (i % 4000 === 0) write(record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(1_500_000)}` }] }))
    }
    write(record('response_item', { type: 'reasoning', id: 'msg_relay', summary: [{ type: 'summary_text', text: 'Prior summary.' }], content: [] }))
  } finally { closeSync(fd) }
}
