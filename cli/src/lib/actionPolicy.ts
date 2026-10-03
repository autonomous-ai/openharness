// Originally written by Fred Nix (@nixfred) in github.com/nixfred/openharness (MIT).

/**
 * The destructive-action gate. A per-machine policy file names tool calls that must be asked about or
 * refused before the engine runs them. The decision is handed back through the engine's own hook
 * (Claude Code PreToolUse `permissionDecision`), so the prompt appears in the terminal and reaches the
 * device through the question watcher that already mirrors permission dialogs. Nothing here executes;
 * it only classifies.
 */
export type GateDecision = 'allow' | 'ask' | 'deny'

export interface GateRule {
  /** Human name, shown as the reason. */
  name: string
  /** Tool names this applies to; empty means every tool. */
  tools?: string[]
  /** Regex (source) matched against the flattened tool input. */
  pattern: string
  decision: Exclude<GateDecision, 'allow'>
}

/**
 * A lane: rules that apply only to agents whose name matches. This is how a fleet says "the planner
 * never pushes, the publisher never posts without me": one policy file, one lane per role, the
 * machine-wide rules still apply underneath.
 */
export interface GateLane {
  name: string
  /** Regex (source) matched case-insensitively against the agent's display name. */
  agent: string
  rules: GateRule[]
}

export interface ActionPolicy {
  version: 1
  enabled: boolean
  rules: GateRule[]
  /** Substrings that, when present in the flattened input, always allow (for known-safe wrappers). */
  allowIf?: string[]
  lanes?: GateLane[]
}

const HOME = '(?:~|\\$HOME|/home/[^/\\s]+|/Users/[^/\\s]+)'

/** What `harness gate init` writes when no policy file exists: ask before risky writes, refuse the unrecoverable. */
export const DEFAULT_POLICY: ActionPolicy = {
  version: 1,
  enabled: true,
  rules: [
    { name: 'git push', tools: ['Bash'], pattern: '\\bgit\\s+push\\b', decision: 'ask' },
    { name: 'force push', tools: ['Bash'], pattern: '\\bgit\\s+push\\b[^\\n]*(--force|-f\\b|\\+\\S)', decision: 'ask' },
    { name: 'git reset --hard / checkout -- / restore .', tools: ['Bash'], pattern: '\\bgit\\s+(reset\\s+--hard|checkout\\s+--\\s|restore\\s+\\.|clean\\s+-\\w*f)', decision: 'ask' },
    { name: 'branch delete', tools: ['Bash'], pattern: '\\bgit\\s+branch\\s+-D\\b', decision: 'ask' },
    { name: 'recursive delete', tools: ['Bash'], pattern: '\\brm\\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\\b|-R\\b)', decision: 'ask' },
    { name: 'sudo / doas', tools: ['Bash'], pattern: '(^|[\\s;&|])(sudo|doas)\\s', decision: 'ask' },
    { name: 'disk or filesystem write', tools: ['Bash'], pattern: '\\b(mkfs(\\.\\w+)?\\b|dd\\s+if=|wipefs\\b|fdisk\\b|parted\\b)', decision: 'deny' },
    { name: 'curl or wget piped to a shell', tools: ['Bash'], pattern: '\\b(curl|wget)\\b[^\\n|]*\\|\\s*(sudo\\s+)?(ba|z|da)?sh\\b', decision: 'ask' },
    { name: 'world-writable chmod', tools: ['Bash'], pattern: '\\bchmod\\s+(-R\\s+)?[0-7]?777\\b', decision: 'ask' },
    { name: 'kill everything', tools: ['Bash'], pattern: '\\b(pkill|killall)\\s+(-9\\s+)?(-f\\s+)?["\']?(claude|codex|tmux|harness|node)\\b', decision: 'ask' },
    { name: 'write under ~/.claude', tools: ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'], pattern: `${HOME}/\\.claude/`, decision: 'ask' },
    { name: 'write under ~/.ssh or ~/.env', tools: ['Bash', 'Write', 'Edit', 'MultiEdit'], pattern: `${HOME}/(\\.ssh/|\\.env\\b|\\.gnupg/)`, decision: 'deny' },
    { name: 'systemd unit or service change', tools: ['Bash'], pattern: '\\bsystemctl\\s+(--user\\s+)?(enable|disable|mask|stop|restart)\\b', decision: 'ask' },
    { name: 'omarchy refresh (factory reset)', tools: ['Bash'], pattern: '\\bomarchy\\s+refresh\\b|omarchy-refresh-', decision: 'deny' },
  ],
  allowIf: ['--dry-run'],
}

/** Flatten any tool input into one searchable string (command, file_path, content, nested fields). */
export function flattenToolInput(input: unknown, depth = 0): string {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input === 'number' || typeof input === 'boolean') return String(input)
  if (depth > 4) return ''
  if (Array.isArray(input)) return input.map((v) => flattenToolInput(v, depth + 1)).join('\n')
  if (typeof input === 'object') return Object.values(input as Record<string, unknown>).map((v) => flattenToolInput(v, depth + 1)).join('\n')
  return ''
}

export interface GateVerdict { decision: GateDecision; rule: string | null; reason: string }

const compiled = new WeakMap<GateRule, RegExp>()
function regex(rule: GateRule): RegExp {
  let re = compiled.get(rule)
  if (!re) { re = new RegExp(rule.pattern, 'i'); compiled.set(rule, re) }
  return re
}

const laneRegex = new WeakMap<GateLane, RegExp>()
function laneMatches(lane: GateLane, agentName: string): boolean {
  let re = laneRegex.get(lane)
  if (!re) { re = new RegExp(lane.agent, 'i'); laneRegex.set(lane, re) }
  return re.test(agentName)
}

/** Deny beats ask beats allow. An `allowIf` substring short-circuits to allow. Lane rules run first. */
export function evaluateToolCall(policy: ActionPolicy, toolName: string, input: unknown, agentName = ''): GateVerdict {
  if (!policy.enabled) return { decision: 'allow', rule: null, reason: 'gate disabled' }
  const text = flattenToolInput(input)
  if (!text) return { decision: 'allow', rule: null, reason: 'no input' }
  for (const safe of policy.allowIf ?? []) if (text.includes(safe)) return { decision: 'allow', rule: null, reason: `allowIf ${safe}` }
  let verdict: GateVerdict = { decision: 'allow', rule: null, reason: 'no rule matched' }
  const laneRules = (policy.lanes ?? []).filter((l) => agentName && laneMatches(l, agentName)).flatMap((l) => l.rules.map((r) => ({ ...r, name: `${l.name}: ${r.name}` })))
  for (const rule of [...laneRules, ...policy.rules]) {
    if (rule.tools && rule.tools.length && !rule.tools.includes(toolName)) continue
    if (!regex(rule).test(text)) continue
    if (rule.decision === 'deny') return { decision: 'deny', rule: rule.name, reason: `${rule.name} is refused by the machine policy` }
    if (verdict.decision === 'allow') verdict = { decision: 'ask', rule: rule.name, reason: `${rule.name} needs your approval` }
  }
  return verdict
}

/** Validate a parsed policy file; returns the policy or a list of problems. Unknown fields are kept. */
export function parsePolicy(raw: unknown): { ok: true; policy: ActionPolicy } | { ok: false; problems: string[] } {
  const problems: string[] = []
  if (!raw || typeof raw !== 'object') return { ok: false, problems: ['policy must be an object'] }
  const p = raw as Record<string, unknown>
  if (p.version !== 1) problems.push('version must be 1')
  if (typeof p.enabled !== 'boolean') problems.push('enabled must be a boolean')
  if (!Array.isArray(p.rules)) problems.push('rules must be an array')
  else p.rules.forEach((r, i) => {
    const rule = r as Record<string, unknown>
    if (typeof rule.name !== 'string' || !rule.name) problems.push(`rules[${i}].name missing`)
    if (typeof rule.pattern !== 'string') problems.push(`rules[${i}].pattern missing`)
    else { try { new RegExp(rule.pattern) } catch { problems.push(`rules[${i}].pattern is not a valid regex`) } }
    if (rule.decision !== 'ask' && rule.decision !== 'deny') problems.push(`rules[${i}].decision must be ask or deny`)
    if (rule.tools !== undefined && (!Array.isArray(rule.tools) || rule.tools.some((t) => typeof t !== 'string'))) problems.push(`rules[${i}].tools must be strings`)
  })
  if (p.allowIf !== undefined && (!Array.isArray(p.allowIf) || p.allowIf.some((t) => typeof t !== 'string'))) problems.push('allowIf must be strings')
  if (p.lanes !== undefined) {
    if (!Array.isArray(p.lanes)) problems.push('lanes must be an array')
    else p.lanes.forEach((l, i) => {
      const lane = l as Record<string, unknown>
      if (typeof lane.name !== 'string' || !lane.name) problems.push(`lanes[${i}].name missing`)
      if (typeof lane.agent !== 'string') problems.push(`lanes[${i}].agent missing`)
      else { try { new RegExp(lane.agent) } catch { problems.push(`lanes[${i}].agent is not a valid regex`) } }
      if (!Array.isArray(lane.rules)) problems.push(`lanes[${i}].rules must be an array`)
    })
  }
  return problems.length ? { ok: false, problems } : { ok: true, policy: raw as ActionPolicy }
}

/** The JSON Claude Code expects on a PreToolUse hook's stdout for a non-allow verdict. */
export function claudePreToolUseOutput(v: GateVerdict): Record<string, unknown> | null {
  if (v.decision === 'allow') return null
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: v.decision,
      permissionDecisionReason: `Harness gate: ${v.reason}`,
    },
  }
}
