/**
 * Ported from txcript (https://github.com/skillsynchq/txcript), Apache-2.0: src/harness/claude_code.rs.
 *
 * Claude Code's transcript (`<projects>/<encoded cwd>/<session>.jsonl`) read into the canonical conversation and
 * written from it. Its lines already carry the Anthropic Messages shape, so this is close to the identity. Where this
 * differs from txcript it says why: each difference is what Claude Code or Harness needs to resume or adopt the file.
 */
import {
  commandTool, isObject, isoTime, parseJsonl, parseTs, renderJsonl, str, u64, uuidV5,
  type Block, type Json, type Message, type Meta, type ToolOutput, type Transcript, type Usage,
} from './canonical.js'

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────

/** A whole transcript's text as its conversation; `meta.id` empty when no line names the session. */
export function readClaudeTranscript(text: string): Transcript {
  const records = parseJsonl(text).filter(isObject)
  const meta = metaFromRecords(records)
  return { meta, messages: recordsToMessages(records, meta.timestamp) }
}

/** `records_to_messages`. */
function recordsToMessages(records: readonly Json[], fallbackTs: number): Message[] {
  const messages: Message[] = []
  // The uuid of the slash command still awaiting its output, so the `local_command` line after it pairs to it.
  const open: { command: string | null } = { command: null }
  for (const record of records) {
    const type = record.type
    if (type === 'summary') continue
    const entry = type === 'user' || type === 'assistant' ? entryOf(record) : null
    if (!entry) {
      // Newer CLIs write slash-command envelopes on `system` lines with no message wrapper.
      const message = systemLineMessage(record, fallbackTs, open)
      if (message) messages.push(message)
      continue
    }
    // The file still holds the history a compaction summary condenses, so the summary would repeat it (#100).
    if (type === 'user' && record.isCompactSummary === true) continue
    const body = envelopeBody(entry.message.content)
    const envelope = body === null ? null : parseEnvelope(body)
    const content = envelope ? envelopeBlocks(envelope, entry.uuid, str(record.parentUuid) ?? null, open) : parseBlocks(entry.message.content)
    if (!content.length) continue
    const model = str(entry.message.model), stop = str(entry.message.stop_reason), usage = parseUsage(entry.message.usage)
    messages.push({
      role: type === 'user' ? 'user' : 'assistant', content, timestamp: parseTs(record.timestamp) ?? fallbackTs,
      ...(model !== undefined ? { model } : {}), ...(stop !== undefined ? { stopReason: stop } : {}), ...(usage ? { usage } : {}),
    })
  }
  return messages
}

/** A user/assistant line as txcript's `EntryLine` reads it: a `uuid` and a `message` with `content`, or not one. */
function entryOf(record: Json): { uuid: string; message: Json } | null {
  const uuid = str(record.uuid), message = record.message
  if (uuid === undefined || !isObject(message) || !Object.hasOwn(message, 'content')) return null
  return { uuid, message }
}

/** `meta_from_records`: the first line naming each field, the earliest time as the start. */
function metaFromRecords(records: readonly Json[]): Meta {
  const meta: Meta = { id: '', timestamp: Date.now() }
  let summary: string | undefined, customTitle: string | undefined, earliest: number | undefined
  for (const record of records) {
    const type = record.type
    if ((type === 'user' || type === 'assistant') && entryOf(record)) {
      if (type === 'user') {
        if (!meta.id && str(record.sessionId)) meta.id = str(record.sessionId)!
        meta.cwd ??= str(record.cwd)
        meta.gitBranch ??= str(record.gitBranch)
        meta.cliVersion ??= str(record.version)
      } else {
        meta.model ??= str((record.message as Json).model)
      }
      const at = parseTs(record.timestamp)
      if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at
    } else if (type === 'summary') {
      summary ??= str(record.summary)
    } else if (type === 'custom-title') {
      customTitle = str(record.customTitle)
    } else if (type === 'agent-name' && customTitle === undefined) {
      customTitle = str(record.agentName)
    }
  }
  if (earliest !== undefined) meta.timestamp = earliest
  const title = customTitle ?? summary
  if (title !== undefined) meta.title = title
  for (const key of ['cwd', 'gitBranch', 'cliVersion', 'model'] as const) if (meta[key] === undefined) delete meta[key]
  return meta
}

function parseBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.map(parseBlock).filter((block): block is Block => block !== null)
}

function parseBlock(value: unknown): Block | null {
  if (!isObject(value)) return null
  switch (value.type) {
    case 'text': return typeof value.text === 'string' ? { type: 'text', text: value.text } : null
    case 'thinking': {
      if (typeof value.thinking !== 'string') return null
      const signature = str(value.signature)
      return { type: 'thinking', text: value.thinking, ...(signature !== undefined ? { signature } : {}) }
    }
    case 'tool_use': {
      const id = str(value.id), name = str(value.name)
      if (id === undefined || name === undefined) return null
      const input = Object.hasOwn(value, 'input') ? value.input : {}
      if (name === 'Artifact') {
        const path = isObject(input) ? str(input.file_path) : undefined
        if (path === undefined) return null
        const described = isObject(input) ? str(input.description) : undefined
        const artifactName = described?.trim() ? described : path.split(/[/\\]/).pop() || 'artifact'
        return { type: 'artifact', artifact: { id, name: artifactName, source: { type: 'path', path } } }
      }
      return { type: 'tool_use', id, tool: { name, input } }
    }
    case 'tool_result': {
      const id = str(value.tool_use_id)
      if (id === undefined) return null
      const content: ToolOutput = typeof value.content === 'string' ? { text: value.content }
        : value.content === undefined ? { text: '' } : { json: value.content }
      return { type: 'tool_result', toolUseId: id, content, isError: value.is_error === true }
    }
    case 'image': {
      const source = value.source
      if (!isObject(source) || typeof source.media_type !== 'string' || typeof source.data !== 'string') return null
      return { type: 'image', sourceType: str(source.type) ?? 'base64', mediaType: source.media_type, data: source.data }
    }
    case 'document': {
      const source = value.source
      if (!isObject(source) || typeof source.type !== 'string' || typeof source.data !== 'string') return null
      const mediaType = str(source.media_type)
      const media = mediaType !== undefined ? { mediaType } : {}
      return { type: 'artifact', artifact: { id: str(value.id) ?? '', name: str(value.title) ?? 'document',
        source: source.type === 'text' ? { type: 'text', text: source.data, ...media } : { type: 'base64', data: source.data, ...media } } }
    }
    // Block types the canonical model does not carry.
    default: return null
  }
}

function parseUsage(value: unknown): Usage | undefined {
  if (!isObject(value)) return undefined
  const input = u64(value.input_tokens), output = u64(value.output_tokens)
  if (input === undefined || output === undefined) return undefined
  const read = u64(value.cache_read_input_tokens), creation = u64(value.cache_creation_input_tokens)
  return { input_tokens: input, output_tokens: output, ...(read !== undefined ? { cache_read_input_tokens: read } : {}),
    ...(creation !== undefined ? { cache_creation_input_tokens: creation } : {}) }
}

// ── local command envelopes ──────────────────────────────────────────────────────────────────────────
//
// Claude Code records the person driving the engine (a slash command and what it printed) as XML-ish tags filling a
// message body: on a `user` line in older CLIs, on a `system` `local_command` line in newer ones.

type Envelope = { kind: 'command'; command: string; args?: string } | { kind: 'stdout'; text: string } | { kind: 'caveat' }

const ENVELOPE_TAGS = ['command-name', 'command-message', 'command-args', 'local-command-stdout', 'local-command-caveat']

function envelopeBlocks(envelope: Envelope, uuid: string, parent: string | null, open: { command: string | null }): Block[] {
  if (envelope.kind === 'command') {
    open.command = uuid
    return [{ type: 'tool_use', id: uuid, tool: { name: envelope.command, input: envelope.args !== undefined ? { args: envelope.args } : {} } }]
  }
  if (envelope.kind === 'stdout') {
    // Output whose parent is not the open command (a `!` run) stands alone under its own id.
    const paired = parent !== null && parent === open.command ? parent : null
    open.command = null
    return [{ type: 'tool_result', toolUseId: paired ?? uuid, content: { text: envelope.text }, isError: false }]
  }
  return []
}

/** A body that could be an envelope: a bare string, or a lone text block. */
function envelopeBody(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content) && content.length === 1 && isObject(content[0]) && content[0].type === 'text') return str(content[0].text) ?? null
  return null
}

/** A body that is entirely local-command markup, or null: one that merely quotes the tags stays text. */
function parseEnvelope(text: string): Envelope | null {
  const tags = envelopeTags(text)
  if (!tags) return null
  const tag = (name: string) => tags.find(([t]) => t === name)?.[1]
  const name = tag('command-name')
  if (name !== undefined) {
    if (!tags.every(([t]) => t === 'command-name' || t === 'command-message' || t === 'command-args')) return null
    const command = unescapeEnvelope(name.trim())
    if (!command) return null
    const args = tag('command-args')?.trim()
    return { kind: 'command', command: command.startsWith('/') ? command : `/${command}`, ...(args ? { args: unescapeEnvelope(args) } : {}) }
  }
  if (tags.length === 1 && tags[0]![0] === 'local-command-stdout') return { kind: 'stdout', text: stripAnsi(unescapeEnvelope(tags[0]![1])) }
  if (tags.length === 1 && tags[0]![0] === 'local-command-caveat') return { kind: 'caveat' }
  return null
}

/** `<tag>…</tag>` sections, order-free, or null when anything but whitespace is outside them. */
function envelopeTags(text: string): Array<[string, string]> | null {
  const tags: Array<[string, string]> = []
  let rest = text.trim()
  while (rest) {
    if (!rest.startsWith('<')) return null
    const close = rest.indexOf('>')
    if (close < 0) return null
    const name = rest.slice(1, close)
    if (!/^[a-z-]+$/.test(name)) return null
    const end = rest.indexOf(`</${name}>`, close + 1)
    if (end < 0) return null
    tags.push([name, rest.slice(close + 1, end)])
    rest = rest.slice(end + name.length + 3).trimStart()
  }
  return tags.length ? tags : null
}

/** The markup has no quoting: written, every close tag gains a backslash (`</tag>` → `<\/tag>`), read, it loses one. */
function shiftEnvelopeEscapes(text: string, add: boolean): string {
  return text.replace(new RegExp(`<(\\\\*)/(${ENVELOPE_TAGS.join('|')})>`, 'g'), (_whole, slashes: string, tag: string) =>
    `<${'\\'.repeat(add ? slashes.length + 1 : Math.max(0, slashes.length - 1))}/${tag}>`)
}
const escapeEnvelope = (text: string) => shiftEnvelopeEscapes(text, true)
const unescapeEnvelope = (text: string) => shiftEnvelopeEscapes(text, false)

/** ANSI escapes out of a command's output: `/context` draws in colour. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]?|\][^\x07]*?(?:\x07|\x1b\\|$)|[\s\S]?)/g, '')
}

function systemLineMessage(record: Json, fallbackTs: number, open: { command: string | null }): Message | null {
  if (record.type !== 'system') return null
  const uuid = str(record.uuid), content = str(record.content)
  if (uuid === undefined || content === undefined) return null
  const envelope = parseEnvelope(content)
  if (!envelope) return null
  const blocks = envelopeBlocks(envelope, uuid, str(record.parentUuid) ?? null, open)
  return blocks.length ? { role: 'user', content: blocks, timestamp: parseTs(record.timestamp) ?? fallbackTs } : null
}

// ── writing ──────────────────────────────────────────────────────────────────────────────────────────

const ENTRY_NAMESPACE = '9f0d9836-9ee7-4c62-83b4-fb8e01365c9f'
const entryUuid = (sessionId: string, index: number) => uuidV5(ENTRY_NAMESPACE, `${sessionId}:${index}`)

/** Anthropic's tool ids are `[A-Za-z0-9_-]+`. Codex's fallback web-search id (`web_search:3`) is not, and one bad id
 *  fails the whole resumed conversation, so ids are made safe the same way on a call and on its result. */
const safeToolId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool'

/** The transcript Claude Code resumes for `transcript`: `meta.id` is the `sessionId` on every line. */
export function writeClaudeTranscript(transcript: Transcript): string {
  return renderJsonl(messagesToRecords(transcript.meta, transcript.messages))
}

/** `messages_to_records`: one line per message, a linear `parentUuid` chain, a leading summary for a title. */
function messagesToRecords(meta: Meta, input: readonly Message[]): Json[] {
  const messages = lowerArtifacts(input)
  const sessionId = meta.id
  const records: Json[] = []
  const commandIds = new Set<string>()
  // A result naming no call in this transcript cannot replay as a `tool_result` (the API rejects an id it never
  // issued), so it takes the `local_command` line, which keeps the text and still loads.
  const called = new Set(messages.flatMap(message => message.content.flatMap(block => block.type === 'tool_use' ? [block.id] : [])))
  const responseIds = responseMessageIds(sessionId, messages)
  let parent: string | null = null
  messages.forEach((message, i) => {
    const uuid = entryUuid(sessionId, i)
    const envelope = message.role === 'user' ? localCommandRecord(message, commandIds, called, uuid, parent, meta) : null
    if (envelope) { records.push(envelope); parent = uuid; return }
    const content = serializeBlocks(message.content)
    // Anthropic's API refuses a message with no content; one made only of reasoning it could not replay is left out.
    if (!content.length) return
    const api: Json = { role: message.role, content,
      ...(message.model !== undefined ? { model: message.model } : {}),
      ...(message.stopReason !== undefined ? { stop_reason: message.stopReason } : {}),
      ...(message.usage ? { usage: message.usage } : {}),
      ...(responseIds[i] ? { id: responseIds[i] } : {}) }
    records.push({ ...envelopeFields(meta, uuid, parent, message.timestamp), type: message.role, message: api })
    parent = uuid
  })
  // A summary's `leafUuid` must name a real user/assistant line, or Claude Code reads the whole session as missing
  // ("No conversation found with session ID"); a `local_command` line is not a leaf.
  const leaf = [...records].reverse().find(record => record.type === 'user' || record.type === 'assistant')
  if (meta.title && leaf) records.unshift({ type: 'summary', summary: meta.title, leafUuid: leaf.uuid })
  return records
}

/**
 * The envelope of a user/assistant line. Beyond txcript's fields, `isSidechain`, `userType` and `entrypoint` are
 * what Claude Code's own CLI writes on every line: Harness adopts a conversation only from a line that names its
 * `entrypoint` (`cli`, a terminal: engines/claude/adoption.ts), and a resume through `agent_create`'s
 * `resumeSessionId` is that adoption.
 */
function envelopeFields(meta: Meta, uuid: string, parent: string | null, at: number): Json {
  return {
    parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'cli',
    ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}), sessionId: meta.id,
    ...(meta.cliVersion !== undefined ? { version: meta.cliVersion } : {}),
    ...(meta.gitBranch !== undefined ? { gitBranch: meta.gitBranch } : {}),
    timestamp: isoTime(at), uuid,
  }
}

/**
 * The `message.id` assistant lines of one response share. Claude Code merges consecutive assistant lines with one id
 * back into one API message on resume; a parallel call batch written without it replays each call as its own message,
 * the first no longer followed by its result, which Claude Code then swaps for "[Tool result missing due to internal
 * error]". So a run of assistant messages with a call before its last shares an id; every other line has none.
 */
function responseMessageIds(sessionId: string, messages: readonly Message[]): Array<string | undefined> {
  const ids: Array<string | undefined> = new Array(messages.length).fill(undefined)
  let start = 0
  while (start < messages.length) {
    let end = start + 1
    if (messages[start]!.role === 'assistant') {
      while (end < messages.length && messages[end]!.role === 'assistant') end += 1
      if (messages.slice(start, end - 1).some(message => message.content.some(block => block.type === 'tool_use'))) {
        ids.fill(`msg_${entryUuid(sessionId, start).replace(/-/g, '')}`, start, end)
      }
    }
    start = end
  }
  return ids
}

/** A path artifact goes back as Claude Code's own `Artifact` tool call and its result. */
function lowerArtifacts(messages: readonly Message[]): Message[] {
  const out: Message[] = []
  for (const original of messages) {
    const results: Block[] = []
    const content = original.content.map((block): Block => {
      if (original.role !== 'assistant' || block.type !== 'artifact' || block.artifact.source.type !== 'path') return block
      const { id, name, source } = block.artifact
      results.push({ type: 'tool_result', toolUseId: id, content: { text: `Artifact available locally at ${source.path}` }, isError: false })
      return { type: 'tool_use', id, tool: { name: 'Artifact', input: { file_path: source.path, description: name } } }
    })
    out.push(results.length ? { ...original, content, stopReason: 'tool_use' } : { ...original, content })
    if (results.length) out.push({ role: 'user', content: results, timestamp: original.timestamp })
  }
  return out
}

/** A user turn that is exactly one local-command block, as its native envelope line; null for conversation. */
function localCommandRecord(message: Message, commandIds: Set<string>, called: Set<string>, uuid: string, parent: string | null, meta: Meta): Json | null {
  if (message.content.length !== 1) return null
  const block = message.content[0]!
  const fields = envelopeFields(meta, uuid, parent, message.timestamp)
  if (block.type === 'tool_use') {
    const command = commandTool(block.tool)
    if (!command) return null
    commandIds.add(block.id)
    const name = escapeEnvelope(command.command), short = escapeEnvelope(command.command.replace(/^\/+/, ''))
    const body = command.args !== undefined
      ? `<command-name>${name}</command-name>\n<command-message>${short}</command-message>\n<command-args>${escapeEnvelope(command.args)}</command-args>`
      : `<command-name>${name}</command-name>\n<command-message>${short}</command-message>`
    return { ...fields, type: 'user', message: { role: 'user', content: body } }
  }
  if (block.type === 'tool_result' && (commandIds.has(block.toolUseId) || !called.has(block.toolUseId))) {
    const text = 'text' in block.content ? block.content.text : JSON.stringify(block.content.json)
    const { entrypoint: _entrypoint, isSidechain: _sidechain, userType: _userType, ...system } = fields
    return { ...system, type: 'system', subtype: 'local_command', content: `<local-command-stdout>${escapeEnvelope(text)}</local-command-stdout>`,
      level: 'info', isMeta: false }
  }
  return null
}

function serializeBlocks(blocks: readonly Block[]): Json[] {
  return blocks.map(serializeBlock).filter((block): block is Json => block !== null)
}

function serializeBlock(block: Block): Json | null {
  switch (block.type) {
    case 'text': return { type: 'text', text: block.text }
    // Not in txcript, which writes every thinking block: Anthropic's API requires a thinking block's `signature`, and
    // reasoning from another engine (Codex's summaries) has none, so a resumed conversation carrying one would be
    // refused as a whole. Only Claude's own signed reasoning goes back.
    case 'thinking': return block.signature !== undefined ? { type: 'thinking', thinking: block.text, signature: block.signature } : null
    case 'tool_use': {
      // Anthropic requires an object input even for a call in the history; Codex's freeform calls carry text.
      const input = isObject(block.tool.input) ? block.tool.input : { input: block.tool.input }
      return { type: 'tool_use', id: safeToolId(block.id), name: block.tool.name, input }
    }
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: safeToolId(block.toolUseId), content: serializeToolOutput(block.content), ...(block.isError ? { is_error: true } : {}) }
    case 'image': return { type: 'image', source: { type: block.sourceType, media_type: block.mediaType, data: block.data } }
    case 'artifact': {
      const { artifact } = block
      const source = artifact.source
      if (source.type === 'path') return { type: 'tool_use', id: safeToolId(artifact.id), name: 'Artifact', input: { file_path: source.path, description: artifact.name } }
      if (source.type === 'text') return { type: 'document', source: { type: 'text', media_type: source.mediaType ?? 'text/plain', data: source.text } }
      return { type: 'document', source: { type: 'base64', media_type: source.mediaType ?? 'application/octet-stream', data: source.data } }
    }
  }
}

/** The block tags Anthropic accepts inside `tool_result.content`; any other fails the whole resumed session. */
const TOOL_RESULT_BLOCK_TAGS = new Set(['browser_state', 'document', 'image', 'search_result', 'text', 'tool_reference'])
const isBlockArray = (value: unknown): value is Json[] => Array.isArray(value)
  && value.every(item => isObject(item) && typeof item.type === 'string' && TOOL_RESULT_BLOCK_TAGS.has(item.type))

/** A string or a content-block array, the only shapes Anthropic takes; other JSON flattens to its text. */
function serializeToolOutput(output: ToolOutput): unknown {
  if ('text' in output) return output.text
  return isBlockArray(output.json) ? stripBlockUuids(output.json) : JSON.stringify(output.json)
}

/** Claude.ai's `uuid` on content blocks, which the Messages API rejects, removed from block envelopes only. */
function stripBlockUuids(blocks: readonly Json[]): Json[] {
  return blocks.map(block => {
    const { uuid: _uuid, ...rest } = block
    if (isBlockArray(rest.content)) rest.content = stripBlockUuids(rest.content)
    const source = rest.source
    if (rest.type === 'document' && isObject(source) && source.type === 'content' && isBlockArray(source.content)) {
      rest.source = { ...source, content: stripBlockUuids(source.content) }
    }
    return rest
  })
}
