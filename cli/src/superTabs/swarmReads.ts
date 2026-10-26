/**
 * The daemon's Swarm reads (design 2026-10-26-swarm-state-parts section 5.3): each Swarm, as each reader sees it (a person,
 * or an agent through `asAgentId`), is first loaded once and then read by what changed since. The daemon is long-lived, so a
 * one-shot `harness super-tab` call costs one changes read, not the whole Swarm it once downloaded every time.
 */
import type { CoreApi } from '../core/api.js'
import { mergeChanges, storeOf, type PartsStore } from './partsStore.js'
import type { ChangedParts, FirstLoad } from './readContract.js'
import { reassemble } from './reassemble.js'
import { backend, object, readable, SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
/** A Swarm as `GET /api/super-tabs/:id` gave it: its state in the old shape, `lastChangedAt` in place of `revision`. */
export interface SwarmRead { state: Json; lastChangedAt: number; githubApp: boolean }

/** About one per running agent and Swarm on a machine; one of the largest Swarms holds about a megabyte. */
const MAX_SWARMS = 32

export class SwarmReads {
  private readonly held = new Map<string, PartsStore>()
  /** Each reader's last read, so reads of one Swarm run one after another, each from where the last left the cursor. */
  private readonly queue = new Map<string, Promise<unknown>>()
  private readonly maxSwarms: number

  constructor(private readonly core: CoreApi, options: { maxSwarms?: number } = {}) {
    this.maxSwarms = options.maxSwarms ?? MAX_SWARMS
  }

  read(tabId: string, asAgentId?: string): Promise<SwarmRead> {
    const key = `${tabId}:${asAgentId ?? ''}`
    const run = (this.queue.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.refresh(key, tabId, asAgentId))
    this.queue.set(key, run)
    void run.catch(() => undefined).finally(() => { if (this.queue.get(key) === run) this.queue.delete(key) })
    return run
  }

  private async refresh(key: string, tabId: string, asAgentId: string | undefined): Promise<SwarmRead> {
    const as = asAgentId ? `asAgentId=${asAgentId}` : ''
    const held = this.held.get(key)
    let store: PartsStore | null = null
    if (held) {
      try {
        const changes = object(await backend(this.core, 'GET', `/api/super-tabs/${tabId}/changes?cursor=${held.cursor}${as ? `&${as}` : ''}`))
        // The epoch moved (who sees what changed) or the cursor outlived the tombstones: only a first load is right now. The
        // answer is `{ reload: true }` alone (design 4.2), so it is read before the format of a reply with parts.
        if (changes.reload !== true) store = mergeChanges(held, readable<ChangedParts>(changes))
      } catch (error) {
        // The Swarm or this reader's access is gone or changed: what is held may show what it can no longer see.
        if (!(error instanceof SuperTabHostError) || ![403, 404].includes(error.status)) throw error
      }
    }
    // Dropped before the first load: a refused one leaves nothing that a later read could resume from.
    this.held.delete(key)
    store ??= storeOf(readable<FirstLoad>(await backend(this.core, 'GET', `/api/super-tabs/${tabId}/parts${as ? `?${as}` : ''}`)))
    this.held.set(key, store)
    for (const oldest of this.held.keys()) {
      if (this.held.size <= this.maxSwarms) break
      this.held.delete(oldest)
    }
    return { state: reassemble(store), lastChangedAt: store.lastChangedAt, githubApp: store.githubApp }
  }
}
