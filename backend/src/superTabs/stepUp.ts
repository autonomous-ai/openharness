/** Cheap first, step up on failure (Ken, 2026-10-29). Simple work runs on a model served on the Swarm's grid first (cli
 *  superTabs/route.ts softOf); when that attempt's first review says Ready no, or its grid host never starts its agent, the
 *  group steps up a tier: no grid and quality 2, then quality 3, at most twice. Since 2026-10-30 a build needs quality 3 anyway
 *  (rules.ts buildRefusal), so the first step takes the top tier too. The server records the step,
 *  closes the failed attempt and wakes the Lead; the Lead's route and start run the next attempt, since only its machine can
 *  probe the others (autoReview.ts, the same ruling for Reviewers). */
import { activeWork, finishWorker, type Conversation, type SuperTabState } from './model.js'
import { policyQuality, targetQuality, type RunTarget } from './rules.js'
import type { RoutingPolicy } from './routingPolicy.js'

/** Grid, then a stronger model, then the top tier; after that it is the Lead's decision (Lead, 2026-10-29). Builds run at the
 *  top tier since 2026-10-30, so in practice grid, then the top tier. */
export const MAX_STEP_UPS = 2
/** What of the failed attempt a brief keeps: conversation.create takes briefs up to 8,000 characters. */
const CARRY_CHARS = 2000
export const REVIEW_FAILED = 'Its first review said Ready no.'
export const GRID_START_FAILED = 'Its grid host did not start the agent.'

/** A group's last step up: the attempt it opened (2 or 3), the least quality from then on, why, when, and what the failed
 *  attempt left for the next one's brief. */
export interface StepUp { attempt: number; floor: number; reason: string; at: number; carry: string
  /** The failed start that stepped it up, so another report of that failure steps nothing up. */
  startId?: string }

const lower = (text: string) => `${text[0]!.toLowerCase()}${text.slice(1)}`

/** Whether [group]'s current attempt is on the cheap path: on a grid model, or already stepped up and below the top tier as
 *  its ledger rates it, its launch on the engine's own model included (review of ee4ee6c9a). */
export function cheapAttempt(group: Conversation, policy: RoutingPolicy): boolean {
  const run = group.ledger?.runs?.find(r => r.assignmentId === group.assignment?.id)
  if (!run) return false
  if (run.grid) return true
  return !!group.stepUp && policyQuality(policy, run.engine, run.model, run.effort ?? null, !!run.engineDefault) < 3
}

/** Steps [group] up for [reason]: records the step, closes its attempt if one is going, and says what to tell its Lead and
 *  whom it stopped. Null for a review, once it stepped up [MAX_STEP_UPS] times, or for a failed start ([startId]) that
 *  stepped it up already. */
export function stepUp(state: SuperTabState, group: Conversation, reason: string, now: number, startId?: string): { notice: string; stopped: string | null } | null {
  const attempt = (group.stepUp?.attempt ?? 1) + 1
  if (group.reviewOf || attempt > MAX_STEP_UPS + 1 || (startId && group.stepUp?.startId === startId)) return null
  const assignment = group.assignment
  const findings = group.checks.filter(c => c.independent && c.evidence && !c.passedBy).map(c => c.evidence!)
  const carry = [...group.pullRequestUrls?.length ? [`Pull requests: ${group.pullRequestUrls.join(' ')}`] : [],
    ...assignment?.result ? [`Last result: ${assignment.result}`] : [], ...findings.length ? [`Findings:\n${findings.join('\n')}`] : []]
    .join('\n').slice(0, CARRY_CHARS)
  const floor = attempt === 2 ? 2 : 3
  group.stepUp = { attempt, floor, reason, at: now, carry, ...startId ? { startId } : {} }
  let stopped: string | null = null
  if (assignment && activeWork(group)) {
    assignment.status = 'cancelled'
    assignment.result = `Stepped up: ${lower(reason)}`
    finishWorker(state, assignment.agentId, group)
    stopped = assignment.agentId
  }
  return { stopped, notice: `#${group.number} stepped up to attempt ${attempt}: ${lower(reason)} Route it again: the route leaves out models on the grid and `
    + `below quality ${floor}, and the new attempt's brief carries the branch, the last result and the findings.` }
}

/** Why [target] may not take a stepped-up group's work: a grid model, or one the policy rates below the step's floor. */
export function stepUpRefusal(group: Conversation, target: RunTarget, policy: RoutingPolicy): string | null {
  const step = group.stepUp
  if (!step) return null
  return target.gridModel || targetQuality(policy, target) < step.floor
    ? `This task stepped up from a cheaper model: it runs on no model on the grid and nothing below quality ${step.floor}.` : null
}

/** The next attempt's brief: what the failed one left. */
export const carryOver = (group: Conversation) => group.stepUp?.carry ? `\n\nCarry-over from attempt ${group.stepUp.attempt - 1}:\n${group.stepUp.carry}` : ''
