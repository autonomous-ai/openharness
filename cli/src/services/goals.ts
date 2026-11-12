/**
 * Hachi's goals (docs/design/2026-11-12-hachi.md, "Goals: what finished means"): `harness goal open` names a goal in
 * the person's words, `harness new --goal` records each harness started for it, and `harness goal done` closes it.
 * That close is the one signal a program can check that a goal finished: the notice, the unread dot and the goal
 * measures come from it, never from what Hachi writes.
 *
 * Only the Hachi harness asks, from its pane on this machine, which is its home: the pane's harness is read here from
 * the core, never from what the request says, and anything else is refused by name (`NOT_HACHI`, exit 5 in the CLI).
 *
 * Kept in this machine's data folder, `hachi/goals.json`, mode 0600: an id, the title, the harnesses (machine and
 * creation, and the harness once made) and three times. At most 50 open goals; a closed one is pruned 7 days after it
 * closed. Never synced and never sent to the backend. A service of its own, not the core's: a session runs without it.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Asker, CoreApi, ServiceRequests } from '../core/api.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import { sessionForPaneId } from '../lib/terminalRuntime.js'

/** The requests the goals answer, declared in core/api.ts for the core to route. */
export { GOALS_REQUESTS } from '../core/api.js'

export const GOALS_OPEN_MAX = 50
export const GOAL_TITLE_MAX = 80
/** Harnesses one goal records: five times what Hachi may run at once (agentClient/commands.ts `SPAWN_LIMITS`). */
export const GOAL_HARNESSES_MAX = 40
export const GOAL_KEPT_MS = 7 * 24 * 60 * 60_000

export const goalsPath = (dataDir: string): string => join(dataDir, 'hachi', 'goals.json')

/** A harness started for a goal: by its creation, which a start has before it is made, and the harness once it is. */
export interface GoalHarness { machineId: string; creationId: string; agentId: string | null }
export interface Goal {
  id: string
  title: string
  harnesses: GoalHarness[]
  openedAt: number
  /** When the last harness was recorded under it. */
  lastStartAt: number | null
  doneAt: number | null
}

const NOT_HACHI = { error: 'NOT_HACHI', message: 'Only Hachi keeps goals. Do the work, and say what is done in your answer.' }

const isText = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 128
const isTime = (v: unknown): v is number | null => v === null || Number.isSafeInteger(v)
const isGoal = (v: unknown): v is Goal => {
  const g = v as Partial<Goal> | null
  return !!g && isText(g.id) && typeof g.title === 'string' && Array.isArray(g.harnesses) && Number.isSafeInteger(g.openedAt)
    && isTime(g.lastStartAt ?? null) && isTime(g.doneAt ?? null)
}

export function startGoals(core: CoreApi, deps: { now?: () => number } = {}): ServiceRequests {
  const now = deps.now ?? Date.now
  const file = goalsPath(core.dataDir)

  /** The goals kept, without those closed more than a week ago, and whether the file holds any others. A file that
   *  cannot be read is no goals, said by its code: never its contents, which are the person's words. */
  const read = (): { goals: Goal[]; pruned: boolean } => {
    let kept: unknown
    try { kept = (JSON.parse(readFileSync(file, 'utf8')) as { goals?: unknown }).goals } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.error(`[goals] goals.json unreadable · ${code ?? (error as Error).name}`)
      return { goals: [], pruned: false }
    }
    const all = Array.isArray(kept) ? kept : []
    const goals = all.filter(isGoal).filter((g) => g.doneAt === null || now() - g.doneAt < GOAL_KEPT_MS)
    return { goals, pruned: goals.length !== all.length }
  }
  /** Written whole and renamed into place, owner-only: the titles are the person's words. False, and a log line by its
   *  code, when this computer could not save it. */
  const write = (goals: Goal[]): boolean => {
    try {
      mkdirSync(join(core.dataDir, 'hachi'), { recursive: true, mode: 0o700 })
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ goals }), { mode: 0o600 })
      renameSync(temp, file)
      chmodSync(file, 0o600)
      return true
    } catch (error) {
      console.error(`[goals] goals.json not written · ${(error as NodeJS.ErrnoException).code}`)
      return false
    }
  }
  const NOT_SAVED = { error: 'NOT_SAVED', message: 'Harness could not save the goal on this computer. Try again in a moment.' }

  /** The Hachi harness, by the pane the request came from on this machine; anything else is no caller. */
  const hachi = (payload: Record<string, unknown>, asker: Asker): boolean => {
    if (!asker.local || typeof payload.pane !== 'string' || !payload.pane) return false
    return sessionForPaneId(core.agents.live(), payload.pane)?.dsh === HACHI_ID
  }
  /** A request only Hachi may make, on the goals as they are kept. */
  const asked = (run: (payload: Record<string, unknown>, goals: Goal[], pruned: boolean) => Record<string, unknown>) =>
    (payload: Record<string, unknown>, asker: Asker): Record<string, unknown> => {
      if (!hachi(payload, asker)) return NOT_HACHI
      const { goals, pruned } = read()
      return run(payload, goals, pruned)
    }

  /** The open goal [id] names, or the refusal. */
  const openGoal = (goals: Goal[], id: unknown): { goal: Goal } | { refusal: Record<string, unknown> } => {
    const goal = goals.find((g) => g.id === id)
    if (!goal) return { refusal: { error: 'UNKNOWN_GOAL', message: 'No such goal. harness goal list lists them.' } }
    return goal.doneAt === null ? { goal } : { refusal: { error: 'GOAL_DONE', message: 'That goal is done. Open a new one for new work.' } }
  }

  return {
    goal_open: asked((payload, goals) => {
      const title = typeof payload.title === 'string' ? payload.title.replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim() : ''
      if (!title || title.length > GOAL_TITLE_MAX) return { error: 'BAD_TITLE', message: `A goal's title is 1 to ${GOAL_TITLE_MAX} characters, from the person's own words.` }
      if (goals.filter((g) => g.doneAt === null).length >= GOALS_OPEN_MAX) {
        return { error: 'GOAL_LIMIT', message: `${GOALS_OPEN_MAX} goals are open. Close the finished ones first (harness goal done <id>).` }
      }
      let id: string
      do id = randomBytes(4).toString('hex'); while (goals.some((g) => g.id === id))
      const goal: Goal = { id, title, harnesses: [], openedAt: now(), lastStartAt: null, doneAt: null }
      return write([...goals, goal]) ? { goal } : NOT_SAVED
    }),

    goal_add: asked((payload, goals) => {
      const found = openGoal(goals, payload.id)
      if ('refusal' in found) return found.refusal
      const { goal } = found
      const { machineId, creationId, agentId = null } = payload
      if (!isText(machineId) || !isText(creationId) || (agentId !== null && !isText(agentId))) {
        return { error: 'BAD_HARNESS', message: 'Say the harness by its machine and creation.' }
      }
      // A start recorded as asked for, then again once made: one harness, now with its id.
      const known = goal.harnesses.find((h) => h.machineId === machineId && h.creationId === creationId)
      if (known) known.agentId = agentId ?? known.agentId
      else if (goal.harnesses.length >= GOAL_HARNESSES_MAX) return { error: 'GOAL_FULL', message: `A goal records at most ${GOAL_HARNESSES_MAX} harnesses. Open another goal.` }
      else goal.harnesses.push({ machineId, creationId, agentId })
      goal.lastStartAt = now()
      return write(goals) ? { goal } : NOT_SAVED
    }),

    goal_done: asked((payload, goals) => {
      const goal = goals.find((g) => g.id === payload.id)
      if (!goal) return { error: 'UNKNOWN_GOAL', message: 'No such goal. harness goal list lists them.' }
      // Done twice is done once: the notice it raises is not raised again.
      if (goal.doneAt !== null) return { goal }
      if (!goal.harnesses.length) return { error: 'GOAL_EMPTY', message: 'No harness was started for that goal, so it is not done. Start its work with harness new --goal <id>.' }
      goal.doneAt = now()
      return write(goals) ? { goal } : NOT_SAVED
    }),

    goal_list: asked((_payload, goals, pruned) => {
      // A list is a read: the file is written only to drop what is past its week.
      if (pruned) write(goals)
      return { goals: [...goals].sort((a, b) => b.openedAt - a.openedAt) }
    }),
  }
}
