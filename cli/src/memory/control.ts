/** Local owner controls. Agent tools get a different, host-scoped recall path. */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { libraryCommandSchema, libraryQuerySchema, libraryProjectQuerySchema, notebookQuerySchema, libraryActivityQuerySchema, type LibraryPreview } from './library.js'
import { MemoryError, parse } from './types.js'
import type { CodingMemoryRuntime } from './runtime.js'
import type { CallerVerdict } from '../pair/learn/approval.js'
import type { MemoryExperimentChoice } from './experiment.js'

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('experiment') }).strict(),
  z.object({ action: z.literal('configure_experiment'), enabled: z.boolean(), expected: z.number().int().nonnegative().safe() }).strict(),
  z.object({ action: z.literal('list'), query: libraryQuerySchema.optional() }).strict(),
  z.object({ action: z.literal('projects'), query: libraryProjectQuerySchema.optional() }).strict(),
  z.object({ action: z.literal('activity'), query: libraryActivityQuerySchema.optional() }).strict(),
  z.object({ action: z.literal('notebooks'), query: notebookQuerySchema.optional() }).strict(),
  z.object({ action: z.literal('notebook'), id: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('show'), id: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal('preview'), command: libraryCommandSchema }).strict(),
  z.object({ action: z.literal('apply'), capability: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
])
type Runtime = Pick<CodingMemoryRuntime, 'ownerKey' | 'libraryStatus' | 'libraryPage' | 'libraryProjects' | 'libraryActivity' | 'libraryNotebooks' | 'libraryNotebook' | 'libraryDetail' | 'libraryPreview' | 'libraryApply'>
interface Deps {
  runtime(): Runtime | null
  /** Must verify the OS owner as well as rejecting a process inside an agent's harness. */
  verify(connId: string): Promise<CallerVerdict>
  now?: () => number
  experiment?: {
    owner(): string | null
    read(owner: string): MemoryExperimentChoice
    write(owner: string, enabled: boolean, expected: number): Promise<MemoryExperimentChoice>
  }
}
interface Capability { owner: string; connId: string; pid: number; expires: number; preview: LibraryPreview }
const TTL_MS = 2 * 60_000

export class MemoryControl {
  private readonly capabilities = new Map<string, Capability>()
  private readonly now: () => number
  constructor(private readonly deps: Deps) { this.now = deps.now ?? Date.now }

  async local(payload: Record<string, unknown>, connId: string): Promise<Record<string, unknown>> {
    // A token-bearing agent cannot turn itself into the person with `confirmed`, a claimed owner,
    // another agentId, or an independently supplied command at apply time.
    if (payload.token) return { ok: false, error: 'PERSON_ONLY' }
    try {
      const { verb: _verb, requestId: _requestId, token: _token, ...input } = payload
      const request = parse(requestSchema, input)
      if (request.action === 'experiment' || request.action === 'configure_experiment') {
        const experiment = this.deps.experiment
        if (!experiment) return { ok: false, error: 'UNSUPPORTED' }
        const owner = experiment.owner()
        if (!owner) return { ok: false, error: 'MEMORY_UNAVAILABLE' }
        const verdict = await this.deps.verify(connId)
        if (!verdict.ok) return { ok: false, error: verdict.error }
        if (owner !== experiment.owner()) throw new MemoryError('owner_changed')
        const choice = request.action === 'experiment' ? experiment.read(owner)
          : await experiment.write(owner, request.enabled, request.expected)
        if (owner !== experiment.owner()) throw new MemoryError('owner_changed')
        return { ok: true, ...choice }
      }
      const runtime = this.deps.runtime()
      if (!runtime) return { ok: false, error: 'UNSUPPORTED' }
      const owner = runtime.ownerKey()
      if (!owner) return { ok: false, error: 'MEMORY_UNAVAILABLE' }
      const verdict = await this.deps.verify(connId)
      if (!verdict.ok) return { ok: false, error: verdict.error, detail: verdict.detail }
      if (runtime !== this.deps.runtime() || owner !== runtime.ownerKey()) throw new MemoryError('owner_changed')
      this.prune(owner)
      switch (request.action) {
        case 'status': return { ok: true, ...await runtime.libraryStatus(owner) }
        case 'list': return { ok: true, ...await runtime.libraryPage(owner, request.query) }
        case 'projects': return { ok: true, ...await runtime.libraryProjects(owner, request.query) }
        case 'activity': return { ok: true, ...await runtime.libraryActivity(owner, request.query) }
        case 'notebooks': return { ok: true, ...await runtime.libraryNotebooks(owner, request.query) }
        case 'notebook': {
          const detail = await runtime.libraryNotebook(owner, request.id)
          return detail ? { ok: true, ...detail } : { ok: false, error: 'NOT_FOUND' }
        }
        case 'show': {
          const detail = await runtime.libraryDetail(owner, request.id)
          return detail ? { ok: true, ...detail } : { ok: false, error: 'NOT_FOUND' }
        }
        case 'preview': {
          const preview = await runtime.libraryPreview(owner, request.command)
          if (owner !== runtime.ownerKey()) throw new MemoryError('owner_changed')
          const capability = randomBytes(16).toString('hex')
          this.capabilities.set(capability, { owner, connId, pid: verdict.pid, expires: this.now() + TTL_MS, preview })
          if (this.capabilities.size > 32) this.capabilities.delete(this.capabilities.keys().next().value!)
          return { ok: true, capability, expiresInMs: TTL_MS, preview }
        }
        case 'apply': {
          const capability = this.capabilities.get(request.capability)
          this.capabilities.delete(request.capability) // Spend once, including a mismatched caller.
          if (!capability || capability.owner !== owner || capability.connId !== connId || capability.pid !== verdict.pid) {
            throw new MemoryError('preview_required')
          }
          return { ok: true, ...await runtime.libraryApply(owner, capability.preview) }
        }
      }
    } catch (error) { return { ok: false, error: error instanceof MemoryError ? error.code.toUpperCase() : 'MEMORY_UNAVAILABLE' } }
  }

  private prune(owner: string): void {
    for (const [id, capability] of this.capabilities) {
      if (capability.owner !== owner || capability.expires <= this.now()) this.capabilities.delete(id)
    }
  }
}
