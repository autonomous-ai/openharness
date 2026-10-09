import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { encodeRuntimeProfile } from '../kit/runtime.js'
import { confirmObserved } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as opencode from './runtimeProfile.js'
import { opencodeBin } from '../../lib/engineBin.js'
import type { OpencodeModelTarget } from './runtimeProfile.js'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000

class ProfileReader {
  readonly engine = 'opencode' as const
  private opencodeCatalogCache: { key: string; expiresAt: number; entries: OpencodeModelTarget[] } | null = null

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state, control } = context
    // OpenCode names what is running in its composer footer
    // (`Build · MiniMax M3 (vibe) Vibe Gateway · high`). Prefer the catalog entry it resolves to,
    // because that id is also what a SWITCH is addressed to — the cached entries rather than a
    // fresh (async) fetch, since this runs on the pane poll.
    //
    // Fall back to the footer's own words when the catalog does not list it. That is not a corner
    // case: with no provider connected OpenCode runs a built-in free model that `opencode models`
    // never prints, so insisting on a catalog match left the chips blank on a freshly opened agent
    // — showing nothing about a model the terminal was naming two lines below.
    const footer = opencode.parseOpencodeFooter(paneText)
    const id = opencode.opencodeFooterModelId(paneText, this.opencodeCatalogCache?.entries ?? [])
    const model = id ?? footer?.target ?? null
    if (model) {
      // 'auto' remains the default: early builds had no reasoning axis at all, and inventing a
      // level for them would put a wrong value on the chip instead of an empty one.
      const effort = footer?.effort ?? 'auto'
      state.model = model
      state.effort = effort
      state.observedAt = Date.now()
      confirmObserved(control, model, effort)
    }
  }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const entries = await this.catalog()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'opencode', model: entry.id, effort: 'auto',
      })
      if (seen.has(id)) continue
      seen.add(id)
      output.push({ id, displayName: entry.id })
    }
    // See commandcodeModels: only worth a row when the catalogue itself came back.
    if (entries.length && state?.model && !entries.some((entry) => entry.id === state.model)) {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'opencode', model: state.model, effort: 'auto',
      })
      if (!seen.has(id)) output.push({ id, displayName: state.model })
    }
    return output
  }

  async catalog(): Promise<OpencodeModelTarget[]> {
    // Its output is read with the engine's own code: without it there is no catalog, and nothing is run.
    const key = env.OPENCODE_DATA_DIR
    if (this.opencodeCatalogCache?.key === key && this.opencodeCatalogCache.expiresAt > Date.now()) {
      return this.opencodeCatalogCache.entries
    }
    let entries: OpencodeModelTarget[] = []
    try {
      const result = await execFileAsync(opencodeBin(), ['models'], {
        env: process.env, timeout: 10_000, maxBuffer: 1024 * 1024,
      })
      entries = opencode.parseOpencodeModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] OpenCode model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.opencodeCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  async config(): Promise<boolean> { await this.catalog(); return false }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'opencode' } { return new ProfileReader() }
