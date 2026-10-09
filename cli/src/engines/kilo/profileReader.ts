import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { encodeRuntimeProfile } from '../kit/runtime.js'
import { confirmObserved } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as kilo from './runtimeProfile.js'
import type { KiloModelTarget } from './runtimeProfile.js'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000

class ProfileReader {
  readonly engine = 'kilo' as const
  private kiloCatalogCache: { key: string; expiresAt: number; entries: KiloModelTarget[] } | null = null

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state, control } = context
    // Kilo names the model in its composer footer too, but the line is shaped differently enough that
    // its resolver had to be rewritten rather than renamed — see engines/kilo/runtimeProfile.ts.
    const id = kilo.kiloFooterModelId(paneText, this.kiloCatalogCache?.entries ?? [])
    if (id) {
      state.model = id
      state.effort = 'auto'
      state.observedAt = Date.now()
      confirmObserved(control, id, 'auto')
    }
  }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session } = context
    const entries = await this.catalog()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const id = encodeRuntimeProfile({
        sessionId: session.agentId, engine: 'kilo', model: entry.id, effort: 'auto',
      })
      if (seen.has(id)) continue
      seen.add(id)
      output.push({ id, displayName: entry.id })
    }
    return output
  }

  async catalog(): Promise<KiloModelTarget[]> {
    // Its output is read with the engine's own code: without it there is no catalog, and nothing is run.
    const key = env.KILO_DATA_DIR
    if (this.kiloCatalogCache?.key === key && this.kiloCatalogCache.expiresAt > Date.now()) {
      return this.kiloCatalogCache.entries
    }
    let entries: KiloModelTarget[] = []
    try {
      // Measured: `kilo models` answers WITHOUT the user being logged in (unlike `kilo profile`), and
      // prints 299 ids on this machine — so an empty catalog here means the binary is missing, not that
      // the account is signed out.
      const result = await execFileAsync(env.KILO_PATH || 'kilo', ['models'], {
        env: process.env, timeout: 10_000, maxBuffer: 1024 * 1024,
      })
      entries = kilo.parseKiloModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Kilo model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.kiloCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  async config(): Promise<boolean> { await this.catalog(); return false }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'kilo' } { return new ProfileReader() }
