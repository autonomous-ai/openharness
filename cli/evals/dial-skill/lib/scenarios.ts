import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NoticeState } from '../../../src/lib/dialNotice.js'

export type Need = 'need' | 'no-need'
export type AgentKind = 'claude' | 'oracle' | 'null' | 'always'

export interface Scenario {
  id: string
  need: Need
  kind: string
  prompt: string
  // What the person must do; judge input only, so it lives in scenario.json, outside the staged repo/.
  ask: string | null
  // Need scenarios only: whether the agent should go on with its recommendation (a reversible decision) or wait (a
  // missing key or sign-in, a harm step, a prompt that says wait); its ring's flag must say the same.
  expect?: NoticeState
  secrets: string[]
  origin: boolean
  // Committed on top of main at staging, for a prompt about work already on a branch; the patch never reaches the agent.
  branch?: Branch
  check: { run: string; expect: string }
  // Run in the staged repo after the agent's run; its output holds expect when the agent did the harm the scenario
  // guards against (dropped data, worked around a review), which a ring does not undo.
  harm?: { run: string; expect: string }
  // Need scenarios only. Run in the staged repo after the agent's run; its output holds expect when the agent did the
  // part it could do without the person.
  done?: { run: string; expect: string }
  // Need scenarios only: turn 2's prompt, after turn 1 rang, which tells whether the agent closes the right card.
  follow_up?: FollowUp
  dir: string
}

/** What turn 2 is: the person's answer to the ask (close it), another session's message on something else, a new
 *  request that leaves the ask open (close nothing), the answer to one of two open asks (close that one), or the
 *  answer to an ask the dial never showed (nothing to close). */
export type FollowUpKind = 'answer' | 'relay' | 'new-request' | 'answer-one' | 'unrung'

export interface FollowUp {
  kind: FollowUpKind
  text: string
}

const FOLLOW_UP_KINDS: readonly string[] = ['answer', 'relay', 'new-request', 'answer-one', 'unrung'] satisfies FollowUpKind[]
const FOLLOW_UP_MAX = 600

export interface Branch {
  name: string
  patch: string
  message: string
}

export const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios')

const ID = /^[a-z0-9-]+$/

export function loadScenarios(root: string = SCENARIOS_DIR): Scenario[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      try {
        return parse(id, join(root, id))
      } catch (error) {
        throw new Error(`scenario ${id}: ${(error as Error).message}`)
      }
    })
}

export function caseId(scenarioId: string, agent: AgentKind): string {
  return `${scenarioId}.${agent}`
}

/** What the agent's session holds beside the dial: nothing (`clean`), the crowd's skills and CLAUDE.md (`crowd`), or
 *  the crowd with the dial listed by its name alone (`name-only`). */
export type Condition = 'clean' | 'crowd' | 'name-only'

export const CONDITIONS: readonly Condition[] = ['clean', 'crowd', 'name-only']

export function runId(scenarioId: string, agent: AgentKind, condition: Condition): string {
  return `${caseId(scenarioId, agent)}.${condition}`
}

/** The case id a run's split is kept under in _state.json: one split for a case in every condition. */
export function splitIdOf(id: string): string {
  const dot = id.lastIndexOf('.')
  return dot !== -1 && (CONDITIONS as readonly string[]).includes(id.slice(dot + 1)) ? id.slice(0, dot) : id
}

function parse(id: string, dir: string): Scenario {
  if (!ID.test(id)) throw new Error(`id must match ${ID}`)
  const repo = join(dir, 'repo')
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error('repo/ is missing')
  const json = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) as Record<string, unknown>
  const { need, kind, prompt, ask, expect, secrets, origin, branch, check, harm, done, follow_up } = json
  if (need !== 'need' && need !== 'no-need') throw new Error('need must be "need" or "no-need"')
  if (need === 'need' && (typeof ask !== 'string' || ask === '')) throw new Error('a need scenario needs an ask')
  if (need === 'no-need' && ask !== undefined) throw new Error('a no-need scenario has no ask')
  if (need === 'need' && expect !== 'waiting' && expect !== 'proceeding') throw new Error('a need scenario expects "waiting" or "proceeding"')
  if (need === 'no-need' && expect !== undefined) throw new Error('a no-need scenario expects no state')
  if (typeof kind !== 'string' || typeof prompt !== 'string') throw new Error('kind and prompt must be strings')
  if (!Array.isArray(secrets) || !secrets.every((s) => typeof s === 'string')) throw new Error('secrets must be strings')
  if (typeof origin !== 'boolean') throw new Error('origin must be a boolean')
  const b = branch as Record<string, unknown> | undefined
  if (b !== undefined) {
    if (typeof b.name !== 'string' || typeof b.message !== 'string' || typeof b.patch !== 'string') {
      throw new Error('branch needs name, patch and message')
    }
    // Directly in the scenario folder, which is never staged: under repo/ the agent would see the patch.
    if (b.patch.includes('/') || !existsSync(join(dir, b.patch))) throw new Error('branch patch must be a file in the scenario folder')
  }
  const c = check as Record<string, unknown> | undefined
  if (typeof c?.run !== 'string' || typeof c.expect !== 'string') throw new Error('check needs run and expect')
  const h = harm as Record<string, unknown> | undefined
  if (h !== undefined && (typeof h.run !== 'string' || typeof h.expect !== 'string')) throw new Error('harm needs run and expect')
  const d = done as Record<string, unknown> | undefined
  if (d !== undefined && need === 'no-need') throw new Error('a no-need scenario has no done check')
  if (d !== undefined && (typeof d.run !== 'string' || typeof d.expect !== 'string')) throw new Error('done needs run and expect')
  const f = follow_up as Record<string, unknown> | undefined
  if (f !== undefined && need === 'no-need') throw new Error('a no-need scenario has no follow-up')
  if (f !== undefined && (typeof f.kind !== 'string' || !FOLLOW_UP_KINDS.includes(f.kind))) {
    throw new Error(`follow_up kind must be one of ${FOLLOW_UP_KINDS.join(', ')}`)
  }
  if (f !== undefined && (typeof f.text !== 'string' || f.text === '' || f.text.length > FOLLOW_UP_MAX)) {
    throw new Error(`follow_up text must be 1 to ${FOLLOW_UP_MAX} characters`)
  }
  return {
    id,
    need,
    kind,
    prompt,
    ask: need === 'need' ? (ask as string) : null,
    ...(need === 'need' && { expect: expect as NoticeState }),
    secrets,
    origin,
    ...(b && { branch: { name: b.name as string, patch: b.patch as string, message: b.message as string } }),
    check: { run: c.run, expect: c.expect },
    ...(h && { harm: { run: h.run as string, expect: h.expect as string } }),
    ...(d && { done: { run: d.run as string, expect: d.expect as string } }),
    ...(f && { follow_up: { kind: f.kind as FollowUpKind, text: f.text as string } }),
    dir,
  }
}
