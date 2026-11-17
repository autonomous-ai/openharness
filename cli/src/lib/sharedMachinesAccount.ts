/**
 * What the shared-machines service (services/sharedMachines.ts) reaches through the core: this machine's
 * sharing as the backend holds it, the machines shared with this account, adding one, and the gateway's
 * trust stores (gateway/sharedTrust.ts). The core answers `shared_machines` (core/sharedMachinesQueries.ts)
 * with `answerSharedMachinesOp`, signed in with its own session, and the service reads the answers
 * through `sharedMachinesPortOf` in lib/sharedMachinesPort.ts. It reaches no other path of the backend.
 */
type Payload = Record<string, unknown>
type Answer = { status: number; body: Record<string, unknown> }

export interface SharedMachinesAccount {
  backend(method: string, path: string, body?: unknown): Promise<Answer>
  /** This machine's id on the account; empty while signed out. */
  machineId(): string
  trust(desired: { pins?: SharedTrustPeer[]; keys?: SharedTrustPeer[] }): Promise<{ pins: number; keys: number }>
}

/** A machine and its key, as sharing trusts or pins it. `email`: on a key this machine trusts, the account it
 *  is shared with — the guest its sessions are (docs/plans/2026-10-19-guest-machine-sharing-plan.md). */
export interface SharedTrustPeer { machineId: string; pub: string; label: string; email?: string }

const MACHINE_RE = /^[a-f0-9]{32}$/

export async function answerSharedMachinesOp(account: SharedMachinesAccount, payload: Payload): Promise<Payload> {
  try {
    const self = account.machineId()
    const target = typeof payload.machineId === 'string' && MACHINE_RE.test(payload.machineId) ? payload.machineId : null
    switch (payload.op) {
      case 'policy':
        if (!self) return { status: 401, body: { error: 'NOT_SIGNED_IN' } }
        return { ...await account.backend('GET', `/api/machines/${self}/share`) }
      case 'publish':
        if (!self) return { status: 401, body: { error: 'NOT_SIGNED_IN' } }
        return { ...await account.backend('PUT', `/api/machines/${self}/share`, { emails: payload.emails, sameDomain: payload.sameDomain === true }) }
      case 'shared': return { ...await account.backend('GET', '/api/machine-shares') }
      case 'add':
      case 'remove':
        if (!target) return { status: 400, body: { error: 'BAD_MACHINE' } }
        return { ...await account.backend(payload.op === 'add' ? 'POST' : 'DELETE', `/api/machine-shares/${target}/add`) }
      case 'trust': return { ...await account.trust({
        ...(Array.isArray(payload.pins) ? { pins: payload.pins as SharedTrustPeer[] } : {}),
        ...(Array.isArray(payload.keys) ? { keys: payload.keys as SharedTrustPeer[] } : {}),
      }) }
      default: return { error: 'UNKNOWN_OP' }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

