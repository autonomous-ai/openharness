// Task #2207's server check on made-up data: runs a Swarm through the real command code (commands.ts applyCommand) and a
// machine report's close and reopen (closedAgents.ts, memberRows.ts sessionRows, as store.ts runs them), and prints what each
// chat shows. In memory: no database, no network, no sign-in. Run from backend/: npx tsx scripts/project-chat-rows.ts
import { applyCommand, type Command } from '../src/superTabs/commands.js'
import { removeClosedAgents, restoreSessions } from '../src/superTabs/closedAgents.js'
import { sessionRows } from '../src/superTabs/memberRows.js'
import { createSuperTab, type Actor, type MessageDraft, type SuperTabState } from '../src/superTabs/model.js'

const ken: Actor = { kind: 'person', userId: 'ken', email: 'ken15@example.invalid' }
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const grant = { contribution: { machineOwnerId: 'ken', contributorId: 'ken' } }
let state: SuperTabState = createSuperTab('demo', 'Demo Swarm', { id: 'ken', email: ken.email }, 'prod')
let step = 0
const title = (id: string) => state.conversations.find(c => c.id === id)?.title ?? id
const show = (label: string, rows: MessageDraft[]) => {
  console.log(`\n${label}`)
  for (const row of rows) console.log(`  [${title(row.conversationId)}] ${row.text}`)
  if (!rows.length) console.log('  (no rows)')
}
const run = (command: Command, actor: Actor = ken, context = {}) => {
  const effects = applyCommand(state, actor, command, { now: 1_000 + step, operationId: `demo-${++step}`, ...context })
  state = effects.state
  return effects.messages
}
const tryRun = (label: string, command: Command, actor: Actor = ken, context = {}) => {
  try { show(label, run(command, actor, context)) } catch (error) { console.log(`\n${label}\n  refused: ${(error as Error).message}`) }
}
const agentOf = (id: string): Actor => ({ kind: 'agent', agentId: id, machineOwnerId: 'ken' })
const add = (harnessId: string, name: string, conversationId: string, lead = false) => {
  const effects = applyCommand(state, ken, { type: 'agent.add', conversationId, machineId: 'studio', harnessId, name, configuration: config, lead } as Command,
    { now: 1_000 + step, operationId: `demo-${++step}`, ...grant })
  state = effects.state
  return effects.result.agentId as string
}

const river = add('river', 'River', 'lead', true)
const task = (run({ type: 'conversation.create', title: 'Offline editing', brief: 'Save edits offline.', checks: [] }).at(0)!.conversationId)
const finn = add('finn', 'Finn 2', task)
const kai = add('kai', 'Kai', task)
// An older Swarm: Finn 2 was put in the project chat before #2207. It stays until removed.
state.conversations.find(c => c.id === 'lead')!.agentIds.push(finn)
console.log(`Project chat members: ${state.conversations.find(c => c.id === 'lead')!.agentIds.map(id => state.agents.find(a => a.id === id)!.name).join(', ')}`)
console.log(`Task members: ${state.conversations.find(c => c.id === task)!.agentIds.map(id => state.agents.find(a => a.id === id)!.name).join(', ')}`)

tryRun('1. River (coordinator) adds Kai to the project chat:', { type: 'conversation.agent', conversationId: 'lead', agentId: kai, present: true, lead: false }, agentOf(river))
tryRun('2. Ken (a person) adds Kai to the project chat:', { type: 'conversation.agent', conversationId: 'lead', agentId: kai, present: true, lead: false })
tryRun('3. River posts in the project chat naming Kai:', { type: 'message.send', conversationId: 'lead', text: 'Kai, announce it here.', replyTo: null, recipientIds: [kai] }, agentOf(river))
tryRun('4. Ken removes Finn 2 from the project chat:', { type: 'conversation.agent', conversationId: 'lead', agentId: finn, present: false, lead: false })
tryRun('5. River removes Kai from the task:', { type: 'conversation.agent', conversationId: task, agentId: kai, present: false, lead: false }, agentOf(river))
tryRun('6. Ken adds Kai back to the task:', { type: 'conversation.agent', conversationId: task, agentId: kai, present: true, lead: false })

// 7. A machine report closes Kai's session, then a later one shows it running again (store.ts, machine report).
const before = structuredClone(state)
const closed = removeClosedAgents(state, state.agents.filter(a => a.id === kai), 2_000).map(a => a.id)
show('7. A machine report shows Kai\'s session closed:', sessionRows(before, state, new Set(closed), 'report-1'))
const beforeReopen = structuredClone(state)
const back = restoreSessions(state, 'studio', ['kai'], 3_000, new Set(['kai']), () => {})
show('8. A later report shows Kai\'s session running again:', sessionRows(beforeReopen, state, new Set(back.map(a => a.id)), 'report-2'))

// 9. Finn 2 is asked to stop, and its own host confirms it.
run({ type: 'agent.release', agentId: finn, decision: 'stop' } as Command, agentOf(river))
const releaseId = state.agents.find(a => a.id === finn)!.releaseId!
tryRun('9. Finn 2\'s host confirms its stop:', { type: 'agent.remove', agentId: finn, releaseId } as Command, agentOf(finn))
