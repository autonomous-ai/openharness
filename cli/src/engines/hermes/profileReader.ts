import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { encodeRuntimeProfile, readJson, runtimeModelLabel } from '../kit/runtime.js'
import { readRuntimeText as readText } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { join } from 'node:path'
import * as hermes from './runtimeProfile.js'
import type { HermesModelTarget } from './runtimeProfile.js'

const CATALOG_TTL_MS = 5 * 60_000

class ProfileReader {
  readonly engine = 'hermes' as const
  private hermesCatalogCache = new Map<string, { expiresAt: number; entries: HermesModelTarget[] }>()
  private readonly hermesTargets = new Map<string, Map<string, HermesModelTarget>>()

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state } = context
    // `⚕ minimax-m3 │ ctx --` — the status line is how a switch is seen immediately; config.yaml is
    // rewritten too, but the poll that reads it runs on its own schedule.
    const model = hermes.hermesStatusModel(paneText)
    if (model && model !== state.model) {
      state.model = model
      state.observedAt = Date.now()
    }
  }

  target(sessionId: string, profileId: string): HermesModelTarget | null {
    return this.hermesTargets.get(sessionId)?.get(profileId) ?? null
  }

  forget(sessionId: string): void { this.hermesTargets.delete(sessionId) }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const entries = await this.hermesCatalog(session.hermesHome || env.HERMES_HOME)
    const targets = new Map<string, HermesModelTarget>()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    const effort = state?.effort && hermes.HERMES_EFFORTS.has(state.effort) ? state.effort : 'auto'
    const add = (entry: HermesModelTarget): void => {
      const short = entry.id.slice(entry.id.lastIndexOf('/') + 1)
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'hermes', model: short, effort,
      })
      if (seen.has(id)) return
      seen.add(id)
      targets.set(id, entry)
      output.push({ id, displayName: runtimeModelLabel(short) })
    }
    for (const entry of entries) add(entry)
    // The provider in use is often absent from the picker cache (a `custom` gateway is its own one-model
    // page), so the configured model is always offered — otherwise the running model is missing from its
    // own list.
    if (state?.model && !seen.size) add({ id: state.model, provider: '' })
    else if (state?.model && ![...targets.values()].some((t) => t.id.endsWith(state.model!))) {
      add({ id: state.model, provider: '' })
    }
    this.hermesTargets.set(session.sessionId, targets)
    return output
  }

  private async hermesCatalog(home = env.HERMES_HOME): Promise<HermesModelTarget[]> {
    // Keyed by home, and now actually asked per home: a profile has its own providers, so the cache
    // key was already right and only the path it read was not.
    const cached = this.hermesCatalogCache.get(home)
    if (cached && cached.expiresAt > Date.now()) return cached.entries
    const cache = await readJson(join(home, 'provider_models_cache.json'))
    const entries = hermes.parseHermesModelsCache(cache)
    this.hermesCatalogCache.set(home, { entries, expiresAt: Date.now() + CATALOG_TTL_MS })
    return entries
  }

  async config(context: InlineRuntimeContext): Promise<boolean> {
    const { session, state } = context
    // Both axes are scalars in config.yaml and neither is announced, so this poll is the only reader.
    // This agent's OWN home: `hermes -p <name>` keeps its model and effort in the profile's
    // config.yaml, and reading the default one reported the wrong model on every profile agent.
    const parsed = hermes.parseHermesConfig(await readText(join(session.hermesHome || env.HERMES_HOME, 'config.yaml')))
    if (parsed.model) state.model = parsed.model.slice(parsed.model.lastIndexOf('/') + 1)
    state.effort = parsed.effort ?? 'auto'
    state.observedAt = Date.now()

    return true
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'hermes' } { return new ProfileReader() }
