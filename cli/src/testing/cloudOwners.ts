/** Cloud fixture construction only; every accepted row passes the actual common owner protocol. */
import { createSessionOwners, type SessionOwnersDeps } from '../core/agents/sessionOwners.js'
import { ENGINES } from '../engines/types.js'
import { sessionFactoryOwners } from '../harnessd/services.js'
import { cloudHarnessIn, cloudPresentation, type CloudHarness, type CloudAgentFrame } from '../lib/cloudAgents.js'
import { cloudPresentationFingerprint } from '../cloud/cards.js'
import { SESSION_FACTS_FORMAT } from '../lib/sessionPresentation.js'
import { emptySessionFingerprint, SESSION_OWNER_LIMITS, type OwnerCard, type OwnerResult, type SessionOwnerCore } from '../lib/sessionOwnerWire.js'

const factories = sessionFactoryOwners(ENGINES)
export type CloudOwnerFixtureDeps = Omit<SessionOwnersDeps, 'factoryOwner' | 'whenStarting' | 'limits'> & {
  ownsFactory(value: unknown): boolean
  whenStarting?: () => Promise<boolean> | null
}
export function createCloudOwners({ ownsFactory, whenStarting, ...deps }: CloudOwnerFixtureDeps) {
  const owners = createSessionOwners({ ...deps, factoryOwner: value => ownsFactory(value) ? factories(value) : undefined,
    whenStarting: () => whenStarting?.() ?? null, limits: SESSION_OWNER_LIMITS })
  let connection = { current: true }
  const bind = () => {
    const captured = connection
    return owners.bound({ service: 'cloud', identity: captured, current: () => captured.current })
  }
  let bound = bind()
  let before = emptySessionFingerprint(), ordinal = 0
  const doors = { begin: ((value) => bound.begin(value)) as SessionOwnerCore['begin'],
    append: ((value) => bound.append(value)) as SessionOwnerCore['append'],
    cancel: ((value) => bound.cancel(value)) as SessionOwnerCore['cancel'],
    ask: ((...args) => bound.ask(...args)) as SessionOwnerCore['ask'],
    unask: ((...args) => bound.unask(...args)) as SessionOwnerCore['unask'],
    checkpoint: (factory = 'devin-cloud') => bound.checkpoint(factory),
    end(transfer: string): OwnerResult {
      const result = bound.end(transfer) as OwnerResult
      const checkpoint = bound.checkpoint('devin-cloud') as { fingerprint: string } | OwnerResult
      if (result.ok && 'fingerprint' in checkpoint) before = checkpoint.fingerprint
      return result
    },
    publish(input: CloudHarness[], cards: OwnerCard[] = []): OwnerResult {
      const invalid = { ok: false as const, error: 'SESSION_OWNER_INVALID' as const }
      if (!Array.isArray(input) || !Array.isArray(cards)) return invalid
      const rows = input.map(cloudHarnessIn)
      if (rows.some(row => !row) || cards.some(card => !card || typeof card !== 'object')
        || new Set(cards.map(card => card.agentId)).size !== cards.length
        || cards.some(card => !rows.some(row => row!.agentId === card.agentId))) return invalid
      const normalized = rows as CloudHarness[], after = cloudPresentationFingerprint(normalized), transfer = `fixture_${++ordinal}`
      const began = bound.begin({ format: SESSION_FACTS_FORMAT, transfer, factory: 'devin-cloud', before, after, count: rows.length }) as OwnerResult
      if (!began.ok) return began
      for (let index = 0; index < rows.length; index += 256) {
        const result = bound.append({ transfer, index, rows: normalized.slice(index, index + 256).map(row => {
          const card = cards.find(card => card.agentId === row.agentId)
          return { facts: cloudPresentation(row), ...(card ? { card } : {}) }
        }) }) as OwnerResult
        if (!result.ok) { bound.cancel(transfer); return result }
      }
      const result = bound.end(transfer) as OwnerResult
      if (result.ok) before = after
      return result
    },
  }
  return { ...owners, frames: () => owners.frames() as CloudAgentFrame[], doors, stop: owners.stopOwner, dispose: owners.stop,
    dialIds: owners.ids, dialRow: owners.row, dialRows: owners.rows,
    reconnect() { connection.current = false; connection = { current: true }; bound = bind() },
    disconnect() { connection.current = false },
  }
}

/** Component-only tests use a complete typed transport mock, never the removed bulk-publish API. */
export const emptyOwnerCore = (): SessionOwnerCore => ({
  checkpoint: () => ({ fingerprint: emptySessionFingerprint() }), begin: () => ({ ok: true }), append: () => ({ ok: true }),
  end: () => ({ ok: true }), cancel: () => ({ ok: true }), ask: () => ({ ok: true }), unask: () => ({ ok: true }),
})
