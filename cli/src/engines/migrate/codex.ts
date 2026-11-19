/**
 * Ported from txcript (https://github.com/skillsynchq/txcript), Apache-2.0: src/harness/codex.rs.
 *
 * Codex's rollout (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`) read into the canonical conversation
 * and written from it. A rollout is two logs in one `{timestamp, type, payload}` envelope: `response_item` (what the
 * model sees) and `event_msg` (what the TUI and Harness's reader replay). Reading runs txcript's one stateful pass;
 * writing emits both logs so Codex can resume the session and Harness can read it.
 */
import {
  artifactText, bashTool, commandTool, editTool, isObject, isoTime, outputText, parseJsonl, parseTs, renderJsonl, rustLines, str, u64, writeTool,
  type Block, type Json, type Message, type Meta, type Role, type Tool, type ToolOutput, type Transcript, type Usage,
} from './canonical.js'

interface Line { timestamp?: string; type: string; payload: unknown }

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────

/** A whole rollout's text as its conversation; `meta.id` empty when it has no `session_meta`. */
export function readCodexRollout(text: string): Transcript {
  const lines = parseJsonl(text).filter((row): row is Line => isObject(row) && typeof row.type === 'string')
  const meta = metaFromLines(lines)
  return { meta, messages: linesToMessages(lines, meta.timestamp) }
}

function metaFromLines(lines: readonly Line[]): Meta {
  const meta: Meta = { id: '', timestamp: Date.now() }
  const first = lines.find(line => line.type === 'session_meta')
  const payload = first && isObject(first.payload) ? first.payload : null
  if (!payload) return meta
  meta.id = str(payload.id) ?? ''
  const cwd = str(payload.cwd), branch = isObject(payload.git) ? str(payload.git.branch) : undefined
  const version = str(payload.cli_version), model = str(payload.model) ?? str(payload.model_name)
  if (cwd !== undefined) meta.cwd = cwd
  if (branch !== undefined) meta.gitBranch = branch
  if (version !== undefined) meta.cliVersion = version
  if (model !== undefined) meta.model = model
  const at = parseTs(payload.timestamp)
  if (at !== undefined) meta.timestamp = at
  return meta
}

interface Queued extends Message { resultKey?: string; fallback?: boolean }

/** `lines_to_messages`: turn/model/usage backfill, web-search pairing, and dropping the duplicate
 *  `function_call_output` that shadows a canonical `exec_command_end` or `custom_tool_call_output`. */
function linesToMessages(lines: readonly Line[], fallbackTs: number): Message[] {
  const queued: Queued[] = []
  let currentTurn: string | null = null
  const turnModels = new Map<string, string>(), turnUsage = new Map<string, Usage>(), lastAssistantByTurn = new Map<string, number>()
  const canonicalResults = new Set<string>()
  // Call ids may be reused once a call completes: a result pairs with the latest occurrence of its id.
  const callOccurrences = new Map<string, number>()
  const pendingWebSearchIds = new Map<string, string[]>(), unresolvedWebSearch = new Map<string, number[]>()
  const modelNow = () => currentTurn !== null ? turnModels.get(currentTurn) : undefined
  const resultKey = (id: string) => `${id}\u0000${callOccurrences.get(id) ?? 0}`
  const push = (role: Role, content: Block[], ts: number, model?: string, extra: Partial<Queued> = {}) =>
    queued.push({ role, content, timestamp: ts, ...(model !== undefined ? { model } : {}), ...extra })
  const toolUse = (ts: number, id: string, tool: Tool) => push('assistant', [{ type: 'tool_use', id, tool }], ts, modelNow())
  const toolResult = (ts: number, id: string, content: ToolOutput, isError: boolean, fallback: boolean) =>
    push('user', [{ type: 'tool_result', toolUseId: id, content, isError }], ts, undefined, { resultKey: resultKey(id), fallback })

  for (const line of lines) {
    const ts = parseTs(line.timestamp) ?? fallbackTs
    const payload = isObject(line.payload) ? line.payload : {}
    const ptype = str(payload.type) ?? ''
    const callId = str(payload.call_id)
    if (line.type === 'response_item' && (ptype === 'function_call' || ptype === 'custom_tool_call') && callId !== undefined) {
      callOccurrences.set(callId, queued.length + 1)
    }
    if (line.type === 'turn_context') {
      currentTurn = str(payload.turn_id) ?? null
      const model = str(payload.model)
      if (currentTurn !== null && model !== undefined) turnModels.set(currentTurn, model)
    } else if (line.type === 'event_msg') {
      if (ptype === 'task_started') currentTurn = str(payload.turn_id) ?? null
      else if (ptype === 'task_complete') {
        const turn = str(payload.turn_id), index = turn !== undefined ? lastAssistantByTurn.get(turn) : undefined
        if (turn !== undefined && index !== undefined) {
          const model = turnModels.get(turn), usage = turnUsage.get(turn)
          if (model !== undefined) queued[index]!.model = model
          if (usage) queued[index]!.usage = usage
        }
      } else if (ptype === 'token_count') {
        const usage = lastTokenUsage(payload)
        if (currentTurn !== null && usage) turnUsage.set(currentTurn, usage)
      } else if (ptype === 'exec_command_end' && callId !== undefined) {
        canonicalResults.add(resultKey(callId))
        const code = payload.exit_code
        toolResult(ts, callId, { text: execOutput(payload) }, typeof code === 'number' && Number.isInteger(code) && code !== 0, false)
      } else if (ptype === 'web_search_end' && callId !== undefined) {
        const action = JSON.stringify(payload.action ?? null)
        pendingWebSearchIds.set(action, [...pendingWebSearchIds.get(action) ?? [], callId])
        const index = unresolvedWebSearch.get(action)?.pop()
        const call = index !== undefined ? queued[index]!.content[0] : undefined
        if (call?.type === 'tool_use') call.id = callId
        canonicalResults.add(resultKey(callId))
        toolResult(ts, callId, { text: webSearchResult(payload) }, false, false)
      }
    } else if (line.type === 'response_item') {
      if (ptype === 'message') {
        const role = payload.role, content = payload.content
        if (content === undefined) continue
        // Setup preludes (<environment_context> and the like) are the engine's scaffolding, not conversation.
        if (role === 'user' && !isSetupMessage(content)) {
          const blocks = contentBlocks(content)
          if (blocks.length) push('user', blocks, ts)
        } else if (role === 'assistant') {
          const blocks = contentBlocks(content)
          if (blocks.length) {
            push('assistant', blocks, ts, modelNow())
            if (currentTurn !== null) lastAssistantByTurn.set(currentTurn, queued.length - 1)
          }
        }
      } else if (ptype === 'reasoning') {
        const summary = reasoningSummary(payload)
        if (summary !== null) push('assistant', [{ type: 'thinking', text: summary }], ts, modelNow())
      } else if (ptype === 'function_call' && callId !== undefined) {
        const args = str(payload.arguments)
        toolUse(ts, callId, normalizeFunctionTool(str(payload.name) ?? 'tool', args === undefined ? {} : jsonOrRaw(args)))
      } else if (ptype === 'function_call_output' && callId !== undefined) {
        const output = payload.output
        const [content, isError] = typeof output === 'string' ? [{ text: output }, false] as const
          : Array.isArray(output) ? contentItemsOutput(output) : [{ text: '' }, false] as const
        toolResult(ts, callId, content, isError, true)
      } else if (ptype === 'custom_tool_call' && callId !== undefined) {
        const input = payload.input
        const raw = typeof input === 'string' ? jsonOrRaw(input) : input === undefined ? {} : input
        toolUse(ts, callId, normalizeCustomTool(str(payload.name) ?? 'custom_tool', raw))
      } else if (ptype === 'custom_tool_call_output' && callId !== undefined) {
        // Code mode (`exec`) writes its output as an array of `input_text` items rather than a string.
        const output = payload.output
        const [content, isError] = typeof output === 'string' ? customToolOutput(output)
          : Array.isArray(output) ? contentItemsOutput(output) : customToolOutput('')
        canonicalResults.add(resultKey(callId))
        toolResult(ts, callId, content, isError, false)
      } else if (ptype === 'web_search_call') {
        const action = payload.action ?? null, key = JSON.stringify(action)
        const id = callId ?? pendingWebSearchIds.get(key)?.pop() ?? `web_search:${queued.length}`
        toolUse(ts, id, { name: 'WebSearch', input: action })
        if (id.startsWith('web_search:')) unresolvedWebSearch.set(key, [...unresolvedWebSearch.get(key) ?? [], queued.length - 1])
      }
    }
  }
  // A fallback result is dropped only when this occurrence of its call has a canonical one.
  return queued.filter(item => !item.fallback || !item.resultKey || !canonicalResults.has(item.resultKey))
    .map(({ resultKey: _key, fallback: _fallback, ...message }) => message)
}

// ── tool names: Codex's into canonical ───────────────────────────────────────────────────────────────

function normalizeFunctionTool(name: string, input: unknown): Tool {
  return name === 'exec_command' || name === 'shell' ? normalizeShell(input) : { name, input }
}

function normalizeCustomTool(name: string, input: unknown): Tool {
  return name === 'apply_patch' ? normalizeApplyPatch(input) : { name, input }
}

function normalizeShell(input: unknown): Tool {
  if (!isObject(input)) return { name: 'Bash', input }
  const normalized: Json = {}
  const command = commandDisplay(input.cmd) ?? commandDisplay(input.command)
  if (command !== undefined) normalized.command = command
  const workdir = str(input.workdir ?? input.cwd)
  if (workdir !== undefined) normalized.workdir = workdir
  return { name: 'Bash', input: Object.keys(normalized).length ? normalized : input }
}

function commandDisplay(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts = value.flatMap(part => typeof part === 'string' ? [part] : typeof part === 'number' || typeof part === 'boolean' ? [String(part)] : [])
  if (!parts.length) return undefined
  // `bash -lc <script>` is shown as the script.
  if (parts.length >= 3 && ['bash', 'sh', 'zsh'].includes(parts[0]!) && ['-lc', '-c'].includes(parts[1]!)) return parts[2]
  return parts.join(' ')
}

/** One Add or one single-hunk Update maps onto Write or Edit; anything else stays the raw patch with its files. */
function normalizeApplyPatch(input: unknown): Tool {
  if (typeof input !== 'string') return { name: 'ApplyPatch', input }
  type Hunk = { old: string[]; new: string[] }
  type Pending = { kind: 'add'; path: string; lines: string[] } | { kind: 'update'; path: string; hunks: Hunk[]; current: Hunk | null }
  type Op = { kind: 'add'; path: string; content: string } | { kind: 'update'; path: string; old: string; new: string }
  const ops: Op[] = []
  let current: Pending | null = null
  const finish = (pending: Pending): Op | null => {
    if (pending.kind === 'add') return { kind: 'add', path: pending.path, content: pending.lines.join('\n') }
    const hunks = pending.current ? [...pending.hunks, pending.current] : pending.hunks
    return hunks.length === 1 ? { kind: 'update', path: pending.path, old: hunks[0]!.old.join('\n'), new: hunks[0]!.new.join('\n') } : null
  }
  const flush = (): boolean => {
    if (!current) return true
    const op = finish(current)
    current = null
    if (!op) return false
    ops.push(op)
    return true
  }
  let ok = true
  for (const line of rustLines(input)) {
    if (line === '*** Begin Patch' || line === '*** End Patch' || line === '*** End of File') continue
    if (line.startsWith('*** Add File: ')) { if (!flush()) { ok = false; break } current = { kind: 'add', path: line.slice(14), lines: [] }; continue }
    if (line.startsWith('*** Update File: ')) { if (!flush()) { ok = false; break } current = { kind: 'update', path: line.slice(17), hunks: [], current: null }; continue }
    // Deletes and moves have no Write or Edit.
    if (line.startsWith('*** Delete File: ') || line.startsWith('*** Move to: ')) { ok = false; break }
    const open = current as Pending | null
    if (open?.kind === 'add') { if (line.startsWith('+')) open.lines.push(line.slice(1)) }
    else if (open?.kind === 'update') {
      if (line.startsWith('@@')) { if (open.current) open.hunks.push(open.current); open.current = { old: [], new: [] } }
      else if (open.current) {
        if (line.startsWith(' ')) { open.current.old.push(line.slice(1)); open.current.new.push(line.slice(1)) }
        else if (line.startsWith('-')) open.current.old.push(line.slice(1))
        else if (line.startsWith('+')) open.current.new.push(line.slice(1))
      }
    }
  }
  if (ok) ok = flush()
  if (ok && ops.length === 1) {
    const op = ops[0]!
    return op.kind === 'add' ? { name: 'Write', input: { file_path: op.path, content: op.content } }
      : { name: 'Edit', input: { file_path: op.path, old_string: op.old, new_string: op.new } }
  }
  const files = rustLines(input).flatMap(line => {
    for (const prefix of ['*** Update File: ', '*** Add File: ', '*** Delete File: ']) if (line.startsWith(prefix)) return [line.slice(prefix.length)]
    return []
  })
  return { name: 'ApplyPatch', input: { patch: input, files } }
}

// ── payloads ─────────────────────────────────────────────────────────────────────────────────────────

function contentBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return []
  const blocks: Block[] = []
  for (const entry of content) {
    if (!isObject(entry)) continue
    if ((entry.type === 'input_text' || entry.type === 'output_text') && typeof entry.text === 'string' && entry.text) blocks.push({ type: 'text', text: entry.text })
    else if (entry.type === 'input_image' && typeof entry.image_url === 'string') {
      const image = dataUrlImage(entry.image_url)
      if (image) blocks.push(image)
    }
  }
  return blocks
}

function dataUrlImage(url: string): Block | null {
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const header = url.slice(0, comma)
  if (!header.startsWith('data:') || !header.endsWith(';base64')) return null
  return { type: 'image', sourceType: 'base64', mediaType: header.slice(5, -7), data: url.slice(comma + 1) }
}

const SETUP_PREFIXES = ['<environment_context>', '<permissions instructions>', '<collaboration_mode>', '<sandbox_mode>', '<approval_policy>']
function isSetupMessage(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0 && content.every(entry => isObject(entry)
    && (entry.type === 'input_text' || entry.type === 'output_text') && typeof entry.text === 'string'
    && SETUP_PREFIXES.some(prefix => (entry.text as string).trimStart().startsWith(prefix)))
}

function reasoningSummary(payload: Json): string | null {
  if (!Array.isArray(payload.summary)) return null
  const parts = payload.summary.flatMap(entry => isObject(entry) && entry.type === 'summary_text' && typeof entry.text === 'string' ? [entry.text] : [])
  return parts.length ? parts.join('\n\n') : null
}

function lastTokenUsage(payload: Json): Usage | undefined {
  const usage = isObject(payload.info) && isObject(payload.info.last_token_usage) ? payload.info.last_token_usage : null
  if (!usage) return undefined
  const input = u64(usage.input_tokens), output = u64(usage.output_tokens), cached = u64(usage.cached_input_tokens)
  if (input === undefined || output === undefined) return undefined
  return { input_tokens: input, output_tokens: output, ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}) }
}

function execOutput(payload: Json): string {
  if (typeof payload.aggregated_output === 'string') return payload.aggregated_output
  const stdout = str(payload.stdout) ?? '', stderr = str(payload.stderr) ?? ''
  return stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr
}

/** A content-item list with its error bit: only code mode's `Script failed` header says a call failed. */
function contentItemsOutput(items: readonly unknown[]): readonly [ToolOutput, boolean] {
  const first = items[0]
  const isError = isObject(first) && first.type === 'input_text' && typeof first.text === 'string' && failedScriptHeader(first.text)
  const texts = items.map(item => isObject(item) && ['input_text', 'output_text', 'text'].includes(String(item.type)) && typeof item.text === 'string' ? item.text : null)
  if (texts.some(text => text === null)) return [{ json: [...items] }, isError]
  let out = ''
  for (const text of texts as string[]) {
    if (out && !out.endsWith('\n')) out += '\n'
    out += text
  }
  return [{ text: out }, isError]
}

function failedScriptHeader(text: string): boolean {
  if (!text.startsWith('Script failed\nWall time ') || !text.endsWith('\nOutput:\n')) return false
  const timing = text.slice('Script failed\nWall time '.length, -'\nOutput:\n'.length)
  return !timing.includes('\n') && timing.includes(' seconds')
}

function customToolOutput(raw: string): readonly [ToolOutput, boolean] {
  const value = jsonOrRaw(raw)
  if (isObject(value)) {
    const output = value.output
    const content: ToolOutput = typeof output === 'string' ? { text: output } : output === undefined ? { text: raw } : { json: output }
    const code = isObject(value.metadata) ? value.metadata.exit_code : undefined
    return [content, typeof code === 'number' && Number.isInteger(code) && code !== 0]
  }
  return [typeof value === 'string' ? { text: value } : { json: value }, false]
}

function webSearchResult(payload: Json): string {
  const action = isObject(payload.action) ? payload.action : null
  const query = str(payload.query) ?? ''
  if (action?.type === 'search') {
    const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === 'string').join('\n') : ''
    return queries || query
  }
  if (action?.type === 'open_page') return str(action.url) ?? query
  if (action?.type === 'find_in_page') {
    const pattern = str(action.pattern) ?? '', url = str(action.url) ?? query
    return !pattern ? url : !url ? pattern : `Find \`${pattern}\` in ${url}`
  }
  return JSON.stringify(payload.action ?? null)
}

function jsonOrRaw(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

// ── writing ──────────────────────────────────────────────────────────────────────────────────────────

const line = (at: string, type: string, payload: unknown): Line => ({ timestamp: at, type, payload })

/** The rollout Codex resumes for `transcript`. */
export function writeCodexRollout(transcript: Transcript): string {
  return renderJsonl(messagesToLines(transcript.meta, transcript.messages))
}

function messagesToLines(meta: Meta, messages: readonly Message[]): Line[] {
  // Codex needs `model_provider` and `base_instructions` present or resume silently starts a fresh session.
  // `base_instructions` may be null (Codex uses its defaults); a null provider fails resume with "Model provider ``
  // not found", and Codex's own rollouts say "openai". `source: cli` is also what Harness adopts as a terminal's
  // conversation (engines/codex/adoption.ts).
  const sessionMeta: Json = {
    id: meta.id, timestamp: isoTime(meta.timestamp), cwd: meta.cwd ?? '', originator: 'codex_cli_rs',
    cli_version: meta.cliVersion ?? '', source: 'cli', model_provider: 'openai', base_instructions: null,
    ...(meta.gitBranch !== undefined ? { git: { branch: meta.gitBranch } } : {}),
  }
  const lines: Line[] = [line(isoTime(meta.timestamp), 'session_meta', sessionMeta)]
  // Only a pending patch call takes a custom-tool result; a completed id may be reused by another tool later.
  const pendingPatches = new Set<string>()
  // A slash command the person ran at Claude Code (`/model`, `/effort`) drove that engine, and Codex has no tool for
  // it: written as a `_model` call, every Change agent showed a row per command (Pixel 8 Pro, 2026-11-19). It and
  // what it printed are left out.
  const commands = new Set<string>()
  messages = messages.map(message => ({ ...message, content: message.content.filter(block => {
    if (block.type === 'tool_use' && commandTool(block.tool)) { commands.add(block.id); return false }
    return !(block.type === 'tool_result' && commands.has(block.toolUseId))
  }) })).filter(message => message.content.length > 0)
  messages.forEach((message, i) => {
    const at = isoTime(message.timestamp)
    // A turn boundary carries the model and frames the usage backfill.
    const turnId = `turn-${i}`
    if (message.role === 'assistant') lines.push(line(at, 'turn_context', { turn_id: turnId, ...(message.model !== undefined ? { model: message.model } : {}) }))
    pushMessageLines(lines, message, at, pendingPatches)
    if (message.role === 'assistant' && message.usage) {
      const usage = message.usage
      lines.push(line(at, 'event_msg', { type: 'token_count', info: { last_token_usage: {
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cached_input_tokens: usage.cache_read_input_tokens ?? 0 } } }))
      lines.push(line(at, 'event_msg', { type: 'task_complete', turn_id: turnId }))
    }
  })
  return lines
}

function pushMessageLines(lines: Line[], message: Message, at: string, pendingPatches: Set<string>): void {
  const textType = message.role === 'assistant' ? 'output_text' : 'input_text'
  let content: Json[] = [], texts: string[] = []
  const flush = () => {
    if (!content.length) return
    lines.push(line(at, 'response_item', { type: 'message', role: message.role, content }))
    if (texts.length) {
      const combined = texts.join('\n\n')
      lines.push(line(at, 'event_msg', message.role === 'user' ? { type: 'user_message', message: combined, kind: 'plain' } : { type: 'agent_message', message: combined }))
    }
    content = []; texts = []
  }
  for (const block of message.content) {
    if (block.type === 'text') { content.push({ type: textType, text: block.text }); texts.push(block.text) }
    else if (block.type === 'image') content.push({ type: 'input_image', image_url: `data:${block.mediaType};${block.sourceType},${block.data}` })
    else if (block.type === 'artifact') { const text = artifactText(block.artifact); content.push({ type: textType, text }); texts.push(text) }
    else if (block.type === 'thinking') {
      flush()
      lines.push(line(at, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: block.text }], encrypted_content: null }))
      lines.push(line(at, 'event_msg', { type: 'agent_reasoning', text: block.text }))
    } else if (block.type === 'tool_use') {
      flush()
      if (isPatchTool(block.tool)) pendingPatches.add(block.id)
      else pendingPatches.delete(block.id)
      pushToolUse(lines, at, block.id, block.tool)
    } else {
      flush()
      const patch = pendingPatches.delete(block.toolUseId)
      lines.push(line(at, 'response_item', patch
        ? { type: 'custom_tool_call_output', call_id: block.toolUseId, output: patchOutput(block.content, block.isError) }
        : { type: 'function_call_output', call_id: block.toolUseId, output: outputText(block.content) }))
    }
  }
  flush()
}

/** `exec_command` for a shell, `apply_patch` for edits; any other tool keeps its canonical name and arguments. */
function pushToolUse(lines: Line[], at: string, id: string, tool: Tool): void {
  const bash = bashTool(tool), edit = editTool(tool), write = writeTool(tool)
  if (bash) {
    // `exec_command` takes `cmd` and `workdir`; Bash's timeout, description and background have no slot.
    lines.push(line(at, 'response_item', { type: 'function_call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: bash.command, ...(bash.workdir !== undefined ? { workdir: bash.workdir } : {}) }), call_id: id }))
  } else if (edit) {
    pushCustomToolCall(lines, at, id, ['*** Begin Patch', `*** Update File: ${edit.filePath}`, '@@',
      ...rustLines(edit.oldString).map(l => `-${l}`), ...rustLines(edit.newString).map(l => `+${l}`), '*** End Patch'].join('\n'))
  } else if (write) {
    pushCustomToolCall(lines, at, id, ['*** Begin Patch', `*** Add File: ${write.filePath}`, ...rustLines(write.content).map(l => `+${l}`), '*** End Patch'].join('\n'))
  } else if (tool.name === 'ApplyPatch') {
    // The raw patch read back as `{patch, files}`: Codex sees the string it wrote.
    const input = tool.input
    const patch = isObject(input) && typeof input.patch === 'string' ? input.patch : typeof input === 'string' ? input : JSON.stringify(input)
    pushCustomToolCall(lines, at, id, patch)
  } else {
    lines.push(line(at, 'response_item', { type: 'function_call', name: openaiToolName(tool.name), arguments: JSON.stringify(tool.input ?? null), call_id: id }))
  }
}

const isPatchTool = (tool: Tool): boolean => !!editTool(tool) || !!writeTool(tool) || tool.name === 'ApplyPatch'

function pushCustomToolCall(lines: Line[], at: string, id: string, input: string): void {
  lines.push(line(at, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: id, name: 'apply_patch', input }))
}

/** Codex's `custom_tool_call_output` envelope: the payload in `output`, the error bit as `exit_code`. */
function patchOutput(content: ToolOutput, isError: boolean): string {
  return JSON.stringify({ output: 'text' in content ? content.text : content.json, metadata: { exit_code: isError ? 1 : 0, duration_seconds: 0.0 } })
}

/** OpenAI validates replayed function names as `[A-Za-z0-9_-]+`. */
function openaiToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'
}
