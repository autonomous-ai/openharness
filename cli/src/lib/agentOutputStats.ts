/** Output observed in this conversation's successful tool receipts. Pure: no Git, subprocesses,
 * network, directory scans or polling. Collected during the existing incremental usage read.
 * These are recorded edits, not a checkout diff; unreported work stays unknown. */
import { createHash } from 'node:crypto'

export type AgentOutputStats = {
  linesAdded: number | null
  linesRemoved: number | null
  pullRequestsCreated: number | null
}
type Pending = { kind: 'edit' | 'pr' } | { kind: 'patch'; added: number; removed: number }
export type OutputLedger = {
  added: number; removed: number; edits: boolean; completedCount: number
  prs: Record<string, true>; completed: Record<string, true>; pending: Record<string, Pending>
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const MAX_PENDING = 128
const MAX_RECEIPTS = 20_000
export const emptyOutputLedger = (): OutputLedger => ({ added: 0, removed: 0, edits: false, completedCount: 0, prs: {}, completed: {}, pending: {} })

export function validOutputLedger(value: unknown): value is OutputLedger {
  const row = object(value)
  const map = (value: unknown, valid: (v: unknown) => boolean, limit: number) => {
    const entries = object(value)
    return entries && Object.keys(entries).length <= limit
      && Object.entries(entries).every(([k, v]) => /^[a-f0-9]{64}$/.test(k) && valid(v))
  }
  return !!row && count(row.added) && count(row.removed) && typeof row.edits === 'boolean'
    && !!map(row.prs, v => v === true, MAX_RECEIPTS)
    && !!map(row.completed, v => v === true, MAX_RECEIPTS)
    && row.completedCount === Object.keys(row.completed as object).length
    && !!map(row.pending, v => {
      const item = object(v)
      return !!item && (item.kind === 'edit' || item.kind === 'pr'
        || item.kind === 'patch' && count(item.added) && count(item.removed))
    }, MAX_PENDING)
}

export function outputSnapshot(state: OutputLedger): AgentOutputStats | null {
  const prs = Object.keys(state.prs).length
  return state.edits || prs ? {
    linesAdded: state.edits ? state.added : null, linesRemoved: state.edits ? state.removed : null,
    pullRequestsCreated: prs || null,
  } : null
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => text(object(v)?.text)).join('\n')
  return ''
}

/** Recognize a real shell command, never `echo "gh pr create"`, heredocs or comments. No execution. */
function createsPr(command: string): boolean {
  if (command.includes('<<') || command.includes('`') || command.includes('$(') || command.includes('||')) return false
  const commands: string[][] = [[]]
  let word = '', quote = '', escaped = false, comment = false
  const flush = () => { if (word) { commands.at(-1)!.push(word); word = '' } }
  for (const char of command) {
    if (comment) { if (char !== '\n') continue; comment = false }
    if (escaped) { word += char; escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; else word += char; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '#' && !word) { comment = true; continue }
    if (';&|\n'.includes(char)) { flush(); commands.push([]) }
    else if (/\s/.test(char)) flush()
    else word += char
  }
  flush()
  if (quote || escaped) return false
  const ran = commands.filter(words => words.length)
  const last = ran.at(-1)
  // Its result must be the command's result, not a later command masking a failed creation.
  return last?.[0] === 'gh' && last[1] === 'pr' && last[2] === 'create'
    && ran.filter(words => words[0] === 'gh' && words[1] === 'pr' && words[2] === 'create').length === 1
}

/** Extract one literal tools.* call from Codex code mode. Never evaluate model-written JavaScript.
 * Compound/dynamic scripts stay unknown: their outputs cannot be attributed to one operation. */
function unwrap(name: string, input: unknown): [string, unknown] {
  if (name !== 'exec' || typeof input !== 'string') return [name, input]
  const calls = [...input.matchAll(/\btools\.([a-zA-Z0-9_]+)\s*\(/g)]
  if (calls.length !== 1) return [name, input]
  const tool = calls[0][1]
  const rest = input.slice(calls[0].index! + calls[0][0].length).trimStart()
  if (tool === 'apply_patch') {
    const literal = /^"(?:\\.|[^"\\])*"/.exec(rest)?.[0]
    return literal ? [tool, parse(literal)] : [name, input]
  }
  if (tool === 'exec_command') {
    const literal = /(?:\bcmd\b|"cmd")\s*:\s*("(?:\\.|[^"\\])*")/.exec(rest)?.[1]
    if (literal) return [tool, { cmd: parse(literal) }]
  }
  return [name, input]
}

function patchCounts(patch: string): { added: number; removed: number } | null {
  if (!patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) return null
  // A deleted file's contents are absent from the patch; don't invent its removed-line count.
  if (patch.includes('\n*** Delete File:')) return null
  let added = 0, removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

function start(state: OutputLedger, id: unknown, rawName: unknown, raw: unknown): void {
  if (typeof id !== 'string' || typeof rawName !== 'string') return
  const key = digest(id)
  if (state.completed[key] || state.pending[key]) return
  const [name, input] = unwrap(rawName.replace(/^functions\./, ''), parse(raw))
  const args = object(input)
  let pending: Pending | null = null
  if (['Edit', 'Write', 'MultiEdit'].includes(name)) pending = { kind: 'edit' }
  else if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : args?.patch ?? args?.input
    const counts = typeof patch === 'string' ? patchCounts(patch) : null
    if (counts) pending = { kind: 'patch', ...counts }
  } else if (['Bash', 'exec_command', 'shell', 'local_shell', 'unified_exec'].includes(name)) {
    const command = args?.command ?? args?.cmd
    // shell's ["bash", "-lc", command] is safe to inspect when its shape is unambiguous.
    const source = Array.isArray(command) && command.length === 3 && ['-c', '-lc'].includes(command[1])
      ? command[2] : command
    if (typeof source === 'string' && createsPr(source)) pending = { kind: 'pr' }
  }
  if (pending && Object.keys(state.pending).length < MAX_PENDING) state.pending[key] = pending
}

function finish(state: OutputLedger, id: unknown, rawOutput: unknown, failed: boolean, receipt?: unknown): void {
  if (typeof id !== 'string') return
  const key = digest(id), pending = state.pending[key]
  if (!pending || state.completed[key]) return
  delete state.pending[key]
  if (state.completedCount >= MAX_RECEIPTS) return
  state.completed[key] = true
  state.completedCount++
  let output = text(rawOutput)
  const wrapped = /^Script completed[\s\S]*?\nOutput:\n([\s\S]+)$/.exec(output)
  if (wrapped) output = wrapped[1]
  const result = object(parse(output))
  // The native exec result is structured on some versions, a textual wrapper on others.
  if (result && typeof result.output === 'string') output = result.output
  const native = object(receipt)
  if (failed || result?.isError === true || native?.interrupted === true
    || (result?.session_id != null && result.exit_code == null)
    || (typeof result?.exit_code === 'number' && result.exit_code !== 0)
    || /(?:Process exited with code|"exit_code"\s*:)\s*[1-9]\d*/.test(output)) return
  if (pending.kind === 'pr') {
    // `gh pr create` prints the created URL on its own line. Quotes, mentions, read/list output,
    // errors and unrelated links never become productivity credit.
    const urls = [...new Set(output.split('\n').map(s => s.trim()).filter(s =>
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(s)))]
    if (urls.length === 1) state.prs[digest(urls[0].toLowerCase())] = true
    return
  }
  let counts: { added: number; removed: number } | null = null
  if (pending.kind === 'patch' && /(?:^|\n)Success\. Updated the following files:/m.test(output)) counts = pending
  if (pending.kind === 'edit') {
    const patches = native?.structuredPatch
    if (Array.isArray(patches) && patches.length && patches.every(p => Array.isArray(object(p)?.lines))) {
      counts = { added: 0, removed: 0 }
      for (const patch of patches) for (const line of object(patch)!.lines as unknown[]) {
        if (typeof line === 'string' && line.startsWith('+')) counts.added++
        else if (typeof line === 'string' && line.startsWith('-')) counts.removed++
      }
    } else if (native?.type === 'create' && typeof native.content === 'string') {
      const content = native.content
      counts = { added: content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0, removed: 0 }
    }
  }
  if (counts && Number.isSafeInteger(state.added + counts.added) && Number.isSafeInteger(state.removed + counts.removed)) {
    state.added += counts.added; state.removed += counts.removed; state.edits = true
  }
}

export function ingestOutput(state: OutputLedger, row: Record<string, unknown>, engine: string): void {
  if (engine === 'claude') {
    const content = object(row.message)?.content
    if (!Array.isArray(content)) return
    for (const value of content) {
      const item = object(value)
      if (!item) continue
      if (row.type === 'assistant' && item.type === 'tool_use') start(state, item.id, item.name, item.input)
      if (row.type === 'user' && item.type === 'tool_result')
        finish(state, item.tool_use_id, item.content, item.is_error === true,
          content.filter(v => object(v)?.type === 'tool_result').length === 1 ? row.toolUseResult : undefined)
    }
  } else if (engine === 'codex' && row.type === 'response_item') {
    const item = object(row.payload)
    if (!item) return
    if (item.type === 'function_call' || item.type === 'custom_tool_call')
      start(state, item.call_id ?? item.id, item.name, item.arguments ?? item.input)
    else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')
      finish(state, item.call_id ?? item.id, item.output, item.is_error === true || item.status === 'failed')
  }
}
