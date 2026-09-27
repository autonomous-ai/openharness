/**
 * `pair.jsonc`: the person's own settings for their paired daemon (daemons/BRAIN.md, "Autonomy dial"),
 * read on EVERY machine, for that machine's harnesses — at `$XDG_CONFIG_HOME/harness/pair.jsonc`,
 * `~/.config/harness/pair.jsonc` when that is unset. JSON with comments and trailing commas.
 *
 *   daemons false turns every daemon off on this machine, whatever the server says: no sensor, brain,
 *           learning, pair harness or zoo reports (lib/daemonsSwitch.ts, the local kill switch). Read on its
 *           own, never waiting for a confirmation: switching off needs nobody's yes.
 *   model   true to let the daemon ask one small model for better status-line words (off by default).
 *   learn   Learning L2 (daemons/LEARNING.md), every part off by default:
 *             borrow  true: what Hermes, Claude Code and Codex learned on their own becomes lesson candidates
 *                     (read-only; proposed like any lesson);
 *             export  ["agents", "claude"]: approved skills are also written to ~/.agents/skills and/or
 *                     ~/.claude/skills, marked as Harness's, for sessions outside Harness.
 *             agentsMd  ["~/code/api"]: projects whose approved notes go into their AGENTS.md (or CLAUDE.md)
 *                     block; every other project's go into its untracked .harness/lessons.md.
 *   rules   answers to give without asking, used only while the account's autonomy is
 *           `act-within-rules`. Each rule: optional `harness` (its name, `*` wildcards), `engine`,
 *           `project` (a folder the harness works in or under, `~` allowed); a `question` pattern
 *           (a case-insensitive regular expression over the question as the daemon shows it); and the
 *           `choice` to answer with — one of the dialog's own options. The first rule that matches wins.
 *
 * A rule can never do what a key could not (pair/floor.ts, pair/classify.ts):
 *   - only on an ALLOW-CLASS permission prompt (a read, test, build, formatter or in-project edit, read
 *     over the whole dialog): never a deny-class prompt (push, force, rm -rf, sudo, deploy, publish,
 *     drop, merge …), never a question the agent asks, never a plan to approve;
 *   - never an option that answers for more than this once ("don't ask again", "allow all …");
 *   - never a terminal or the pair harness itself.
 * And rules are what the person confirmed: a new or changed pair.jsonc takes effect only after they say
 * yes to it at a window (pair/gate.ts); until then the rules confirmed before (or none) apply.
 * Everything a rule does is journaled on this machine (by `rule`) and reported afterwards by the brain.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isApproveOption, isDeclineOption, isPersistentOption, matchOption } from './floor.js'
import type { PairQuestion } from './protocol.js'

export interface PairRule {
  name: string
  harness: RegExp | null
  engine: string | null
  project: string | null
  question: RegExp
  choice: string
}

/** Where approved skills may be exported (pair/learn/export.ts). */
export const EXPORT_DESTINATIONS = ['agents', 'claude'] as const
export type ExportDestination = typeof EXPORT_DESTINATIONS[number]

export interface LearnConfig {
  borrow: boolean
  export: ExportDestination[]
  /** Project folders (absolute) opted in to notes in their AGENTS.md or CLAUDE.md. */
  agentsMd: string[]
}

export interface PairConfig {
  model: boolean
  rules: PairRule[]
  learn: LearnConfig
  /** What was wrong with the file, if anything: it is then read as no rules at all. */
  error?: string
}

export const EMPTY_PAIR_CONFIG: PairConfig = { model: false, rules: [], learn: { borrow: false, export: [], agentsMd: [] } }

/** `learn` as written; anything else in it is off. */
export function parseLearnConfig(raw: unknown, home = homedir()): LearnConfig {
  const learn = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const wanted = Array.isArray(learn.export) ? learn.export : []
  const folders = Array.isArray(learn.agentsMd) ? learn.agentsMd : []
  return {
    borrow: learn.borrow === true,
    export: EXPORT_DESTINATIONS.filter((dest) => wanted.includes(dest)),
    agentsMd: [...new Set(folders.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      .map((f) => resolve(f.trim().replace(/^~(?=\/|$)/, home))))],
  }
}

/** Whether `folder` is one of the opted-in projects, or inside one. */
export function inProjects(folder: string, projects: readonly string[]): boolean {
  const at = resolve(folder)
  return projects.some((p) => at === p || at.startsWith(`${p}/`))
}

export function pairConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(home, '.config')
  return join(base, 'harness', 'pair.jsonc')
}

/** JSON with `//` and `/* *\/` comments and trailing commas, as editors write `.jsonc`. */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') { inString = true; out += c; i++; continue }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue }
    out += c
    i++
  }
  return JSON.parse(withoutTrailingCommas(out))
}

/** Drop a comma that closes nothing but a `}` or `]`, outside strings. */
function withoutTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === '\\') { out += text[i + 1] ?? ''; i++; continue }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; out += c; continue }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += c
  }
  return out
}

const glob = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

/** The settings in `text`; a malformed file or rule is reported and read as nothing, never half used. */
export function parsePairConfig(text: string, home = homedir()): PairConfig {
  let value: unknown
  try { value = parseJsonc(text) } catch (err) {
    return { ...EMPTY_PAIR_CONFIG, error: `pair.jsonc is not JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_PAIR_CONFIG, error: 'pair.jsonc must be an object' }
  const raw = value as { model?: unknown; rules?: unknown; learn?: unknown }
  const rules: PairRule[] = []
  const list = Array.isArray(raw.rules) ? raw.rules : []
  for (const [index, item] of list.entries()) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const where = `rule ${index + 1}`
    if (typeof r.question !== 'string' || !r.question.trim()) return { ...EMPTY_PAIR_CONFIG, error: `${where}: "question" is a pattern and is required` }
    if (typeof r.choice !== 'string' || !r.choice.trim()) return { ...EMPTY_PAIR_CONFIG, error: `${where}: "choice" is required` }
    if (isPersistentOption(r.choice)) return { ...EMPTY_PAIR_CONFIG, error: `${where}: a rule never chooses an option that answers for more than this once` }
    let question: RegExp
    try { question = new RegExp(r.question, 'i') } catch { return { ...EMPTY_PAIR_CONFIG, error: `${where}: "question" is not a valid pattern` } }
    const project = typeof r.project === 'string' && r.project.trim()
      ? resolve(r.project.trim().replace(/^~(?=\/|$)/, home)) : null
    rules.push({
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : where,
      harness: typeof r.harness === 'string' && r.harness.trim() ? glob(r.harness.trim()) : null,
      engine: typeof r.engine === 'string' && r.engine.trim() ? r.engine.trim().toLowerCase() : null,
      project,
      question,
      choice: r.choice.trim(),
    })
  }
  return { model: raw.model === true, rules, learn: parseLearnConfig(raw.learn, home) }
}

export interface RuleSubject { name: string; engine: string; cwd?: string | null }

/**
 * The first rule that answers this question, and the option it keys — or null. The floor is checked
 * here and again by the owner (pair/owner.ts) before a key goes in.
 */
export function matchRule(config: PairConfig, subject: RuleSubject, question: PairQuestion): { rule: PairRule; option: string } | null {
  // Rules answer allow-class permission prompts only: never a deny-class one, never a question the agent
  // asks (AskUserQuestion), never a plan to approve — not even to decline it.
  if (question.deny || !question.permission || !question.allow || question.multi) return null
  for (const rule of config.rules) {
    if (rule.harness && !rule.harness.test(subject.name)) continue
    if (rule.engine && rule.engine !== subject.engine.toLowerCase()) continue
    if (rule.project) {
      const cwd = subject.cwd ? resolve(subject.cwd) : ''
      if (!cwd || (cwd !== rule.project && !cwd.startsWith(`${rule.project}/`))) continue
    }
    if (!rule.question.test(question.text)) continue
    const option = matchOption(question.options, rule.choice)
    if (!option || isPersistentOption(option)) continue
    // Approving: only the one-time yes a [y] key could approve. Declining the allow-class prompt is allowed.
    if (!isDeclineOption(option) && !isApproveOption(option)) continue
    return { rule, option }
  }
  return null
}

export interface RuleRunnerDeps {
  /** Pairing is on and the account's autonomy is `act-within-rules`. */
  active: () => boolean
  config: () => PairConfig
  question: (agentId: string) => PairQuestion | null
  subject: (agentId: string) => RuleSubject | null
  /** PairOwner.answer, as `rule`: the floor again, the dialog's id again, and the journal. */
  answer: (input: { agentId: string; requestId: string; choice: string }, by: 'rule', why: string) =>
    Promise<{ ok: boolean; error?: unknown }>
  log?: (line: string) => void
}

/**
 * What act-within-rules does when a question opens on this machine: the first matching rule answers it
 * through the owner. Null when nothing ran (dial not there, no rule, a stale id).
 */
export function ruleRunner(deps: RuleRunnerDeps): (agentId: string, requestId: string) => Promise<{ rule: string; option: string; ok: boolean; error?: unknown } | null> {
  return async (agentId, requestId) => {
    if (!deps.active()) return null
    const question = deps.question(agentId)
    const subject = deps.subject(agentId)
    if (!question || question.requestId !== requestId || !subject) return null
    const match = matchRule(deps.config(), subject, question)
    if (!match) return null
    const result = await deps.answer({ agentId, requestId, choice: match.option }, 'rule', `rule "${match.rule.name}"`)
    deps.log?.(`[pair] rule "${match.rule.name}" · ${agentId.slice(0, 8)} · ${result.ok ? `answered "${match.option}"` : `refused ${String(result.error)}`}`)
    return { rule: match.rule.name, option: match.option, ok: result.ok, ...(result.ok ? {} : { error: result.error }) }
  }
}

/**
 * The settings file, re-read whenever it changes on disk. A missing file is no rules and no model. What it
 * says is only a request: the daemon runs a file's rules once the person confirmed that exact text at a
 * window (pair/gate.ts `rules(load())`); `get()` is the file as written, confirmed or not.
 */
export class PairConfigFile {
  private cached: PairConfig = EMPTY_PAIR_CONFIG
  private text: string | null = null
  private stamp = ''
  private warned = ''

  constructor(readonly path: string, private readonly home = homedir()) {}

  get(): PairConfig { return this.load().config }

  /** The file as it is now: its settings, and its exact text (null when there is no file). */
  load(): { config: PairConfig; text: string | null } {
    let stamp = ''
    try {
      const stat = statSync(this.path)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch { stamp = 'missing' }
    if (stamp === this.stamp) return { config: this.cached, text: this.text }
    this.stamp = stamp
    if (stamp === 'missing') { this.cached = EMPTY_PAIR_CONFIG; this.text = null; return { config: this.cached, text: null } }
    try {
      this.text = readFileSync(this.path, 'utf8')
      this.cached = parsePairConfig(this.text, this.home)
    } catch (err) {
      this.text = null
      this.cached = { ...EMPTY_PAIR_CONFIG, error: err instanceof Error ? err.message : String(err) }
    }
    if (this.cached.error && this.cached.error !== this.warned) {
      this.warned = this.cached.error
      console.warn(`[pair] ${this.path}: ${this.cached.error} — no rules until it is fixed`)
    }
    return { config: this.cached, text: this.text }
  }
}

/** A commented starting point, for the docs and for anyone writing their first rule. */
export const PAIR_CONFIG_EXAMPLE = `// ~/.config/harness/pair.jsonc — your paired daemon's settings on this machine.
{
  // "daemons": false turns every daemon off on this machine, whatever the account says.
  // Better status-line words from one small model call per question (off by default).
  "model": false,
  // Learning (off by default): borrow what Hermes, Claude Code and Codex learned on their own as lesson
  // candidates; export approved skills to ~/.agents/skills and ~/.claude/skills for sessions outside Harness;
  // and the projects whose notes may go into their AGENTS.md (others get an untracked .harness/lessons.md).
  "learn": { "borrow": false, "export": [], "agentsMd": [] },
  // Answers given without asking, only while autonomy is "act-within-rules".
  // Never on push, force, rm -rf, sudo, deploy, publish, drop or merge; never "don't ask again".
  "rules": [
    {
      "name": "tests in api",
      "harness": "api*",               // the harness's name; * is a wildcard
      "engine": "claude",
      "project": "~/code/api",          // a folder it works in or under
      "question": "^Approve Bash command: npm (run )?test",
      "choice": "Yes",                  // one of the dialog's own options
    },
  ],
}
`
