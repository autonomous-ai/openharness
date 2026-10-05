import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { compileFlow, parseFlowSource } from './flow.js'
import { decide, downstream, outcome, resetTask, type Readiness } from './graph.js'
import type { Task } from './model.js'

type Event =
  | { settle: string; state: 'succeeded' | 'failed' | 'cancelled'; verdict?: Task['verdict']; decision?: string; outcome?: 'approved' | 'rejected' }
  | { retry: string } | { cancel: string }
  | { expect: { tasks?: Record<string, string | { state: string; attempt: number }>; decisions?: Record<string, Readiness['kind']>; errors?: Record<string, string>; summaries?: Record<string, string>; run?: string } }
const folder = join(import.meta.dirname, 'fixtures', 'graphs')

function simulate(source: string, file: string) {
  const compiled = compileFlow(parseFlowSource(source, file), {})
  const tasks: Task[] = compiled.tasks.map(spec => ({ ...spec, state: 'queued', attempt: 1, agentId: null, cwd: '', summary: '', error: null, uncertain: false, artifacts: [], inputs: {} }))
  const decisions: Record<string, Readiness['kind']> = {}
  let run: 'active' | 'cancelled' = 'active'
  const pump = (): void => {
    for (let changed = true; changed && run === 'active';) {
      changed = false
      for (const task of tasks) {
        if (task.state !== 'queued' || run !== 'active') continue
        const r = decide(task, tasks, () => false)
        decisions[task.id] = r.kind
        if (r.kind === 'wait') continue
        if (r.kind === 'launch') {
          // parallelism 3; approvals and cancel steps run nothing, so they take no slot
          if (task.approval === undefined && task.cancel === undefined && tasks.filter(t => t.state === 'running').length >= 3) continue
          changed = true
          task.cwd = `/sim/${task.id}/${task.attempt}`
          if (task.cancel !== undefined) {
            task.state = 'succeeded'; run = 'cancelled'
            for (const other of tasks) if (['queued', 'running', 'waiting', 'blocked'].includes(other.state)) other.state = 'cancelled'
          } else task.state = task.approval ? 'waiting' : 'running'
        } else {
          task.state = r.kind === 'skip' ? 'skipped' : r.kind === 'block' ? 'blocked' : 'failed'
          if (r.kind === 'skip') task.summary = r.reason
          else task.error = r.reason
          changed = true
        }
      }
    }
  }
  const byId = (id: string) => tasks.find(t => t.id === id)!
  const runState = () => run === 'cancelled' ? 'cancelled' : outcome(tasks, () => false)
  pump()
  return {
    apply(event: Event): void {
      if ('settle' in event) {
        const task = byId(event.settle)
        task.state = event.state
        if (event.verdict) task.verdict = event.verdict
        if (event.outcome || event.decision) task.decision = { outcome: event.outcome ?? 'approved', ...(event.decision ? { decision: event.decision } : {}), at: 0 }
      } else if ('retry' in event) {
        const below = downstream(tasks, event.retry)
        expect(below.some(t => ['running', 'waiting'].includes(t.state)), `retry ${event.retry} refused`).toBe(false)
        resetTask(byId(event.retry), true)
        for (const task of below) resetTask(task, task.cwd !== '')
      } else if ('cancel' in event) byId(event.cancel).state = 'cancelled'
      else {
        for (const [id, want] of Object.entries(event.expect.tasks ?? {})) expect(typeof want === 'string' ? byId(id).state : { state: byId(id).state, attempt: byId(id).attempt }, id).toEqual(want)
        for (const [id, want] of Object.entries(event.expect.decisions ?? {})) expect(decisions[id], `decision of ${id}`).toBe(want)
        for (const [id, want] of Object.entries(event.expect.errors ?? {})) expect(byId(id).error, `error of ${id}`).toContain(want)
        for (const [id, want] of Object.entries(event.expect.summaries ?? {})) expect(byId(id).summary, `summary of ${id}`).toContain(want)
        if (event.expect.run) expect(runState()).toBe(event.expect.run)
        return
      }
      pump()
    },
  }
}

describe('graph fixtures', () => {
  for (const name of readdirSync(folder).filter(f => f.endsWith('.yaml'))) {
    const { scenarios, ...flow } = parse(readFileSync(join(folder, name), 'utf8')) as { scenarios: { name: string; events: Event[] }[] }
    for (const scenario of scenarios) it(`${name}: ${scenario.name}`, () => {
      const sim = simulate(stringify(flow), name)
      for (const event of scenario.events) sim.apply(event)
    })
  }
})
