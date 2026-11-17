/** Account vault exchange stays beside crypto; edge receives only a local-store change notice. */
import type { ConnectorSync, GatewayAccount } from '../core/api.js'
import { VaultSync, vaultPortOf } from '../lib/connectors/vaultSync.js'
import { VaultStore } from '../lib/connectors/vaultStore.js'
import { answerVaultOp, type VaultAccount } from '../lib/connectors/vaultOps.js'

interface Dependencies {
  root: string
  account(): GatewayAccount
  ready(): boolean
  backend(method: string, path: string, body?: unknown, waitMs?: number): Promise<{ status: number; body: Record<string, unknown> }>
  vault: VaultAccount['connectorVault']
  changed(): void
  log(line: string): void
  /** Reused across gateway restarts in one service process, including pending OS-operation settlement. */
  store?: VaultStore
}

export function connectorAccountKey(account: GatewayAccount): string {
  return JSON.stringify([account.machineId, account.autonomousEnv, account.signIn?.epoch, account.signIn?.acct])
}

export function createGatewayConnectorSync(deps: Dependencies) {
  const store = deps.store ?? new VaultStore(deps.root)
  const key = () => connectorAccountKey(deps.account())
  let generation = key(), active: VaultSync | null = null, draining: Promise<unknown> | null = null
  let trusted = deps.ready(), epoch = 0
  let stopped = false, waiting = false
  const report = () => { try { deps.log('[connectors] synchronization unavailable') } catch { /* Logging cannot grant authority. */ } }

  const ensure = (): void => {
    if (stopped || draining || active || !deps.account().machineId || !deps.ready()) return
    const owner = generation, authority = epoch
    active = new VaultSync({
      vault: { root: deps.root }, store,
      current: () => !stopped && key() === owner && authority === epoch && deps.ready(),
      changed: deps.changed, log: deps.log,
      port: vaultPortOf((op, payload = {}, waitMs) => answerVaultOp({
        backend: (method, path, body) => deps.backend(method, path, body, waitMs), connectorVault: deps.vault,
      }, { ...payload, op })),
    })
    active.start()
  }

  const accountChanged = (): void => {
    const next = key()
    const ready = deps.ready()
    const revoked = next !== generation || (trusted && !ready)
    trusted = ready
    if (!revoked) { ensure(); return }
    epoch++
    generation = next
    if (active) {
      const old = active
      old.stop(); active = null
      draining = old.settled().catch(report).then(() => {
        draining = null
        try { ensure() } catch { report() }
      })
    }
    ensure()
  }

  const sync: ConnectorSync = async refresh => {
    if (stopped) throw new Error('CONNECTORS_SYNC_UNAVAILABLE')
    if (!refresh) return { shared: !!deps.account().machineId }
    accountChanged()
    if (!deps.account().machineId) return { shared: false }
    if (stopped || waiting || !active || !deps.ready()) throw new Error('CONNECTORS_SYNC_UNAVAILABLE')
    waiting = true
    const owner = generation, authority = epoch
    try {
      // The core bounds the reply. Retain this single waiter until actual settlement, even after its reply expires.
      const result = await active.run()
      if (result !== 'synced' || stopped || owner !== key() || authority !== epoch) throw new Error('CONNECTORS_SYNC_UNAVAILABLE')
      return { shared: true }
    } finally { waiting = false }
  }

  return {
    sync, accountChanged,
    changed: (revision: number | null) => { accountChanged(); active?.changed(revision) },
    stop: async () => {
      stopped = true
      const old = active
      active = null; old?.stop()
      await Promise.all([old?.settled(), draining])
    },
  }
}
