/**
 * Read-only reproduction against current worktree code, with synthetic events.
 * Run from the repository root:
 *   node --import ./cli/node_modules/tsx/dist/loader.mjs \
 *     docs/research/2026-09-28-swarm-communication/reproduce_goal_scope.mts
 *
 * No daemon, provider session, filesystem store, or network client is started.
 * This prints observations; it is not a test asserting that the gap must remain.
 */
import { CodexNormalizer } from '../../../cli/src/engines/codex/normalizer.ts'
import { SwarmPromptScopes } from '../../../cli/src/teams/promptScope.ts'
import { channelTeamId } from '../../../cli/src/teams/service.ts'

const normalizer = new CodexNormalizer('live')
const scopes = new SwarmPromptScopes(() => 1_000)
const harness = 'synthetic-codex'
const swarm = 'synthetic-swarm-a'
const objective = 'Implement the upload recovery action'
const event = (type: string, payload: object): string => JSON.stringify({ type, payload })
const goal = event('response_item', {
  type: 'message', role: 'user',
  content: [{ type: 'input_text', text: `<codex_internal_context source="goal">\n<objective>\n${objective}\n</objective>\n</codex_internal_context>` }],
})

scopes.prepare(harness, `/goal ${objective}`, swarm)
const observations: object[] = []
for (const raw of [
  event('event_msg', { type: 'task_started' }), goal,
  event('event_msg', { type: 'task_complete' }),
  event('event_msg', { type: 'task_started' }), goal,
]) {
  for (const normalized of normalizer.ingest(raw)) {
    if (normalized.type !== 'turn_started') continue
    // cli.ts sends every fresh normalized turn start through this same call.
    scopes.started(harness, normalized.payload.userMessage, 'transcript', 'codex')
    observations.push({
      event: normalized.payload.userMessage.startsWith('/goal ') ? 'initial_goal' : 'automatic_continuation',
      scopeIsOriginatingSwarm: scopes.current(harness) === channelTeamId(swarm),
      scopeIsUnknown: scopes.current(harness) === null,
    })
  }
}

// A repair must not trust a user-typed lookalike as continuation provenance.
scopes.started(harness, `Continuing goal: ${objective}`, 'transcript', 'codex')
observations.push({
  event: 'unproven_lookalike_input',
  scopeIsUnknown: scopes.current(harness) === null,
})
console.log(JSON.stringify({
  method: 'Synthetic events through current CodexNormalizer and SwarmPromptScopes; no live provider calls.',
  observations,
}, null, 2))
