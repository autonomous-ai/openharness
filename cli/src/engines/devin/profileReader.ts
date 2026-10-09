import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeModelOption } from '../facets/runtime.js'
import { effortLabel, encodeRuntimeProfile, record } from '../kit/runtime.js'
import { confirmObserved } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as devin from './runtimeProfile.js'
import type { DevinModelTarget } from './runtimeProfile.js'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000
const CATALOG_LIMIT = 96

class ProfileReader {
  readonly engine = 'devin' as const
  private readonly devinTargets = new Map<string, Map<string, DevinModelTarget>>()
  private devinCatalogCache: { key: string; expiresAt: number; entries: DevinModelTarget[] } | null = null

  pane(context: InlineRuntimeContext, paneText: string): void | false {
    const { session, state, control } = context
    // Devin writes no transcript unless the user passes `--export`, so the footer's bottom-left cell is
    // the only per-session record of the running model. It is a DISPLAY name (`SWE-1.6 Slow`); the
    // catalog resolves it back to a model key so the chip and the picker agree.
    const label = devin.devinFooterModel(paneText)
    const model = label ? this.devinModelKeyForLabel(session.sessionId, label) : null
    if (model) {
      state.model = model.modelKey
      state.effort = model.effort
      state.observedAt = Date.now()
      confirmObserved(control, model.modelKey, model.effort)
    }
  }

  target(sessionId: string, profileId: string): DevinModelTarget | null {
    return this.devinTargets.get(sessionId)?.get(profileId) ?? null
  }

  forget(sessionId: string): void { this.devinTargets.delete(sessionId) }

  private devinModelKeyForLabel(sessionId: string, label: string): DevinModelTarget | null {
    // Resolve against the CATALOG, not the per-session id map. That map is only built when something opens
    // the model picker, so a session nobody had picked on could not read its own footer and the chip stayed
    // blank. The catalog is the same data minus the per-session ids, and ingestConfig warms it on attach.
    // The session map stays first: its rows are the ones the picker will offer.
    const targets = this.devinTargets.get(sessionId)
    const pool: Iterable<DevinModelTarget> = targets?.size
      ? targets.values()
      : this.devinCatalogCache?.entries ?? []
    const wanted = label.trim().toLowerCase()
    for (const target of pool) {
      // A row whose id carries no effort keeps the effort word in its label ("GLM-5.2 High"), so an exact
      // label match is what identifies it; anything looser would tie the footer to the wrong sibling.
      if (target.label.toLowerCase() === wanted) return target
      if (target.effort !== 'auto' && `${target.label} ${effortLabel(target.effort)}`.toLowerCase() === wanted) {
        return target
      }
    }
    return null
  }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const entries = await this.devinCatalog()
    const targets = new Map<string, DevinModelTarget>()
    // Keep every row of the running model together with it, so its effort list stays complete.
    const ordered = state?.model
      ? [...entries].sort((a, b) => Number(b.modelKey === state.model) - Number(a.modelKey === state.model))
      : entries

    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of ordered) {
      if (output.length >= CATALOG_LIMIT) break
      if (!devin.DEVIN_EFFORTS.has(entry.effort)) continue
      const id = encodeRuntimeProfile({
        sessionId: session.agentId,
        engine: 'devin',
        model: entry.modelKey,
        effort: entry.effort,
      })
      if (seen.has(id)) continue
      seen.add(id)
      targets.set(id, entry)
      output.push({ id, displayName: `${entry.label} / ${effortLabel(entry.effort)}` })
    }
    this.devinTargets.set(session.sessionId, targets)
    return output
  }

  private async devinCatalog(): Promise<DevinModelTarget[]> {
    // Its output is read with the engine's own code: without it there is no catalog, and nothing is run.
    const key = env.DEVIN_HOME
    if (this.devinCatalogCache?.key === key && this.devinCatalogCache.expiresAt > Date.now()) {
      return this.devinCatalogCache.entries
    }
    let entries: DevinModelTarget[] = []
    try {
      const result = await execFileAsync('devin', ['models', 'list'], {
        env: process.env,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
      entries = devin.parseDevinModelsOutput(result.stdout)
    } catch (err) {
      console.warn('[runtime-profile] Devin model catalog failed:', err instanceof Error ? err.message : err)
    }
    this.devinCatalogCache = { key, entries, expiresAt: Date.now() + CATALOG_TTL_MS }
    return entries
  }

  async config(): Promise<boolean> { await this.devinCatalog(); return false }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'devin' } { return new ProfileReader() }
