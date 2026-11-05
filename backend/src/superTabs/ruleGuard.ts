/**
 * An instructions save keeps the rules people gave (task #3151, Ken 11-05, from lamp). A PM's tidy dropped Leo's rule, judging
 * it impossible without asking him, and the "(0xken15, 4 Nov)" of a rule it kept; nothing checked the save. Now a save that
 * drops a rule, or who gave it (instructionsDiff.ts droppedRules), is refused with the list, unless each person of each
 * dropped rule makes the save or wrote a message approving it that the save names. Who a person is comes from the sender or
 * the stored message's author, never the caller's word (askedBy). The approver is then told in one private line.
 */
import { attributedRules, budgetParts, droppedRules, INSTRUCTIONS_BUDGET, ITEM_CHARS, keptIn, MAX_REPEATS, personKey, removedItems, repeatedRules,
  type DroppedRule, type InstructionsBudget, type RulePlace } from './instructionsDiff.js'
import { fail, type Author, type SuperTabState } from './model.js'
import { canReadProject, projectRules, type SwarmProject } from './projects.js'
import { isSwarmBuddyChat } from './buddies.js'
import { swarmUsernames } from './usernames.js'

/** Approval messages one save may name: one per person whose rules it drops is plenty. */
export const MAX_APPROVALS = 20
/** Characters of one rule in a refusal or a notice; a longer one is cut. */
const RULE_CHARS = 300

/** A message a save names as a person's approval, as the store loads it by id in this tab. */
export interface ApprovalRow { id: string; author: Author; source: boolean; createdAt: number; conversationId: string }

/** The members a written name is: by username, shown name or email, else by one word of a shown name ("Leo" is Leo Tran),
 *  honorifics and a possessive aside (instructionsDiff.ts personKey). */
export function membersNamed(state: SuperTabState, name: string): string[] {
  const key = personKey(name)
  if (!key) return []
  const usernames = swarmUsernames(state)
  const whole = state.people.filter(p => [usernames.get(p.id), p.name, p.email, p.email.split('@')[0]].some(n => n && personKey(n) === key))
  if (whole.length) return whole.map(p => p.id)
  return state.people.filter(p => p.name?.split(/\s+/).some(word => personKey(word) === key)).map(p => p.id)
}

const cut = (text: string) => [...text].length <= RULE_CHARS ? text : `${[...text].slice(0, RULE_CHARS - 1).join('')}…`
const WHY: Record<DroppedRule['why'], string> = {
  removed: 'removed',
  unattributed: 'kept without who gave it',
  changed: 'changed beyond a rewording, so its meaning may differ',
  waiting: 'moved to a code task that has not merged',
}

/**
 * Where this project's people's rules may have moved (task #3392): its rules record, by who asked for each, and its code
 * tasks (a task's brief; not a step, a chat or a task cancelled unmerged), a task counting once it merged. A task that went
 * quiet is in the state only when the save names it (tasks), which loads it.
 */
function rulePlaces(state: SuperTabState, project: SwarmProject): RulePlace[] {
  const records = projectRules(state, project.id).map(r => ({ text: r.text, people: [r.askedBy], where: 'the rules record', open: false }))
  const tasks = state.conversations.filter(c => (c.projectId ?? 'lead') === project.id && c.id !== project.leadConversationId && !c.kind
    && !c.reviewOf && !c.step && !c.audience && c.brief && (c.ledger?.mergedAt !== undefined || c.assignment?.status !== 'cancelled'))
    .map(c => ({ text: c.brief, people: [], where: c.number ? `task #${c.number}` : `task "${c.title}"`, open: c.ledger?.mergedAt === undefined }))
  return [...records, ...tasks]
}

/**
 * The rules [after] drops from [before] that their people allowed, by the person to tell, and those rules: refused with the
 * list when any is not allowed. A person allows their rule by making the save themselves (no notice: they know) or by a
 * message of their own among [approvals] (the store's rows) that [named] lists: a person's, not relayed by a Buddy or the Swarm
 * (source), written after [since] (when the revision being replaced was saved) in a conversation of this project. A rule of
 * several people needs each of them. A name that is no member is the project owner's to allow.
 */
export function allowedDrops(state: SuperTabState, project: SwarmProject, before: string, after: string, sender: { kind: Author['kind']; id: string },
  named: readonly string[], approvals: readonly ApprovalRow[], since: number): { told: Map<string, DroppedRule[]>; rules: DroppedRule[] } {
  const told = new Map<string, DroppedRule[]>()
  const membersOf = new Map<string, string[]>()
  const members = (name: string) => membersOf.get(name) ?? membersOf.set(name, membersNamed(state, name)).get(name)!
  // One written person for comparing revisions: the members they are, so "0xken15" and "Ken" are one.
  const dropped = droppedRules(before, after, name => members(name).sort().join(',') || `?${personKey(name)}`, rulePlaces(state, project))
  if (!dropped.length) return { told, rules: [] }
  const saver = sender.kind === 'person' ? sender.id : undefined
  // Written after the revision this save replaces, in a conversation of this project: an old "thanks" approves nothing (review
  // of #3112). A person's one Buddy chat belongs to no project.
  const here = (conversationId: string) => conversationId === project.leadConversationId || state.conversations.some(c => c.id === conversationId
    && !isSwarmBuddyChat(c) && (c.projectId ?? 'lead') === project.id)
  const approvers = new Set(approvals.filter(a => named.includes(a.id) && a.author.kind === 'person' && !a.source && a.createdAt >= since
    && here(a.conversationId)).map(a => a.author.id)
    .filter(id => state.people.some(p => p.id === id && canReadProject(state, { kind: 'person', userId: p.id, email: p.email }, project))))
  const refused: DroppedRule[] = []
  for (const rule of dropped) {
    const by = rule.people.map(name => {
      const ids = members(name).length ? members(name) : [project.ownerId]
      if (saver && ids.includes(saver)) return saver
      return ids.find(id => approvers.has(id))
    })
    if (by.some(id => !id)) { refused.push(rule); continue }
    for (const id of new Set(by as string[])) if (id !== saver) told.set(id, [...told.get(id) ?? [], rule])
  }
  if (refused.length) {
    const unknown = (rule: DroppedRule) => rule.people.filter(name => !members(name).length)
    fail('INSTRUCTIONS_RULES_DROPPED', [
      'Not saved: this drops rules people gave. Keep each rule and who gave it, or move it word for word with who gave it: into '
        + 'people notes or its role section, into the project\'s rules record, or into a code task, whose line stays until that '
        + 'task merges (name a quiet one in tasks). Otherwise ask that person and name their own message approving the change '
        + '(approvals). Never drop or weaken a person\'s rule on your own judgment, even one you think cannot be done.',
      ...refused.map(rule => `- "${cut(rule.text)}" (${rule.people.join(', ')}): ${WHY[rule.why]}`
        + (rule.movedTo ? ` (${rule.movedTo}): keep its line until it merges.` : '.')
        + (unknown(rule).length ? ` ${unknown(rule).join(', ')} is no member here, so the project's owner decides.` : '')),
    ].join('\n'), 409, { dropped: refused.map(rule => ({ rule: rule.text, people: rule.people, why: rule.why })) })
  }
  return { told, rules: dropped }
}

/**
 * Refuses a save that adds a line repeating one the document keeps (task #3283, Leo 11-05, from lamp: a PM saved a rule the
 * instructions already had as if new, which hid that it had skipped it). Each repeat is listed with the existing line quoted;
 * a change meant is made on that line. Conservative: only the same words (instructionsDiff.ts repeatedRules).
 */
export function refuseRepeats(before: string, after: string): void {
  const repeats = repeatedRules(before, after)
  if (!repeats.length) return
  const shown = repeats.slice(0, MAX_REPEATS)
  fail('INSTRUCTIONS_RULE_REPEATED', [
    'Not saved: this adds a line the instructions already have, so it would be read twice. Check that rule before adding it: '
      + 'it may be one you skipped. If you meant to change it, change that line in place instead of adding another.',
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
/** How the coordinator sorted a line it dropped (pmSchedule.ts, the daily tidy): kept elsewhere with who said it, or a step
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

/** The one line a person is told when [who] changed their [rules] in [project]'s instructions with their approval. */
export function approvedDropNotice(who: string, project: SwarmProject, rules: readonly DroppedRule[]): string {
  const each = rules.map(rule => `${rule.why === 'removed' ? 'removed' : 'changed'} "${cut(rule.text)}"`).join('; ')
  return `${who} changed your ${rules.length === 1 ? 'rule' : `${rules.length} rules`} in the ${project.name} instructions, as you approved: ${each}.`
    .replace(/\s*[\r\n]+\s*/g, ' ')
}
