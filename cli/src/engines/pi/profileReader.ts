import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { addOption, record, text } from '../kit/runtime.js'
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
  private piCatalogCache: { key: string; expiresAt: number; entries: ReturnType<typeof parsePiModelsOutput>; names: ReadonlySet<string> } | null = null
  private piCatalogReading: Promise<ReturnType<typeof parsePiModelsOutput>> | null = null

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state, control } = context
    // Pi puts both axes in one footer cell: `minimax/minimax-m3 • high`.
    const footer = pi.parsePiFooterProfile(paneText)
    if (footer) {
      state.model = footer.model
      state.effort = footer.effort
      state.observedAt = Date.now()
      confirmObserved(control, footer.model, footer.effort)
      return
    }
    // Pi 1.0: the model alone, and only a name the catalog has (see `parsePi1FooterModel`).
    const known = this.knownModels()
    const model = known && pi.parsePi1FooterModel(paneText, known)
    if (!model) return
    state.model = model
    state.observedAt = Date.now()
    if (control && control.target.model === model) control.modelConfirmed = true
  }

  /** The catalog's model names, as last read; a read starts here when there is none or it is old. */
  private knownModels(): ReadonlySet<string> | null {
    const cache = this.piCatalogCache
    if (!cache || cache.key !== env.PI_HOME || cache.expiresAt <= Date.now()) void this.piCatalog()
    return cache?.key === env.PI_HOME ? cache.names : null
  }

  /**
   * Pi's session file says which model answers and how deep it thinks: a `model_change` when `/model`
   * moves it, every assistant message's `model`, and a `thinking_level_change`. Pi 1.0 no longer prints
   * `model • level` in its footer (its right edge clips a long model name, and a footer extension can
   * replace it), so without this no pi harness had a model and a switch could never be confirmed.
   */
  transcript(context: InlineRuntimeContext, raw: Record<string, unknown>): void {
    const { state, control } = context
    const message = record(raw.message)
    // Pi 1.0 writes `modelId`/`thinkingLevel`; 0.82 wrote `model`/`level`.
    const model = raw.type === 'model_change' ? text(raw.modelId) || text(raw.model)
      : raw.type === 'message' && message?.role === 'assistant' ? text(message.model) : null
    const effort = raw.type === 'thinking_level_change' ? text(raw.thinkingLevel) || text(raw.level) : null
    if (model) {
      state.model = model
      state.observedAt = Date.now()
      if (control && control.target.model === model) control.modelConfirmed = true
    }
    if (effort && pi.PI_EFFORTS.has(effort)) {
      state.effort = effort
      state.observedAt = Date.now()
      if (control && control.target.effort === effort) control.effortConfirmed = true
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
    // One read at a time: every pane read asks for the names until the first one answers.
    this.piCatalogReading ??= (async () => {
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
      this.piCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS, names: new Set(entries.map(entry => entry.model)) }
      return entries
    })().finally(() => { this.piCatalogReading = null })
    return this.piCatalogReading
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'pi' } { return new ProfileReader() }
