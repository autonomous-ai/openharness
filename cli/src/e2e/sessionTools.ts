/**
 * sessionTools — which of the engine's own tools each step went through, and which model answered
 * it, read afterwards from the engine's session file.
 *
 * A step passes on its proof (a log line, the file on disk, the read token — smokeChecks.ts); this
 * says HOW the engine got there, which is the other half of "does the tool still work on the grid":
 * claude may read with `Read` or with `Bash cat`, codex writes with `apply_patch` and, in code mode,
 * reaches everything through `exec`. Every step's prompt carries its `(ref-…)` tag, so the tool
 * calls between one tagged prompt and the next belong to that step.
 *
 *   claude  ~/.claude/projects/<cwd with every non-alphanumeric as "-">/*.jsonl
 *           user message text holds the ref · assistant content[] `tool_use` → name
 *   codex   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (the one holding the refs)
 *           payload `message` (role user) holds the ref · `function_call` / `custom_tool_call` →
 *           name, and for code mode's `exec` the `tools.<name>(` calls inside its JavaScript
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface StepUse {
  /** The engine's tools this step called, in order, consecutive repeats folded. */
  tools: string[]
  /** The models that answered this step — claude writes it on every reply, codex on every turn.
   *  How "claude never ran on Fable" is checked rather than assumed. */
  models: string[]
}

/** ref → what the engine used for that step. */
export function useByRef(engine: string, cwd: string, refs: readonly string[], home = homedir()): Record<string, StepUse> {
  const out: Record<string, StepUse> = {}
  if (!refs.length) return out
  const files = engine === 'claude' ? claudeSessionFiles(cwd, home) : engine === 'codex' ? codexSessionFiles(refs, home) : []
  for (const file of files) {
    let current: string | null = null
    // codex writes a turn's `turn_context` (its model) BEFORE the user message that starts the turn,
    // so its model belongs to the NEXT ref; claude writes the model on each reply, after the ref.
    let turnModel: string | null = null
    const addModel = (use: StepUse, model: string | null): void => { if (model && !use.models.includes(model)) use.models.push(model) }
    for (const line of readText(file).split('\n')) {
      let rec: Record<string, unknown>
      try { rec = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const model = modelOf(engine, rec)
      if (engine === 'codex' && model) { turnModel = model; continue }
      const found = userRef(engine, rec, refs)
      if (found) {
        current = found
        out[current] ??= { tools: [], models: [] }
        if (engine === 'codex') addModel(out[current], turnModel)
        continue
      }
      if (!current) continue
      const use = out[current]
      for (const tool of toolCalls(engine, rec)) if (use.tools[use.tools.length - 1] !== tool) use.tools.push(tool)
      if (engine === 'claude') addModel(use, model)
    }
  }
  return out
}

function modelOf(engine: string, rec: Record<string, unknown>): string | null {
  if (engine === 'claude') {
    const m = rec.type === 'assistant' ? (rec.message as { model?: unknown } | undefined)?.model : undefined
    return typeof m === 'string' && m !== '<synthetic>' ? m : null
  }
  // codex: a top-level `turn_context` record per turn, the model in its payload (measured on a
  // 0.156.1 rollout — not a payload type, which is where the other records keep theirs).
  const p = rec.payload as { model?: unknown } | undefined
  return rec.type === 'turn_context' && typeof p?.model === 'string' ? p.model : null
}

function readText(file: string): string {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join(' ')
  return ''
}

function userRef(engine: string, rec: Record<string, unknown>, refs: readonly string[]): string | null {
  let text = ''
  if (engine === 'claude' && rec.type === 'user') text = textOf((rec.message as { content?: unknown } | undefined)?.content)
  if (engine === 'codex') {
    const p = rec.payload as { type?: string; role?: string; content?: unknown } | undefined
    if (p?.type === 'message' && p.role === 'user') text = textOf(p.content)
  }
  return text ? refs.find((r) => text.includes(r)) ?? null : null
}

function toolCalls(engine: string, rec: Record<string, unknown>): string[] {
  if (engine === 'claude') {
    if (rec.type !== 'assistant') return []
    const content = (rec.message as { content?: unknown } | undefined)?.content
    return Array.isArray(content)
      ? content.filter((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'tool_use').map((c) => String((c as { name?: unknown }).name))
      : []
  }
  const p = rec.payload as { type?: string; name?: string; namespace?: string; input?: unknown; arguments?: unknown } | undefined
  if (!p?.type) return []
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    const name = codexCallName(p)
    if (name === 'exec' && typeof p.input === 'string') {
      // Code mode: one `exec` of JavaScript that calls the real tools as `tools.<name>(…)`.
      const inner = [...p.input.matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => `exec→${m[1]}`)
      return inner.length ? inner : ['exec']
    }
    return [name]
  }
  if (p.type === 'local_shell_call') return ['local_shell']
  return []
}

/** A namespaced call arrives as name `sub` + namespace `mcp__e2e_calc` (codex 0.156.1 on the grid). */
function codexCallName(p: { name?: string; namespace?: string }): string {
  const ns = p.namespace && p.name && !p.name.startsWith(p.namespace) ? p.namespace : ''
  return ns ? `${ns}${ns.endsWith('__') ? '' : '__'}${p.name}` : String(p.name)
}

export interface ToolResult {
  /** `tool` was called after this step's prompt. */
  called: boolean
  /** One of those calls came back with results: not an error, and a link in what it returned. */
  answered: boolean
  /** What the first call returned, cut short — the probe quotes it when the step is not proven. */
  output?: string
}

/**
 * Whether `tool` was called for the step tagged `ref` and came back with results — the proof for a
 * tool whose server is not on this machine (the harness's web search runs on the grid), so its own
 * log cannot be read the way `e2e_calc`'s is. "Results" is a link in what the tool returned: a web
 * search that answered has one, and an error or an approval refusal ("MCP tool call requires
 * approval") does not.
 *
 *   claude  assistant `tool_use` { id, name } → user `tool_result` { tool_use_id, is_error, content }
 *   codex   `function_call` { name, namespace, call_id } → `function_call_output` { call_id, output }
 */
export function toolResult(engine: string, cwd: string, ref: string, tool: string, home = homedir()): ToolResult {
  const files = engine === 'claude' ? claudeSessionFiles(cwd, home) : engine === 'codex' ? codexSessionFiles([ref], home) : []
  const calls = new Set<string>()
  const outputs: string[] = []
  let errored = false
  for (const file of files) {
    let inStep = false
    for (const line of readText(file).split('\n')) {
      let rec: Record<string, unknown>
      try { rec = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const found = userRef(engine, rec, [ref])
      if (found) { inStep = true; continue }
      if (!inStep) continue
      // The next step's prompt — another `(ref-…)` — ends this one. Not any user line: both engines
      // also record context and hook text in the user role, in the middle of a turn.
      if (isOtherStep(engine, rec)) { inStep = false; continue }
      if (engine === 'claude') {
        const content = (rec.message as { content?: unknown } | undefined)?.content
        if (!Array.isArray(content)) continue
        for (const c of content as Array<Record<string, unknown>>) {
          if (rec.type === 'assistant' && c?.type === 'tool_use' && c.name === tool) calls.add(String(c.id))
          if (rec.type === 'user' && c?.type === 'tool_result' && calls.has(String(c.tool_use_id))) {
            outputs.push(textOf(c.content))
            if (c.is_error === true) errored = true
          }
        }
      } else {
        const p = rec.payload as { type?: string; name?: string; namespace?: string; call_id?: string; output?: unknown } | undefined
        if (p?.type === 'function_call' && codexCallName(p) === tool && p.call_id) calls.add(p.call_id)
        if (p?.type === 'function_call_output' && p.call_id && calls.has(p.call_id)) outputs.push(textOf(p.output))
      }
    }
  }
  const answered = !errored && outputs.some((o) => /https?:\/\//.test(o))
  return { called: calls.size > 0, answered, ...(outputs.length ? { output: outputs[0].replace(/\s+/g, ' ').slice(0, 160) } : {}) }
}

/** A user line carrying a step's `(ref-…)` tag (paneProbe.ts checkRef) — the probe's next prompt. */
function isOtherStep(engine: string, rec: Record<string, unknown>): boolean {
  let text = ''
  if (engine === 'claude' && rec.type === 'user') text = textOf((rec.message as { content?: unknown } | undefined)?.content)
  if (engine === 'codex') {
    const p = rec.payload as { type?: string; role?: string; content?: unknown } | undefined
    if (p?.type === 'message' && p.role === 'user') text = textOf(p.content)
  }
  return /\(ref-[0-9a-z]{6}\)/.test(text)
}

function claudeSessionFiles(cwd: string, home: string): string[] {
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))
  } catch {
    return []
  }
}

/** The rollout files of the last day that mention one of this run's refs. */
function codexSessionFiles(refs: readonly string[], home: string): string[] {
  const root = join(home, '.codex', 'sessions')
  const since = Date.now() - 24 * 60 * 60 * 1000
  const hits: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1)
      else if (st.isFile() && e.startsWith('rollout-') && e.endsWith('.jsonl') && st.mtimeMs >= since) {
        const text = readText(p)
        if (refs.some((r) => text.includes(r))) hits.push(p)
      }
    }
  }
  walk(root, 0)
  return hits
}
