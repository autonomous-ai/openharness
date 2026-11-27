/** Explicit inline/older-master resume repair only. Review removal on 2026-12-15. */
import { join } from 'node:path'
import { homeRoots } from '../lib/engineHomes.js'
import { launchContract } from './launches.js'
import { repairHistory } from './kit/resumeRepair.js'
import type { HistoryRepair, ResumeSource } from './facets/resumeRepair.js'
export type { ResumeSource } from './facets/resumeRepair.js'

export async function prepareResume(source: ResumeSource, current: () => boolean): Promise<HistoryRepair> {
  const contract = launchContract(source.engine)?.resumeRepair
  if (!contract || !source.sessionId) return { repairedItems: 0 }
  const { home, folder } = contract.sessions
  const roots = (source.codexHome ? [source.codexHome] : homeRoots(home.setting)).map(root => join(root, folder))
  return repairHistory(contract, source.sessionId, source.transcriptPath, roots, current)
}
