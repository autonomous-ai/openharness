/**
 * One machine (docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is a mechanism under the scenes,
 * so a list shows that Mac once. `GET /api/machines` names, on a team machine that lives on a Mac, the Mac's own machine
 * (`hostMachineId`); this folds each such row into its Mac's. A team machine whose Mac is not listed (deleted, another
 * environment) and a dedicated one (`harness team on`, no Mac) stay rows of their own.
 */
export interface FoldableMachine { machineId: string; hostMachineId?: string | null }

/** [rows] with each team machine folded into its Mac's row (`team`), in the order the Macs were listed. */
export function foldTeamMachines<T extends FoldableMachine>(rows: T[]): Array<T & { team: T[] }> {
  const ids = new Set(rows.map(r => r.machineId))
  // A Mac is a listed machine that is not itself folded into another: never a team machine, never its own host.
  const macOf = (r: T) => r.hostMachineId && r.hostMachineId !== r.machineId && ids.has(r.hostMachineId)
    && !rows.find(m => m.machineId === r.hostMachineId)?.hostMachineId ? r.hostMachineId : null
  return rows.filter(r => !macOf(r)).map(r => ({ ...r, team: rows.filter(t => macOf(t) === r.machineId) }))
}
