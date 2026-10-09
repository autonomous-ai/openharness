import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { addOption } from '../kit/runtime.js'
import { confirmObserved } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as pi from './runtimeProfile.js'
import type { parsePiModelsOutput } from './runtimeProfile.js'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000

class ProfileReader {
  readonly engine = 'pi' as const
  private piCatalogCache: { key: string; expiresAt: number; entries: ReturnType<typeof parsePiModelsOutput> } | null = null

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state, control } = context
    // Pi puts both axes in one footer cell: `minimax/minimax-m3 • high`.
    const footer = pi.parsePiFooterProfile(paneText)
    if (footer) {
      state.model = footer.model
      state.effort = footer.effort
      state.observedAt = Date.now()
      confirmObserved(control, footer.model, footer.effort)
    }
  }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const entries = await this.piCatalog()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      addOption(output, seen, session, entry.model, 'auto', entry.model)
      if (!entry.thinking) continue
      for (const level of pi.PI_THINKING_LEVELS) addOption(output, seen, session, entry.model, level, entry.model)
    }
    if (entries.length && state?.model) {
      addOption(output, seen, session, state.model, 'auto', state.model)
      if (state.effort && pi.PI_EFFORTS.has(state.effort)) {
        addOption(output, seen, session, state.model, state.effort, state.model)
      }
    }
    return output
  }

  private async piCatalog(): Promise<ReturnType<typeof parsePiModelsOutput>> {
    // Its output is read with the engine's own code: without it there is no catalog, and nothing is run.
    const key = env.PI_HOME
    if (this.piCatalogCache?.key === key && this.piCatalogCache.expiresAt > Date.now()) {
      return this.piCatalogCache.entries
    }
    let entries: ReturnType<typeof parsePiModelsOutput> = []
    try {
      const result = await execFileAsync('pi', ['--list-models'], {
        env: process.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
      entries = pi.parsePiModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Pi model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.piCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'pi' } { return new ProfileReader() }
