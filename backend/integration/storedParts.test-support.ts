import type { PrismaClient } from '@prisma/client'
import { swarmTransaction } from '../src/superTabs/cache.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import * as parts from '../src/superTabs/parts/index.js'

type Tx = Parameters<Parameters<typeof swarmTransaction>[1]>[0]

/** Rewrites [tab]'s parts after [change], as an older release would have left them: for data no command writes any more.
 *  Versions keep rising. [after] runs in the same transaction, with what [change] returned. */
export async function rewriteParts<T>(db: PrismaClient, tab: string, change: (state: SuperTabState) => T, after?: (tx: Tx, value: T) => Promise<unknown>): Promise<T> {
  return swarmTransaction(db, async tx => {
    const current = await parts.loadAll(tx, tab)
    const state = parts.reassemble(current)
    const value = change(state)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
    if (after) await after(tx, value)
    return value
  })
}
