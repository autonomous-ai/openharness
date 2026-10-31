/**
 * Gives every project from before instructions its document (design docs/plans/2026-10-30-project-instructions-design.md,
 * Migration). Never run by the server: scripts/swarm-instructions/migrate.ts runs it, a dry run unless `--apply`, after the
 * backend that knows instructions is deployed.
 *
 * Per project without a document: a built-in skill set gets a copy of the template; a custom role set gets one section per
 * role, under the role's name and in its own text, then the template's Workflow and Routing. The project's rules, and the
 * routing policy's notes and differences from the built-in policy, follow under Routing: the owner's words where they
 * exist, a plain sentence where they do not. Nothing is cut for length (the 64 KB limit is a save's). Open tasks' machine
 * and device requirements are not written: the route shows them on their task until it closes.
 *
 * A project that has a document (revision 1 or later, new projects included) is left alone, so a second run writes
 * nothing. Old rules, policy and role texts stay where they are, unread by the new code, for one release.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { clock, guardedWrite, loadAll, reassemble, type HeadData } from '../parts/index.js'
import { swarmTransaction } from '../cache.js'
import { stableId, type SuperTabState } from '../model.js'
import { placeRules, projectRules, projectsOf, skillSetOf, type SwarmProject } from '../projects.js'
import type { SwarmRule } from '../rules.js'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, type RoutingModel, type RoutingPolicy } from '../routingPolicy.js'
import { instructionsHash } from '../instructions.js'
import { INSTRUCTIONS_TEMPLATE, TEMPLATE_INTRO, TEMPLATE_ROUTING, TEMPLATE_WORKFLOW } from '../instructionsTemplate.js'
import { writeInstructions } from '../instructionsStore.js'

type Transaction = Prisma.TransactionClient
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 }
export const MIGRATION_SUMMARY = 'Built from this project\'s skills, rules and routing settings.'

export interface MigrationSource {
  project: SwarmProject
  /** A custom set's stored role texts, by role id (SuperTabRoleText). */
  roleTexts: Record<string, string>
  /** The Swarm's rules: only the project's own are written. */
  rules: SwarmRule[]
  /** The Swarm's effective routing policy (its owner's account policy with the Swarm's override). */
  policy: RoutingPolicy
}

const ENGINES: Record<string, string> = { claude: 'Claude', codex: 'Codex' }
const rowName = (row: Pick<RoutingModel, 'engine' | 'model' | 'effort'>) =>
  `${ENGINES[row.engine] ?? row.engine} ${row.model === 'default' ? 'default model' : row.model} at ${row.effort} effort`
const sameRow = (a: Pick<RoutingModel, 'engine' | 'model' | 'effort'>, b: Pick<RoutingModel, 'engine' | 'model' | 'effort'>) =>
  a.engine === b.engine && a.model === b.model && a.effort === b.effort

/** The policy's settings that differ from the built-in policy, each as one sentence. */
function policyLines(policy: RoutingPolicy): string[] {
  const base = effectivePolicy(null, null).policy, lines: string[] = []
  if (policy.notes.trim()) lines.push(`Routing notes: ${policy.notes.trim()}`)
  for (const row of policy.models) {
    const built = base.models.find(m => sameRow(m, row))
    if (!built) lines.push(row.enabled ? `${rowName(row)} is offered at strength ${row.quality} of 3, cost ${row.cost}.` : `${rowName(row)} is off.`)
    else {
      if (built.enabled !== row.enabled) lines.push(`${rowName(row)} is ${row.enabled ? 'on' : 'off'}.`)
      if (built.quality !== row.quality || built.cost !== row.cost) lines.push(`${rowName(row)} counts as strength ${row.quality} of 3 at cost ${row.cost}.`)
    }
  }
  for (const row of base.models) if (!policy.models.some(m => sameRow(m, row))) lines.push(`${rowName(row)} is not offered.`)
  for (const level of ['low', 'medium', 'high'] as const) {
    if (policy.floor[level] !== base.floor[level]) lines.push(`Work of ${level} difficulty needs a model of strength ${policy.floor[level]} of 3 or more.`)
  }
  if (policy.quotaReserve !== base.quotaReserve) lines.push(`Keep ${policy.quotaReserve}% of each engine's quota in reserve.`)
  const local = policy.localModels ?? base.localModels!, builtLocal = base.localModels!
  if (local.enabled !== builtLocal.enabled) lines.push(`Models on the Swarm's grid are ${local.enabled ? 'on' : 'off'}.`)
  if (local.quality !== builtLocal.quality) lines.push(`A model on the Swarm's grid counts as strength ${local.quality} of 3 unless it is named here.`)
  const named = local.models ?? [], builtNamed = builtLocal.models ?? []
  for (const row of named) {
    if (!builtNamed.some(m => m.model === row.model && m.quality === row.quality)) lines.push(`Grid model ${row.model} counts as strength ${row.quality} of 3.`)
  }
  for (const row of builtNamed) if (!named.some(m => m.model === row.model)) lines.push(`Grid model ${row.model} has no strength of its own.`)
  for (const row of policy.priorOverrides ?? []) lines.push(`For ${row.kind} work, ${row.model} counts as strength ${row.quality} of 3.`)
  return lines
}

/** A custom role's start default (projects.ts RoleDefaults), which the instructions' routing now carries. */
const defaultsLine = (name: string, defaults: NonNullable<NonNullable<SwarmProject['roles']>[number]['defaults']>) =>
  `${name} runs on ${ENGINES[defaults.engine]} ${defaults.model ?? 'default model'}${defaults.effort ? ` at ${defaults.effort} effort` : ''} unless its start names another.`

/** The document [source]'s project gets. Pure: the same source always gives the same text. */
export function documentFor(source: MigrationSource): { from: 'template' | 'custom'; text: string } {
  const { project } = source
  const custom = skillSetOf(project) === 'custom' ? project.roles ?? [] : null
  const lines = [
    ...source.rules.filter(r => r.projectId === project.id).map(r => r.text),
    ...policyLines(source.policy),
    ...(custom ?? []).flatMap(role => role.defaults ? [defaultsLine(role.name, role.defaults)] : []),
  ]
  const body = custom
    ? [TEMPLATE_INTRO, `## Roles\n\n${custom.map(role => `### ${role.name}\n\n${source.roleTexts[role.id] ?? ''}`.trimEnd()).join('\n\n')}`,
      TEMPLATE_WORKFLOW, TEMPLATE_ROUTING].join('\n\n')
    : INSTRUCTIONS_TEMPLATE.trimEnd()
  if (!custom && !lines.length) return { from: 'template', text: INSTRUCTIONS_TEMPLATE }
  const added = lines.length ? `\n\nFrom this project's rules and routing settings before these instructions:\n\n${lines.map(line => `- ${line}`).join('\n')}` : ''
  return { from: custom ? 'custom' : 'template', text: `${body}${added}\n` }
}

export interface MigratedDocument { tabId: string; projectId: string; from: 'template' | 'custom'; bytes: number; text: string }
export interface InstructionsMigrationReport {
  apply: boolean
  /** Swarms in parts that were read. */
  swarms: number
  /** Documents written, or in a dry run to be written, with their text. */
  documents: MigratedDocument[]
  /** Projects that already have a document: left alone. */
  alreadyDone: number
  /** Swarms not in parts yet: they get their documents when they are migrated, then rerun. */
  skipped: string[]
  failed: Array<{ tabId: string; error: string }>
}

/** The report as the script prints it: each document's project, origin and size, its text only for the Swarm named in
 *  [textOf]. A document holds its team's private role texts and rules, and a run against production prints into an
 *  operator's or agent's transcript (review of phase 2). */
export function printableReport(report: InstructionsMigrationReport, opts: { textOf?: string } = {}) {
  return { ...report, documents: report.documents.map(({ text, ...document }) => document.tabId === opts.textOf ? { ...document, text } : document) }
}

interface Plan { headVersion: number; head: HeadData; headFields: { groupCounter: number; visibilityEpoch: number; sequenceBase: number }
  projects: SwarmProject[]; documents: Array<MigratedDocument & { project: SwarmProject }>; alreadyDone: number }

/** What one Swarm's projects would get, read in [tx] (or straight from the database for a dry run). */
async function planSwarm(tx: Transaction, tabId: string): Promise<Plan> {
  const parts = await loadAll(tx, tabId)
  const head = parts.head
  const state = reassemble(parts) as SuperTabState
  // A rule from before rules were per project names its project as commands do (projects.ts placeRules).
  placeRules(state)
  const account = await tx.routingPolicy.findUnique({ where: { id: stableId('routing-policy', state.ownerId, state.environment) } })
  const policy = effectivePolicy(account?.policy ?? null, state.routingPolicy ?? null).policy
  const projects = projectsOf(state)
  const documents: Plan['documents'] = []
  let alreadyDone = 0
  for (const project of projects) {
    if ((project.instructionsRevision ?? 0) > 0) { alreadyDone++; continue }
    const roleTexts = skillSetOf(project) === 'custom'
      ? Object.fromEntries((await tx.superTabRoleText.findMany({ where: { tabId, projectId: project.id } })).map(r => [r.roleId, r.text])) : {}
    const { from, text } = documentFor({ project, roleTexts, rules: projectRules(state, project.id), policy })
    documents.push({ tabId, projectId: project.id, from, bytes: Buffer.byteLength(text), text, project })
  }
  return { headVersion: head.version, head: head.data!, headFields: { groupCounter: parts.groupCounter, visibilityEpoch: parts.visibilityEpoch,
    sequenceBase: parts.sequenceBase }, projects, documents, alreadyDone }
}

/** Writes the documents and names their revision on the head, guarded by the head's version: a command in between wins,
 *  and the Swarm is failed and retried on the next run. */
async function writePlan(tx: Transaction, tabId: string, plan: Plan, now: number): Promise<void> {
  const written = new Map(plan.documents.map(d => [d.projectId, d]))
  // A Swarm from before projects keeps its one project only in `projectsOf`: it is written out, as any project command does.
  const projects = plan.projects.map(({ progress: _progress, ...project }) => {
    const document = written.get(project.id)
    return document ? { ...project, instructionsRevision: 1, instructionsHash: instructionsHash(document.text) } : project
  })
  await guardedWrite(tx, tabId, { op: 'update', kind: 'head', key: 'head', seen: plan.headVersion, data: { ...plan.head, projects }, head: plan.headFields }, clock.next())
  for (const document of plan.documents) {
    await writeInstructions(tx, tabId, { projectId: document.projectId, revision: 1, hash: instructionsHash(document.text), text: document.text,
      summary: MIGRATION_SUMMARY, writtenBy: { kind: 'system', id: 'migration' }, askedBy: document.project.ownerId, at: now })
  }
}

export async function migrateInstructions(db: PrismaClient, opts: { apply: boolean; now?: () => number }): Promise<InstructionsMigrationReport> {
  const now = opts.now ?? Date.now
  const report: InstructionsMigrationReport = { apply: opts.apply, swarms: 0, documents: [], alreadyDone: 0, skipped: [], failed: [] }
  const rows = await db.superTab.findMany({ select: { id: true, format: true }, orderBy: { id: 'asc' } })
  for (const row of rows) {
    if (row.format !== 2) { report.skipped.push(row.id); continue }
    report.swarms++
    try {
      const plan = opts.apply
        ? await swarmTransaction(db, async tx => {
          const planned = await planSwarm(tx, row.id)
          if (planned.documents.length) await writePlan(tx, row.id, planned, now())
          return planned
        }, TRANSACTION)
        : await planSwarm(db as unknown as Transaction, row.id)
      report.alreadyDone += plan.alreadyDone
      report.documents.push(...plan.documents.map(({ project: _project, ...document }) => document))
    } catch (error) {
      report.failed.push({ tabId: row.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}
