/**
 * Task #3896: seed only the four projects named by Dee in autonomous.ai. Run explicitly after the backend deploy;
 * never on reads or in the worker. A dry run resolves their ids; missing or ambiguous names refuse the entire seed.
 * An owner's saved choice wins. Only the existing head is read and written, guarded by its version, with no task scan.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { SwarmProject } from '../projects.js'
import type { ProjectProcess } from '../process.js'
import { clock, guardedWrite, type HeadData } from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import { fail } from '../model.js'

const TAB = 'c51479bd73b59e58176ad9e4'
const SEEDS: ReadonlyArray<{ name: string; process: ProjectProcess }> = [
  { name: 'harness', process: 'full' }, { name: 'lamp', process: 'full' },
  { name: 'scout', process: 'simple' }, { name: 'harness-gtm', process: 'simple' },
]
interface SeedPlan {
  projects: SwarmProject[]
  changed: Array<{ projectId: string; process: ProjectProcess }>
  held: Array<{ name: string; reason: 'missing' | 'ambiguous' }>
}

/** Plans on a copy, never by a name outside the Swarm that asked, never overwriting an owner's setting. */
export function processSeedPlan(tabId: string, projects: SwarmProject[]): SeedPlan {
  const plan: SeedPlan = { projects: structuredClone(projects), changed: [], held: [] }
  if (tabId !== TAB) return plan
  const targets = SEEDS.map(seed => ({ ...seed, matches: plan.projects.filter(project => project.name === seed.name) }))
  for (const target of targets) if (target.matches.length !== 1) {
    plan.held.push({ name: target.name, reason: target.matches.length ? 'ambiguous' : 'missing' })
  }
  if (plan.held.length) return plan
  for (const { process, matches } of targets) {
    const project = matches[0]!
    if (project.process !== undefined) continue
    project.process = process
    plan.changed.push({ projectId: project.id, process })
  }
  return plan
}

/** Primary-key lookup of one head, and at most one guarded write. A concurrent setting change retries at the caller. */
export async function seedProjectProcesses(db: PrismaClient, opts: { apply: boolean }) {
  const seed = async (tx: Prisma.TransactionClient) => {
    const head = await tx.swarmHead.findUnique({ where: { id: `${TAB}:head` }, select: {
      version: true, deleted: true, data: true, groupCounter: true, visibilityEpoch: true, sequenceBase: true,
    } })
    const data = head?.data as HeadData | undefined
    if (!head || head.deleted || !data?.projects || data.deletion) fail('PROCESS_SEED_UNAVAILABLE', 'The requesting Swarm has no live project head.', 409)
    const plan = processSeedPlan(TAB, data.projects)
    const applied = opts.apply && !plan.held.length && plan.changed.length > 0
    if (applied) await guardedWrite(tx, TAB, { op: 'update', kind: 'head', key: 'head', seen: head.version,
      data: { ...data, projects: plan.projects }, head: { groupCounter: head.groupCounter, visibilityEpoch: head.visibilityEpoch, sequenceBase: head.sequenceBase } }, clock.next())
    return { tabId: TAB, applied, changed: plan.changed, held: plan.held }
  }
  return opts.apply ? swarmTransaction(db, seed, { maxWait: 5_000, timeout: 10_000 }) : seed(db as unknown as Prisma.TransactionClient)
}
