/**
 * An instructions save keeps the rules people gave (task #3151, Ken 11-05, from lamp). A PM's tidy dropped Leo's rule, judging
 * it impossible without asking him, and the "(0xken15, 4 Nov)" of a rule it kept; nothing checked the save. Now a save that
 * drops a rule, or who gave it (instructionsDiff.ts droppedRules), is refused with the list, unless each person of each
 * dropped rule makes the save or wrote a message approving it that the save names. Who a person is comes from the sender or
 * the stored message's author, never the caller's word (askedBy). The approver is then told in one private line.
 */
import { droppedRules, personKey, type DroppedRule } from './instructionsDiff.js'
import { fail, type Author, type SuperTabState } from './model.js'
import { canReadProject, type SwarmProject } from './projects.js'
import { swarmUsernames } from './usernames.js'

/** Approval messages one save may name: one per person whose rules it drops is plenty. */
export const MAX_APPROVALS = 20
/** Characters of one rule in a refusal or a notice; a longer one is cut. */
const RULE_CHARS = 300

/** A message a save names as a person's approval, as the store loads it by id in this tab. */
export interface ApprovalRow { id: string; author: Author; source: boolean }

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
}

/**
 * The rules [after] drops from [before] that their people allowed, by the person to tell: refused with the list when any is
 * not allowed. A person allows their rule by making the save themselves (no notice: they know) or by a message of their own
 * among [approvals] (the store's rows) that [named] lists: a person's, not relayed by a Buddy or the Swarm (source). A rule of
 * several people needs each of them. A name that is no member is the project owner's to allow. [before] null is a revision
 * the store could not read: nothing to keep, and the chat line says the change could not be shown (instructionsDiff.ts).
 */
export function allowedDrops(state: SuperTabState, project: SwarmProject, before: string | null, after: string, sender: { kind: Author['kind']; id: string },
  named: readonly string[], approvals: readonly ApprovalRow[]): Map<string, DroppedRule[]> {
  const told = new Map<string, DroppedRule[]>()
  if (before === null) return told
  const membersOf = new Map<string, string[]>()
  const members = (name: string) => membersOf.get(name) ?? membersOf.set(name, membersNamed(state, name)).get(name)!
  // One written person for comparing revisions: the members they are, so "0xken15" and "Ken" are one.
  const dropped = droppedRules(before, after, name => members(name).sort().join(',') || `?${personKey(name)}`)
  if (!dropped.length) return told
  const saver = sender.kind === 'person' ? sender.id : undefined
  const approvers = new Set(approvals.filter(a => named.includes(a.id) && a.author.kind === 'person' && !a.source).map(a => a.author.id)
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
      'Not saved: this drops rules people gave. Keep each rule and who gave it, or ask that person and name their own message '
        + 'approving the change (approvals). Never drop or weaken a person\'s rule on your own judgment, even one you think cannot be done.',
      ...refused.map(rule => `- "${cut(rule.text)}" (${rule.people.join(', ')}): ${WHY[rule.why]}.`
        + (unknown(rule).length ? ` ${unknown(rule).join(', ')} is no member here, so the project's owner decides.` : '')),
    ].join('\n'), 409, { dropped: refused.map(rule => ({ rule: rule.text, people: rule.people, why: rule.why })) })
  }
  return told
}

/** The one line a person is told when [who] changed their [rules] in [project]'s instructions with their approval. */
export function approvedDropNotice(who: string, project: SwarmProject, rules: readonly DroppedRule[]): string {
  const each = rules.map(rule => `${rule.why === 'removed' ? 'removed' : 'changed'} "${cut(rule.text)}"`).join('; ')
  return `${who} changed your ${rules.length === 1 ? 'rule' : `${rules.length} rules`} in the ${project.name} instructions, as you approved: ${each}.`
    .replace(/\s*[\r\n]+\s*/g, ' ')
}
