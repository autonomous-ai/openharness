/** One volatile credential binding for the owner's selected, live OpenCode companion. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { digest } from './admission.js'
import { openCodeSnapshotIdentity, parseOpenCodeMemorySnapshot, type OpenCodeMemorySnapshot } from './opencodeInference.js'

export interface OpenCodeMemoryActor { agentId: string; sessionId: string; processKey: string }
export interface OpenCodeMemoryOwner extends OpenCodeMemoryActor { ownerKey: string; model: string | null }
interface Deps { current(): OpenCodeMemoryOwner | null; now?: () => number }
const probe = z.object({ kind: z.literal('probe') }).strict()
const observation = z.object({ kind: z.literal('observe'), challenge: z.string().uuid(),
  nativeVersion: z.literal('1.18.34'), snapshot: z.unknown() }).strict()

/** Nothing here is serialized, logged, sent to clients, or reused after an owner/process change. */
export class OpenCodeMemoryBinding {
  private pending: { challenge: string; key: string; until: number } | null = null
  private observed: { snapshot: OpenCodeMemorySnapshot; key: string; until: number } | null = null
  private readonly now: () => number
  constructor(private readonly deps: Deps) { this.now = deps.now ?? Date.now }

  clear(): void { this.pending = null; this.observed = null }

  private context(actor?: OpenCodeMemoryActor): { owner: OpenCodeMemoryOwner; key: string } | null {
    const owner = this.deps.current()
    if (!owner || !owner.ownerKey || !owner.sessionId || !owner.processKey) { this.clear(); return null }
    const key = digest([owner.ownerKey, owner.agentId, owner.sessionId, owner.processKey])
    if (this.observed && (this.observed.key !== key || this.observed.until <= this.now()
      || (owner.model && owner.model !== this.observed.snapshot.model))) this.observed = null
    if (this.pending && (this.pending.key !== key || this.pending.until <= this.now())) this.pending = null
    if (actor && (actor.agentId !== owner.agentId || actor.sessionId !== owner.sessionId || actor.processKey !== owner.processKey)) return null
    return { owner, key }
  }

  /** The hook asks before reading or handing over its selected provider's credentials. */
  receive(actor: OpenCodeMemoryActor, input: unknown): Record<string, unknown> {
    const context = this.context(actor)
    if (!context) return { observe: false }
    if (probe.safeParse(input).success) {
      // A new foreground request withdraws the earlier selection even if the new one is unsupported.
      this.observed = null
      this.pending = { challenge: randomUUID(), key: context.key, until: this.now() + 5_000 }
      return { observe: true, challenge: this.pending.challenge }
    }
    const result = observation.safeParse(input)
    if (!result.success || !this.pending || result.data.challenge !== this.pending.challenge || this.pending.key !== context.key) return { observe: false }
    this.pending = null
    try {
      const snapshot = parseOpenCodeMemorySnapshot(result.data.snapshot)
      if (context.owner.model && snapshot.model !== context.owner.model) return { observe: false }
      this.observed = { snapshot, key: context.key, until: this.now() + 15 * 60_000 }
      return { observe: true, recorded: true }
    } catch { this.observed = null; return { observe: false } }
  }

  read(actor: OpenCodeMemoryActor): OpenCodeMemorySnapshot | null {
    const context = this.context(actor), snapshot = this.observed?.snapshot
    if (!context || !snapshot) return null
    return structuredClone(snapshot)
  }

  identity(actor: OpenCodeMemoryActor): string | null {
    const snapshot = this.read(actor)
    return snapshot && this.observed ? digest([this.observed.key, openCodeSnapshotIdentity(snapshot)]) : null
  }
}
