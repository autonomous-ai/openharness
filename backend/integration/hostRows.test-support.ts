/**
 * Test support: the host form's rows (read/host.ts) in the shapes of the store's old host reads, which it replaced
 * (`hostTabs`, `hostPools`, `hostAssignments`). Suites written against those call these instead and keep their assertions.
 */
import type { AuthUser } from '../src/lib/ssoAuth.js'
import type { SuperTabStore } from '../src/superTabs/store.js'
import { HostReads } from '../src/superTabs/read/host.js'
import type { HostTabRows } from '../src/superTabs/read/contract.js'

type Options = { teamAccountsIdle?: boolean; githubApp?: boolean }

/** A full host read, holding no etags, so every Swarm comes back with its rows. */
async function hostRead(store: SuperTabStore, user: AuthUser, machineId: string, options: Options = {}): Promise<HostTabRows[]> {
  return (await new HostReads(store, options).changes(user, machineId, { full: true })).tabs as HostTabRows[]
}
/** What `store.hostTabs` listed: every Swarm's roster rows, in order. */
export const rosterRows = async (store: SuperTabStore, user: AuthUser, machineId: string, options?: Options) =>
  (await hostRead(store, user, machineId, options)).flatMap(tab => tab.roster)
/** What `store.hostPools` listed: the pool of every Swarm where this machine is the caller's contribution. */
export const poolRows = async (store: SuperTabStore, user: AuthUser, machineId: string, options?: Options) =>
  (await hostRead(store, user, machineId, options)).flatMap(tab => tab.pool ? [tab.pool] : [])
/** What `store.hostAssignments` listed: the active assignments this machine runs for the caller. */
export const assignmentRows = async (store: SuperTabStore, user: AuthUser, machineId: string, options?: Options) =>
  (await hostRead(store, user, machineId, options)).flatMap(tab => tab.assignments)
