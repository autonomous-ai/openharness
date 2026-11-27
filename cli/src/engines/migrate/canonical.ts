/**
 * Ported from txcript (https://github.com/skillsynchq/txcript), Apache-2.0: src/common.rs, src/harness/jsonl.rs.
 *
 * The canonical conversation both directions of a migration go through: Claude Code's transcript and Codex's
 * rollout are each read into it and written from it, so the two converters never know each other. It is the
 * Anthropic Messages shape (tool results ride on user messages), as in txcript. Pure: no files, no clock.
 */
import { createHash } from 'node:crypto'

export type Role = 'user' | 'assistant'

/** Session-level facts every engine has. */
export interface Meta {
  id: string
  /** When the session started, epoch ms. */
  timestamp: number
  cwd?: string
  gitBranch?: string
  title?: string
  cliVersion?: string
  model?: string
}

export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** A tool call in Claude Code's names and argument keys (txcript's `Tool::to_canonical` form). */
export interface Tool { name: string; input: unknown }

/** A tool's result: text, or the engine's structured output kept as JSON. */
export type ToolOutput = { text: string } | { json: unknown }

export type ArtifactSource =
  | { type: 'text'; text: string; mediaType?: string }
  | { type: 'base64'; data: string; mediaType?: string }
  | { type: 'path'; path: string; mediaType?: string }

export interface Artifact { id: string; name: string; source: ArtifactSource }

export type Block =
  | { type: 'text'; text: string }
  /** `signature` is Anthropic's opaque token, `encrypted` Codex's `encrypted_content`: replayable only to their own engine. */
  | { type: 'thinking'; text: string; signature?: string; encrypted?: string }
  | { type: 'tool_use'; id: string; tool: Tool }
  | { type: 'tool_result'; toolUseId: string; content: ToolOutput; isError: boolean }
  | { type: 'image'; sourceType: string; mediaType: string; data: string }
  | { type: 'artifact'; artifact: Artifact }

export interface Message {
  role: Role
  content: Block[]
  /** Epoch ms. */
  timestamp: number
  model?: string
  stopReason?: string
  usage?: Usage
}

export interface Transcript { meta: Meta; messages: Message[] }

export type Json = Record<string, unknown>

export const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
export const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
/** A JSON number that is a non-negative integer (serde's `as_u64`). */
export const u64 = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** `Date.parse` of an RFC 3339 time, or undefined. */
export function parseTs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

/** RFC 3339 with milliseconds and `Z`, as txcript writes (`SecondsFormat::Millis, true`). */
export const isoTime = (at: number): string => new Date(at).toISOString()

/** Each non-blank line parsed as JSON, an invalid one skipped (`jsonl::parse`). */
export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a torn or foreign line is not a record */ }
  }
  return out
}

/** One JSON object a line, each ending in a newline (`jsonl::render`). */
export const renderJsonl = (records: readonly unknown[]): string => records.map(record => `${JSON.stringify(record)}\n`).join('')

/** RFC 4122 version 5 (SHA-1, name-based): txcript's deterministic per-line ids, so a conversion is a pure function. */
export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ── typed views of a canonical tool ──────────────────────────────────────────────────────────────────
//
// txcript's typed `Tool` variants exist only where a writer treats a tool specially. A variant matches only when the
// input fits its schema exactly (serde's `deny_unknown_fields`): any other key keeps the call raw, so nothing is lost.

type Field = 'string' | 'u64' | 'bool'
function fits(input: unknown, required: Record<string, Field>, optional: Record<string, Field> = {}): input is Json {
  if (!isObject(input)) return false
  const ok = (value: unknown, kind: Field) => kind === 'string' ? typeof value === 'string' : kind === 'bool' ? typeof value === 'boolean' : u64(value) !== undefined
  for (const [key, kind] of Object.entries(required)) if (!ok(input[key], kind)) return false
  for (const [key, value] of Object.entries(input)) {
    if (key in required) continue
    const kind = optional[key]
    // serde reads an explicit null as an absent Option.
    if (!kind || value !== null && !ok(value, kind) || value === null && kind === 'bool') return false
  }
  return true
}

/** `Tool::Command`: a slash command the person ran at the engine, not a model's tool call. */
export function commandTool(tool: Tool): { command: string; args?: string } | null {
  if (!tool.name.startsWith('/') || !fits(tool.input, {}, { args: 'string' })) return null
  const args = str(tool.input.args)
  return { command: tool.name, ...(args !== undefined ? { args } : {}) }
}

export function bashTool(tool: Tool): { command: string; workdir?: string } | null {
  if (tool.name !== 'Bash' || !fits(tool.input, { command: 'string' }, { workdir: 'string', timeout_ms: 'u64', description: 'string', run_in_background: 'bool' })) return null
  const workdir = str(tool.input.workdir)
  return { command: tool.input.command as string, ...(workdir !== undefined ? { workdir } : {}) }
}

export function editTool(tool: Tool): { filePath: string; oldString: string; newString: string } | null {
  if (tool.name !== 'Edit' || !fits(tool.input, { file_path: 'string', old_string: 'string', new_string: 'string' }, { replace_all: 'bool' })) return null
  return { filePath: tool.input.file_path as string, oldString: tool.input.old_string as string, newString: tool.input.new_string as string }
}

export function writeTool(tool: Tool): { filePath: string; content: string } | null {
  if (tool.name !== 'Write' || !fits(tool.input, { file_path: 'string', content: 'string' })) return null
  return { filePath: tool.input.file_path as string, content: tool.input.content as string }
}

/** `Artifact::display_text`: an artifact for an engine with no carrier of its own. */
export function artifactText(artifact: Artifact): string {
  const { source } = artifact
  if (source.type === 'text') return `[artifact: ${artifact.name}]\n${source.text}`
  if (source.type === 'base64') return `[artifact: ${artifact.name}]`
  return `[artifact: ${artifact.name}] ${source.path}`
}

/** A tool output as one string (`tool_output_text`). */
export const outputText = (output: ToolOutput): string => 'text' in output ? output.text : JSON.stringify(output.json)

/** Rust's `str::lines`: split on `\n`, a trailing `\r` dropped, and no last empty line after a final newline. */
export function rustLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
}
