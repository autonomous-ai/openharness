/**
 * Reads what `claude -p --output-format stream-json --verbose` prints into the run the grader and the report use:
 * the final answer, the turns in the report's `Turn` shape, the served model and the token usage.
 */

export interface Turn { role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result'; content: string; name?: string; thinking?: string }
export interface Usage {
  input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number
  // The cache writes by how long the cache keeps them, which bill at different rates.
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }
}
export interface RunResult {
  answer: string
  transcript: Turn[]
  model: string | null
  usage: Usage
  stop_reason: string | null
  status: 'ok' | 'truncated'
  tool_calls: number
  limited: boolean
}

/** The words Claude Code ends a run with when the account's subscription or rate limit stops it. */
const LIMIT = /usage limit|rate.?limit|hit your limit/i

/** Whether a `result` event, from stream-json or json output alike, is Claude Code stopped by the account limit. */
export function limitedBy(result: Record<string, unknown>): boolean {
  return result.is_error === true && typeof result.result === 'string' && LIMIT.test(result.result)
}

const SYNTHETIC = '<synthetic>'

interface Block { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }

export function parseClaudeStream(jsonl: string): RunResult {
  const run: RunResult = { answer: '', transcript: [], model: null, usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: null, status: 'ok', tool_calls: 0, limited: false }
  const toolNames = new Map<string, string>()
  // The models that answered the main thread, in order: init echoes --model, not what served it, and a subagent may
  // run on another model by design. Claude Code gives its own messages (an API error, the account limit) the model
  // '<synthetic>': no model served them.
  const served = new Set<string>()
  // The report shows thinking folded into the turn it led to, so it waits for that turn.
  let thinking: string | undefined
  const push = (turn: Turn): void => {
    if (thinking !== undefined) turn.thinking = thinking
    thinking = undefined
    run.transcript.push(turn)
  }

  for (const event of events(jsonl)) {
    if (event.type === 'assistant' || event.type === 'user') {
      const message = event.message as { content?: unknown; model?: unknown } | undefined
      if (event.type === 'assistant' && event.parent_tool_use_id === null && typeof message?.model === 'string' && message.model !== SYNTHETIC) served.add(message.model)
      const content = message?.content
      const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
      for (const block of blocks) {
        if (block.type === 'thinking') {
          // Unless asked to show it, Claude Code prints thinking with empty text: nothing to fold into a turn.
          if (block.thinking) thinking = thinking === undefined ? block.thinking : `${thinking}\n\n${block.thinking}`
        } else if (block.type === 'text') push({ role: event.type, content: block.text ?? '' })
        else if (block.type === 'tool_use') {
          toolNames.set(block.id ?? '', block.name ?? '')
          push({ role: 'tool_call', name: block.name ?? '', content: JSON.stringify(block.input ?? {}, null, 2) })
          run.tool_calls++
        } else if (block.type === 'tool_result') push({ role: 'tool_result', name: toolNames.get(block.tool_use_id ?? '') ?? '', content: resultText(block.content) })
      }
    } else if (event.type === 'result') {
      run.answer = typeof event.result === 'string' ? event.result : ''
      run.usage = usageOf(event.usage)
      run.stop_reason = typeof event.stop_reason === 'string' ? event.stop_reason : null
      if (event.subtype === 'error_max_turns') run.status = 'truncated'
      run.limited ||= limitedBy(event)
    } else if (event.type === 'rate_limit_event') {
      // Only the run's own status: overage may be refused while the plan still allows the run.
      if ((event.rate_limit_info as { status?: unknown } | undefined)?.status === 'rejected') run.limited = true
    }
  }
  // Thinking with no turn after it still belongs in the transcript.
  if (thinking !== undefined) push({ role: 'assistant', content: '' })
  // More than one is named so that no check of the model's prefix accepts it.
  run.model = served.size > 1 ? `mixed: ${[...served].join(', ')}` : served.values().next().value ?? null
  return run
}

/** One parsed event per line. The last line may be torn when the process was killed mid-write, so it is dropped; a
 *  broken line before it means the stream is not what the parser expects, and that must be seen. */
function events(jsonl: string): Record<string, unknown>[] {
  const lines = jsonl.split('\n').filter((line) => line.trim() !== '')
  const out: Record<string, unknown>[] = []
  lines.forEach((line, i) => {
    try {
      out.push(JSON.parse(line))
    } catch (err) {
      if (i < lines.length - 1) throw new Error(`claude stream-json line ${i + 1} is not JSON: ${(err as Error).message}`)
    }
  })
  return out
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part: Block) => (part.type === 'text' ? part.text ?? '' : `[${part.type}]`)).join('\n')
}

/** The token counts of a `usage` object, from stream-json and json output alike. */
export function usageOf(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>
  const n = (key: string): number => (typeof u[key] === 'number' ? u[key] : 0)
  const usage: Usage = { input_tokens: n('input_tokens'), output_tokens: n('output_tokens') }
  if (typeof u.cache_read_input_tokens === 'number') usage.cache_read_input_tokens = u.cache_read_input_tokens
  if (typeof u.cache_creation_input_tokens === 'number') usage.cache_creation_input_tokens = u.cache_creation_input_tokens
  const split = (u.cache_creation ?? {}) as Record<string, unknown>
  if (typeof split.ephemeral_5m_input_tokens === 'number' && typeof split.ephemeral_1h_input_tokens === 'number') {
    usage.cache_creation = { ephemeral_5m_input_tokens: split.ephemeral_5m_input_tokens, ephemeral_1h_input_tokens: split.ephemeral_1h_input_tokens }
  }
  return usage
}

/** The token counts of several calls together, cache writes kept apart by how long the cache keeps them. */
export function sumUsage(usages: Usage[]): Usage {
  const total: Usage = { input_tokens: 0, output_tokens: 0 }
  for (const u of usages) {
    total.input_tokens += u.input_tokens
    total.output_tokens += u.output_tokens
    if (u.cache_read_input_tokens !== undefined) total.cache_read_input_tokens = (total.cache_read_input_tokens ?? 0) + u.cache_read_input_tokens
    if (u.cache_creation_input_tokens !== undefined) total.cache_creation_input_tokens = (total.cache_creation_input_tokens ?? 0) + u.cache_creation_input_tokens
    if (u.cache_creation !== undefined) {
      const t = total.cache_creation ?? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
      total.cache_creation = {
        ephemeral_5m_input_tokens: t.ephemeral_5m_input_tokens + u.cache_creation.ephemeral_5m_input_tokens,
        ephemeral_1h_input_tokens: t.ephemeral_1h_input_tokens + u.cache_creation.ephemeral_1h_input_tokens,
      }
    }
  }
  return total
}
