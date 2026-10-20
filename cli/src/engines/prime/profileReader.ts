import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { addOption, record, text } from '../kit/runtime.js'
import { confirmObserved } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { engineBin } from '../../lib/engineBin.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as prime from './runtimeProfile.js'
import type { PrimeModelTarget } from './runtimeProfile.js'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000

/**
 * Prime Agent's model and thinking level, read three ways (all measured on prime-agent 0.9.5):
 *  - its footer, `claude-opus-5-5:high · 9.7k (1%)` — the model without its provider;
 *  - its session file: `model_change {provider, modelId}`, `thinking_level_change {thinkingLevel}`, and each
 *    assistant message's `provider` + `model` (Pi 1.0's names, kept by the fork);
 *  - `prime-agent model list` for the catalog.
 * A profile's model is `<provider>/<model>` (see runtimeProfile.ts), so the footer's bare name is taken only
 * when it names one catalog entry, or the one already known.
 */
class ProfileReader {
  readonly engine = 'prime' as const
  private cache: { key: string; expiresAt: number; entries: PrimeModelTarget[] } | null = null
  private reading: Promise<PrimeModelTarget[]> | null = null

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { state, control } = context
    const footer = prime.parsePrimeFooterProfile(paneText)
    if (!footer) return
    const model = this.qualify(footer.model, control?.target.model ?? null, state.model)
    // A name the catalog cannot place is read as nothing: a level without its model is half a profile.
    if (!model) return
    state.model = model
    state.effort = footer.effort
    state.observedAt = Date.now()
    confirmObserved(control, model, footer.effort)
    if (control && control.target.model === model) control.modelConfirmed = true
  }

  /**
   * The footer's bare model as `<provider>/<model>`: the model a switch asked for, or the one already known,
   * when it is that name; else the catalog's only entry of that name. Two providers' entries of one name
   * place nothing.
   */
  private qualify(bare: string, asked: string | null, known: string | null): string | null {
    for (const id of [asked, known]) if (id && id.endsWith(`/${bare}`)) return id
    const cache = this.cache
    if (!cache || cache.key !== env.PRIME_AGENT_DIR || cache.expiresAt <= Date.now()) void this.catalog()
    if (cache?.key !== env.PRIME_AGENT_DIR) return null
    const matches = cache.entries.filter((entry) => entry.model === bare)
    return matches.length === 1 ? matches[0].id : null
  }

  transcript(context: InlineRuntimeContext, raw: Record<string, unknown>): void {
    const { state, control } = context
    const message = record(raw.message)
    const qualified = (provider: string | null, model: string | null): string | null =>
      model ? (provider ? `${provider}/${model}` : model) : null
    const model = raw.type === 'model_change' ? qualified(text(raw.provider), text(raw.modelId) || text(raw.model))
      : raw.type === 'message' && message?.role === 'assistant' ? qualified(text(message.provider), text(message.model)) : null
    const effort = raw.type === 'thinking_level_change' ? text(raw.thinkingLevel) || text(raw.level) : null
    if (model) {
      state.model = model
      state.observedAt = Date.now()
      if (control && control.target.model === model) control.modelConfirmed = true
    }
    if (effort && prime.PRIME_EFFORTS.has(effort)) {
      state.effort = effort
      state.observedAt = Date.now()
      if (control && control.target.effort === effort) control.effortConfirmed = true
    }
  }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const entries = await this.catalog()
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    // The same model column under two providers would read as one name twice: say whose.
    const counts = new Map<string, number>()
    for (const entry of entries) counts.set(entry.model, (counts.get(entry.model) ?? 0) + 1)
    const label = (entry: PrimeModelTarget): string => (counts.get(entry.model) ?? 0) > 1 ? `${entry.model} (${entry.provider})` : entry.model
    for (const entry of entries) {
      addOption(output, seen, session, entry.id, 'auto', label(entry))
      if (!entry.thinking) continue
      for (const level of prime.PRIME_THINKING_LEVELS) addOption(output, seen, session, entry.id, level, label(entry))
    }
    if (entries.length && state?.model) {
      const bare = state.model.slice(state.model.indexOf('/') + 1)
      addOption(output, seen, session, state.model, 'auto', bare)
      if (state.effort && prime.PRIME_EFFORTS.has(state.effort)) addOption(output, seen, session, state.model, state.effort, bare)
    }
    return output
  }

  private async catalog(): Promise<PrimeModelTarget[]> {
    const key = env.PRIME_AGENT_DIR
    if (this.cache?.key === key && this.cache.expiresAt > Date.now()) return this.cache.entries
    this.reading ??= (async () => {
      let entries: PrimeModelTarget[] = []
      try {
        // Pi's `--list-models` is `model list` here (same table, measured).
        const result = await execFileAsync(engineBin('prime'), ['model', 'list'], {
          env: process.env,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        })
        entries = prime.parsePrimeModelsOutput(result.stdout)
      } catch (err) {
        console.warn('[runtime-profile] Prime Agent model catalog failed:', err instanceof Error ? err.message : err)
      }
      this.cache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
      return entries
    })().finally(() => { this.reading = null })
    return this.reading
  }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'prime' } { return new ProfileReader() }
