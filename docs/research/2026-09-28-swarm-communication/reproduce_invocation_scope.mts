/**
 * Synthetic invocation-lifetime reproduction against current worktree code.
 * Run from the repository root:
 *   node --import ./cli/node_modules/tsx/dist/loader.mjs \
 *     docs/research/2026-09-28-swarm-communication/reproduce_invocation_scope.mts
 *
 * No native provider, network client, socket server, or terminal transport starts.
 * Generated membership keys stay inside a disposable ledger and process memory.
 * This prints observations, not assertions that the current gaps should remain.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ChannelDirectory } from '../../../cli/src/teams/channels.ts'
import { SwarmPromptScopes } from '../../../cli/src/teams/promptScope.ts'
import { TeamService, channelTeamId } from '../../../cli/src/teams/service.ts'
import { teamRequest } from '../../../cli/src/teams/wire.ts'

const root = mkdtempSync('/private/tmp/swarm-invocation-scope-')
const scopes = new SwarmPromptScopes()
const source = { machineId: 'synthetic-host', agentId: 'synthetic-codex' }
const peerA = { machineId: 'synthetic-host', agentId: 'synthetic-claude' }
const peerB = { machineId: 'synthetic-host', agentId: 'synthetic-grok' }
let transportStubCalls = 0
const service = new TeamService({
  stateDir: join(root, 'ledgers'),
  machineId: source.machineId,
  command: () => 'harness team',
  runtime: async address => ({ name: address.agentId, engine: 'codex', available: false }),
  taskScope: async address => scopes.current(address.agentId),
  delivery: async () => { transportStubCalls++; return null },
})
const directory = new ChannelDirectory({
  machineId: source.machineId,
  service,
  readDesk: async () => ({
    enabled: true, settingsRevision: 1, revision: 1,
    tabs: [
      { id: 'swarm-a', name: 'Synthetic A', channelHost: source.machineId, panes: [source, peerA] },
      { id: 'swarm-b', name: 'Synthetic B', channelHost: source.machineId, panes: [source, peerB] },
    ],
  }),
  forward: async () => { throw new Error('This reproduction has no remote transport') },
})

const accept = (text: string, swarm: string) => {
  scopes.prepare(source.agentId, text, swarm)
  scopes.started(source.agentId, text, 'hook')
}
const contextNow = () => directory.taskContext(source.agentId, scopes.current(source.agentId))
const credentials = (context: Record<string, unknown>) => {
  // Inspect the returned synthetic command; never execute it or print its key.
  const command = String(context.command)
  const memberKey = command.match(/--member-key ([a-f0-9]{64})(?:\s|$)/)?.[1]
  if (!memberKey || typeof context.teamId !== 'string') throw new Error('Unexpected context shape')
  return { teamId: context.teamId, memberKey }
}
const requestFor = async (context: Record<string, unknown>, target: string, operation: string) => {
  const auth = credentials(context)
  const result = await teamRequest(service, { action: 'members', ...auth })
  const members = result.members as Array<{ id: string; agentId: string }> | undefined
  const recipient = members?.find(member => member.agentId === target)
  if (!recipient) throw new Error('Synthetic recipient was not discoverable')
  return {
    action: 'ask', ...auth, id: operation.repeat(32), to: recipient.id,
    text: 'Synthetic question belonging to the earlier owner input.',
  }
}

try {
  await directory.refresh()
  accept('First owner task in A', 'swarm-a')
  const contextA = await contextNow()
  const frozenA = await requestFor(contextA, peerA.agentId, 'a')

  // A shell invocation can have been authored under A but reach context lookup
  // only after a scheduler delay. This barrier supplies that ordering explicitly;
  // it is not a claim that a native engine produced the sequence in this run.
  let releaseOldInvocation!: () => void
  const delayed = new Promise<void>(resolve => { releaseOldInvocation = resolve })
  const oldInvocation = (async () => { await delayed; return contextNow() })()
  accept('Replacement owner task in B', 'swarm-b')
  const frozenAResult = await teamRequest(service, frozenA)
  releaseOldInvocation()
  const delayedContext = await oldInvocation
  const delayedAsk = await requestFor(delayedContext, peerB.agentId, 'b')
  const delayedResult = await teamRequest(service, delayedAsk)

  // Even a pinned swarm/member command does not identify which accepted input
  // in that same swarm originated it.
  const frozenB = await requestFor(delayedContext, peerB.agentId, 'c')
  accept('Different owner work still in B', 'swarm-b')
  const oldSameSwarmResult = await teamRequest(service, frozenB)

  const sourceFiles = ['promptScope.ts', 'channels.ts', 'service.ts', 'wire.ts', 'model.ts']
  console.log(JSON.stringify({
    method: 'Synthetic accepted inputs, a controlled delayed invocation, and real current service/wire code; admission only, no provider or terminal transport.',
    observations: {
      initialContextWasA: contextA.teamId === channelTeamId('swarm-a'),
      frozenACommandRejectedAfterB: frozenAResult.error === 'CHANNEL_SCOPE',
      delayedOldInvocationReceivedBContext: delayedContext.teamId === channelTeamId('swarm-b'),
      delayedOldInvocationAdmittedInB: 'exchange' in delayedResult,
      priorInputCommandAdmittedAfterNewInputInSameSwarm: 'exchange' in oldSameSwarmResult,
      transportStubCalls,
    },
    sourceSha256: Object.fromEntries(sourceFiles.map(name => [name,
      createHash('sha256').update(readFileSync(new URL(`../../../cli/src/teams/${name}`, import.meta.url))).digest('hex'),
    ])),
    limit: 'Demonstrates the current API cannot distinguish these synthetic invocation origins. Does not measure native engine frequency, deployed behavior, semantic necessity, or actual peer delivery.',
  }, null, 2))
} finally {
  directory.stop()
  service.stop()
  rmSync(root, { recursive: true, force: true })
}
