/** Optional model metadata follows discovery; it never owns a binding or delays session control. */
import type { ModelsPort } from '../api.js'
import { basename } from 'node:path'
import { gridAssignmentAnswersIn, gridAssignmentProcess, sameGridAssignment,
  type GridAssignment, type GridAssignmentProcess } from '../../lib/gridAssignmentWire.js'
import { readProcessEnv } from '../../lib/processEnv.js'
import type { RegisteredSession, registry as Registry } from '../../lib/registry.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { sameProcessIdentity } from '../../lib/terminalRuntime.js'
import { argvTokens, engineProcessMatchScore, processArgvIsBoundaryFaithful, processRows } from '../../lib/tmux.js'

/**
 * The endpoint this daemon itself built a row's launch for, when that launch is a local Grid profile's.
 * A local hub serves at a loopback address with no `/relay` segment, so models recognises it only by this.
 */
function trustedBaseUrl(session: RegisteredSession): string | undefined {
  return session.gridLaunch?.targetId?.startsWith('local:') ? session.gridLaunch.baseUrl : undefined
}

/**
 * A committed process's command line, only where its argv boundaries are real (/proc on Linux and WSL).
 * Flattened `ps` text is never read as flags: a prompt could spell a provider endpoint or `-m`. Without
 * faithful argv the executable alone is offered, so environment- and config-backed launches still classify.
 */
async function faithfulArgs(identity: NonNullable<RegisteredSession['processIdentity']>, engine: RegisteredSession['engine']): Promise<string> {
  const rows = await processRows()
  const row = rows?.find(candidate => sameProcessIdentity(candidate, identity))
  if (!row) return identity.executable
  if (processArgvIsBoundaryFaithful(row)) return row.args
  // An engine may replace its argv with a bare process title. The daemon-owned launcher directly
  // above it still has the launch argv; accept that only with faithful boundaries and the expected
  // harness-engine shape, so flattened prompt text never becomes model evidence.
  const title = row.args.trim()
  const parent = rows?.find(candidate => candidate.pid === row.parentPid)
  if (!parent || !processArgvIsBoundaryFaithful(parent)) return identity.executable
  // Codex's npm entrypoint is a direct wrapper around its native child. Its own faithful argv still
  // names the model flags after the child has replaced its title; process matching proves this is
  // the same engine's wrapper, not an arbitrary parent command.
  if (engineProcessMatchScore(parent, engine) > 0) return parent.args
  if (!title || /\s/.test(title)) return identity.executable
  const tokens = argvTokens(parent.args)
  const at = tokens.indexOf('harness-engine')
  if (at < 0) return identity.executable
  const expected = basename(identity.executable)
  const launched = [tokens[at + 1], tokens[at + 2]].some(token => token && basename(token) === expected)
  return launched ? parent.args : identity.executable
}

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
        const trusted = trustedBaseUrl(session)
        if (agent.gridProcess) inputs.push({ owner, process: { ...agent.gridProcess, key: owner.key, ...(trusted ? { trustedBaseUrl: trusted } : {}) } })
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
      void Promise.all([readProcessEnv(identity), faithfulArgs(identity, session.engine)]).then(([env, args]) => {
        if (!env) { owner.done(); return }
        const process = gridAssignmentProcess(owner.key, session.engine, env, args, trustedBaseUrl(session))
        if (process) ask([{ owner, process }])
        else { owner.apply(null); owner.done() }
      }).catch(() => { owner.done() })
    },
  }
}
