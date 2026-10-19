/**
 * Shared tabs in the directory (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md, "Messages
 * across accounts"): the rosters this computer holds, verified against their pins (rosterStore.ts), merged into the
 * account's desk tabs, so another account's harness is a teammate like any other. A tab this account shares gains the
 * members' harnesses; a tab shared with this account is a tab of its own, as its owner named it.
 *
 * Only what the roster says is shown, and only after taking out control and format characters: a member's name, an
 * engine and an owner's address are not cleaned where a roster is read (roster.ts cleans only harness names), and each
 * ends up in a note or a message's header an agent reads.
 */
import { consentKey } from './consentStore.js'
import type { DirectoryTab, Member } from './directory.js'
import { cleanName, type Roster, type RosterHarness } from './roster.js'

/** An account as its address names it: the part before the @, for prefixes (`bob/api`). The whole address when that
 *  part is empty, so a label is never blank. */
export function accountLabel(email: string): string {
  return cleanName(email.replace(/@[^@]*$/, '')) || cleanName(email)
}

/** `accountLabel` as a marker's `assignee:<account>/<harness>` takes it (tasks.ts matches `[\w.-]{1,64}`; any other
 *  character would make the whole marker unreadable, and the issue no task): other characters, and runs of `-`, become one `-`, none at either
 *  end, at most 64, `account` when nothing is left. The note tells agents this label, and the desktop maps assignees back
 *  with the same function. */
export function markerLabel(email: string): string {
  return markerSafe(accountLabel(email)) || 'account'
}

/** A harness as a marker's `<harness>` takes it: `markerLabel`'s rule on its display name, in lower case, `harness` when
 *  nothing is left. Display names are session titles ("Fix login test"), or carry the start of an id when two share one
 *  ("app (1a2b)"): written as the note named them, the reader did not take the marker and the issue was no task (final
 *  review I2). The note gives each harness this name, and the desktop maps an assignee back with the same function. */
export function markerName(name: string): string {
  return markerSafe(cleanName(name)).toLowerCase() || 'harness'
}

/** A harness's marker name told apart from another's that makes the same one ("Fix login test" and "fix (login) test",
 *  or two titles with no letter in them, both `harness`): `<markerName>-<the start of its id>`, the name cut so the
 *  whole stays within the 64 the reader takes. The note gives it only where `markerName` collides in a tab; the desktop
 *  maps it back with the same function (`markerNameWithId`, task_step.dart). */
export function markerNameWithId(name: string, agentId: string): string {
  const start = markerSafe(cleanName(agentId).slice(0, 8)).toLowerCase() || 'id'
  return `${markerName(name).slice(0, 63 - start.length).replace(/-+$/, '')}-${start}`
}

/** Only [\w.-]: other runs, and runs of `-`, one `-`, none at either end, at most 64. */
const markerSafe = (text: string): string =>
  text.replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')

/** The accounts the rosters name: each one's label for prefixes, its label in a task marker (`markerLabel`), and for
 *  headers the name a roster gives it as a member (`Bob's account`), or its label where none does (an owner, a member
 *  with no name). */
export function accountsIn(rosters: readonly Roster[]): Map<string, { label: string; marker: string; name: string }> {
  const out = new Map<string, { label: string; marker: string; name: string }>()
  const put = (accountId: string, email: string, name: string): void => {
    const label = out.get(accountId)?.label ?? accountLabel(email)
    const marker = out.get(accountId)?.marker ?? markerLabel(email)
    out.set(accountId, { label, marker, name: cleanName(name) || out.get(accountId)?.name || label })
  }
  for (const roster of rosters) {
    put(roster.owner.accountId, roster.owner.email, '')
    for (const m of roster.members) put(m.accountId, m.email, m.name)
  }
  return out
}

const pane = (h: RosterHarness): Member => ({ machineId: h.machineId, agentId: h.agentId, accountId: h.accountId, name: cleanName(h.name), engine: cleanName(h.engine) })
const add = (panes: Member[], next: Member): void => {
  if (!panes.some((p) => p.machineId === next.machineId && p.agentId === next.agentId)) panes.push(next)
}

/**
 * The desk tabs with the shared tabs merged in; `desk` itself is left as read. A roster this account owns adds the other
 * accounts' harnesses to the desk tab it is shared from (`deskTab`), whose own panes the desk already lists: the desk is
 * the account's word for its own harnesses, and the roster only follows it. A tab whose desk tab is not known here yet
 * (the shares not read since a restart) adds nothing until it is. A roster of another account's is a tab of its own.
 *
 * Another account's harness is that account's only as a roster says, never as the desk does: a desk pane on a machine a
 * held roster lists under another account is dropped from every desk tab, and that harness is in a tab only as its
 * roster's entry, with its account. The desk carries other accounts' panes to show them (the spec's "Open questions",
 * 1), and a backend that put Bob's harness into an unshared tab beside one of this account's would otherwise make the
 * two teammates as if Bob's were this account's own (review of B1).
 *
 * A machine of this account's (`self.machineIds`: this computer and the machines its directory lists, as the member's
 * own check trusts them, sharedTabs.ts `checkOwn`) is never another account's, whatever a roster says: a tab's owner,
 * another account, could otherwise list one under its account and silently take every pane of it from this account's
 * own tabs. Such an entry is left out of the tabs too, and `checkOwn` records it for the person (review of B1).
 *
 * In a tab another account owns, a harness of this machine (`self.machineId`) is in it only if this machine asked for it
 * (`self.consent`, consentStore.ts keys): the owner signs the roster and can keep listing one the member took out while
 * the owner's computer was away, or list it again (final review of 1b). Left out, it has no shared tab's note or
 * teammates there, sends nothing into it, and what waits for it is held and then fails (service.ts `verdict`). Another
 * machine of this account answers for its own harnesses the same way, on that machine.
 */
export function sharedTabsFor(rosters: readonly Roster[], self: { accountId: string; machineId: string; machineIds: ReadonlySet<string>; consent: ReadonlySet<string> },
  deskTab: (id: string) => string | null, desk: readonly DirectoryTab[]): DirectoryTab[] {
  const foreign = (h: RosterHarness): boolean => h.accountId !== self.accountId && !self.machineIds.has(h.machineId)
  const theirs = new Set(rosters.flatMap((r) => r.harnesses.filter(foreign).map((h) => h.machineId)))
  const tabs = desk.map((t) => ({ ...t, panes: t.panes.filter((p) => !theirs.has(p.machineId)) }))
  for (const roster of rosters) {
    if (roster.owner.accountId === self.accountId) {
      const id = deskTab(roster.sharedTabId)
      const tab = tabs.find((t) => t.id === id)
      if (!tab) continue
      tab.sharedTabId = roster.sharedTabId
      for (const h of roster.harnesses) if (foreign(h)) add(tab.panes, pane(h))
      continue
    }
    const panes: Member[] = []
    const asked = (h: RosterHarness): boolean => h.machineId !== self.machineId || self.consent.has(consentKey(roster.sharedTabId, h.machineId, h.agentId))
    for (const h of roster.harnesses) if ((h.accountId === self.accountId && asked(h)) || foreign(h)) add(panes, pane(h))
    const name = cleanName(roster.name)
    tabs.push({ id: roster.sharedTabId, sharedTabId: roster.sharedTabId, name, named: name !== '', panes })
  }
  return tabs
}
