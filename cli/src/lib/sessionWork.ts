/** Minimal, replayable work-location evidence. No Git, I/O, shell execution or raw output storage. */
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import { literalToolCall, literalToolCalls, type ToolOutputSlot } from './literalToolCall.js'

export type WorkLocation = { cwd: string; at: string }
export type WorkPullRequest = { url: string; cwd: string | null; at: string }
type Operation = { paths: string[]; at: string; order: number; createsPr: boolean;
  children?: Array<{ operation: Operation; output?: ToolOutputSlot }> }
export type SessionWorkLedger = {
  context: string | null; sequence: number; latest: number; currentOrder: number; failedOrder: number;
  current: WorkLocation[]; locations: WorkLocation[]; pullRequests: WorkPullRequest[];
  pending: Record<string, Operation>; running: Record<string, Operation>; completed: string[];
  uncertain: boolean; truncated: boolean;
}
export type SessionWork = Pick<SessionWorkLedger, 'current' | 'locations' | 'pullRequests' | 'uncertain' | 'truncated'>
const LIMIT = 128
const RECEIPTS = 2048
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const stamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
export const validWorkPath = (v: unknown): v is string =>
  typeof v === 'string' && isAbsolute(v) && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v)
export const validPullRequestUrl = (v: unknown): v is string => typeof v === 'string'
  && /^https:\/\/github\.com\/[\w-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(v)
  && new URL(v).href === v && Number.isSafeInteger(Number(v.split('/').at(-1)))
export const emptySessionWork = (): SessionWorkLedger => ({ context: null, sequence: 0, latest: 0, currentOrder: 0, failedOrder: 0,
  current: [], locations: [], pullRequests: [], pending: {}, running: {}, completed: [], uncertain: false, truncated: false })

export function validSessionWork(value: unknown): value is SessionWorkLedger {
  const r = object(value)
  const locations = (v: unknown) => Array.isArray(v) && v.length <= LIMIT
    && v.every(x => validWorkPath(x?.cwd) && stamp(x?.at))
  const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const operation = (op: Operation, depth = 0): boolean => depth <= 4
    && Array.isArray(op?.paths) && op.paths.length <= LIMIT && op.paths.every(validWorkPath)
    && integer(op.order) && op.order <= Number(r?.sequence) && stamp(op.at) && typeof op.createsPr === 'boolean'
    && (op.children === undefined || Array.isArray(op.children) && op.children.length <= 32
      && op.children.every(child => operation(child?.operation, depth + 1) && (child.output === undefined
        || integer(child.output.block) && child.output.block < 32
        && (child.output.index === undefined || integer(child.output.index) && child.output.index < 32)
        && (child.output.settled === undefined || typeof child.output.settled === 'boolean'))))
  return !!r && (r.context === null || validWorkPath(r.context)) && integer(r.sequence) && integer(r.latest)
    && Number(r.latest) <= Number(r.sequence) && integer(r.currentOrder) && Number(r.currentOrder) <= Number(r.sequence)
    && integer(r.failedOrder) && Number(r.failedOrder) <= Number(r.sequence) && locations(r.current) && locations(r.locations)
    && Array.isArray(r.pullRequests) && r.pullRequests.length <= LIMIT && r.pullRequests.every(p =>
      validPullRequestUrl(p?.url) && (p.cwd === null || validWorkPath(p.cwd)) && stamp(p?.at))
    && [r.pending, r.running].every(operations => !!object(operations) && Object.keys(operations as object).length <= LIMIT
    && Object.entries(operations as Record<string, Operation>).every(([id, op]) => /^[a-f0-9]{64}$/.test(id) && operation(op)))
    && Array.isArray(r.completed) && r.completed.length <= RECEIPTS && r.completed.every(id => /^[a-f0-9]{64}$/.test(id))
    && typeof r.uncertain === 'boolean' && typeof r.truncated === 'boolean'
}

export function sessionWorkSnapshot(state: SessionWorkLedger): SessionWork | null {
  if (!state.sequence && !state.pullRequests.length && !state.locations.length) return null
  // Pending calls are intent, not successful work. Multiple simultaneous calls prevent a claim
  // that the last completed checkout is the unique place the agent is working now.
  const pending = [...Object.values(state.pending), ...Object.values(state.running)]
  return { current: state.current.map(v => ({ ...v })), locations: state.locations.map(v => ({ ...v })),
    pullRequests: state.pullRequests.map(v => ({ ...v })),
    uncertain: state.uncertain || pending.length > 0, truncated: state.truncated }
}

type Word = { text: string; literal: boolean }
type Command = { words: Word[]; after: string }
/** Tokenize only straight-line shell syntax. Quoted words stay words; never evaluate expansion. */
function commands(source: string): Command[] | null {
  if (source.length > 128 * 1024) return null
  const result: Command[] = []
  let words: Word[] = [], text = '', literal = true, quote = '', started = false
  const word = () => { if (started) words.push({ text, literal }); text = ''; literal = true; started = false }
  const command = (after: string) => { word(); if (words.length) result.push({ words, after }); words = [] }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '\\' && quote !== "'") {
      const next = source[++i]
      if (next === undefined) return null
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) text += '\\'
      if (next !== '\n') { text += next; started = true }
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      else { text += ch; if (quote !== "'" && (ch === '$' || ch === '`')) literal = false }
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue }
    if (ch === '#' && !started) { while (i < source.length && source[i] !== '\n') i++; command(';'); continue }
    if (ch === '>' && source[i + 1] === '&' || ch === '&' && source[i + 1] === '>') {
      text += source.slice(i, i + 2); i++; started = true; continue
    }
    // Subshells, substitutions, background work and alternatives need a real execution receipt.
    if ('()`{}'.includes(ch) || ch === '<') return null
    if (ch === '$' || ch === '~' && !started || ch === '*' || ch === '?') literal = false
    if (ch === '&' || ch === '|') {
      const doubled = source[i + 1] === ch
      if (doubled) i++
      if (ch === '&' && !doubled || ch === '|' && doubled) return null
      command(doubled ? '&&' : '|'); continue
    }
    if (ch === ';' || ch === '\n') { command(';'); continue }
    if (/\s/.test(ch)) { word(); continue }
    text += ch; started = true
  }
  if (quote) return null
  command('')
  return result
}

function pathFrom(word: Word | undefined, cwd: string | null): string | null {
  if (!word?.literal || !word.text || word.text.startsWith('-') || /[\x00-\x1f\x7f]/.test(word.text)) return null
  const path = isAbsolute(word.text) ? resolve(word.text) : cwd ? resolve(cwd, word.text) : null
  return validWorkPath(path) ? path : null
}

export function shellWorkLocations(source: string, initial: string | null): { paths: string[]; createsPr: boolean } | null {
  const parsed = commands(source)
  if (!parsed?.length) return null
  let cwd = initial
  const paths = new Set<string>()
  let createsPr = false
  for (const [index, command] of parsed.entries()) {
    const { words, after } = command
    const name = words[0]?.text
    if (!words[0]?.literal || /^(?:if|then|else|fi|for|while|until|case|function|eval|source|exec|command|builtin|pushd|popd|time|!|\.)$/.test(name)) return null
    if (['sh', 'bash', 'zsh', 'fish', 'env', 'sudo'].includes(name) || name.includes('=')) return null
    if (words.some(w => /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)=|^--(?:git-dir|work-tree)(?:=|$)/.test(w.text))) return null
    if (name === 'cd') {
      const operand = words[1]?.text === '--' ? words[2] : words[1]
      if (words.length !== (words[1]?.text === '--' ? 3 : 2) || index < parsed.length - 1 && after !== '&&') return null
      cwd = pathFrom(operand, cwd)
      if (!cwd) return null
      if (index === parsed.length - 1) paths.add(cwd)
      continue
    }
    // Environment setup does not establish a separate work location.
    if (['export', 'unset', 'set'].includes(name)) continue
    let location = cwd
    if (name === 'git' && words[1]?.text === '-C') {
      location = pathFrom(words[2], cwd)
      if (!location || words.slice(3).some(w => w.text === '-C' || w.text === '--git-dir' || w.text === '--work-tree')) return null
    }
    // A pipeline's consumers inherit the shell cwd but usually only read stdin. Keep its source.
    if (location && (index === 0 || parsed[index - 1].after !== '|')) paths.add(location)
    if (name === 'gh' && words[1]?.text === 'pr' && words[2]?.text === 'create'
      && index === parsed.length - 1 && words.slice(3).every(w => w.literal)) createsPr = true
  }
  return { paths: [...paths].slice(0, LIMIT), createsPr }
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** A single unconditional literal code-mode call. Anything else stays unknown, never evaluated. */
function unwrap(name: string, input: unknown): [string, unknown] {
  if (name !== 'exec' || typeof input !== 'string') return [name, parse(input)]
  const call = literalToolCall(input)
  return call ? [call.name, call.input] : [name, input]
}

function operation(name: string, raw: unknown, cwd: string | null): { paths: string[]; createsPr: boolean } | null | undefined {
  const [tool, input] = unwrap(name.replace(/^functions\./, ''), parse(raw))
  const args = object(input)
  if (['Bash', 'exec_command', 'shell', 'local_shell', 'unified_exec'].includes(tool)) {
    const explicit = args?.workdir ?? args?.cwd
    if (explicit !== undefined && !validWorkPath(explicit)) return null
    const base = validWorkPath(explicit) ? explicit : cwd
    const rawCommand = args?.cmd ?? args?.command
    const source = Array.isArray(rawCommand) && rawCommand.length === 3 && ['-c', '-lc'].includes(rawCommand[1])
      ? rawCommand[2] : rawCommand
    return typeof source === 'string' ? shellWorkLocations(source, base) : null
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(tool)) {
    const path = pathFrom({ text: typeof args?.file_path === 'string' ? args.file_path : '', literal: true }, cwd)
    return path ? { paths: [dirname(path)], createsPr: false } : null
  }
  if (tool === 'apply_patch') {
    const patch = typeof input === 'string' ? input : args?.patch ?? args?.input
    if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) return null
    const files = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
    const paths = files.map(match => pathFrom({ text: match[1], literal: true }, cwd)).map(path => path && dirname(path))
    return paths.length && paths.every((p): p is string => !!p)
      ? { paths: [...new Set(paths)].slice(0, LIMIT), createsPr: false } : null
  }
  // Code mode may execute anything; it invalidates confidence when unsupported. Unrelated tools
  // such as web search and user questions do not change where a session last worked.
  return ['exec', 'apply_patch'].includes(tool) ? null : undefined
}

function prepare(state: SessionWorkLedger, name: string, input: unknown, cwd: string | null, at: string,
  order?: number): Operation | null {
  const [tool, raw] = unwrap(name.replace(/^functions\./, ''), parse(input))
  const args = object(raw)
  const continuation = tool === 'write_stdin' && (typeof args?.session_id === 'number' || typeof args?.session_id === 'string')
    ? hash(`process:${args.session_id}`) : tool === 'wait' && typeof args?.cell_id === 'string' ? hash(`cell:${args.cell_id}`) : null
  if (continuation && state.running[continuation]) {
    const running = state.running[continuation]
    delete state.running[continuation]
    // Input could change an interactive shell's directory. Only passive waits confirm an operation.
    return args?.terminate === true || typeof args?.chars === 'string' && args.chars.length > 0
      ? { at: running.at, order: running.order, paths: [], createsPr: false } : running
  }
  const found = continuation ? null : operation(name, input, cwd)
  if (found === undefined) return null
  return { paths: found?.paths ?? [], createsPr: found?.createsPr ?? false, order: order ?? ++state.sequence, at }
}

function begin(state: SessionWorkLedger, id: unknown, name: unknown, input: unknown, cwd: string | null, at: string): void {
  if (typeof id !== 'string' || typeof name !== 'string') return
  const key = hash(id)
  if (state.pending[key] || state.completed.includes(key)) return
  if (Object.keys(state.pending).length >= LIMIT) { state.uncertain = true; state.truncated = true; return }
  const raw = parse(input)
  const calls = name.replace(/^functions\./, '') === 'exec' && typeof raw === 'string' ? literalToolCalls(raw) : null
  if (calls) {
    const orders = new Map<number, number>()
    const children: NonNullable<Operation['children']> = []
    for (const call of calls) {
      const order = orders.get(call.group) ?? state.sequence + 1
      const op = prepare(state, call.name, call.input, cwd, at, order)
      if (op) {
        state.sequence = Math.max(state.sequence, order)
        orders.set(call.group, order)
        children.push({ operation: op, ...(call.output ? { output: call.output } : {}) })
      }
    }
    if (children.length) state.pending[key] = { paths: [], at, order: state.sequence, createsPr: false, children }
  } else {
    const op = prepare(state, name, input, cwd, at)
    if (op) state.pending[key] = op
  }
}

function outputText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.map(v => outputText(object(v)?.text)).join('\n')
  const obj = object(raw)
  return typeof obj?.output === 'string' ? obj.output : ''
}

function finish(state: SessionWorkLedger, id: unknown, raw: unknown, failed: boolean, receipt?: unknown): void {
  if (typeof id !== 'string') return
  const key = hash(id), op = state.pending[key]
  if (!op) return
  delete state.pending[key]
  state.completed.push(key)
  if (state.completed.length > RECEIPTS) { state.completed.shift(); state.truncated = true }
  finishOperation(state, op, raw, failed, receipt)
}

/** Codex stores each text(...) output as a separate input_text block. Joining those JSON objects
 * destroys their boundaries and loses yielded process ids, exit codes and PR creation receipts. */
function outputBlocks(raw: unknown): unknown[] {
  const blocks = Array.isArray(raw) ? raw.map(row => object(row)?.text).filter((row): row is string => typeof row === 'string')
    : [typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '']
  return blocks.map(text => text.replace(/^Script completed[\s\S]*?\nOutput:\n/, '').trim())
    .filter(text => text && !/^Script running with cell ID/.test(text)).map(parse)
}

function finishOperation(state: SessionWorkLedger, op: Operation, raw: unknown, failed: boolean, receipt?: unknown): void {
  let text = outputText(raw)
  if (op.children) {
    const blocks = outputBlocks(raw)
    const cell = /Script running with cell ID ([\w-]+)/.exec(text)?.[1]
    const remaining: NonNullable<Operation['children']> = []
    for (const child of op.children) {
      const slot = child.output
      if (cell && slot && slot.block >= blocks.length) {
        remaining.push({ ...child, output: { ...slot, block: slot.block - blocks.length } }); continue
      }
      let value = slot ? blocks[slot.block] : undefined
      const row = object(value)
      const invalid = !slot || value === undefined || slot.index !== undefined && row?.i !== slot.index
        || slot.settled && row?.status !== 'fulfilled'
      if (slot?.settled) value = row?.value
      finishOperation(state, child.operation, value, failed || !!invalid)
    }
    if (cell && remaining.length) {
      if (Object.keys(state.running).length < LIMIT) state.running[hash(`cell:${cell}`)] = { ...op, children: remaining }
      else { state.uncertain = true; state.truncated = true }
    }
    return
  }
  const wrapper = /^Script completed[\s\S]*?\nOutput:\n([\s\S]*)$/.exec(text)
  if (wrapper) text = wrapper[1]
  const result = object(parse(text)) ?? object(raw)
  const native = object(receipt)
  const running = result?.session_id != null && result.exit_code == null
    ? hash(`process:${result.session_id}`)
    : /Process running with session ID ([\w-]+)/.test(text)
      ? hash(`process:${/Process running with session ID ([\w-]+)/.exec(text)![1]}`)
      : /Script running with cell ID ([\w-]+)/.test(text)
        ? hash(`cell:${/Script running with cell ID ([\w-]+)/.exec(text)![1]}`) : null
  const unsuccessful = failed || result?.isError === true || native?.interrupted === true
    || native?.backgroundTaskId != null || running != null
    || typeof result?.exit_code === 'number' && result.exit_code !== 0
    || /(?:Process exited with code|"exit_code"\s*:)\s*[1-9]\d*/.test(text)
    || /Script running with cell ID|Process running with session ID|Script terminated/.test(text)
  if (running && !failed && result?.isError !== true) {
    if (Object.keys(state.running).length < LIMIT) state.running[running] = op
    else state.truncated = true
  }
  state.latest = Math.max(state.latest, op.order)
  if ((!running && unsuccessful) || !op.paths.length) state.failedOrder = Math.max(state.failedOrder, op.order)
  if (!unsuccessful && op.paths.length && op.order >= state.currentOrder) {
    // Keep the last successful location through failures, pending work and unsupported scripts.
    // Calls in one parallel group share an order, so several worktrees stay explicitly multiple.
    const previous = op.order === state.currentOrder ? state.current : []
    state.currentOrder = op.order
    state.current = [...previous, ...op.paths.filter(cwd => !previous.some(row => row.cwd === cwd)).map(cwd => ({ cwd, at: op.at }))].slice(0, LIMIT)
  }
  state.uncertain = state.currentOrder < state.latest || state.failedOrder === state.latest
  if (unsuccessful) return
  for (const cwd of op.paths) {
    const old = state.locations.find(p => p.cwd === cwd)
    if (!old || old.at < op.at) {
      state.locations = [{ cwd, at: op.at }, ...state.locations.filter(p => p.cwd !== cwd)]
        .sort((a, b) => b.at.localeCompare(a.at))
    }
  }
  if (state.locations.length > LIMIT) { state.locations.length = LIMIT; state.truncated = true }
  if (op.createsPr) {
    if (typeof result?.output === 'string') text = result.output
    const urls = [...new Set(text.split('\n').map(s => s.trim()).filter(validPullRequestUrl))]
    if (urls.length === 1 && !state.pullRequests.some(p => p.url === urls[0])) {
      state.pullRequests.unshift({ url: urls[0], cwd: op.paths.length === 1 ? op.paths[0] : null, at: op.at })
      if (state.pullRequests.length > LIMIT) { state.pullRequests.length = LIMIT; state.truncated = true }
    }
  }
}

/** Caller enforces session/fork identity before ingestion. Timestamps are transcript evidence. */
export function ingestSessionWork(state: SessionWorkLedger, row: Record<string, unknown>, engine: string, launchCwd?: string | null): void {
  if (!stamp(row.timestamp)) return
  const at = new Date(row.timestamp).toISOString()
  if (engine === 'codex' && ['session_meta', 'turn_context'].includes(String(row.type))) {
    const cwd = object(row.payload)?.cwd
    if (validWorkPath(cwd)) state.context = cwd
    return
  }
  const cwd = validWorkPath(row.cwd) ? row.cwd : state.context ?? (validWorkPath(launchCwd) ? launchCwd : null)
  if (engine === 'claude') {
    const content = object(row.message)?.content
    if (!Array.isArray(content)) return
    for (const v of content) {
      const item = object(v)
      if (!item) continue
      if (row.type === 'assistant' && item.type === 'tool_use') begin(state, item.id, item.name, item.input, cwd, at)
      if (row.type === 'user' && item.type === 'tool_result') finish(state, item.tool_use_id, item.content, item.is_error === true,
        content.filter(v => object(v)?.type === 'tool_result').length === 1 ? row.toolUseResult : undefined)
    }
  } else if (engine === 'codex' && row.type === 'response_item') {
    const item = object(row.payload)
    if (!item) return
    if (item.type === 'function_call' || item.type === 'custom_tool_call')
      begin(state, item.call_id ?? item.id, item.name, item.arguments ?? item.input, cwd, at)
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')
      finish(state, item.call_id ?? item.id, item.output, item.is_error === true || item.status === 'failed')
  }
}
