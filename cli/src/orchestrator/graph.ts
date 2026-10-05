// cli/src/orchestrator/graph.ts
import { evaluateCondition, parseCondition } from './conditions.js'
import type { Task } from './model.js'

export type Readiness =
  | { kind: 'launch' } | { kind: 'wait' }
  | { kind: 'skip'; reason: string } | { kind: 'block'; reason: string } | { kind: 'fail'; reason: string }
export type Busy = (taskId: string) => boolean
export type Outcome = 'completed' | 'stopped' | 'in-progress'

const FINAL = new Set(['succeeded', 'failed', 'skipped', 'cancelled', 'blocked'])
const BAD = new Set(['failed', 'blocked', 'cancelled'])
/** Did not succeed and will not change by itself: blocks all_success and none_failed_min_one_success (uncertain included). */
const bad = (task: Task, busy: Busy): boolean => BAD.has(task.state) && task.retryAt === undefined && !busy(task.id)
const BLOCK = { kind: 'block', reason: 'An upstream task did not succeed.' } as const

/** Settled: final, not uncertain, no automatic retry pending, nothing of its attempt still running or saving. */
export function settled(task: Task, busy: Busy): boolean {
  return FINAL.has(task.state) && !task.uncertain && task.retryAt === undefined && !busy(task.id)
}

/** What a queued task should do now: the trigger rule first, then its condition. */
export function decide(task: Task, tasks: readonly Task[], busy: Busy): Readiness {
  const found = task.dependsOn.map(id => tasks.find(t => t.id === id))
  // Saved runs are parsed without graph validation, so a hand-edited state file can name a task that is not there.
  const missing = task.dependsOn.find((_id, i) => !found[i])
  if (missing !== undefined) return { kind: 'fail', reason: `Dependency ${missing} is missing from this run.` }
  const deps = found as Task[]
  const done = deps.map(dep => settled(dep, busy))
  const rule = task.triggerRule ?? 'all_success'
  if (rule !== 'all_done' && deps.some(dep => bad(dep, busy))) return BLOCK
  if (done.includes(false)) return { kind: 'wait' }
  if (rule === 'all_success') {
    const skipped = deps.find(dep => dep.state === 'skipped')
    if (skipped) return { kind: 'skip', reason: `Skipped: upstream ${skipped.id} was skipped.` }
  }
  if (rule === 'none_failed_min_one_success' && !deps.some(dep => dep.state === 'succeeded')) return { kind: 'skip', reason: 'Skipped: no upstream task succeeded.' }
  if (task.when === undefined) return { kind: 'launch' }
  const condition = parseCondition(task.when)
  // A saved condition was checked when its flow was compiled; a hand-edited state file fails the task instead of the pump.
  if ('error' in condition) return { kind: 'fail', reason: `The condition ${task.when} cannot be evaluated: ${condition.error}` }
  const dep = deps.find(d => d.id === condition.task)
  if (!dep) return { kind: 'fail', reason: `The condition ${task.when} cannot be evaluated: ${condition.task} is not a dependency.` }
  // A decision counts only once its approval finished with it: one recorded on an approval cancelled before that is a record.
  const result = evaluateCondition(condition, { state: dep.state, verdict: dep.verdict, decision: dep.state === 'succeeded' ? dep.decision?.decision : undefined })
  if (!result.ok) return { kind: 'fail', reason: result.reason }
  return result.value ? { kind: 'launch' } : { kind: 'skip', reason: `Skipped: ${condition.text} is false.` }
}

export function downstream(tasks: readonly Task[], id: string): Task[] {
  const found = new Set<string>([id])
  for (let grew = true; grew;) {
    grew = false
    for (const task of tasks) if (!found.has(task.id) && task.dependsOn.some(dep => found.has(dep))) { found.add(task.id); grew = true }
  }
  return tasks.filter(task => task.id !== id && found.has(task.id))
}

/** The reset table: everything an attempt produced goes; configuration and the prompt hash stay. */
export function resetTask(task: Task, newAttempt: boolean): void {
  if (newAttempt) task.attempt++
  Object.assign(task, { state: 'queued', error: null, uncertain: false, agentId: null, cwd: '', artifacts: [], inputs: {}, summary: '' })
  for (const key of ['deadline', 'pid', 'engine', 'verdict', 'decision', 'loopState', 'retryAt', 'scripts'] as const) delete task[key]
}

export function outcome(tasks: readonly Task[], busy: Busy): Outcome {
  if (tasks.some(t => busy(t.id))) return 'in-progress'
  if (tasks.every(t => t.state === 'succeeded' || t.state === 'skipped')) return 'completed'
  const moving = tasks.some(t => ['queued', 'launching', 'running', 'waiting'].includes(t.state) || t.retryAt !== undefined)
  return moving ? 'in-progress' : 'stopped'
}
