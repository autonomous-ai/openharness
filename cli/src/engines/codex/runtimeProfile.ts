/** Codex runtime metadata and model policy. Model catalogs stay scoped to the bound engine home. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionCodexHome } from '../../lib/engineHomes.js'
import { parseCodexCatalog, type CodexCatalogModel } from './modelPicker.js'
import type { EngineRuntime, RuntimeContext, RuntimeModelOption, RuntimeRecord, RuntimeSession, RuntimeState } from '../facets/runtime.js'
import { addOption, currentPaneUi, encodeRuntimeProfile, parseVersion, record, runtimeModelLabel, stripAnsi, text, versionAtLeast } from '../kit/runtime.js'

/** Persistent arrived in Codex 0.160; older transcripts and catalog fallbacks retain their existing behavior. */
const CODEX_EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'])
const CODEX_CONTROL_MIN_VERSION: [number, number, number] = [0, 144, 0]

interface CodexCacheModel {
  slug?: unknown
  display_name?: unknown
  visibility?: unknown
  supported_reasoning_levels?: Array<{ effort?: unknown }>
}

interface CodexCache {
  models?: CodexCacheModel[]
}

/** Max and Ultra follow the catalog; the historical slug rule is only the missing-catalog fallback. */
export function codexEffortAllowed(model: string, effort: string, listed: readonly string[] | null = null): boolean {
  if (!CODEX_EFFORTS.has(effort)) return false
  if (effort !== 'max' && effort !== 'ultra') return true
  if (listed) return listed.includes(effort)
  return /^gpt-5\.6(?:-|$)/i.test(model) || model.toLowerCase() === 'codex-auto-review'
}

function decode(raw: Record<string, unknown>): RuntimeRecord | null {
  const payload = record(raw.payload)
  const cliVersion = raw.type === 'session_meta' ? text(payload?.cli_version) : ''
  let source: Record<string, unknown> | null = null
  if (raw.type === 'event_msg' && payload?.type === 'thread_settings_applied') source = record(payload.thread_settings)
  else if (raw.type === 'turn_context') source = payload
  const version = parseVersion(cliVersion) ? cliVersion : null
  if (!source && !version) return null
  return { version, source: !!source, model: text(source?.model),
    effort: text(source?.reasoning_effort) || text(source?.effort), mode: text(record(source?.collaboration_mode)?.mode) }
}

function reduce({ session, state, control }: RuntimeContext, evidence: RuntimeRecord): void {
  const version = text(evidence.version)
  if (parseVersion(version)) { session.cliVersion = version; state.cliVersion = version }
  if (evidence.source !== true) return
  const model = text(evidence.model)
  const effort = text(evidence.effort)
  const mode = text(evidence.mode)
  if (model) state.model = model
  if (CODEX_EFFORTS.has(effort.toLowerCase())) state.effort = effort.toLowerCase()
  if (mode === 'plan' || mode === 'default') state.mode = mode
  if (model || effort || mode) state.observedAt = Date.now()
  if (control && state.model === control.target.model) {
    control.modelConfirmed = true
    if (control.target.effort === 'auto' || state.effort === control.target.effort) control.effortConfirmed = true
  }
}

function transcript(context: RuntimeContext, raw: Record<string, unknown>): void {
  const evidence = decode(raw)
  if (evidence) reduce(context, evidence)
}

function pane({ state }: RuntimeContext, paneText: string): void {
  paneText = stripAnsi(paneText)
  const currentUi = currentPaneUi(paneText)
  const matches = [...paneText.matchAll(/\b(gpt-[a-z0-9][a-z0-9._-]*)\s+(low|medium|high|xhigh|max|ultra|persistent|default)\s*[·│]/gi)]
  const latest = matches[matches.length - 1]
  if (latest) {
    state.model = latest[1].toLowerCase()
    state.effort = latest[2].toLowerCase() === 'default' ? 'auto' : latest[2].toLowerCase()
    state.observedAt = Date.now()
  }
  if (/\bplan mode\b/i.test(currentUi)) state.mode = 'plan'
  else if (/\b(?:default|work) mode\b/i.test(currentUi)) state.mode = 'default'
}

async function readCodexCache(session: RuntimeSession): Promise<CodexCache> {
  try {
    const cache: unknown = JSON.parse(await readFile(join(sessionCodexHome(session), 'models_cache.json'), 'utf8'))
    return record(cache) ?? {}
  } catch {
    return {}
  }
}

export async function codexCatalog(session: RuntimeSession): Promise<CodexCatalogModel[]> {
  return parseCodexCatalog(await readCodexCache(session))
}

async function models(session: RuntimeSession, state: RuntimeState | undefined): Promise<RuntimeModelOption[]> {
  const output: RuntimeModelOption[] = []
  const seen = new Set<string>()
  const cache = await readCodexCache(session)
  const catalog = parseCodexCatalog(cache)
  for (const item of Array.isArray(cache.models) ? cache.models : []) {
    const model = text(item.slug)
    if (!model || item.visibility === 'hide') continue
    const label = text(item.display_name) || runtimeModelLabel(model)
    addOption(output, seen, session, model, 'auto', label)
    const listed = catalog.find((entry) => entry.slug === model)?.efforts ?? []
    for (const effort of listed) {
      if (effort !== 'auto' && codexEffortAllowed(model, effort, listed)) addOption(output, seen, session, model, effort, label)
    }
  }
  if (state?.model) {
    addOption(output, seen, session, state.model, 'auto')
    const listed = catalog.find((entry) => entry.slug === state.model)?.efforts ?? null
    if (state.effort && codexEffortAllowed(state.model, state.effort, listed)) {
      addOption(output, seen, session, state.model, state.effort)
    }
  }
  return output
}

export const runtime: EngineRuntime = {
  decode, reduce, transcript, pane, models, catalog: codexCatalog, effortAllowed: codexEffortAllowed,
  supportsControl: session => versionAtLeast(session.cliVersion, CODEX_CONTROL_MIN_VERSION),
  selectedModel(session, state) {
    return state.model && state.effort ? encodeRuntimeProfile({ sessionId: session.agentId, engine: session.engine, model: state.model, effort: state.effort }) : null
  },
}
