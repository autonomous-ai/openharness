import type { InlineRuntimeContext, InlineRuntimeReader } from '../facets/inlineRuntime.js'
import type { RuntimeCatalogModel, RuntimeModelOption, RuntimeSession } from '../facets/runtime.js'
import { addOption, encodeRuntimeProfile, RUNTIME_EFFORTS } from '../kit/runtime.js'
import { confirmObserved } from '../kit/runtimeReader.js'
import { env } from '../../config/env.js'
import { errorKind } from '../../lib/log.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as opencode from './runtimeProfile.js'
import { opencodeBinAsync } from '../../lib/engineBin.js'
import type { OpencodeModelTarget } from './runtimeProfile.js'

const execFileAsync = promisify(execFile)
const CATALOG_TTL_MS = 5 * 60_000
const MAX_CATALOGS = 32

class ProfileReader {
  readonly engine = 'opencode' as const
  private readonly catalogs = new Map<string, { expiresAt: number; entries: OpencodeModelTarget[] }>()

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
    const id = opencode.opencodeFooterModelId(paneText, this.cachedEntries(context.session.cwd))
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

  /** Its own model-control facet drives `/models` and `/effort`, session or none. */
  supportsControl(): boolean {
    return true
  }

  async modelCatalog(session: RuntimeSession): Promise<RuntimeCatalogModel[]> {
    return (await this.catalog(session.cwd)).map(entry => ({ slug: entry.id, displayName: entry.name ?? entry.id,
      listed: true, defaultEffort: 'auto', efforts: entry.efforts ?? [] }))
  }

  async models(context: InlineRuntimeContext): Promise<RuntimeModelOption[]> {
    const { session, state } = context
    const entries = await this.catalog(session.cwd)
    const output: RuntimeModelOption[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      // `auto` is OpenCode's Default variant: no variant chosen, the provider's own setting.
      // An effort the profile id cannot carry is no row: a pick of it could never be named back.
      for (const effort of ['auto', ...(entry.efforts ?? []).filter((e) => RUNTIME_EFFORTS.has(e))]) addOption(output, seen, session, entry.id, effort, entry.name ?? entry.id)
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

  /** The entries a catalog read last found for a folder, for the pane poll, which cannot wait for a read. */
  private cachedEntries(cwd: string | null | undefined): OpencodeModelTarget[] {
    return this.catalogs.get(`${env.OPENCODE_DATA_DIR}\u0000${cwd ?? ''}`)?.entries ?? []
  }

  /**
   * The models OpenCode offers in [cwd], an agent's folder: a project's own config can add providers, and OpenCode
   * answers for the folder it is asked about (`location[directory]`), its home otherwise (MSI, 2026-11-17).
   */
  async catalog(cwd?: string | null): Promise<OpencodeModelTarget[]> {
    // Its output is read with the engine's own code: without it there is no catalog, and nothing is run.
    const key = `${env.OPENCODE_DATA_DIR}\u0000${cwd ?? ''}`
    const hit = this.catalogs.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.entries
    let entries: OpencodeModelTarget[] = []
    const bin = await opencodeBinAsync()
    // Run from where the daemon is: an agent's folder may be gone, and a program started in a folder that is not
    // there never runs. The folder is said to OpenCode instead.
    const run = async (args: string[]) => (await execFileAsync(bin, args, { env: process.env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout
    // OpenCode 2 names each model and its variants (its efforts) in its own list, from the one server its screens
    // use too; `opencode models`, all an older OpenCode has, prints only the ids.
    const where = cwd ? `?location%5Bdirectory%5D=${encodeURIComponent(cwd)}` : ''
    try {
      entries = opencode.parseOpencodeApiModels(await run(['api', 'GET', `/api/model${where}`]))
    } catch { /* An older OpenCode has only the ids returned below. */ }
    if (!entries.length) {
      try {
        entries = opencode.parseOpencodeModelsOutput(await run(['models']))
      } catch (err) {
        console.warn('[runtime-profile] OpenCode model catalog failed:', errorKind(err))
      }
    }
    this.catalogs.delete(key)
    this.catalogs.set(key, { entries, expiresAt: Date.now() + CATALOG_TTL_MS })
    // One per folder an agent is open in; the oldest goes first.
    while (this.catalogs.size > MAX_CATALOGS) this.catalogs.delete(this.catalogs.keys().next().value!)
    return entries
  }

  async config(context: InlineRuntimeContext): Promise<boolean> { await this.catalog(context.session.cwd); return false }
}

export function createRuntimeProfileReader(): InlineRuntimeReader & { engine: 'opencode' } { return new ProfileReader() }
