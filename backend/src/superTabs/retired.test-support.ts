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
  'proposal.create': { projectId: 'lead', title: 'Sync edits', text: 'Sync edits across devices', goal: 'Edits sync', why: 'People lose edits',
    doneWhen: 'An edit shows on the other device', evidence: ['Two reports'], priority: 'P2' },
  'proposal.decide': { conversationId: 'card-1', decision: 'accept', reason: 'Worth it',
    task: { goal: 'Edits sync', changes: 'Sync on save', constraints: 'None', owns: ['src/sync'], requires: { access: ['github'] }, review: { focus: 'Data loss' } },
    checks: [{ description: 'An edit shows on the other device', independent: true }] },
  'proposal.ask': { conversationId: 'card-1', personId: 'u2', question: 'Which devices?', defaultAnswer: 'All', deadline: 1_762_800_000_000, requiresConsent: false },
  'proposal.answer': { conversationId: 'card-1', questionId: 'q-1', text: 'Phones too' },
  'proposal.merge': { conversationId: 'card-1', intoConversationId: 'card-2', reason: 'Same ask' },
  'proposal.close': { projectId: 'lead', messageId: 'm-3', reason: 'Built already' },
  'buddy.propose': { conversationId: 'buddy-chat', ownerMessageId: 'm-4', projectId: 'lead', text: 'Sync my edits', title: 'Sync edits',
    goal: 'Edits sync', scope: 'Desktop and phone', priority: 'normal', attachmentIds: ['file-1'] },
  'buddy.create': { machineId: 'mac-1', engine: 'claude', model: 'opus', name: 'Theo', mainProjectId: 'lead',
    setup: { name: 'MacBook', cwd: '/Users/minh/Harness', engines: ['claude'] } },
  'buddy.remove': { conversationId: 'buddy-chat' },
  'buddy.default': { conversationId: 'buddy-chat' },
  'buddy.chat': { projectId: 'lead' },
  'buddy.rename': { conversationId: 'buddy-chat', name: 'Theo' },
  'buddy.engine': { engine: 'codex', conversationId: 'buddy-chat' },
  'buddy.model': { gridModel: 'qwen3-coder', conversationId: 'buddy-chat' },
  'buddy.modelResult': { agentId: 'agent-1', requestId: 'm-5', ok: false, fresh: true, error: 'Context too long', stayed: ['harness-2'] },
  'buddy.sessionEnd': { conversationId: 'buddy-chat', thread: 'm-6', reason: 'idle' },
  'tab.buddyCap': { cap: 8 },
} satisfies Record<RetiredCommand, object>

/** How many [type] commands the retired-commands counter holds for [client]. */
export async function counted(type: string, client: string): Promise<number> {
  const line = new RegExp(`^swarm_retired_commands_total\\{type="${type}",client="${client}"\\} (\\d+)$`, 'm').exec(await metrics.registry.metrics())
  return line ? Number(line[1]) : 0
}
