import { metrics } from '../lib/metrics.js'
import type { RetiredCommand } from './retired.js'

/** What the last older apps and agents sent for each retired command: the shape its schema had when the command went. A pull
 *  request that retires another command adds its payload here, and the tests of the store and of the route try it. */
export const OLD_PAYLOADS = {
  'process.confirm': { projectId: 'lead', noteId: 'note-3' },
  'project.digest': { projectId: 'lead', time: '08:00', timeZone: 'Asia/Ho_Chi_Minh' },
  'machine.projects': { machineId: 'mac-1', projectIds: ['lead'], askedIn: { conversationId: 'lead', messageId: 'm-1' } },
  'machine.ownAccountWork': { machineId: 'mac-1', allowed: true },
  'machine.access': { machineId: 'mac-1', action: 'add', name: 'Lamp', account: 'own', teammates: true, note: 'connection info in ~/.lamp' },
  'member.status': { status: { text: 'Heads down', emoji: '🎯', until: '2026-11-10T09:00:00.000Z' } },
  'member.timeZone': { timeZone: 'Asia/Ho_Chi_Minh' },
  'member.username': { username: 'minh' },
  'member.name': { name: 'Minh Nguyen' },
  'decision.ask': { conversationId: 'task-1', personId: 'u2', questions: [{ question: 'Ship it?', options: ['Yes', 'No'], recommended: 0,
    unblocks: 'The release', defaultAt: '2026-11-11T09:00:00.000Z' }, { send: { text: 'Please review #12', projectId: 'lead' } }] },
  'decision.answer': { decisionId: 'decision-1', choice: 1, note: 'Not today', ownerMessageId: 'm-2' },
  'mention.done': { mentionId: 'mention-1' },
  'work.check': { conversationId: 'task-1', assignmentId: 'a-1', checkId: 'c-1', passed: false, evidence: 'Fails on Windows.',
    head: 'A'.repeat(40), base: 'main' },
  'conversation.merged': { conversationId: 'task-1', pullRequestUrl: 'https://github.com/acme/app/pull/12', mergedAt: '2026-11-10T08:00:00.000Z',
    fixes: 'https://github.com/acme/app/pull/9' },
  'work.assign': { conversationId: 'task-1', agentId: 'agent-2', roleId: 'engineer', routeDecisionId: 'route-1', overrideReason: 'Faster machine' },
  'work.status': { conversationId: 'task-1', assignmentId: 'a-1', status: 'needs_human', result: 'Which login provider?',
    ask: { personId: 'u2', options: ['GitHub', 'Google'], recommended: 0 }, hold: { kind: 'person', personId: 'u2', defaultAt: '2026-11-11T09:00:00.000Z' } },
  'work.cancel': { conversationId: 'task-1', assignmentId: 'current', reason: 'Duplicate of #12' },
  'work.define': { conversationId: 'task-1', brief: 'Sign in works offline.', checks: [{ description: 'Signs in offline', independent: true }] },
  'work.queue': { conversationId: 'task-1', after: null, notBefore: '2026-11-12', hold: { kind: 'task', taskNumber: 9 } },
  'work.priority': { conversationId: 'task-1', priority: 'P1' },
  'work.pause': { conversationId: 'task-1', paused: true, reason: 'Waiting on design' },
  'work.resume': { conversationId: 'task-1', assignmentId: 'a-1', lostAt: 1_762_000_000_000 },
  'work.lane': { conversationId: 'task-1', lane: 'Backend' },
  'member.start': { conversationId: 'task-1' },
  'member.helper': { conversationId: 'task-1' },
  'conversation.unlink': { conversationId: 'task-1', pullRequestUrl: 'https://github.com/acme/app/pull/12', reason: 'Wrong task' },
  'project.process': { projectId: 'lead', process: 'simple' },
  'project.boardMode': { projectId: 'lead', on: true },
  'project.canChat': { projectId: 'lead', personId: 'u2', granted: true },
  'project.decider': { projectId: 'lead', personId: 'u2' },
  'member.approvalMode': { mode: 'review' },
  'task.suggest': { conversationId: 'task-1', agentId: 'agent-2' },
  'task.approve': { conversationId: 'task-1', suggestedAgentId: 'agent-2' },
  'task.reject': { conversationId: 'task-1', reason: 'Not now' },
} satisfies Record<RetiredCommand, object>

/** How many [type] commands the retired-commands counter holds for [client]. */
export async function counted(type: string, client: string): Promise<number> {
  const line = new RegExp(`^swarm_retired_commands_total\\{type="${type}",client="${client}"\\} (\\d+)$`, 'm').exec(await metrics.registry.metrics())
  return line ? Number(line[1]) : 0
}
