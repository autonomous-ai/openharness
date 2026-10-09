/** Optional model metadata follows discovery; it never owns a binding or delays session control. */
import type { ModelsPort } from '../api.js'
import { gridAssignmentAnswersIn, gridAssignmentProcess, sameGridAssignment,
  type GridAssignment, type GridAssignmentProcess } from '../../lib/gridAssignmentWire.js'
import { readProcessEnv } from '../../lib/processEnv.js'
import type { RegisteredSession, registry as Registry } from '../../lib/registry.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { sameProcessIdentity } from '../../lib/terminalRuntime.js'
import { processArgs } from '../../lib/tmux.js'

export interface GridAssignmentsDeps {
  models: () => Pick<ModelsPort, 'gridAssignments'>
  registry: Pick<typeof Registry, 'list' | 'byAgent' | 'updateProcessIdentity'>
  revision: (agentId: string) => number
  announce: (session: RegisteredSession) => void
  /** The same bound as an ordinary port call; also bounds the explicit inline compatibility path. */
  waitMs?: number
}

export function createGridAssignments({ models, registry, revision, announce, waitMs = 30_000 }: GridAssignmentsDeps) {
  let sequence = 0
  // Ordering tokens only. Every observation is classified again; no assignments are cached here.
  const latest = new Map<string, { serial: number; signature: string; pending: boolean }>()
  const ticket = (session: RegisteredSession, evidence: unknown) => {
    for (const id of latest.keys()) if (!registry.byAgent(id)) latest.delete(id)
    const snapshot = { ...session, revision: revision(session.agentId) }
    const signature = JSON.stringify([snapshot.registeredAt, snapshot.engine, snapshot.sessionId, snapshot.boundAt,
      snapshot.primaryRuntimeKey, snapshot.active, snapshot.processIdentity, snapshot.revision, evidence])
    const prior = latest.get(session.agentId)
    if (prior?.pending && prior.signature === signature) return null
    const serial = ++sequence
    const state = { serial, signature, pending: true }
    latest.set(session.agentId, state)
    return {
      key: String(serial),
      done: () => { state.pending = false },
      apply(assignment: GridAssignment | null) {
        const current = registry.byAgent(snapshot.agentId)
        if (!current || latest.get(snapshot.agentId)?.serial !== serial || current.registeredAt !== snapshot.registeredAt
          || current.engine !== snapshot.engine || current.sessionId !== snapshot.sessionId || current.boundAt !== snapshot.boundAt
          || current.primaryRuntimeKey !== snapshot.primaryRuntimeKey || current.active !== snapshot.active
          || !sameProcessIdentity(current.processIdentity, snapshot.processIdentity) || revision(current.agentId) !== snapshot.revision) return
        if (sameGridAssignment(current.grid ?? null, assignment)) return
        registry.updateProcessIdentity(current.agentId, current.processIdentity!, undefined, assignment)
        announce(current)
      },
    }
  }

  const ask = (inputs: Array<{ process: GridAssignmentProcess; owner: NonNullable<ReturnType<typeof ticket>> }>) => {
    if (!inputs.length) return
    const processes = inputs.map(input => input.process)
    let timer: NodeJS.Timeout
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); timer.unref?.() })
    // Promise.resolve also contains a synchronous throw from an unavailable port.
    void Promise.race([Promise.resolve().then(() => models().gridAssignments(processes)), deadline]).then(value => {
      const answers = gridAssignmentAnswersIn(value, processes)
      if (!answers) return
      const owners = new Map(inputs.map(input => [input.process.key, input.owner]))
      for (const answer of answers) owners.get(answer.key)!.apply(answer.assignment)
    }).catch(() => {}).finally(() => { clearTimeout(timer); for (const input of inputs) input.owner.done() })
  }

  return {
    /** One call after a completed discovery pass, including rows whose absent markers invalidate older reads. */
    observe(observed: readonly DiscoveredTerminalAgent[]): void {
      const rows = registry.list()
      const inputs: Array<{ process: GridAssignmentProcess; owner: NonNullable<ReturnType<typeof ticket>> }> = []
      for (const agent of observed) {
        const session = rows.find(row => row.engine === agent.engine && sameProcessIdentity(row.processIdentity, agent.processIdentity))
        if (!session) continue
        const owner = ticket(session, agent.gridProcess ?? null)
        if (!owner) continue
        if (agent.gridProcess) inputs.push({ owner, process: { ...agent.gridProcess, key: owner.key } })
        else owner.done()
      }
      ask(inputs)
    },
    /** A swap has already committed its process. Read metadata in the background, never under its route hold. */
    refresh(session: RegisteredSession): void {
      if (!session.processIdentity) return
      const owner = ticket(session, 'refresh')
      if (!owner) return
      const identity = session.processIdentity
      void Promise.all([readProcessEnv(identity), processArgs(identity)]).then(([env, args]) => {
        if (!env) { owner.done(); return }
        const process = gridAssignmentProcess(owner.key, session.engine, env, args)
        if (process) ask([{ owner, process }])
        else { owner.apply(null); owner.done() }
      }).catch(() => { owner.done() })
    },
  }
}
