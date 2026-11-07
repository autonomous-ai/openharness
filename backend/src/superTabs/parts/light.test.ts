import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activeWork, type Actor, type Assignment, type Conversation, type WorkStatus } from '../model.js'
import { canReadGroup } from '../projects.js'
import { outsider, owner, peer, swarm } from '../read/fixture.test-support.js'
import { FINISHED, GROUP_FIELDS } from './light.js'

/** Every field a conversation and its assignment can carry: adding one to model.ts fails this file's typecheck until it is
 *  here, and the test below until light.ts either projects it or names it as unread by reads (review of #1745). */
const assignment: Required<Assignment> = {
  agentId: 'a',
  askedOf: 'p',
  changesRequestedAt: 1,
  configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
  execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' },
  handoffs: 1,
  hold: { kind: 'requester' },
  id: 'w',
  leaseUntil: 1,
  lost: { reason: 'r', at: 1 },
  nudgedAt: 1,
  progressAt: 1,
  recordingProgress: { at: 1, revision: 1 },
  reopened: { at: 1, why: 'r' },
  result: null,
  reviewFoundAt: 1,
  status: 'working',
  toldEngineerAt: 1,
  verdicts: [{ by: 'agent:r', passed: true, handoff: 1, review: 'g' }],
}
const conversation: Required<Conversation> = {
  agentIds: [],
  answered: [],
  archived: false,
  assignment,
  audience: { people: [] },
  brief: '',
  briefAt: 1,
  buddyChats: ['other'],
  buddyDefault: true,
  buddyDownTold: true,
  buddyName: 'Sparky',
  buddySessions: [],
  cards: {},
  chatLimits: { asks: [] },
  checks: [],
  codePullRequestUrls: [],
  dormant: false,
  handOutLane: 'Desktop',
  heardAt: 0,
  hold: { kind: 'requester' },
  id: 'g',
  kind: 'leads',
  lane: 'Desktop',
  lastActivityAt: '',
  lastMainSequence: 0,
  lastMessageSequence: 0,
  lastPersonSequence: 0,
  leadAction: { kind: 'post', at: 1 },
  leadId: null,
  ledger: {},
  liveness: { state: 'quiet', why: 'silent', since: 1 },
  lostAttempt: { id: 'w', agentId: 'a' },
  messageSeq: 0,
  notBefore: '2026-12-04',
  number: 1,
  openedBy: 'server',
  owed: [],
  paused: { by: 'person:owner', at: 1, reason: 'Wait' },
  pin: { agentId: 'a', why: 'ci', at: 1 },
  priority: 'P0',
  process: 'full',
  projectId: 'p',
  proposal: { version: 1, text: 'Words', goal: 'Goal', why: 'Why', doneWhen: 'Done', evidence: ['Evidence'], priority: 'P2', createdAt: 0, senders: [], questions: [] },
  proposals: [],
  pullRequestChecks: {},
  pullRequestEvents: {},
  pullRequestHeads: {},
  pullRequestUrls: [],
  pulse: {} as never,
  queueRank: 1.5,
  reactionSeq: 0,
  released: { at: 1, tags: [] },
  releasing: ['cli'],
  reportSeq: 0,
  requesterId: 'p',
  reviewOf: 'r',
  reviewStamp: { assignmentId: 'w', handoff: 1 },
  step: 'Review',
  stepIds: [],
  stepUp: { attempt: 2, floor: 2, reason: 'r', at: 1, carry: '' },
  stuck: { key: 'k', messageId: 'm', tagged: [], fixed: 'f' },
  talkedAt: { w: { person: 1, answer: 2 } },
  task: { goal: '', changes: '', constraints: '', owns: [] },
  taskApproval: { personId: 'p', generation: 'g', state: 'proposal', createdAt: 1 },
  teamWritten: true,
  teamWrittenBy: { kind: 'assigned' },
  title: 't',
  unlinkedPullRequests: [],
  waitingLinuxStep: { step: { name: 'Test on a Linux machine', kind: 'test', areas: [], where: ['The CLI on a Linux machine'], os: 'linux' }, pulls: [] },
  writers: [],
}

describe('the light conversation projection (parts/light.ts)', () => {
  it('projects or deliberately leaves out every field a conversation and its assignment carry', () => {
    const fields = [...Object.keys(conversation).filter(k => k !== 'assignment'), ...Object.keys(assignment).map(k => `assignment.${k}`)]
    const projected: string[] = [...GROUP_FIELDS.always, ...GROUP_FIELDS.whenRunning]
    const named = [...projected, ...GROUP_FIELDS.unread].map(f => f === 'task.owns' ? 'task' : f)
    expect(fields.filter(f => !named.includes(f))).toEqual([])
    expect(GROUP_FIELDS.unread.filter(f => projected.includes(f))).toEqual([])
  })

  it('reads work as finished exactly where model.ts does, for every status', () => {
    const statuses: Record<WorkStatus, true> = { planned: true, working: true, needs_human: true, blocked: true, review: true, done: true,
      stopped: true, cancelled: true, reconciling: true, lost: true }
    for (const status of Object.keys(statuses) as WorkStatus[]) {
      expect([status, !FINISHED.includes(status)]).toEqual([status, activeWork({ ...conversation, assignment: { ...assignment, status } })])
    }
  })

  it('keeps the fields the access check reads: every reader reads a light conversation as they read the whole one', () => {
    // The route-decision list asks canReadGroup of light groups (store.ts readableDecisions): a field dropped here opens a private one.
    expect(GROUP_FIELDS.always).toEqual(expect.arrayContaining(['id', 'kind', 'projectId', 'audience', 'agentIds']))
    const s = swarm()
    s.join(peer)
    s.join(outsider)
    const lead = s.add('lead-harness', 'lead', true)
    const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
    const [web, hidden, closedChat, buddyChat] = [s.group('Web'), s.group('Secret work', secret), s.group('Peer and PM'), s.group('Peer\'s Buddy')]
    s.edit(state => {
      const audience = { people: [{ id: peer.userId, generation: state.people.find(p => p.id === peer.userId)!.generation }] }
      state.conversations.find(c => c.id === closedChat)!.audience = audience
      Object.assign(state.conversations.find(c => c.id === buddyChat)!, { kind: 'buddy', leadId: null, agentIds: [], audience })
    })
    const state = s.state
    const kept = GROUP_FIELDS.always.filter(field => !field.includes('.'))
    const light = (group: Conversation) => Object.fromEntries(kept.filter(field => field in group).map(field => [field, group[field as keyof Conversation]])) as unknown as Conversation
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: state.agents.find(a => a.id === lead)!.machineOwnerId }
    const readers: Actor[] = [owner, peer, outsider, leadActor]
    const reads = readers.flatMap(actor => [web, hidden, closedChat, buddyChat].map(id => {
      const group = state.conversations.find(c => c.id === id)!
      expect(canReadGroup(state, actor, light(group)), `${actor.kind} ${id}`).toBe(canReadGroup(state, actor, group))
      return canReadGroup(state, actor, group)
    }))
    // The readers differ over the groups, or "the same" proves little.
    expect(reads).toContain(true)
    expect(reads).toContain(false)
  })
})

/** The lines of [text] from the line that starts with [open] to the next one that starts with [close], both left out. */
function block(text: string, open: string, close: string): string[] {
  const lines = text.split('\n'), from = lines.findIndex(line => line.startsWith(open))
  expect(from, open).toBeGreaterThanOrEqual(0)
  const to = lines.findIndex((line, i) => i > from && line.startsWith(close))
  return lines.slice(from + 1, to)
}
/** How many entries [line] holds at its top level: commas outside brackets, braces, parentheses and quotes, a trailing one aside. */
function entriesOn(line: string): number {
  let depth = 0, quote: string | null = null, commas = 0
  const body = line.trim().replace(/,$/, '')
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if ('[{('.includes(c)) depth++
    else if (']})'.includes(c)) depth--
    else if (c === ',' && depth === 0) commas++
  }
  return commas + 1
}
const sorted = (names: string[]) => [...names].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)

// Task #3519: on 11-05 nearly every merge batch left the next pull requests conflicting here, as each feature appended its field
// to the same one-line lists. One entry per line in a fixed order lets git merge two additions cleanly.
describe('the field lists stay one entry per line, in order', () => {
  it('lists each of GROUP_FIELDS\' fields on its own line, sorted', () => {
    const lines = block(readFileSync(new URL('./light.ts', import.meta.url), 'utf8'), 'export const GROUP_FIELDS = {', '} as const')
    for (const list of Object.keys(GROUP_FIELDS) as Array<keyof typeof GROUP_FIELDS>) {
      const entries = block(lines.join('\n'), `  ${list}: [`, '  ],')
      expect(entries.every(line => /^ {4}'[^']+',$/.test(line)), `${list}: one quoted field a line`).toBe(true)
      const names = entries.map(line => line.trim().slice(1, -2))
      expect(names, list).toEqual(sorted(names))
      expect(names, list).toEqual([...GROUP_FIELDS[list]])
    }
  })

  it('writes the test\'s every-field fixtures one field a line, sorted', () => {
    const text = readFileSync(new URL('./light.test.ts', import.meta.url), 'utf8')
    for (const open of ['const assignment: Required<Assignment> = {', 'const conversation: Required<Conversation> = {']) {
      const lines = block(text, open, '}')
      // A field written `key: value,`, or in shorthand, `key,`.
      expect(lines.filter(line => !/^ {2}[A-Za-z]+(: |,$)/.test(line) || entriesOn(line) !== 1), open).toEqual([])
      const keys = lines.map(line => line.trim().split(/[:,]/)[0]!)
      expect(keys, open).toEqual(sorted(keys))
    }
  })
})
