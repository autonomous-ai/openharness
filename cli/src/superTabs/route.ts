/** Super Tab routing v1, the pure half (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * The system removes what cannot run the task, Jev chooses among the rest with the full context, and a
 * fixed policy order decides when Jev is unsure or unavailable. Jev's acceptance rule is the voice
 * router's (`jevPick`), tuned on the owner's desk on 2026-10-10. */
import { isAbsolute } from 'node:path'
import type { JevChoice, JevChoiceAnswer } from '../lib/jev/jevClient.js'
import { claudeAliasForModel } from '../engines/claude/runtimeProfile.js'
import { jevPick } from '../lib/routeDecide.js'

export type Level = 'low' | 'medium' | 'high'
export interface Assessment { difficulty: Level; risk: Level; why: string; needs: { tools: string[]; devices: string[]; cwd?: string } }
export interface PolicyModel { engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number; enabled: boolean }
export interface Policy { version: 1; models: PolicyModel[]; floor: Record<Level, number>; quotaReserve: number; notes: string }
export interface Quota { known: boolean; leftPercent: number | null; resetsAt: number | null }
export interface Probe {
  kind: 'member' | 'new'; agentId?: string; name?: string; machineId: string; machineName: string
  engine: 'claude' | 'codex'; model: string; effort: string; quality: number; cost: number
  quota: Quota; activity: string; known: boolean; refusals: string[]
}
export interface Shown extends Probe { id: string; title: string; label: string }
export interface Choice { shown: Shown[]; excluded: Array<{ title: string; reason: string }>; floor: number; belowFloor: boolean }
export interface Verdict { pick: Shown; via: 'jev' | 'order' | 'only'; p: number | null; why: string; fallback?: 'unsure' | 'unavailable' }

const LEVELS: Level[] = ['low', 'medium', 'high']
const MAX_SHOWN = 12
const ENGINE = { claude: 'Claude', codex: 'Codex' } as const
const cut = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`

export function parseAssessment(value: unknown): Assessment | string {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  if (!LEVELS.includes(v.difficulty as Level)) return 'Set difficulty to low, medium or high.'
  if (!LEVELS.includes(v.risk as Level)) return 'Set risk to low, medium or high.'
  const why = typeof v.why === 'string' ? v.why.trim() : ''
  if (!why || why.length > 300) return 'Give why in 1 to 300 characters.'
  const needs = (v.needs && typeof v.needs === 'object' ? v.needs : {}) as Record<string, unknown>
  const list = (x: unknown) => Array.isArray(x) && x.every(i => typeof i === 'string') ? x as string[] : []
  const cwd = needs.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) return 'needs.cwd must be an absolute path.'
  return { difficulty: v.difficulty as Level, risk: v.risk as Level, why, needs: { tools: list(needs.tools), devices: list(needs.devices), ...(cwd ? { cwd } : {}) } }
}

export const floorFor = (policy: Policy, a: Assessment): number => Math.min(3, policy.floor[a.difficulty] + (a.risk === 'high' ? 1 : 0))

/** Claude sends ISO strings, Codex epoch seconds; anything above 1e10 is already milliseconds. */
function resetMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e10 ? value : value * 1000
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null }
  return null
}
export function quotaOf2(q: { known: boolean; windows: Array<{ usedPercent: number; resetsAt: unknown }> }): Quota {
  if (!q.known || !q.windows.length) return { known: false, leftPercent: null, resetsAt: null }
  const tightest = q.windows.reduce((x, y) => y.usedPercent > x.usedPercent ? y : x)
  return { known: true, leftPercent: Math.max(0, 100 - tightest.usedPercent), resetsAt: resetMs(tightest.resetsAt) }
}

/** A member's model is what its engine reported after work: Claude's full id (`claude-opus-4-7`, `claude-sonnet-4-5[1m]`),
 * Codex's slug (`gpt-5.5`). The policy names Claude families and a Codex `default`, so the id is reduced to its family
 * first, and an id with no row of its own takes the engine's `default` row before the floor. */
export function rateFor(policy: Policy, engine: string, model: string | null, effort: string | null): { quality: number; cost: number } {
  const name = engine === 'claude' && model ? claudeAliasForModel(model.replace(/\[1m\]$/i, '')) ?? model : model ?? 'default'
  const row = policy.models.find(m => m.engine === engine && m.model === name && m.effort === (effort ?? 'default'))
    ?? policy.models.find(m => m.engine === engine && m.model === name)
    ?? policy.models.find(m => m.engine === engine && m.model === 'default')
  return row ? { quality: row.quality, cost: row.cost } : { quality: 1, cost: 1 }
}

const titleOf = (p: Probe) => cut(`${p.kind === 'member' ? p.name ?? 'Member' : 'New agent'} · ${ENGINE[p.engine]} ${p.model} ${p.effort} · ${p.machineName}`, 160)
/** Jev does not know the time, so a reset is told as how far away it is. */
function resetsIn(resetsAt: number, now: number): string {
  const ms = Math.max(0, resetsAt - now)
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)} days`
}
function quotaText(q: Quota, now: number): string {
  if (!q.known || q.leftPercent === null) return 'quota unknown'
  if (q.resetsAt === null) return `quota ${Math.round(q.leftPercent)}% left`
  return `quota ${Math.round(q.leftPercent)}% left, resets in ${resetsIn(q.resetsAt, now)}`
}
const labelOf = (p: Probe, now: number) => cut(`${p.kind === 'member' ? `Member ${p.name ?? ''}`.trim() : 'New agent'} · ${ENGINE[p.engine]} ${p.model} ${p.effort} · quality ${p.quality}, cost ${p.cost} · ${p.machineName} · ${p.activity} · ${quotaText(p.quota, now)}`, 640)

/** The fixed policy order (D): cheaper, then more quota left, then an earlier reset, then a member, then by title. */
function compare(x: Probe, y: Probe): number {
  return x.cost - y.cost
    || (y.quota.leftPercent ?? -1) - (x.quota.leftPercent ?? -1)
    || (x.quota.resetsAt ?? Infinity) - (y.quota.resetsAt ?? Infinity)
    || (x.kind === y.kind ? 0 : x.kind === 'member' ? -1 : 1)
    || titleOf(x).localeCompare(titleOf(y))
}

export function choose(probes: Probe[], policy: Policy, a: Assessment, now: number = Date.now()): Choice | { error: 'NO_CANDIDATE'; excluded: Array<{ title: string; reason: string }> } {
  const excluded = probes.filter(p => p.refusals.length).map(p => ({ title: titleOf(p), reason: p.refusals.join(' ') }))
  const viable = probes.filter(p => !p.refusals.length)
  if (!viable.length) return { error: 'NO_CANDIDATE', excluded }
  const floor = floorFor(policy, a)
  // Each step narrows only when something is left, so a floor-meeting candidate is never dropped for being
  // unknown or low on quota; those are fallbacks, not filters.
  const meeting = viable.filter(p => p.quality >= floor)
  const byFloor = meeting.length ? meeting : viable
  const known = byFloor.filter(p => p.known)
  const byKnown = known.length ? known : byFloor
  const funded = byKnown.filter(p => p.quota.leftPercent === null || p.quota.leftPercent >= policy.quotaReserve)
  const set = funded.length ? funded : byKnown
  const shown = [...set].sort(compare).slice(0, MAX_SHOWN)
    .map((p, i) => ({ ...p, id: `c${i}`, title: titleOf(p), label: labelOf(p, now) }))
  return { shown, excluded, floor, belowFloor: !meeting.length }
}

const INSTRUCTIONS = cut([
  'Choose the candidate that should do this task.',
  'The Lead assessed its difficulty and risk; every candidate shown meets the quality floor unless the policy says none does.',
  'Prefer lower cost, then more quota left and an earlier reset, unless the task, its history or the policy notes give a clear reason otherwise.',
  'A candidate that already failed or stopped on this task is a worse choice. An idle member already in the Super Tab saves a start.',
].join(' '), 1500)

export function jevQuestion(input: { title: string; brief: string; checks: string[]; history: string[] }, a: Assessment, policy: Policy, choice: Choice) {
  const state = {
    task: cut(`Group: ${cut(input.title, 160)}\nBrief: ${cut(input.brief, 2000)}\nChecks:\n${cut(input.checks.map(c => `- ${c}`).join('\n'), 2000)}`, 4400),
    lead: cut(`Difficulty: ${a.difficulty}. Risk: ${a.risk}. Why: ${a.why}. Needs tools: ${a.needs.tools.join(', ') || 'none'}; devices: ${a.needs.devices.join(', ') || 'none'}.`, 800),
    policy: cut(`Quality floor: ${choice.floor}${choice.belowFloor ? ' (no candidate meets it; all are shown)' : ''}. Notes: ${policy.notes || 'none'}`, 700),
    history: cut(input.history.length ? input.history.join('\n') : 'No earlier attempts.', 2000),
  }
  const questions: Record<string, JevChoice> = {
    who: { type: 'choice', instructions: INSTRUCTIONS, criteria: Object.fromEntries(choice.shown.map(s => [s.id, s.label])) },
  }
  return { state, questions }
}

export function decide(choice: Choice, answer: JevChoiceAnswer | undefined, unavailable: string | null): Verdict {
  const first = choice.shown[0]
  if (choice.shown.length === 1) return { pick: first, via: 'only', p: null, why: 'Only candidate that can run this task.' }
  const picked = unavailable ? undefined : jevPick(answer, choice.shown.map(s => s.id), true)
  if (picked) {
    const pick = choice.shown.find(s => s.id === picked)!
    return { pick, via: 'jev', p: answer!.probabilities[picked], why: `Jev chose ${pick.title}.` }
  }
  const reason = unavailable ? `Jev unavailable (${unavailable})` : 'Jev unsure'
  return { pick: first, via: 'order', p: null, why: `${reason}; first in the policy order.`, fallback: unavailable ? 'unavailable' : 'unsure' }
}

export function recordOf(choice: Choice, verdict: Verdict, a: Assessment, policy: Policy): Record<string, unknown> {
  return {
    assessment: { difficulty: a.difficulty, risk: a.risk, why: a.why },
    candidates: choice.shown.map(s => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
      engine: s.engine, model: s.model, effort: s.effort, quality: s.quality, cost: s.cost, title: s.title, label: s.label })),
    excluded: choice.excluded.slice(0, 200).map(e => ({ title: e.title, reason: cut(e.reason, 500) })),
    floor: choice.floor, notes: policy.notes.length > 0,
    pick: verdict.pick.id, via: verdict.via, ...(verdict.fallback ? { fallback: verdict.fallback } : {}), p: verdict.p, belowFloor: choice.belowFloor, why: cut(verdict.why, 300),
  }
}
