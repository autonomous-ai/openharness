/** Claude Code runtime metadata and model policy, extracted without changing its observations. */
import { join } from 'node:path'
import { sessionClaudeHome } from '../../lib/engineHomes.js'
import type { EngineRuntime, RuntimeContext, RuntimeModelOption, RuntimeRecord, RuntimeSession, RuntimeState } from '../facets/runtime.js'
import { addOption, currentPaneUi, encodeRuntimeProfile, flattenContent, parseVersion, readJson, record, stripAnsi, text, versionAtLeast } from '../kit/runtime.js'

const CLAUDE_EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
const BASIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CLAUDE_ALIASES = ['default', 'opus', 'fable', 'sonnet', 'haiku'] as const
const CLAUDE_ULTRACODE_MIN_VERSION: [number, number, number] = [2, 1, 209]

function confirmsClaudeAutoEffort(content: string): boolean {
  return [
    /\b(?:set|reset)\b.{0,40}\b(?:effort level|effort)\b.{0,40}\b(?:auto|model default)\b/i,
    /\b(?:effort level|effort)\b.{0,40}\b(?:set|reset)\b.{0,40}\b(?:auto|model default)\b/i,
    /\busing\b.{0,40}\bauto\b.{0,40}\beffort\b/i,
  ].some((pattern) => pattern.test(content))
}

function normalizeClaudeDisplay(value: string): string | null {
  const cleaned = value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\s+\(default\).*$/i, '')
    .replace(/\s+and saved.*$/i, '')
    .replace(/\s+for (?:the )?current session.*$/i, '')
    .trim()
  if (!cleaned) return null
  const alias = /^(default|best|fable|opus|sonnet|haiku)(\[1m\])?$/i.exec(cleaned)
  if (alias) return `${alias[1].toLowerCase()}${alias[2]?.toLowerCase() ?? ''}`
  const family = /^(Fable|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)*)(?:\s+\(1M context\))?/i.exec(cleaned)
  if (family) return `claude-${family[1].toLowerCase()}-${family[2].replace(/\./g, '-')}${/1M context/i.test(cleaned) ? '[1m]' : ''}`
  if (/^claude-[a-z0-9._:-]+(?:\[1m\])?$/i.test(cleaned)) return cleaned.toLowerCase()
  return null
}

function claudeAliasForModel(model: string): string | null {
  const normalized = model.toLowerCase()
  if ((CLAUDE_ALIASES as readonly string[]).includes(normalized)) return normalized
  return /^claude-(opus|fable|sonnet|haiku)(?:-|$)/.exec(normalized)?.[1] ?? null
}

function claudeEfforts(model: string, cliVersion: string | null = null): string[] {
  // `[1m]` marks the 1M-context variant, not a different model — strip it so `claude-opus-5[1m]` gets
  // the same efforts as `claude-opus-5` (otherwise a 1M model looked effort-less and a /model switch
  // reset the observed effort to `auto`). The version match is open-ended (4.7/4.8, then 5+) so a new
  // release like Opus 5 works without a code change.
  const normalized = model.toLowerCase().replace(/\[1m\]$/, '')
  let efforts: string[] = []
  if (/^claude-(?:opus|fable|sonnet)-(?:4-[78]|[5-9]|\d{2,})(?:-|$)/.test(normalized)) efforts = [...BASIC_EFFORTS]
  else if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(normalized)) efforts = ['low', 'medium', 'high', 'max']
  else if (/^(?:fable|opus|sonnet)$/.test(normalized)) efforts = [...BASIC_EFFORTS]
  if (efforts.length > 0 && versionAtLeast(cliVersion, CLAUDE_ULTRACODE_MIN_VERSION)) efforts.push('ultracode')
  return efforts
}

function availableModelMatches(model: string, allowed: string[]): boolean {
  if (model === 'default') return true
  if (allowed.length === 0) return true
  const lower = model.toLowerCase()
  const family = lower.replace(/\[1m\]$/, '')
  const wantsLongContext = lower.endsWith('[1m]')
  return allowed.some((item) => {
    const candidate = item.toLowerCase()
    const sameFamily = candidate.includes(`-${family}-`) || candidate.endsWith(`-${family}`)
    const contextMatches = wantsLongContext === /(?:\[1m\]|1m.context)/i.test(candidate)
    return lower === candidate || lower.startsWith(`${candidate}-`) || lower.startsWith(`${candidate}[`) || (sameFamily && contextMatches)
  })
}

function claudeSettingsFiles(session: RuntimeSession): string[] {
  const root = sessionClaudeHome(session)
  const files = [join(root, 'settings.json')]
  if (session.cwd) {
    files.push(join(session.cwd, '.claude', 'settings.json'))
    files.push(join(session.cwd, '.claude', 'settings.local.json'))
  }
  return files
}

async function claudeAvailableModels(session: RuntimeSession): Promise<string[]> {
  const merged: string[] = []
  for (const file of claudeSettingsFiles(session)) {
    const config = await readJson(file)
    const values = config?.availableModels
    if (!Array.isArray(values)) continue
    for (const value of values) if (typeof value === 'string' && !merged.includes(value)) merged.push(value)
  }
  return merged
}

async function claudeConfiguredEffort(session: RuntimeSession): Promise<string> {
  let configured: string | null = null
  for (const file of claudeSettingsFiles(session)) {
    const config = await readJson(file)
    const raw = text(config?.effortLevel) || text(config?.effort)
    const normalized = raw.toLowerCase() === 'default' ? 'auto' : raw.toLowerCase()
    if (CLAUDE_EFFORTS.has(normalized)) configured = normalized
  }
  return configured ?? 'auto'
}

function claudeStartupBanner(pane: string): { model: string; effort?: string } | null {
  const lines = pane.split('\n')
  const start = lines.findLastIndex(line => /\bClaude Code v\d+\.\d+/.test(line))
  if (start < 0) return null
  const banner = lines.slice(start, start + 4).join('\n')
  const match = /\b(Fable|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)*)(\s+\(1M context\))?(?:\s+with\s+(low|medium|high|xhigh|max|ultracode)\s+effort)?\s*·\s*Claude\s+(?:Max|Pro|Team|Enterprise)\b/i.exec(banner)
  if (!match) return null
  return {
    model: `claude-${match[1].toLowerCase()}-${match[2].replace(/\./g, '-')}${match[3] ? '[1m]' : ''}`,
    ...(match[4] ? { effort: match[4].toLowerCase() } : {}),
  }
}

function decode(raw: Record<string, unknown>): RuntimeRecord | null {
  const cliVersion = text(raw.version)
  const message = record(raw.message)
  const assistantModel = raw.type === 'assistant' ? text(message?.model) : ''
  // Claude uses this marker for local errors such as exhausted quota.
  // It is not a model change; keep the last real observation.
  const model = assistantModel && assistantModel !== '<synthetic>' ? assistantModel : null
  const content = `${flattenContent(message?.content)}\n${flattenContent(raw.content)}`
  const modelMatch = /Set model to\s+(.+?)(?:\n|$)/i.exec(content)
  const setModel = !!modelMatch
  const nextModel = modelMatch ? normalizeClaudeDisplay(modelMatch[1]) : null
  const effortMatch = /Set effort level to\s+(low|medium|high|xhigh|max|ultracode)/i.exec(content)
  const effort = effortMatch?.[1].toLowerCase() ?? (confirmsClaudeAutoEffort(content) ? 'auto' : null)
  const version = parseVersion(cliVersion) ? cliVersion : null
  return version || model || setModel || effort ? { version, model, setModel, nextModel, effort } : null
}

function reduce({ session, state, control }: RuntimeContext, evidence: RuntimeRecord): void {
  const version = text(evidence.version)
  if (parseVersion(version)) { session.cliVersion = version; state.cliVersion = version }
  const model = text(evidence.model)
  if (model) {
    state.model = model
    state.observedAt = Date.now()
  }
  if (evidence.setModel === true) {
    const nextModel = control?.target.model ?? (text(evidence.nextModel) || state.model)
    state.model = nextModel
    if (!control && nextModel && state.effort && !claudeEfforts(nextModel, session.cliVersion).includes(state.effort)) {
      state.effort = 'auto'
    }
    state.observedAt = Date.now()
    if (control) control.modelConfirmed = true
  }
  const effort = text(evidence.effort)
  if (effort) {
    state.effort = effort
    state.observedAt = Date.now()
    if (control) control.effortConfirmed = control.target.effort === 'auto' || state.effort === control.target.effort
  }
}

function transcript(context: RuntimeContext, raw: Record<string, unknown>): void {
  const evidence = decode(raw)
  if (evidence) reduce(context, evidence)
}

function pane({ state }: RuntimeContext, paneText: string): void {
  paneText = stripAnsi(paneText)
  const currentUi = currentPaneUi(paneText)
  const banner = !state.model ? claudeStartupBanner(paneText) : null
  if (banner) {
    state.model = banner.model
    if (banner.effort) state.effort = banner.effort
    state.observedAt = Date.now()
  }
  const header = /(Fable|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)*)(\s+\(1M context\))?\s+with\s+(low|medium|high|xhigh|max|ultracode)\s+effort/gi
  const matches = [...paneText.matchAll(header)]
  const latest = matches[matches.length - 1]
  if (latest) {
    state.model = `claude-${latest[1].toLowerCase()}-${latest[2].replace(/\./g, '-')}${latest[3] ? '[1m]' : ''}`
    state.effort = latest[4].toLowerCase()
    state.observedAt = Date.now()
  }
  const footer = paneText.split('\n').slice(-8).join('\n')
  if (/─+\s*ultracode\s*─+/i.test(footer)) {
    state.effort = 'ultracode'
    state.observedAt = Date.now()
  }
  if (/\bplan mode on\b/i.test(currentUi)) state.mode = 'plan'
  else if (/\b(?:auto|default) mode on\b/i.test(currentUi)) state.mode = 'default'
}

async function models(session: RuntimeSession, state: RuntimeState | undefined): Promise<RuntimeModelOption[]> {
  const output: RuntimeModelOption[] = []
  const seen = new Set<string>()
  const allowed = await claudeAvailableModels(session)
  for (const model of CLAUDE_ALIASES) {
    if (model === 'fable' && !versionAtLeast(session.cliVersion, [2, 1, 170])) continue
    if (!availableModelMatches(model, allowed)) continue
    addOption(output, seen, session, model, 'auto')
    for (const effort of claudeEfforts(model, session.cliVersion)) addOption(output, seen, session, model, effort)
  }
  if (state?.model) {
    const model = claudeAliasForModel(state.model) ?? state.model
    addOption(output, seen, session, model, 'auto')
    for (const effort of claudeEfforts(model, session.cliVersion)) addOption(output, seen, session, model, effort)
    if (state.effort) addOption(output, seen, session, model, state.effort)
  }
  return output
}

export const runtime: EngineRuntime = {
  decode, reduce, transcript, pane, models,
  configuredEffort: claudeConfiguredEffort,
  supportsControl: session => versionAtLeast(session.cliVersion, [2, 1, 153]),
  selectedModel(session, state) {
    if (!state.model) return null
    const model = claudeAliasForModel(state.model) ?? state.model
    const effort = state.effort ?? (claudeEfforts(model).length === 0 ? 'auto' : null)
    return effort ? encodeRuntimeProfile({ sessionId: session.agentId, engine: session.engine, model, effort }) : null
  },
}
