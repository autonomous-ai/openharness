/**
 * An instructions save keeps the rules people gave (task #3151, Ken 11-05, from lamp). A PM's tidy dropped Leo's rule, judging
 * it impossible without asking him, and the "(0xken15, 4 Nov)" of a rule it kept; nothing checked the save. Now a save that
 * drops a rule, or who gave it (instructionsDiff.ts droppedRules), is refused with the list, unless each person of each
 * dropped rule makes the save or wrote a message approving it that the save names. Who a person is comes from the sender or
 * the stored message's author, never the caller's word (askedBy). The approver is then told in one private line.
 */
import { attributedRules, budgetParts, droppedRules, INSTRUCTIONS_BUDGET, ITEM_CHARS, keptIn, MAX_REPEATS, personKey, removedItems, repeatedRules,
  type DroppedRule, type InstructionsBudget, type RulePlace } from './instructionsDiff.js'
import { fail, type Author, type Conversation, type SuperTabState } from './model.js'
import { canReadProject, isAgentChat, projectRules, type SwarmProject } from './projects.js'
import type { ProjectRules } from './policy.js'
import { agentWrittenNameOf } from './personNames.js'
import { swarmUsernames } from './usernames.js'

/** Approval messages one save may name: one per person whose rules it drops is plenty. */
export const MAX_APPROVALS = 20
/** Characters of one rule in a refusal; a longer one is cut. */
const RULE_CHARS = 300

/** A message a save names as a person's approval, as the store loads it by id in this tab. */
export interface ApprovalRow { id: string; author: Author; source: boolean; createdAt: number; conversationId: string }

/** The members a written name is: by username, shown name or email, else by one word of a shown name ("Leo" is Leo Tran),
 *  honorifics and a possessive aside (instructionsDiff.ts personKey). */
export function membersNamed(state: SuperTabState, name: string, authority?: ProjectRules['instructionApprovals']): string[] {
  const key = personKey(name)
  if (!key) return []
  // Explicit identity links outrank mutable display names. Only listed IDs gain the extra identity.
  const present = new Set(state.people.map(p => p.id))
  const linked = authority?.people.find(p => personKey(p.name) === key)
  if (linked) return linked.accountIds.filter(id => present.has(id))
  const usernames = swarmUsernames(state)
  // A linked account's unique handle/email may name the group too. Display names never add an account to that group.
  const account = state.people.find(p => [usernames.get(p.id), p.email].some(n => n && personKey(n) === key))
  const accountLink = account && authority?.people.find(p => p.accountIds.includes(account.id))
  if (accountLink) return accountLink.accountIds.filter(id => present.has(id))
  const whole = state.people.filter(p => [usernames.get(p.id), p.name, p.email, p.email.split('@')[0]].some(n => n && personKey(n) === key))
  if (whole.length) return whole.map(p => p.id)
  return state.people.filter(p => p.name?.split(/\s+/).some(word => personKey(word) === key)).map(p => p.id)
}

const cut = (text: string) => [...text].length <= RULE_CHARS ? text : `${[...text].slice(0, RULE_CHARS - 1).join('')}…`
const WHY: Record<DroppedRule['why'], string> = {
  removed: 'removed',
  unattributed: 'kept without who gave it',
  changed: 'changed beyond a rewording, so its meaning may differ',
  waiting: 'moved to a code task the Swarm has not seen merged on GitHub',
}

/**
 * Where this project's people's rules may have moved (task #3392): its rules record, by who asked for each, and its code
 * tasks (a task's brief; not a step, a chat or a task cancelled unmerged), a task counting once the Swarm read its pull
 * request merged on GitHub. A task that went
 * quiet is in the state only when the save names it (tasks), which loads it.
 */
function rulePlaces(state: SuperTabState, project: SwarmProject, merges: Readonly<Record<string, number | null>>): RulePlace[] {
  // Merged only as GitHub itself says, read by the store before this save ([merges]), never by the task's own merge record,
  // which any agent of the project writes with any link (River, review of #3220); and only after the rule went into its brief
  // (briefAt): an older merge never carried it (#3463). A task from before briefAt counts any merge, as it did.
  const seenMerged = (c: Conversation) => (c.pullRequestUrls ?? []).some(url => {
    const at = merges[url]
    return typeof at === 'number' && (c.briefAt === undefined || at > c.briefAt)
  })
  const records = projectRules(state, project.id).map(r => ({ text: r.text, people: [r.askedBy], where: 'the rules record', open: false }))
  const tasks = codeTasks(state, project).filter(c => seenMerged(c) || c.assignment?.status !== 'cancelled')
    .map(c => ({ text: c.brief, people: [], where: c.number ? `task #${c.number}` : `task "${c.title}"`, open: !seenMerged(c) }))
  return [...records, ...tasks]
}

/** The project's code tasks: its tasks with a brief, not a step, a chat or a private chat (rulePlaces, tasksHoldingMoves). */
const codeTasks = (state: SuperTabState, project: SwarmProject): Conversation[] => state.conversations.filter(c => (c.projectId ?? 'lead') === project.id
  && c.id !== project.leadConversationId && !c.kind && !c.reviewOf && !c.step && !c.audience && !!c.brief)

/** How the guard tells people apart in this Swarm: a written name as the members it is, so "0xken15" and "Ken" are one. */
function identifier(state: SuperTabState, authority?: ProjectRules['instructionApprovals']): (name: string) => string {
  const membersOf = new Map<string, string[]>()
  return name => (membersOf.get(name) ?? membersOf.set(name, membersNamed(state, name, authority)).get(name)!).slice().sort().join(',') || `?${personKey(name)}`
}

/**
 * The project's code tasks a save from [before] to [after] would move a person's rule into, as the guard itself reads a move
 * (droppedRules): each task alone, counted open, that holds a rule the save drops, across wrapped lines or as one rule of a
 * line of several, with the guard's own words (filler words, word endings: review 2 of #3273). The store reads their pull
 * requests' merges before the save (store.ts pullRequestMergesFor, #3463). It runs only for a save that drops a person's rule,
 * once per code task: a few dozen in a project.
 */
export function tasksHoldingMoves(state: SuperTabState, project: SwarmProject, before: string, after: string): Conversation[] {
  const identify = identifier(state)
  const lost = droppedRules(before, after, identify)
  if (!lost.length) return []
  return codeTasks(state, project).filter(task =>
    droppedRules(before, after, identify, [{ text: task.brief, people: [], where: task.id, open: true }]).some(rule => rule.movedTo === task.id))
}

/**
 * The rules [after] drops from [before], each allowed by its people: refused with the list when any is not allowed. A
 * person allows their rule by making the save themselves or by a
 * message of their own among [approvals] (the store's rows) that [named] lists: a person's, not relayed by the Swarm
 * (source), written after [since] (when the revision being replaced was saved) in a conversation of this project. A rule of
 * several people needs each of them. A name that is no member is the project owner's to allow.
 */
export function allowedDrops(state: SuperTabState, project: SwarmProject, before: string, after: string, sender: { kind: Author['kind']; id: string },
  named: readonly string[], approvals: readonly ApprovalRow[], since: number, merges: Readonly<Record<string, number | null>> = {}, authority?: ProjectRules['instructionApprovals']): { rules: DroppedRule[] } {
  const membersOf = new Map<string, string[]>()
  const members = (name: string) => membersOf.get(name) ?? membersOf.set(name, membersNamed(state, name, authority)).get(name)!
  const dropped = droppedRules(before, after, identifier(state, authority), rulePlaces(state, project, merges))
  if (!dropped.length) return { rules: [] }
  const saver = sender.kind === 'person' ? sender.id : undefined
  // Written after the revision this save replaces, in a conversation of this project: an old "thanks" approves nothing (review
  // of #3112). A person's 1:1 chat with an agent belongs to no project.
  const here = (conversationId: string) => conversationId === project.leadConversationId || state.conversations.some(c => c.id === conversationId
    && !isAgentChat(c) && (c.projectId ?? 'lead') === project.id)
  const eligible = (id: string) => state.people.some(p => p.id === id && canReadProject(state, { kind: 'person', userId: p.id, email: p.email }, project))
  const approvers = new Set(approvals.filter(a => named.includes(a.id) && a.author.kind === 'person' && !a.source && a.createdAt >= since
    && here(a.conversationId)).map(a => a.author.id)
    .filter(eligible))
  const decider = authority?.topDeciderId && approvers.has(authority.topDeciderId) ? authority.topDeciderId : undefined
  const refused: DroppedRule[] = []
  for (const rule of dropped) {
    const by = decider ? [decider] : rule.people.map(name => {
      const ids = members(name).length ? members(name) : [project.ownerId]
      if (saver && ids.includes(saver)) return saver
      return ids.find(id => approvers.has(id))
    })
    if (by.some(id => !id)) refused.push(rule)
  }
  if (refused.length) {
    const unknown = (rule: DroppedRule) => rule.people.filter(name => !members(name).length)
    fail('INSTRUCTIONS_RULES_DROPPED', [
      'Not saved: this drops rules people gave. Keep each rule and who gave it, or move it word for word with who gave it: into '
        + 'people notes or its role section, into the project\'s rules record, or into a code task, whose line stays until the '
        + 'Swarm sees that task\'s pull request merged on GitHub (name a quiet one in tasks). Otherwise ask that person and name their own message approving the change '
        + '(approvals). Never drop or weaken a person\'s rule on your own judgment, even one you think cannot be done.',
      ...(authority?.topDeciderId ? [`The project's top decider ${agentWrittenNameOf(state, authority.topDeciderId) ?? 'named in its rules record'} may also approve any rule with their own recent message in this project.`] : []),
      ...refused.map(rule => `- "${cut(rule.text)}" (${rule.people.join(', ')}): ${WHY[rule.why]}`
        + (rule.movedTo ? ` (${rule.movedTo}): keep its line until it merges.` : '.')
        + (unknown(rule).length ? ` ${unknown(rule).join(', ')} is no member here, so the project's owner decides.`
          : ` Ask ${rule.people.map(name => members(name).map(id => agentWrittenNameOf(state, id) ?? name).join(' or ')).join(' and ')} for approval.`)),
    ].join('\n'), 409, { dropped: refused.map(rule => ({ rule: rule.text, people: rule.people, why: rule.why,
      ...rule.movedTo ? { movedTo: rule.movedTo } : {} })) })
  }
  return { rules: dropped }
}

/**
 * Refuses a save that adds a line repeating one the document keeps (task #3283, Leo 11-05, from lamp: a PM saved a rule the
 * instructions already had as if new, which hid that it had skipped it; #3568, anh Dee 11-06: also the same rule in other
 * words, instructionsDiff.ts repeatedRules). Each repeat is listed with the existing line quoted; a change meant is made on
 * that line. A person may keep both by giving a reason (repeatReason, [forced]); the coordinator never does.
 */
export function refuseRepeats(before: string, after: string, forced = false): void {
  if (forced) return
  const repeats = repeatedRules(before, after)
  if (!repeats.length) return
  const shown = repeats.slice(0, MAX_REPEATS)
  fail('INSTRUCTIONS_RULE_REPEATED', [
    'Not saved: this adds a line that says what the instructions already say, so it would be read twice. Check that rule before '
      + 'adding it: it may be one you skipped. If you meant to change it, change that line in place instead of adding another. '
      + 'Only a member who means to keep both lines saves them, giving a reason (repeatReason).',
    ...shown.map(repeat => `- Existing line: "${cut(repeat.existing)}" (added again as "${cut(repeat.added)}")`),
    ...(repeats.length > shown.length ? [`- And ${repeats.length - shown.length} more.`] : []),
  ].join('\n'), 409, { repeated: shown })
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`
const partName = (part: string) => part === 'core' ? 'Core' : part === 'people notes' ? 'People notes' : part === 'total' ? 'Whole document'
  : `Role section ${part.slice('role '.length)}`

/**
 * Refuses a save that makes a part of the instructions bigger than its budget (task #3392, anh Dee 11-05, decision 5): core,
 * each role section, people notes and the whole document (instructionsDiff.ts budgetParts), each named with its size, its budget
 * and its size before. A part over budget already, as documents were when this came in, may be saved smaller or unchanged:
 * that is the way down, never blocked.
 */
export function refuseOverBudget(before: string, after: string, budget: InstructionsBudget = INSTRUCTIONS_BUDGET): void {
  const was = new Map(budgetParts(before, budget).map(p => [p.part, p.bytes]))
  const over = budgetParts(after, budget).filter(p => p.bytes > p.budget && p.bytes > (was.get(p.part) ?? 0))
    .map(p => ({ ...p, before: was.get(p.part) ?? 0 }))
  if (!over.length) return
  fail('INSTRUCTIONS_OVER_BUDGET', [
    'Not saved: this makes the instructions bigger than their budget. Make it smaller: a rule the Swarm can check becomes a code '
      + 'task instead of a line; a person\'s rule moves word for word, with who gave it, into people notes or its role section; a '
      + 'step or date that passed goes. A part already over budget may be saved as long as it does not grow.',
    ...over.map(p => `- ${partName(p.part)}: ${kb(p.bytes)} of ${kb(p.budget).replace('.0 KB', ' KB')} (was ${kb(p.before)}).`),
  ].join('\n'), 409, { parts: over })
}

/** Lines one revision's History keeps (River, 11-05): a rewrite of the whole document lists its first 500. */
export const MAX_DROPPED_LINES = 500
/** How the coordinator sorted a line it dropped: kept elsewhere with who said it, or a step
 *  or date that passed. `rule`: a person's rule, dropped with their approval. `unsorted`: nobody said, and its words are not
 *  kept elsewhere; listed so the History never hides a line. */
export type DropKind = 'merged' | 'expired' | 'rule' | 'unsorted'
export interface DroppedLine { text: string; kind: DropKind; people: string[] }
/** What a save may say of the lines it drops: a line's words, or enough of them to find it, and its kind. */
export interface SortedLine { text: string; kind: Exclude<DropKind, 'unsorted'> }

const words = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Every line [after] dropped from [before], for the revision's History, now that the instruction-change line leaves the chat
 * (#3101): each with who gave it and its kind. A person's rule dropped with their approval ([rules], allowedDrops) is `rule`,
 * whatever it was called. Otherwise the kind the save gave the line ([sorted]: its words, or a part of them), else `merged`
 * when its words are all in one line of [after], else `unsorted`.
 */
export function droppedLines(before: string, after: string, sorted: readonly SortedLine[], rules: readonly DroppedRule[]): DroppedLine[] {
  const kept = keptIn(after)
  const named = sorted.map(line => ({ key: words(line.text), kind: line.kind })).filter(line => line.key)
  return removedItems(before, after).slice(0, MAX_DROPPED_LINES).map(text => {
    const key = words(text)
    const people = [...new Set(attributedRules(text).flatMap(rule => rule.people))]
    const kind: DropKind = rules.some(rule => text.includes(rule.text)) ? 'rule'
      : named.find(line => key.includes(line.key))?.kind ?? (kept(text) ? 'merged' : 'unsorted')
    return { text: [...text].length <= ITEM_CHARS ? text : `${[...text].slice(0, ITEM_CHARS - 1).join('')}…`, kind, people }
  })
}

