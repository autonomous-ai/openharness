// cli/src/orchestrator/flow.ts
import { createHash } from 'node:crypto'
import { LineCounter, isAlias, isCollection, isPair, isScalar, parseDocument, visit, type Document, type Scalar, type YAMLMap } from 'yaml'
import { z } from 'zod'
import { parseCondition } from './conditions.js'
import { globToRegExp } from './outputs.js'
import { OrchestratorError, TRIGGER_RULES, TaskId, TaskSpec, validatePlan } from './model.js'
import type { HarnessChoice } from './prompts.js'

/** File name of the run's pinned copy; absent in runs from before it was recorded, which used flow.yaml. */
export const pinnedFlowName = (path: string): 'flow.yaml' | 'flow.json' => /\.json$/i.test(path) ? 'flow.json' : 'flow.yaml'
export const FLOW_SOURCE_LIMIT = 256 * 1024
export const RUN_STEP_DEFAULT_TIMEOUT_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const
const Duration = z.string().regex(/^[1-9][0-9]{0,5}[smh]$/, 'a duration looks like 90s, 45m or 2h')
const durationMs = (text: string): number => Number(text.slice(0, -1)) * UNIT_MS[text.at(-1) as keyof typeof UNIT_MS]
const FlowDecision = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'a decision id looks like ship or needs-work'), label: z.string().trim().min(1).max(100).optional() })
// Relative, no `..` segment, no backslash or NUL: an output never names a file outside the task folder.
const Glob = z.string().min(1).max(256).regex(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$))[^\\\0]+$/, 'outputs must be relative paths inside the task folder')

const FlowInput = z.strictObject({
  required: z.boolean().optional(),
  default: z.string().max(32_768).optional(),
  description: z.string().max(500).optional(),
})
const FlowTask = z.strictObject({
  id: TaskId,
  title: z.string().trim().min(1).max(100).optional(),
  harness: z.string().min(1).max(129).optional(),
  prompt: z.string().trim().min(1).max(24_000).optional(),
  run: z.string().trim().min(1).max(24_000).describe('Shell command, run in the task folder in its own process group. Exit 0 is success. Inputs are in HARNESS_INPUT_<NAME>; $inputs is not substituted here.').optional(),
  outputs: z.strictObject({ files: z.array(Glob).min(1).max(16), verdict: z.literal('ready').optional() })
    .describe('Agent tasks: when the worker ends a turn and every glob matches a file in the task folder (and .harness/verdict.json says ready, if asked), the task finishes.').optional(),
  timeout: Duration.describe('Limit for one attempt, at most 24h. Shell steps default to 10m; agent tasks and approvals have no default.').optional(),
  retry: z.strictObject({ max_attempts: z.number().int().min(1).max(6), delay: Duration.optional() })
    .describe('Automatic retries: max_attempts is the number of attempts in all, the first attempt included; delay (1s to 60s) is doubled before each next attempt.').optional(),
  depends_on: z.array(TaskId).max(32).optional(),
  when: z.string().min(1).max(300).describe('One comparison against a direct dependency: <task>.state, <task>.decision or <task>.verdict.ready|errors|warnings.').optional(),
  trigger_rule: z.enum(TRIGGER_RULES).describe('When the task may start: all_success (default), all_done, none_failed_min_one_success.').optional(),
  approval: z.union([z.string().trim().min(1).max(4000), z.strictObject({ message: z.string().trim().min(1).max(4000), decisions: z.array(FlowDecision).min(1).max(8).optional() })])
    .describe('Waits for a person to approve or reject. $inputs is substituted in the message. The answer is saved as approval.json.').optional(),
  cancel: z.string().trim().min(1).max(2000).describe('Cancels the whole run with this reason when the task becomes ready (usually under when).').optional(),
  loop: z.strictObject({ until_run: z.string().trim().min(1).max(24_000), max_iterations: z.number().int().min(1).max(20) })
    .describe('Agent tasks: after each turn the daemon runs until_run; a failure goes back to the same agent, at most max_iterations checks.').optional(),
  idle_timeout: Duration.describe('Agent tasks: fail when the agent shows no activity for this long. No default.').optional(),
})
export const FlowFile = z.strictObject({
  spec: z.literal(1),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  description: z.string().max(2000).optional(),
  engine: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), FlowInput).optional(),
  tasks: z.array(FlowTask).min(1).max(64),
})
export type FlowFile = z.infer<typeof FlowFile>
/**
 * The published `flow.schema.json` (without `$id`/`title`). The zod schema stays per field for friendly messages;
 * the task alternatives that compileFlow enforces are stated here for editors and other readers.
 */
export function flowJsonSchema(): Record<string, unknown> {
  const schema: Record<string, unknown> = z.toJSONSchema(FlowFile, { io: 'input' })
  const task = (schema.properties as { tasks: { items: Record<string, unknown> } }).tasks.items
  const without = (...keys: string[]) => ({ anyOf: keys.map(k => ({ required: [k] })) })
  task.oneOf = [
    { description: 'A shell step: run.', required: ['id', 'run'], not: without('harness', 'prompt', 'outputs', 'approval', 'cancel', 'loop', 'idle_timeout') },
    { description: 'An agent task: harness and prompt.', required: ['id', 'harness', 'prompt'], not: without('run', 'approval', 'cancel') },
    { description: 'An approval: waits for a person.', required: ['id', 'approval'], not: without('run', 'harness', 'prompt', 'outputs', 'retry', 'cancel', 'loop', 'idle_timeout') },
    { description: 'A cancel step: stops the run.', required: ['id', 'cancel'], not: without('run', 'harness', 'prompt', 'outputs', 'retry', 'timeout', 'approval', 'loop', 'idle_timeout') },
  ]
  return schema
}
export interface FlowIssue { path: string; message: string; line?: number; col?: number }
export interface ParsedFlow {
  flow: FlowFile; sha256: string; file: string
  /** Source position of a path in the file, so compile errors point at the line too. */
  at(path: readonly PropertyKey[]): { line?: number; col?: number }
}
export interface CompiledFlow { name: string; description?: string; engine?: string; inputs: Record<string, string>; tasks: TaskSpec[]; warnings: string[] }

export class FlowError extends OrchestratorError {
  constructor(readonly file: string, readonly issues: FlowIssue[], code = 'INVALID_FLOW') {
    super(code, issues.map(i => `${file}${i.line ? `:${i.line}:${i.col}` : ''}: ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n'))
  }
}
/**
 * Harness and engine eligibility of a compiled flow, with file positions. Shared by start and --dry-run.
 * An engine problem has path `engine`; every other issue is a harness problem.
 */
export function checkFlowHarnesses(parsed: ParsedFlow, compiled: CompiledFlow, engine: string, catalog: HarnessChoice[], engineSupported: (engine: string) => boolean): FlowIssue[] {
  const issues: FlowIssue[] = []
  if (!engineSupported(engine)) issues.push({ path: 'engine', message: `${engine} cannot run orchestrator work here.`, ...(compiled.engine === engine ? parsed.at(['engine']) : {}) })
  const installed = new Set(catalog.filter(h => engineSupported(h.engine)).map(h => h.id))
  compiled.tasks.forEach((task, index) => {
    // Shell steps, approvals and cancel steps run no harness.
    if (task.run !== undefined || task.approval || task.cancel !== undefined) return
    const own = task.harness.startsWith('engine:') ? task.harness.slice('engine:'.length) : null
    if (own !== null ? !engineSupported(own) : !installed.has(task.harness)) issues.push({
      path: `tasks[${index}] (${task.id})`,
      message: own !== null ? `${task.harness} cannot run orchestrator work here.` : `${task.harness} is not an installed harness on this machine.`,
      ...parsed.at(['tasks', index, 'harness']),
    })
  })
  return issues
}
/** The wire code for harness problems: any non-engine issue makes it a harness problem. */
export const harnessIssueCode = (issues: readonly FlowIssue[]): string => issues.some(i => i.path !== 'engine') ? 'HARNESS_UNAVAILABLE' : 'ENGINE_UNSUPPORTED'
export const inputEnvName = (name: string): string => `HARNESS_INPUT_${name.toUpperCase()}`
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const pathText = (path: readonly PropertyKey[]): string => path.map((p, i) => typeof p === 'number' ? `[${p}]` : `${i ? '.' : ''}${String(p)}`).join('')

/** Parse YAML 1.2 (JSON included) as plain data: one document, no anchors, aliases or tags. */
export function parseFlowSource(source: string, file: string): ParsedFlow {
  if (Buffer.byteLength(source, 'utf8') > FLOW_SOURCE_LIMIT) throw new FlowError(file, [{ path: '', message: 'A flow file is limited to 256 KiB.', line: 1, col: 1 }])
  const lines = new LineCounter()
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: true, uniqueKeys: true, merge: false, schema: 'core', version: '1.2' })
  const issues: FlowIssue[] = doc.errors.map(e => ({ path: '', message: e.message.split('\n')[0], ...e.linePos?.[0] }))
  visit(doc, (_key, node) => {
    const at = (offset = 0): { line: number; col: number } => lines.linePos(offset)
    // toJS() would stringify (and warn with) a collection key's content, which may be a secret.
    if (isPair(node) && !isScalar(node.key)) issues.push({ path: '', message: 'Keys must be plain names.', ...at((node.key as { range?: [number, number, number] } | null)?.range?.[0]) })
    else if (isAlias(node)) issues.push({ path: '', message: 'Aliases are not allowed in a flow.', ...at(node.range?.[0]) })
    else if (isScalar(node) || isCollection(node)) {
      if (node.anchor) issues.push({ path: '', message: 'Anchors are not allowed in a flow.', ...at(node.range?.[0]) })
      if (node.tag) issues.push({ path: '', message: 'Tags are not allowed in a flow.', ...at(node.range?.[0]) })
    }
  })
  if (issues.length) throw new FlowError(file, issues)
  const parsed = FlowFile.safeParse(doc.toJS() as unknown)
  if (!parsed.success) for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') issues.push({ path: pathText(issue.path), message: `Unknown keys: ${issue.keys.join(', ')}`, ...locateKey(doc, lines, issue.path, String(issue.keys[0])) })
    else issues.push({ path: pathText(issue.path), message: issue.message, ...locate(doc, lines, issue.path) })
  }
  if (issues.length || !parsed.success) throw new FlowError(file, issues)
  return { flow: parsed.data, sha256: sha256(source), file, at: path => locate(doc, lines, path) }
}
function locate(doc: Document, lines: LineCounter, path: readonly PropertyKey[]): { line?: number; col?: number } {
  for (let n = path.length; n >= 0; n--) {
    const node = (n ? doc.getIn(path.slice(0, n) as unknown[], true) : doc.contents) as { range?: [number, number, number] } | null | undefined
    if (node?.range) return lines.linePos(node.range[0])
  }
  return {}
}

/**
 * Position of the key itself (`colour:`), not of its value. An unknown key is always a plain scalar key of a parsed map
 * (non-scalar keys were rejected above). Validation sees keys as strings, so `1:` or `true:` are matched by their text and a null key (`null:`, `~:`) by the empty string yaml turns it into.
 */
function locateKey(doc: Document, lines: LineCounter, path: readonly PropertyKey[], key: string): { line: number; col: number } {
  const parent = (path.length ? doc.getIn(path as unknown[], true) : doc.contents) as YAMLMap
  const pair = parent.items.find(item => isScalar(item.key) && (item.key.value === null ? '' : String(item.key.value)) === key)!
  return lines.linePos((pair.key as Scalar).range![0])
}

const references = (text: string, pattern: RegExp): string[] => [...text.matchAll(pattern)].map(m => m[1])
type Kind = 'run' | 'agent' | 'approval' | 'cancel'

/** Compile a parsed flow into the orchestrator's task specs. Every problem is reported at once. */
export function compileFlow(parsed: ParsedFlow, given: Record<string, string>): CompiledFlow {
  const { flow, file } = parsed
  const issues: FlowIssue[] = []
  // Kept with their task's position so the list reads in task order whichever pass found them.
  const found: { index: number; text: string }[] = []
  const warn = (index: number, text: string): void => { found.push({ index, text }) }
  const declared = flow.inputs ?? {}
  // Name only: a value is often a secret.
  for (const name of Object.keys(given)) if (!Object.hasOwn(declared, name)) issues.push({ path: 'inputs', message: `Unknown input: ${name}`, ...parsed.at(['inputs']) })
  // Own properties only: an input may be called `constructor`.
  const inputs: Record<string, string> = Object.create(null)
  for (const [name, input] of Object.entries(declared)) {
    const at = parsed.at(['inputs', name])
    if (input.required && input.default !== undefined) issues.push({ path: `inputs.${name}`, message: 'An input cannot be both required and have a default.', ...at })
    const value = Object.hasOwn(given, name) ? given[name] : input.default
    if (value === undefined && input.required) issues.push({ path: `inputs.${name}`, message: `Missing required input: ${name}`, ...at })
    else inputs[name] = value ?? ''
  }
  const ids = new Set<string>()
  const tasks: { index: number; spec: TaskSpec }[] = []
  const substitute = (text: string): string => text.replace(/\$inputs\.([a-z][a-z0-9_]*)/g, (match, name: string) => Object.hasOwn(inputs, name) ? inputs[name] : match)
  flow.tasks.forEach((t, index) => {
    const fail = (message: string, key?: string): void => { issues.push({ path: `tasks[${index}] (${t.id})`, message, ...parsed.at(key ? ['tasks', index, key] : ['tasks', index]) }) }
    const unknownInputs = (text: string, key: string): void => {
      for (const name of references(text, /\$inputs\.([a-z][a-z0-9_]*)/g)) if (!Object.hasOwn(declared, name)) fail(`Unknown input: $inputs.${name}`, key)
    }
    // Shell commands get inputs through the environment only.
    const shellInputs = (command: string, key: string, where: string): void => {
      for (const name of references(command, /\$inputs\.([A-Za-z0-9_]+)/g)) fail(`Use "$${inputEnvName(name)}" in ${where}; $inputs.${name} is not substituted into shell commands.`, key)
      for (const name of references(command, /\$\{?HARNESS_INPUT_([A-Z0-9_]+)/g)) if (!Object.hasOwn(declared, name.toLowerCase())) fail(`Unknown input: HARNESS_INPUT_${name}`, key)
    }
    if (ids.has(t.id)) fail(`Duplicate task id: ${t.id}`)
    ids.add(t.id)
    // Exactly one kind; with more or fewer, every key that is present is still checked against the kinds present.
    const present = new Set<Kind>([
      ...(t.run !== undefined ? ['run' as const] : []),
      ...(t.harness !== undefined || t.prompt !== undefined ? ['agent' as const] : []),
      ...(t.approval !== undefined ? ['approval' as const] : []),
      ...(t.cancel !== undefined ? ['cancel' as const] : []),
    ])
    const kind = present.size === 1 && !(present.has('agent') && (t.harness === undefined || t.prompt === undefined)) ? [...present][0] : undefined
    if (!kind) fail('A task has exactly one of run, harness + prompt, approval or cancel.')
    const allows = (...kinds: Kind[]): boolean => !present.size || kinds.some(k => present.has(k))
    if (t.outputs && !allows('agent')) fail(present.has('run') ? 'outputs apply to agent tasks; a run step succeeds by its exit code.' : 'outputs apply to agent tasks.', 'outputs')
    if (t.loop && !allows('agent')) fail('loop applies to agent tasks.', 'loop')
    if (t.idle_timeout && !allows('agent')) fail('idle_timeout applies to agent tasks.', 'idle_timeout')
    if (t.retry && !allows('agent', 'run')) fail('retry does not apply to approval or cancel tasks.', 'retry')
    if (t.timeout && !allows('agent', 'run', 'approval')) fail('timeout does not apply to cancel tasks.', 'timeout')
    const timeoutMs = t.timeout ? durationMs(t.timeout) : undefined
    if (timeoutMs !== undefined && timeoutMs > DAY_MS) fail('timeout is limited to 24h.', 'timeout')
    const idleTimeoutMs = t.idle_timeout ? durationMs(t.idle_timeout) : undefined
    if (idleTimeoutMs !== undefined && idleTimeoutMs > DAY_MS) fail('idle_timeout is limited to 24h.', 'idle_timeout')
    const delayMs = t.retry?.delay ? durationMs(t.retry.delay) : undefined
    if (delayMs !== undefined && delayMs > 60_000) fail('retry.delay is 1s to 60s.', 'retry')
    if (t.harness !== undefined && ['run', 'approval', 'cancel'].includes(t.harness)) fail(`"${t.harness}" is reserved; use the ${t.harness} key instead.`, 'harness')
    if (t.run !== undefined) shellInputs(t.run, 'run', 'run steps')
    if (t.loop) shellInputs(t.loop.until_run, 'loop', 'until_run')
    if (t.prompt !== undefined) unknownInputs(t.prompt, 'prompt')
    if (t.cancel !== undefined) unknownInputs(t.cancel, 'cancel')
    const message = typeof t.approval === 'string' ? t.approval : t.approval?.message
    if (message !== undefined) unknownInputs(message, 'approval')
    const decisions = typeof t.approval === 'object' ? t.approval.decisions?.map(d => ({ id: d.id, label: d.label ?? d.id })) : undefined
    for (const [i, d] of (decisions ?? []).entries()) if (decisions!.findIndex(other => other.id === d.id) !== i) fail(`approval.decisions: duplicate id ${d.id}.`, 'approval')
    // The loop check logs are never outputs of the task.
    if (t.outputs?.files.some(glob => /^(?:\.\/)*\.harness\/loop(?:\/|$)/.test(glob))) fail('outputs cannot name .harness/loop/, the loop check logs.', 'outputs')
    if (!kind) return
    if (t.trigger_rule === 'none_failed_min_one_success' && !(t.depends_on ?? []).length) warn(index, `Task ${t.id} uses trigger_rule none_failed_min_one_success without depends_on; it is always skipped.`)
    const common = {
      id: t.id, title: t.title ?? t.id, dependsOn: t.depends_on ?? [],
      ...(t.when ? { when: t.when.trim() } : {}),
      ...(t.trigger_rule ? { triggerRule: t.trigger_rule } : {}),
      ...(t.retry ? { retry: { maxAttempts: t.retry.max_attempts, ...(delayMs !== undefined ? { delayMs } : {}) } } : {}),
    }
    const timeout = timeoutMs !== undefined ? { timeoutMs } : {}
    let spec: TaskSpec
    if (kind === 'run') spec = { ...common, harness: 'run', prompt: t.run!, run: t.run!, timeoutMs: timeoutMs ?? RUN_STEP_DEFAULT_TIMEOUT_MS }
    else if (kind === 'approval') spec = { ...common, harness: 'approval', prompt: substitute(message!), approval: { message: substitute(message!), ...(decisions ? { decisions } : {}) }, ...timeout }
    else if (kind === 'cancel') spec = { ...common, harness: 'cancel', prompt: substitute(t.cancel!), cancel: substitute(t.cancel!) }
    else {
      if (t.loop && timeoutMs === undefined && idleTimeoutMs === undefined) warn(index, `Task ${t.id} loops without timeout or idle_timeout; it may run until someone stops it.`)
      // A loop's check decides when it finishes, so only a plain agent task needs this warning.
      if (!t.outputs && timeoutMs === undefined && !t.loop) warn(index, `Task ${t.id} has neither outputs nor timeout; it finishes only when its worker calls finish or fail.`)
      spec = {
        ...common, harness: t.harness!, prompt: substitute(t.prompt!), ...(t.outputs ? { outputs: t.outputs } : {}), ...timeout,
        ...(t.loop ? { loop: { untilRun: t.loop.until_run, maxIterations: t.loop.max_iterations } } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      }
    }
    tasks.push({ index, spec })
  })
  // Conditions need every task's kind and outputs, so they are checked once all tasks are known.
  flow.tasks.forEach((t, index) => {
    if (t.when === undefined) return
    const fail = (message: string): void => { issues.push({ path: `tasks[${index}] (${t.id})`, message: `when: ${message}`, ...parsed.at(['tasks', index, 'when']) }) }
    const condition = parseCondition(t.when)
    if ('error' in condition) return fail(condition.error)
    const dep = (t.depends_on ?? []).includes(condition.task) ? flow.tasks.find(other => other.id === condition.task) : undefined
    if (!dep) return fail(`${condition.task} is not a direct dependency of ${t.id}.`)
    if (condition.field === 'decision') {
      const declaredDecisions = typeof dep.approval === 'object' ? dep.approval.decisions : undefined
      if (!declaredDecisions) fail(`${dep.id} has no decisions to compare.`)
      else if (!declaredDecisions.some(d => d.id === condition.value)) fail(`${dep.id} has no decision ${condition.value}.`)
    } else if (condition.field.startsWith('verdict.')) {
      if (dep.approval !== undefined || dep.cancel !== undefined) fail(`${dep.id} writes no verdict.`)
      else if (dep.run !== undefined) warn(index, `Task ${t.id}: when reads the verdict of ${dep.id}, a shell step; it must write .harness/verdict.json itself.`)
      else if (dep.outputs?.verdict !== 'ready') warn(index, `Task ${t.id}: when reads the verdict of ${dep.id}, which does not declare outputs.verdict: ready.`)
    }
    const rule = t.trigger_rule ?? 'all_success'
    if (condition.field === 'state' && condition.op === '==') {
      const never = rule === 'all_success' ? ['failed', 'blocked', 'cancelled', 'skipped'] : rule === 'none_failed_min_one_success' ? ['failed', 'blocked', 'cancelled'] : []
      if (never.includes(condition.value)) warn(index, `Task ${t.id}: when ${condition.text} can never be true under trigger_rule ${rule}, which ${rule === 'all_success' ? 'blocks or skips' : 'blocks'} ${t.id} first; use trigger_rule: all_done.`)
    }
  })
  const specs: TaskSpec[] = []
  for (const { index, spec } of tasks) {
    const result = TaskSpec.safeParse(spec)
    if (result.success) specs.push(result.data)
    else for (const issue of result.error.issues) issues.push({ path: `tasks[${index}] (${spec.id}).${pathText(issue.path)}`, message: issue.message, ...parsed.at(['tasks', index]) })
  }
  // Graph problems are independent of field problems: report every unknown dependency, then cycles.
  const unknown = flow.tasks.flatMap((t, index) => (t.depends_on ?? []).filter(dep => !ids.has(dep)).map(dep => ({ path: `tasks[${index}] (${t.id}).depends_on`, message: `Unknown dependency: ${dep}`, ...parsed.at(['tasks', index, 'depends_on']) })))
  issues.push(...unknown)
  if (!unknown.length && specs.length === flow.tasks.length) {
    let valid = true
    try { validatePlan([], specs) } catch (error) {
      // validatePlan only throws OrchestratorError (cycle / unknown dependency).
      valid = false
      issues.push({ path: 'tasks', message: (error as OrchestratorError).message, ...parsed.at(['tasks']) })
    }
    // Literal references only: inputs/<x>/<file> is filled for direct dependencies; shell code and prose are not analyzed.
    const promised = (dep: FlowFile['tasks'][number]): ((file: string) => boolean) | null => {
      const globs = dep.outputs?.files ?? []
      const patterns = dep.run !== undefined ? [/^stdout\.log$/, /^stderr\.log$/] : dep.approval !== undefined ? [/^approval\.json$/] : dep.cancel !== undefined ? [] : globs.map(globToRegExp)
      if (dep.run === undefined && dep.approval === undefined && dep.cancel === undefined && !dep.outputs) return null
      // A folder that a declared glob reaches into counts as declared.
      return file => patterns.some(p => p.test(file)) || globs.some(glob => glob.startsWith(`${file.replace(/\/+$/, '')}/`))
    }
    const seen = new Set<string>()
    if (valid) flow.tasks.forEach((t, index) => {
      const field = (key: string): string[] => key === 'approval' && typeof t.approval === 'object' ? ['approval', 'message'] : key === 'loop' ? ['loop', 'until_run'] : [key]
      const message = typeof t.approval === 'string' ? t.approval : t.approval?.message
      for (const [key, text] of [['prompt', t.prompt], ['run', t.run], ['approval', message], ['loop', t.loop?.until_run]] as const) {
        if (!text) continue
        // `inputs/` starts a path word; the id is a whole id followed by a slash.
        for (const [, id, rest] of text.matchAll(/(?<![^\s'"`=(])inputs\/([a-z][a-z0-9-]{0,63})\/([^\s'"`]*)/g)) {
          if (!(t.depends_on ?? []).includes(id)) {
            const error = `tasks[${index}] ${key} inputs/${id}/`
            if (!seen.has(error)) {
              seen.add(error)
              issues.push({ path: `tasks[${index}] (${t.id})`, message: `inputs/${id}/ is only filled for direct dependencies; add ${id} to depends_on.`, ...parsed.at(['tasks', index, ...field(key)]) })
            }
            continue
          }
          const word = rest.split(/[;|&<>)]/)[0]
          const name = /[*?$]/.test(word) ? '' : word.replace(/[.,:!?]+$/, '') // a glob or variable is not a literal file name
          const isPromised = promised(flow.tasks.find(other => other.id === id)!)
          const warning = `Task ${t.id} reads inputs/${id}/${name}, which ${id} does not declare in outputs.`
          if (name && isPromised && !isPromised(name) && !seen.has(warning)) { seen.add(warning); warn(index, warning) }
        }
      }
    })
  }
  if (issues.length) throw new FlowError(file, issues)
  return { name: flow.name, description: flow.description, engine: flow.engine, inputs, tasks: specs, warnings: found.sort((x, y) => x.index - y.index).map(w => w.text) }
}
