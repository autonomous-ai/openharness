import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { effortLabel, encodeRuntimeProfile, readJson, record, runtimeModelLabel, text, RUNTIME_EFFORTS } from '../kit/runtime.js'
import { env } from '../../config/env.js'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as commandcode from './runtimeProfile.js'
import type { CommandcodeModelTarget } from './runtimeProfile.js'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000

const EFFORTS = RUNTIME_EFFORTS
/** Command Code ids are "vendor/name"; everything we store and show uses the name alone. */
function shortCommandcodeModel(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1)
}

/**
 * Command Code keeps the reasoning level in its GLOBAL config, keyed by the FULL gateway id:
 *   { "model": "deepseek/deepseek-v4-flash", "reasoningEffort": { "deepseek/deepseek-v4-flash": "high" } }
 * Nothing in the transcript, the pane footer or the session header carries it, so this file is the only
 * source. It is per MACHINE rather than per session: two agents on the same model necessarily read the same
 * level. Matching is done on the short name because that is what the running model is stored as.
 */
/** The configured level for `model`, or 'auto' when the model has none set. */
async function commandcodeConfiguredEffort(model: string | null): Promise<{ effort: string; defaultModel: string }> {
  const config = await readJson(join(env.COMMANDCODE_HOME, 'config.json'))
  const defaultModel = shortCommandcodeModel(text(config?.model))
  const efforts = record(config?.reasoningEffort)
  const wanted = model || defaultModel
  if (!efforts || !wanted) return { effort: 'auto', defaultModel }
  for (const [id, level] of Object.entries(efforts)) {
    if (shortCommandcodeModel(id) !== wanted) continue
    const normalized = text(level).toLowerCase()
    if (normalized && normalized !== 'default' && EFFORTS.has(normalized)) return { effort: normalized, defaultModel }
  }
  return { effort: 'auto', defaultModel }
}


class ProfileReader {
  readonly engine = 'commandcode' as const
  private commandcodeCatalogCache: { key: string; expiresAt: number; entries: CommandcodeModelTarget[] } | null = null
  private readonly commandcodeTargets = new Map<string, Map<string, CommandcodeModelTarget>>()

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state } = context
    // `/model` reprints the session banner (`# models: kimi-k2.6 · taste-1`) with the new model. The
    // transcript would say the same thing, but only after the NEXT turn runs — too late to confirm a
    // switch, and long enough for the chip to look stuck.
    const model = commandcode.commandcodeBannerModel(paneText)
    if (model && model !== state.model) {
      state.model = model
      state.observedAt = Date.now()
      // Effort is stored per model in the CLI's global config, so the level we hold belongs to the old
      // one. Re-read rather than carry it across.
      context.refreshConfig(true)
    }
  }

  transcript(context: InlineRuntimeContext, raw: Record<string, unknown>): void {
    const { state } = context
    const before = state.model
    const model = text(raw.model)
    if (!model) return
    state.model = shortCommandcodeModel(model)
    // Effort is NOT touched here: it comes from the CLI config (ingestConfig), and stamping 'auto' on every
    // assistant line would wipe a configured level a second after it was read.
    state.observedAt = Date.now()
    if (state.model !== before) context.refreshConfig()
  }

  target(sessionId: string, profileId: string): CommandcodeModelTarget | null {
    return this.commandcodeTargets.get(sessionId)?.get(profileId) ?? null
  }

  forget(sessionId: string): void { this.commandcodeTargets.delete(sessionId) }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const entries = await this.commandcodeCatalog()
    const targets = new Map<string, CommandcodeModelTarget>()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    const add = (entry: CommandcodeModelTarget, effort: string): void => {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'commandcode', model: entry.shortId, effort,
      })
      if (seen.has(id)) return
      seen.add(id)
      targets.set(id, entry)
      output.push({ id, displayName: `${runtimeModelLabel(entry.shortId)} / ${effortLabel(effort)}` })
    }
    for (const entry of entries) {
      add(entry, 'auto')
      for (const level of commandcode.COMMANDCODE_EFFORT_LEVELS) add(entry, level)
    }
    // `entries.length` guards the fallback: a model row is worth adding when the catalogue is readable but
    // does not list what the session runs (a pinned build, a just-removed model). When the catalogue could
    // not be read at all, one lone row is a picker that cannot pick anything — better to offer none.
    if (entries.length && state?.model && !entries.some((entry) => entry.shortId === state.model)) {
      const own: CommandcodeModelTarget = { id: state.model, shortId: state.model, section: '', isDefault: false }
      add(own, 'auto')
      if (state.effort && commandcode.COMMANDCODE_EFFORTS.has(state.effort)) add(own, state.effort)
    }
    this.commandcodeTargets.set(session.sessionId, targets)
    return output
  }

  private async commandcodeCatalog(): Promise<CommandcodeModelTarget[]> {
    // Its output is read with the engine's own code: without it there is no catalog, and nothing is run.
    const key = env.COMMANDCODE_HOME
    if (this.commandcodeCatalogCache?.key === key && this.commandcodeCatalogCache.expiresAt > Date.now()) {
      return this.commandcodeCatalogCache.entries
    }
    let entries: CommandcodeModelTarget[] = []
    try {
      const result = await execFileAsync('commandcode', ['--list-models'], {
        env: process.env, timeout: 15_000, maxBuffer: 1024 * 1024,
      })
      entries = commandcode.parseCommandcodeModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Command Code model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.commandcodeCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  async config({ state }: InlineRuntimeContext): Promise<boolean> {
    const config = await commandcodeConfiguredEffort(state.model)
    state.effort = config.effort
    if (!state.model && config.defaultModel) state.model = config.defaultModel
    state.observedAt = Date.now()
    return true
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'commandcode' } { return new ProfileReader() }
