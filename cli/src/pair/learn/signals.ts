/**
 * NOTICE (daemons/LEARNING.md): the only things worth learning from are real signals, and the default is
 * that there are none. Fed the same session events the pair sensor reads (emitSessionEvents), on the
 * harnessd that owns the harness, while pairing is on. No model.
 *
 *   correction      The person's next prompt after an agent's turn starts by correcting it: "no, …",
 *                   "don't …", "stop, …", "that's wrong", "instead …", "not like that", "revert …". A bare
 *                   "no" answers a question and is not one; "no, that's fine" is not one either.
 *   repeat-failure  The same failure — the same failing test, or the same failing command when no test is
 *                   named — on two different engines or harnesses in the same project within 7 days.
 *   repeat-steps    The same sequence of three or more command steps, in separate turns, three times in
 *                   one project.
 *
 * Replays, sub-agents, terminals and archived pair chats are the caller's to leave out;
 * the collection DSH's real work is included, while its tool-free reviews never register as agents.
 * prompts the daemon itself sent (`daemonSent`) are never a person correcting anything. Every signal
 * carries its provenance — engine, machine, agent, session, turn, the project as a hash — and its
 * evidence trimmed and redacted (guard.ts). The failures and step sequences seen are kept in a small
 * 0600 file so a restart does not forget a week.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { redactDeep, untrusted } from './guard.js'
import { contentHash, projectHash, projectName, type Provenance, type Signal } from './types.js'

export const FAILURE_WINDOW_MS = 7 * 24 * 60 * 60_000
export const STEPS_WINDOW_MS = 30 * 24 * 60 * 60_000
export const STEPS_MIN = 3
export const STEPS_MAX = 5
export const STEPS_REPEATS = 3
const FAILURES_MAX = 500
const WINDOWS_MAX = 2_000
const EVIDENCE_MAX = 240

// ── correction ──────────────────────────────────────────────────────────────────────────────────────

const CORRECTION: RegExp[] = [
  /^(no|nope|nah)\s*[,.!;:—–-]+\s*\S/,           // "no, use pnpm" — a bare "no" answers a question
  /^no\s+no\b/,
  /^(don'?t|dont|do not)\s+(?!worry\b|mind\b)[a-z]/,        // "don't touch the lockfile"
  /^stop\s*([,.!;:—–-]|$)/,                         // "stop." / "stop, that's the wrong file"
  /^stop\s+(it|that|this|doing|[a-z]+ing)\b/,              // "stop editing the tests" (not "stop the server")
  /^(that'?s|that is|this is|it'?s|you'?re)\s+(wrong|not right|incorrect|not what i (asked|meant|wanted)|the wrong)\b/,
  /^wrong\b/,
  /^instead\b/,
  /^not like that\b/,
  /^revert\b/,
  /^undo (that|this|it|the|your)\b/,
]
/** "no, thanks", "no, that's fine": a person answering, not correcting. */
const NOT_A_CORRECTION = /^(no|nope|nah)\s*[,.!;:—–-]+\s*(thanks|thank you|that'?s (fine|ok|okay|good|all|it)|it'?s (fine|ok|okay|good)|all good|looks good|go ahead|carry on|leave it|that'?ll do|not now|not yet|later)\b/

/** The person's prompt corrects what the agent just did. A heuristic: tested both ways in signals.spec.ts. */
export function isCorrection(text: string): boolean {
  const flat = text.replace(/[‘’]/g, '\'').replace(/^[\s>"'`*_(]+/, '').trim().toLowerCase()
  if (!flat) return false
  if (NOT_A_CORRECTION.test(flat)) return false
  return CORRECTION.some((pattern) => pattern.test(flat))
}

// ── commands and steps ──────────────────────────────────────────────────────────────────────────────

const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'unified_exec', 'run_terminal_cmd', 'run_shell_command', 'terminal', 'execute_command', 'command'])

/** The command a shell tool call ran, or null when the tool is not a shell or the shape is not plain. */
export function shellCommand(tool: string, input: unknown): string | null {
  if (!SHELL_TOOLS.has(tool.replace(/^functions\./, '').toLowerCase())) return null
  let value: unknown = input
  if (typeof input === 'string') {
    try { value = JSON.parse(input) } catch { return input.trim() || null }
  }
  const args = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const command = args ? args.command ?? args.cmd : value
  if (typeof command === 'string') return command.trim() || null
  if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
    // ["bash", "-lc", "npm test"] is the command "npm test".
    if (command.length === 3 && /(^|\/)(ba|z)?sh$/.test(command[0]) && ['-c', '-lc'].includes(command[1])) return command[2].trim() || null
    return command.join(' ').trim() || null
  }
  return null
}

/** Reads and probes: they fail harmlessly (grep finds nothing, diff finds a difference) and teach nothing. */
const NOISE = /^(ls|ll|cat|less|more|head|tail|grep|egrep|fgrep|rg|ag|find|fd|test|\[|which|type|command|echo|printf|pwd|wc|stat|file|diff|cmp|tree|sed|awk|jq|sort|uniq|cut|true|false|sleep|clear|history|env|printenv|date|whoami|open|code|git (status|diff|log|show|branch|rev-parse|remote|fetch|blame|ls-files|grep))(\s|$)/

const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'cargo', 'go', 'make', 'just', 'uv', 'uvx', 'poetry', 'pip', 'pip3',
  'python', 'python3', 'node', 'deno', 'docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform', 'bundle', 'rake', 'rails', 'mix', 'gradle',
  './gradlew', 'mvn', 'dotnet', 'git', 'gh', 'swift', 'xcodebuild', 'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'prettier', 'ruff', 'mypy', 'alembic',
  'prisma', 'turbo', 'nx', 'rspec', 'php', 'ruby', 'composer', 'artisan', 'flutter', 'dart', 'zig', 'cmake', 'ctest', 'tox', 'nox', 'hatch', 'pdm', 'rye'])

/** One command split into what it runs, in order: `cd x && npm ci && npm test` is `npm ci`, `npm test`. */
export function segments(command: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\\' && quote !== "'") { i++; continue }
    if (quote) { if (c === quote) quote = null; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    // Heredocs, substitutions and compound scripts need a real shell grammar. Omit the
    // whole call rather than teach lines of Python/JS (or strings) as shell commands.
    if (c === '`' || c === '(' || c === ')' || (c === '<' && command[i + 1] === '<')) return []
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]!))) {
      const end = command.indexOf('\n', i)
      const part = command.slice(start, i).trim()
      if (part) parts.push(part)
      if (end < 0) return parts
      i = end; start = end + 1; continue
    }
    if (c === ';' || c === '\n' || (c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      const part = command.slice(start, i).trim()
      if (part) parts.push(part)
      if (c === '&' || c === '|') i++
      start = i + 1
    }
  }
  if (quote) return []
  const last = command.slice(start).trim()
  if (last) parts.push(last)
  return parts
}

/**
 * A step, as sequences are compared: the program and what it was asked to do, without its arguments —
 * `npm run db:reset`, `cargo test`, `./scripts/migrate.sh`. Null for a `cd`, a read or a probe.
 */
export function stepOf(segment: string): string | null {
  const words = segment.split(/\s+/).filter(Boolean)
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()   // FOO=1 npm test
  const program = words[0]
  if (!program || program === 'cd' || program === 'pushd' || program === 'popd' || program === 'export' || program === 'source') return null
  if (NOISE.test(words.join(' '))) return null
  const head = program.startsWith('/') ? program.split('/').pop()! : program
  if (!RUNNERS.has(head)) return head
  const rest: string[] = []
  let skipValue = false
  for (const word of words.slice(1)) {
    if (skipValue) { skipValue = false; continue }
    if (word.startsWith('-')) { skipValue = VALUE_FLAGS.has(word) && !(word === '-m' && head.startsWith('python')); continue }
    const path = /[/\\]|\.\w{1,4}$|^['"]/.test(word) && !/^[\w:-]+$/.test(word)
    // `python manage.py migrate`: an interpreter's script is part of the step, and so is its subcommand.
    if (path && rest.length === 0 && INTERPRETERS.has(head) && /^[\w./-]+\.(py|js|mjs|cjs|ts|rb|php)$/.test(word)) { rest.push(word.split('/').pop()!); continue }
    if (path) break
    rest.push(word)
    // `npm run build`, `uv run pytest`: the script is the step. Otherwise the subcommand is.
    if (rest.length === 1 && SCRIPT_RUNNERS.has(head) && ['run', 'exec', 'x', 'dlx', 'run-script'].includes(word)) continue
    break
  }
  return [head, ...rest].join(' ')
}

/** Flags whose value is the next word, not the subcommand: `pnpm -C cli test`, `cargo -p core test`. */
const VALUE_FLAGS = new Set(['-C', '--dir', '--prefix', '--filter', '-F', '--cwd', '--workspace', '-w', '-p', '--package', '--manifest-path', '-f', '--file', '-m'])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'deno', 'bun', 'php', 'ruby'])
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'pdm', 'hatch', 'rye', 'deno'])

// ── failures ────────────────────────────────────────────────────────────────────────────────────────

const TEST_FAILURE: RegExp[] = [
  /^\s*FAIL\s+(\S+\.(?:spec|test)\.[cm]?[jt]sx?(?:\s+>\s+.+?)?)\s*(?:\d+\s*ms)?\s*$/,     // vitest / jest file line
  /^\s*[×✗✕]\s+(.+?)\s*(?:\d+\s*ms)?\s*$/,                                               // vitest test line
  /^\s*●\s+(.+\s›\s.+?)\s*$/,                                                            // jest
  /^\s*FAILED\s+(\S+::\S+)/,                                                              // pytest
  /^\s*---\s+FAIL:\s+(\S+)/,                                                              // go test
  /^\s*test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/,                                               // cargo test
]

/** The tests a failing run names, at most five. `suite > name` is dropped for `file > suite > name`. */
export function failingTests(output: string): string[] {
  const names: string[] = []
  for (const line of output.split('\n')) {
    for (const pattern of TEST_FAILURE) {
      const match = pattern.exec(line)
      const name = match?.[1]?.trim()
      if (name && !names.includes(name)) names.push(name)
      if (match) break
    }
    if (names.length >= 20) break
  }
  return names.filter((name) => !names.some((other) => other !== name && other.endsWith(` > ${name}`))).slice(0, 5)
}

// ── the detector ────────────────────────────────────────────────────────────────────────────────────

export interface LearnContext {
  agentId: string
  sessionId: string
  engine: string
  cwd: string | null
}

/** A session event as emitSessionEvents carries it (lib/normalize.ts LiveEvent | SessionEvent). */
export interface LearnEvent { type: string; payload?: unknown }

interface Step { head: string | null; command: string }

interface Track {
  sessionId: string
  engine: string
  cwd: string | null
  project: string | null
  turn: number
  open: boolean
  /** A turn of this session has ended while this daemon watched: the next prompt answers it. */
  hadTurn: boolean
  steps: Step[]
  /** What the agent ran in its last turn, for a correction's evidence. */
  last: string[]
  /** The end of what the agent said in its last turn. */
  lastText: string
  text: string
  starts: Map<string, { tool: string; command: string | null }>
}

interface FailureSeen {
  key: string
  what: 'test' | 'command'
  name: string
  from: Provenance
  evidence: string
}

interface WindowTurn { from: Provenance; commands: string[] }

interface SignalsState {
  v: 2
  failures: FailureSeen[]
  windows: Record<string, WindowTurn[]>
  signaled: Record<string, number>
}

export interface LessonSignalsDeps {
  now: () => number
  /** This machine's name, for provenance. */
  machine: () => string
  onSignal: (signal: Signal) => void
  /** Where failures and step sequences are kept across restarts (0600); null keeps them in memory. */
  file?: string | null
  /** This computer's home folder, redacted to `~` in evidence. */
  home?: string | null
}

export class LessonSignals {
  private readonly tracks = new Map<string, Track>()
  /** Prompts the daemon typed (a pair tool, a rule): never the person correcting anything. */
  private readonly sent = new Map<string, string[]>()
  private loaded: SignalsState | null = null

  /** Read on first use (a signal to notice), never at construction: with daemons off nothing is read. */
  constructor(private readonly deps: LessonSignalsDeps) {}

  private get state(): SignalsState {
    this.loaded ??= this.load()
    return this.loaded
  }

  /** The daemon itself sent this prompt (pair/owner.ts send). */
  daemonSent(agentId: string, text: string): void {
    const list = [...(this.sent.get(agentId) ?? []), text.trim()].slice(-5)
    this.sent.set(agentId, list)
  }

  forget(agentId: string): void {
    this.tracks.delete(agentId)
    this.sent.delete(agentId)
  }

  /** Events from one session, live. `replay` (re-read, resumed) is history: nothing is noticed in it. */
  ingest(ctx: LearnContext, events: readonly LearnEvent[], opts: { replay?: boolean } = {}): void {
    if (opts.replay || !ctx.agentId) return
    for (const event of events) {
      const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>
      switch (event.type) {
        case 'turn_started': this.turnStarted(ctx, typeof payload.userMessage === 'string' ? payload.userMessage : ''); break
        case 'tool_start': this.toolStarted(ctx, payload); break
        case 'tool_end': this.toolEnded(ctx, payload); break
        case 'text_delta': this.textDelta(ctx, payload); break
        case 'turn_ended': this.turnEnded(ctx, payload.aborted === true); break
        default: break
      }
    }
  }

  private track(ctx: LearnContext): Track {
    let t = this.tracks.get(ctx.agentId)
    if (!t || t.sessionId !== ctx.sessionId) {
      t = {
        sessionId: ctx.sessionId, engine: ctx.engine, cwd: ctx.cwd, project: projectHash(ctx.cwd), turn: 0, open: false,
        hadTurn: false, steps: [], last: [], lastText: '', text: '', starts: new Map(),
      }
      this.tracks.set(ctx.agentId, t)
    }
    t.engine = ctx.engine
    if (ctx.cwd && ctx.cwd !== t.cwd) { t.cwd = ctx.cwd; t.project = projectHash(ctx.cwd) }
    return t
  }

  private provenance(ctx: LearnContext, t: Track): Provenance {
    return { engine: ctx.engine, machine: this.deps.machine(), agentId: ctx.agentId, session: ctx.sessionId, turn: t.turn, project: t.project, at: this.deps.now() }
  }

  private clean(text: string, max = EVIDENCE_MAX): string {
    return untrusted(text, max, { home: this.deps.home ?? null })
  }

  // ── correction ──────────────────────────────────────────────────────────────────────────────────────

  private turnStarted(ctx: LearnContext, message: string): void {
    const t = this.track(ctx)
    const sent = this.sent.get(ctx.agentId) ?? []
    const byDaemon = sent.includes(message.trim())
    if (byDaemon) this.sent.set(ctx.agentId, sent.filter((text) => text !== message.trim()))
    if (t.hadTurn && !t.open && !byDaemon && isCorrection(message)) {
      const said = this.clean(message)
      const before = t.last.slice(-5).map((command) => this.clean(command, 160))
      const lastText = t.lastText ? this.clean(t.lastText, 300) : ''
      this.emit({
        kind: 'correction',
        key: `correction:${t.project ?? '-'}:${contentHash(said.toLowerCase())}`,
        project: t.project, projectName: projectName(t.cwd), at: this.deps.now(),
        from: [{ ...this.provenance(ctx, t), turn: t.turn + 1 }],
        evidence: [`the person said: ${said}`, ...before.map((command) => `the agent ran: ${command}`), ...(lastText ? [`the agent said: ${lastText}`] : [])],
        correction: { said, before },
      })
    }
    t.turn++
    t.open = true
    t.steps = []
    t.text = ''
    t.starts.clear()
  }

  private textDelta(ctx: LearnContext, payload: Record<string, unknown>): void {
    const t = this.tracks.get(ctx.agentId)
    if (!t || typeof payload.content !== 'string') return
    t.text = `${t.text}${payload.content}`.slice(-600)
  }

  // ── tools ───────────────────────────────────────────────────────────────────────────────────────────

  private toolStarted(ctx: LearnContext, payload: Record<string, unknown>): void {
    const t = this.track(ctx)
    const id = typeof payload.id === 'string' ? payload.id : ''
    const tool = typeof payload.tool === 'string' ? payload.tool : ''
    if (!id || !tool || payload.parentToolUseId) return
    t.starts.set(id, { tool, command: shellCommand(tool, payload.input) })
    if (t.starts.size > 200) t.starts.delete(t.starts.keys().next().value as string)
  }

  private toolEnded(ctx: LearnContext, payload: Record<string, unknown>): void {
    const t = this.track(ctx)
    const id = typeof payload.id === 'string' ? payload.id : ''
    const started = t.starts.get(id)
    t.starts.delete(id)
    const command = started?.command ?? null
    if (!command) return
    for (const segment of segments(command)) t.steps.push({ head: stepOf(segment), command: segment })
    if (t.steps.length > 200) t.steps.splice(0, t.steps.length - 200)
    if (payload.isError !== true) return
    const output = typeof payload.output === 'string' ? payload.output : ''
    const tests = failingTests(output).map((name) => this.clean(name, 160)).filter(Boolean)
    const failures: Array<{ what: 'test' | 'command'; name: string }> = tests.map((name) => ({ what: 'test', name }))
    if (!failures.length) {
      // The failing part of a chain: the last step that is not a read or a probe.
      const last = segments(command).filter((segment) => stepOf(segment) !== null).pop()
      if (last) failures.push({ what: 'command', name: this.clean(last, 120) })
    }
    const evidence = this.clean(`${command} -> ${output.split('\n').filter((line) => line.trim()).slice(-3).join(' | ')}`)
    // Every failure is remembered; one run that fails five tests is still one signal at most.
    let spoke = false
    for (const failure of failures) spoke = this.failure(ctx, t, failure, evidence, !spoke) || spoke
  }

  private failure(ctx: LearnContext, t: Track, failure: { what: 'test' | 'command'; name: string }, evidence: string, mayEmit: boolean): boolean {
    // Two harnesses whose folders are unknown are not known to share a project: nothing to pair.
    if (!t.project) return false
    const now = this.deps.now()
    const key = `${failure.what}:${t.project}:${failure.name}`
    const from = this.provenance(ctx, t)
    this.state.failures = this.state.failures.filter((f) => now - f.from.at < FAILURE_WINDOW_MS)
    const other = this.state.failures.find((f) => f.key === key && (f.from.engine !== from.engine || f.from.agentId !== from.agentId))
    const same = this.state.failures.some((f) => f.key === key && f.from.agentId === from.agentId && f.from.session === from.session && f.from.turn === from.turn)
    if (!same) this.state.failures.push({ key, what: failure.what, name: failure.name, from, evidence })
    if (this.state.failures.length > FAILURES_MAX) this.state.failures.splice(0, this.state.failures.length - FAILURES_MAX)
    const signalKey = `fail:${key}`
    let emitted = false
    if (mayEmit && other && !this.recentlySignaled(signalKey, FAILURE_WINDOW_MS)) {
      this.state.signaled[signalKey] = now
      emitted = true
      this.emit({
        kind: 'repeat-failure', key: signalKey, project: t.project, projectName: projectName(t.cwd), at: now,
        from: [other.from, from], evidence: [other.evidence, evidence], failure,
      })
    }
    this.save()
    return emitted
  }

  // ── steps ───────────────────────────────────────────────────────────────────────────────────────────

  private turnEnded(ctx: LearnContext, aborted: boolean): void {
    const t = this.tracks.get(ctx.agentId)
    if (!t || !t.open) return
    t.open = false
    t.hadTurn = true
    t.last = t.steps.map((step) => step.command)
    t.lastText = t.text
    if (!aborted) this.sequences(ctx, t)
  }

  private sequences(ctx: LearnContext, t: Track): void {
    if (!t.project) return
    const steps: Step[] = []
    for (const step of t.steps) {
      if (!step.head) continue
      if (steps.length && steps[steps.length - 1]!.head === step.head) { steps[steps.length - 1] = step; continue }
      steps.push(step)
    }
    if (steps.length < STEPS_MIN) return
    const now = this.deps.now()
    const from = this.provenance(ctx, t)
    const touched = new Set<string>()
    for (let len = Math.min(STEPS_MAX, steps.length); len >= STEPS_MIN; len--) {
      for (let i = 0; i + len <= steps.length; i++) {
        const window = steps.slice(i, i + len)
        if (new Set(window.map((s) => s.head)).size < 2) continue
        const key = `steps:${t.project}:${window.map((s) => s.head).join(' > ')}`
        if (touched.has(key)) continue
        touched.add(key)
        const turns = (this.state.windows[key] ?? []).filter((w) => now - w.from.at < STEPS_WINDOW_MS)
        const here = turns.some((w) => w.from.agentId === from.agentId && w.from.session === from.session && w.from.turn === from.turn)
        if (!here) turns.push({ from, commands: window.map((s) => this.clean(s.command, 160)) })
        this.state.windows[key] = turns.slice(-10)
      }
    }
    this.prune(now)
    // The longest sequence that reached the count this turn, and none of the shorter ones inside it.
    const ready = [...touched]
      .filter((key) => (this.state.windows[key]?.length ?? 0) >= STEPS_REPEATS && !this.recentlySignaled(key, STEPS_WINDOW_MS))
      .sort((a, b) => b.split(' > ').length - a.split(' > ').length)
    const chosen = ready[0]
    if (chosen) {
      const turns = this.state.windows[chosen]!
      const prefix = `steps:${t.project}:`
      const heads = chosen.slice(prefix.length).split(' > ')
      const inside = ` > ${chosen.slice(prefix.length)} > `
      for (const key of touched) if (inside.includes(` > ${key.slice(prefix.length)} > `)) this.state.signaled[key] = now
      this.state.signaled[chosen] = now
      this.emit({
        kind: 'repeat-steps', key: chosen, project: t.project, projectName: projectName(t.cwd), at: now,
        from: turns.map((w) => w.from), steps: heads,
        evidence: turns.slice(-3).map((w) => w.commands.join(' ; ')),
      })
    }
    this.save()
  }

  // ── state ───────────────────────────────────────────────────────────────────────────────────────────

  private recentlySignaled(key: string, windowMs: number): boolean {
    const at = this.state.signaled[key]
    return at !== undefined && this.deps.now() - at < windowMs
  }

  private prune(now: number): void {
    for (const [key, turns] of Object.entries(this.state.windows)) {
      const kept = turns.filter((w) => now - w.from.at < STEPS_WINDOW_MS)
      if (kept.length) this.state.windows[key] = kept
      else delete this.state.windows[key]
    }
    const keys = Object.keys(this.state.windows)
    if (keys.length > WINDOWS_MAX) {
      keys.sort((a, b) => lastAt(this.state.windows[a]!) - lastAt(this.state.windows[b]!))
      for (const key of keys.slice(0, keys.length - WINDOWS_MAX)) delete this.state.windows[key]
    }
    for (const [key, at] of Object.entries(this.state.signaled)) if (now - at >= STEPS_WINDOW_MS) delete this.state.signaled[key]
  }

  private emit(signal: Signal): void {
    try { this.deps.onSignal(signal) } catch (err) {
      console.warn(`[learn] signal handler failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private load(): SignalsState {
    const empty: SignalsState = { v: 2, failures: [], windows: {}, signaled: {} }
    if (!this.deps.file) return empty
    try {
      const parsed = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Omit<SignalsState, 'v'>> & { v?: number }
      if (parsed?.v !== 1 && parsed?.v !== 2) return empty
      return {
        v: 2,
        failures: Array.isArray(parsed.failures) ? parsed.failures : [],
        // v1 split script bodies into commands. Rebuild only that derived index from new work.
        windows: parsed.v === 2 && parsed.windows && typeof parsed.windows === 'object' ? parsed.windows : {},
        signaled: parsed.signaled && typeof parsed.signaled === 'object'
          ? Object.fromEntries(Object.entries(parsed.signaled).filter(([key]) => parsed.v === 2 || !key.startsWith('steps:'))) : {},
      }
    } catch { return empty }
  }

  private save(): void {
    const file = this.deps.file
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(redactDeep(this.state, { home: this.deps.home ?? null })), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
    } catch (err) {
      console.warn(`[learn] could not save signals: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function lastAt(turns: WindowTurn[]): number {
  return turns.reduce((max, w) => Math.max(max, w.from.at), 0)
}
