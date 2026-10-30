# Design: Swarm state by parts (#1726)

Group 1 design doc, 2026-10-26. Engineer (Hugo). Spec: [docs/plans/2026-10-26-swarm-state-parts.md](../plans/2026-10-26-swarm-state-parts.md)
(draft 2, its rulings, and the 2026-10-26 private conversations addendum). Issue: https://github.com/autonomous-ai/openharness/issues/1726

This document is the contract for groups 2–5. Where it says **must**, a builder implements exactly that; where it
says **Ruling**, it settles a point the spec left open or got wrong against the code, with the reason and the cost if
wrong. Section 8 lists those that need the Product Manager's or owner's confirmation before groups 2–5 start.

Citations are `path:line` on `feat/swarm-state-parts` at `83312cb7d`.

## 0. Summary

- Seven part collections replace `SuperTab.state`: **head**, **member** (one per person), **group**, **agent**,
  **machine**, **start**, **progress** (one per project). The `SuperTab` row stays as the Swarm's index row (member,
  invitation and machine lookups) and keeps the old `state` read-only.
- Every part has `version` (bumped by every write and every touch, never reset) and `changedAt` (stamped only when
  its data changes). Part `data` keeps today's JSON shape for that record, so the pure command layer
  (`applyCommand`) runs unchanged on a state reassembled from the parts a command loads.
- A command loads the Swarm's **active** parts (everything except dormant groups and finished starts, plus the ones
  it names, 3.1), runs
  `applyCommand`, writes only the parts whose data changed, and **touches** (version-guarded no-op bump) the parts
  whose invariants it read. Section 1 lists both for every command and writer.
- Reads: first load, changes since a cursor (`changedAt > cursor`, cursor = server read start − 30 s), dormant groups
  on demand, and a host form for the CLI. A visibility epoch on the head forces a full reload when who-sees-what
  changes. Old full-state routes answer HTTP 426 `UPDATE_REQUIRED`.
- Messages are numbered per group from the group's `messageSeq`, which starts at the tab's final revision; old
  numbers are kept.
- A conversation can carry an explicit **audience** (chosen people plus the project's Lead); it is enforced in one
  predicate used by every read path (section 4.8).

### Notation used in the tables

| Symbol | Part |
|---|---|
| `H` | head |
| `M(p)` | member part of person `p` |
| `A(a)` | agent part of agent `a` |
| `G(g)` | group part of conversation `g`; `GL` is the Leads conversation; `GP(p)` is project `p`'s Lead conversation |
| `Mc(m)` | machine part of machine `m` (exists for every machine the Swarm references, contributed or not; Ruling R1) |
| `S(s)` | start part |
| `P(p)` | progress part of project `p` |
| `X` | the `SuperTab` index row (not a part; never in the change feed) |
| `SA` | the actor's own part: `M(person)` for a person, `A(agent)` for an agent (spec ruling 2) |
| `Δrows` | rows in existing collections (messages, deliveries, receipts, runs, …) |

**W** = written (data changes, `changedAt` stamped). **T** = touched: read and guarded, `version` bumped, data
unchanged. A part that is written is never also listed as touched.

## 1. Commands and writers: parts read, written and guarded

### 1.1 Rules that apply to every row

These defaults hold for every command; the table adds what is specific.

- **D1 Actor.** Every command touches `SA` (spec ruling 2). Removing a person writes (tombstones) `M(p)`; removing an
  agent writes `A(a)`. An agent actor's contributor membership (`model.ts:294-300`) is guarded by rule (b):
  `member.remove` writes every agent the member contributed (`commands.ts:1290`).
- **D2 Groups it relies on.** A command that checks a group exists, is open, or reads its `agentIds`/`leadId`, and
  does not write it, touches it. `controls()` (`commands.ts:292-297`) reads the target group's `leadId`; the target
  group is then written or touched.
- **D3 Agents it names.** A command that names an agent (`agentId`, a recipient, a route candidate) and does not
  write it touches `A(agent)`.
- **D4 Messages.** A message written into group `g` writes `G(g)`: `messageSeq += 1` per message, and
  `lastMessageSequence`, `reportSeq`, `pullRequestUrls`, `lastActivityAt`, `dormant=false`. A shown message in a
  non-Lead project group writes `P(p)` only when the project goes from clean to dirty (spec ruling 1; section 3.6).
- **D5 Leads.** A change to `leadId` of a project's Lead conversation, or removal of an agent listed in `GL`,
  writes `GL` (its `agentIds`) and `H` (visibility epoch). That is the only place `syncLeads` writes (spec ruling 10).
- **D6 New agent.** Creating an agent (`agent.add`, `agent.started`) touches `H` (display names must stay unique,
  spec ruling 10) and `M(contributor)`, writes `Mc(machine)` (harness reservation, `commands.ts:1574-1584`) and
  writes `X` (machine reference).
- **D7 Finished work.** `finishWorker` (`model.ts:278-284`) writes `A(worker)` and every Reviewer whose decision
  changes, and writes `P(p)` (the project's worker-decision fence, Ruling R5).
- **D8 Group removals.** A command that removes an agent from groups finds them by the `agentIds` index, **dormant
  groups included**, and writes each (today `removeAgent` filters every conversation, `commands.ts:536-540`).
- **D9 Roles.** A command that chooses a custom role (`roleId` on `agent.add`, `agent.start`, `work.assign`) touches
  `H`, which holds the role sets, so a concurrent `project.role.*` conflicts.
- **D10 Delivery rows follow group rules (rule b).** `conversation.archive`, `conversation.agent` (`present:false`) and
  `conversation.audience` change what `deliveryAllowed` (`store.ts:1410-1425`) accepts without cancelling rows today.
  They must write the affected queued/claimed/uncertain delivery rows, so a concurrent claim conflicts on the row
  (section 3.5). Archive and `present:false` cancel them (2026-10-28: kept for a reopening, deliveries in archived
  groups waited unread for days; `superTabs/deliverySettle.ts` ends any other open delivery that can no longer move);
  `conversation.audience` bumps `updatedAt` and additionally cancels rows authored by people it removes.
- Side writes into existing collections (`SuperTabRun`, session scopes, configurations, role texts, route decisions,
  terminal requests, mentions, attachments, attempts, native contexts) are unchanged from today's `executeOnce`
  (`store.ts:661-838`) and are not repeated below.

### 1.2 Commands (all 61 command types)

`commandSchema` (`commands.ts:63-138`) defines 60 types; `conversation.audience` is added by the private
conversations addendum (4.8).

| Command | W (writes) | T (touches) | Invariants and the rule that guards each |
|---|---|---|---|
| `machine.contribute` | `Mc(m)`; `Mc` of the Mac's team pools (name, slots, pause, `commands.ts:832`); `S` of abandoned starts (error); `GP` of each project told; `X` when `m` is new | `H` when `m` is new | Not cleaning, no pending start on `m` (`commands.ts:806,823`): every start on `m` writes `Mc(m)`, rule (a). At most 32 machines: a new contribution touches `H`, rule (a). |
| `machine.pause` | `Mc(m)`, `Mc` of team pools | — | Contributor only, not removed: data of `Mc(m)`, written. |
| `machine.remove` | `Mc(m)` and team pools (removal or cleanup); `A` of every removed agent (tombstone); `G` of every group containing them (D8) with notices; `S` of pending starts on `m` (error); `H` (rules lose `m`, `commands.ts:572-582`); `X`; `Δrows` deliveries cancelled | — | No start dispatched on `m` (`commands.ts:550`): dispatch touches `Mc(m)`, (a). A Lead is never removed (`protectLead`, `commands.ts:307-312`): `agent.add` and `conversation.agent` that make an agent a Lead write or touch its `A`, which conflicts with the tombstone, (a). |
| `machine.cleaned` | `Mc(m)` (contribution or cleanup dropped); `X` (`cleanupMachineIds`) | — (the host may have left; no `SA`) | Removal id matches: data of `Mc(m)`. |
| `localModels.set` | `H` | — | Owner only: `H.ownerId`, immutable. |
| `localModels.status` | `H` | — | Grid matches: `H`. |
| `tab.rename` | `H` | `G('lead')` when the actor is an agent (`controls`) | Lead check, D2. |
| `tab.project` | `H` | `G('lead')` when agent | Not set yet: `H`. |
| `tab.pause` | `H` | `G('lead')` when agent | — |
| `tab.routingPolicy` | `H` | — | Owner only. |
| `rule.set` | `H` (rules); `GP(p)` (rule row) | — | At most 50 rules a project: `H`. Lead quoting the owner: `GP(p).leadId`, written. `askedIn` message is immutable. |
| `rule.remove` | `H`; `GP(p)` | — | as `rule.set` |
| `project.create` | `H` (projects); `G` of the new Lead conversation (insert) | — | At most 100 projects, not paused: `H`. |
| `project.rename` | `H` | — | Project owner: `H`. |
| `project.delete` | `H` (projects, rules, invitations, `retiredConversationNumber`, epoch); `G` of every group of the project, dormant included (tombstones); `A` of the project's agents incl. its Lead (tombstones); `S` of its starts (tombstones); `P(p)` (tombstone); `Mc` of their machines (closing sessions); `GL` (D5); `X`; `Δrows` deliveries cancelled, role texts | — | No active work, no pending start (`projects.ts:156-161`): `work.assign` writes `G`, `agent.start` touches `G`, (a). |
| `project.sharing` | `H` (visibility, members, epoch) | `M(p)` of every person who loses access | Readers of the project: rule (b), every command of a person touches `M(person)` (D1); claims touch the sender's `M` (3.5). |
| `project.cadence` | `H` | — | — |
| `project.report` | `P(p)` (`summarized` map, 3.6); `GP(p)` when `text` | `GP(p)` when `text` is null (Lead check) | Lead of the project: `GP(p).leadId`. Answers the wake-up delivery (`store.ts:815-822`). |
| `project.repository` | `H` | `GP(p)` when agent | Not already set: `H`. |
| `project.skills` | `H`; `GP(p)` (row); `G` of each "role gone" notice (`commands.ts:710-715`) | `GP(p)` if no row | Owner or Lead quoting the owner: `GP(p)`. |
| `project.roles.create` | `H` | — | No roles yet: `H`. |
| `project.role.set` | `H` | — | Roles in use (`commands.ts:273-283`): role choices touch `H` (D9), (a). |
| `project.role.remove` | `H` | — | as above |
| `project.roles.reset` | `H` | — | as above |
| `conversation.create` | `G` (insert, with `audience` when given, 4.8); `H` (group counter; `overlapAlerts` when an alert is added); `GL` (overlap row) | `GP(p)` (`controls`); `G(reviewOf)` | Numbering: `H.groupCounter`, written (spec ruling 10). Not paused: `H`. Reviewed group open: touched. |
| `conversation.rename` | `G` | — | Open: `G`. |
| `conversation.archive` | `G` (`archived`, `dormant`); `Δrows` delivery `updatedAt` (D10) | — | No active work: `G`. |
| `conversation.audience` *(new, 4.8)* | `G` (`audience`); `H` (epoch); `Δrows` deliveries (D10), native contexts revoked | `M(p)` of every person removed from the audience; `GP(p)` | Rule (b) for readers removed. Who may change it: `GP(p).leadId` or a person in the audience. |
| `agent.add` | `A` (insert, or existing); `G` (`agentIds`, `leadId`, initial message); `GL`+`H` when it becomes a project Lead (D5); `H` when it sets the project's repository; `Mc(m)` (D6); `X` | `H` (D6, D9); `M(contributor)` | `ALREADY_SHARED`: unique part key `(tabId, agentId)`, an insert race is P2002 (retryable). `STOP_REQUESTED`/existing kind: `A` written. |
| `agent.start` | `S` (insert); `G` override/rule rows when written | `G` (open, D2); `H` (pending starts ≤ 32, paused, rules, D9); `Mc(m)` and every `Mc` that `machineSlots` counts (Mac and team pool, `machines.ts:335-339`); `M(contributor)`; `P(p)` (worker decisions, R5) | Slots: rule (a), every slot consumer writes or touches `Mc`. 32 pending starts: `H` touch, (a). Route decision link: route decision row written. |
| `agent.startDispatch` | `S` (`dispatched`) | `Mc(m)` (re-admission); `H` (paused, rules); `G` (open); `P(p)` | Claimed once: `S`. |
| `agent.started` | `S`; `A` (insert); `G` (`agentIds`, row); `Mc(m)` (D6); `X` | `H` (D6); `M(contributor)` | `ALREADY_SHARED`: unique key. Start not failed: `S`. |
| `agent.startSettled` | `S`; `G` (row) | — | — |
| `agent.startFailed` | `S`; `G` (row) | — | Not started: `S`. |
| `agent.stopLease` | — (session scope row) | `A(target)` (= `SA`) | `releaseId` current: `A`. |
| `agent.remove` | `A` (tombstone); `G` of every group containing it (D8); `Mc(m)` (closing session, release, reservation); `X`; `Δrows` deliveries cancelled | — | No active work: `work.assign` writes or touches `A(worker)`, (a). Not a Lead: as `machine.remove`. |
| `agent.release` | `A(target)` | `GP(project)` (Lead check) | No active work and not reviewing: `work.assign` writes or touches the worker and the group's Reviewers, (a). |
| `agent.sessionClosed` | `Mc(m)` (closing dropped, harness released); `X` | — (no `SA`) | Closing request exists: `Mc(m)`. |
| `agent.configuration` | `A` | — | `previousVersion` matches: `A`. |
| `agent.rebind` | `A`; `G` of its active assignment | `Mc(m)` | One member per terminal (`commands.ts:1145`): every rebind on `m` touches `Mc(m)`, (a). |
| `conversation.agent` | `G`; `A(member)` when a Reviewer's decision clears; `GL`+`H` on a Lead change (D5); `Δrows` delivery `updatedAt` on removal (D10) | `A(member)` otherwise; `H` (rules) | Not stopping, same project: `A`. Active work: `G`. |
| `invite.create` | `H` (invitations); `X` (`invitedEmails`) | — | Not a member: `invite.accept` writes `H`, (a). |
| `invite.revoke` | `H`; `X` | — | — |
| `invite.accept` | `M` (insert); `H` (invitation removed); `X` (`memberIds`) | — (not yet a member) | Invitation valid: `H`. |
| `member.remove` | `M(p)` (tombstone); `Mc` of their machines (removal); `A` of agents they contributed and agents on their machines (tombstones); `G` containing them (D8); `S` pending on their machines (error); `H` (invitations, rules, epoch); `GL` (D5); `X`; `Δrows` deliveries cancelled, native contexts revoked | — | Their in-flight commands touch `M(p)` or their agents' `A`, (b). |
| `message.send` | `G` (D4); `P(p)` clean→dirty | `A` of each recipient (D3) | Postable (open, sender in `agentIds`): `G`. Recipient still a member: `A`. Lead↔worker loop bound reads the last 6 messages, immutable. |
| `mention.done` | — (mention row) | — | Own mention: mention row. |
| `delivery.resolve` | `G` (row); delivery row | `A(target)`; sender's `M` or `A` | `deliveryAllowed` on resend: as a claim (3.5). |
| `work.define` | `G`; D7 for the previous worker; `H`+`GL` when an overlap alert is added | — | No active work: `G`. |
| `work.assign` | `G`; `A(worker)` when its `workDecision`/`releaseId` clears; `A` of the group's Reviewers whose decision clears; `H`+`GL` on an overlap alert | `A(worker)` when nothing on it changes; `A` of the group's other Reviewers; `H` (paused, rules, D9); `P(p)` (R5); `S` of the worker's unsettled start (`commands.ts:1439`) | One active assignment per agent (`commands.ts:1458`): `A(worker)` written or touched, so two assignments of one agent conflict, (a); `SuperTabRun` unique id still backs it across Swarms. |
| `work.status` | `G`; on `done`/`stopped`, D7 | — | Current assignment: `G`. Stop proof: stop receipt row, immutable. |
| `work.cancel` | `G`; D7 | `GP(p)` (Lead check) | Current assignment: `G`. |
| `work.check` | `G` | — | Current assignment; independence: `G`. |
| `route.record` | `G` (route row); route decision row | `H` (rules); `A(candidate)`; `P(p)` (R5) | Pick allowed by rules: `H`. 30 routes an hour: route decision rows (insert-only count; a 31st concurrent record is tolerated, as today). |
| `route.override` | `G` (row); route decision row | `A(candidate)` | Decision open: route decision row. |
| `route.modelResult` | route decision row | `G(decision group)` (`controls`) | — |
| `agent.screen` | terminal request row | `A(target)`; `GP(target's project)` (`mayDrive`) | Ten waiting requests: terminal rows, as today. |
| `agent.input` | terminal request row; `G(currentGroup)` (row) | `A(target)`; `GP` | as above |
| `agent.screenResult` | terminal request row | `A(target)` (= `SA`) | Claimed request: terminal row. |
| `agent.inputResult` | terminal request row | `A(target)` | as above |
| `agent.alert` | `A` (`alerting`, `limitedUntil`); `G(currentGroup)` and `GP` rows | — | One row per episode: `A`. |

`currentGroup` (`terminal.ts:46-50`) picks the newest open group the agent is in; it must search dormant groups too
(D8 index) and the row wakes that group (D4), so terminal rows land where they land today.

### 1.3 Writers outside commands

| Writer | W | T | Invariants and guard |
|---|---|---|---|
| `create` (`store.ts:330-345`) | `H`, `M(owner)`, `G('lead')`, `GL`; `X` (insert) | — | New ids. |
| `observeMachine` (`store.ts:1269-1311`) | `Mc(m)` only, in the steady state (observation). Also, only when the value changes: `A(x).downSince` (`recordAgentPresence`, `machines.ts:264-271`); `Mc(m)` ledger when a stop proof matches a reservation; `Mc` of any machine of the tab whose removal expired (`expireRemovals`, `machines.ts:326-331`); `X` when a removal expired | — | Contribution current (`store.ts:1274-1275`): `member.remove` writes `Mc` of the member's machines, (b), so no `M` touch is needed. |
| Native turn append (`native.ts:179-230`) | `G` (D4: message, `messageSeq`, PR links, assignment `blocked` on a required recovery); `P(p)` clean→dirty; `Δrows` message, delivery to the Lead, native context `lastEventId`, receipt | `A(target)`; `M(operator)` | Operator still a writer, context valid (`native.ts:56-78`): `M(operator)` touched; agent binding: `A` touched; group open and agent present: `G` written; project access: `project.sharing` writes `M`, (b). |
| Delivery claim / ack (`store.ts:1492-1521`) | delivery row only | `A(receiver)`; sender's `M` or `A` (spec ruling 9) | Section 3.5. No Swarm-wide bump any more (`store.ts:1514` goes). |
| Hold notice (`store.ts:1524-1547`) | delivery row; on the first notice `G` (row) and a delivery to the Lead | `A(waiting agent)` | As a claim. |
| Deliveries wake-up (`store.ts:1434-1471`, a GET that writes) | `GP(p)` (update request message); `P(p)` (`requested` map, `requestedAt`, `requestMessageId`); `A(x).downNamed` of each down worker named | `A(Lead)` (= `SA`) | One request per state: stable message id, P2002 on a race (retryable, as today). |
| Stopped receipt (`store.ts:1559-1610`) | `G` (assignment `stopped`, notice); D7; `A(worker).downSince` | — (host is the machine owner, maybe not a member) | Execution matches: `G`. |
| `saveSharing` (`store.ts:377-399`) | `H` (`sharing`) | `M(owner)` | `sharing.revision` matches: `H`. No epoch (sharing is owner-only and never in a read). |
| `join` (`store.ts:412-444`) | `M` (insert) when new; `X` (`memberIds`) | `H` (sharing generation) | A concurrent `saveSharing` writes `H`, (a). |
| `read()` backfill (`store.ts:451-456`) | **removed** | — | The migration backfills `pullRequestUrls` for every group (section 6); reads never write (Ruling R8). |
| Archive sweep (new, worker) | `G` (`dormant=true`) for groups idle 24 h with work done or cancelled | — | Guarded write on `G.version`; a message in between bumps the version and the sweep skips it. |
| Expiry sweep (new, worker) | `S` (tombstone) for starts finished 7 days; `H` (expired invitations removed); purge of tombstones older than 7 days (TTL index) | — | Guarded writes. |

### 1.4 Whole-state passes (spec ruling 10)

| Pass (today) | Today runs | Serializes on | New behavior |
|---|---|---|---|
| `syncLeads` (`model.ts:336-342`) | every read and command | `GL` | Written only by D5. Readers derive nothing. |
| `numberConversations`, `nextConversationNumber`, `retiredConversationNumber` (`model.ts:346-355`) | every command | `H.groupCounter` | `conversation.create` takes `++groupCounter`. The migration fills missing numbers and sets the counter to `nextConversationNumber − 1`; `project.delete` no longer needs a retired number (the counter never decreases), but the old field is kept on `H.data` for reassembly. |
| `placeRules` (`projects.ts:178-185`) | every command and read | `H` | The migration places every rule; `rule.set` always sets `projectId`. No runtime pass. |
| `expireRemovals` (`machines.ts:326-331`) | every command, read and observation | `Mc(m)` | Applied as a view on every read; written by `observeMachine` and by any command that writes that `Mc`. |
| `assignAgentDisplayNames` (`agentNames.ts:21-42`) | every command and read | `H` (touch) | Run at agent creation over all agents (D6). The migration persists every name. |
| `appendPullRequestUrls` (`model.ts:140-149`) | every command, all groups | `G(g)` | Only for groups the command writes. |
| `restorePullRequestUrls` (`store.ts:49-68`) | every read and command | — | Migration only (R8). |
| `noteProjectReports` (`projectUpdates.ts:7-18`) | every shown message | `P(p)` | Clean→dirty only (3.6). |
| `parkLaterConversations` (`model.ts:310-317`) | every load | — | A group part of an unknown `kind` is skipped by the loader; nothing to park. |
| `awaitingWorkers` / `finishWorker` (`model.ts:261-284`) | start, assign, route | `P(p)` (R5) | The migration persists the derived `awaiting` decision of legacy workers. |
| `alertOverlaps` pruning (`commands.ts:602`) | create, define, assign | `H` | Prunes only pairs whose group part is tombstoned (existence by id, dormant groups count as existing). |
| `recordingProgress` stamp (`store.ts:694-702`), `lastMessageSequence` (`store.ts:716`) | message commands | `G(g)` | `recordingProgress.revision` becomes the group's `messageSeq` after the command (3.6). |
| `revokeNativeContexts`, `endedHolds` (`native.ts:234-263`, `store.ts:770`) | every command (diff) | — | Diff of the parts the command wrote; every change they detect is in a written part. |
| `TAB_TOO_LARGE` 8 MiB (`commands.ts:1561`) | every command | — | Per part: refuse a write whose part `data` exceeds 4 MiB (`PART_TOO_LARGE`, 413). No whole-Swarm limit. |
| `indexes()` (`store.ts:69-75`) | every write | `X` | Written only by commands that add or remove a person, invitation or machine reference (listed above); those always write `X`, so two of them conflict instead of one losing an id. |

## 2. Storage: Prisma models

### 2.1 Common shape

Every part model has these fields. Group 2 may name the Prisma models; the names below are used in this doc.

```prisma
model SwarmGroup {                 // likewise SwarmHead, SwarmMember, SwarmAgent, SwarmMachine, SwarmStart, SwarmProgress
  id         String   @id @map("_id")  // `${tabId}:${key}`
  tabId      String
  key        String                    // conversation id (agent id, person id, machineId, start id, project id; "head" for SwarmHead)
  version    Int                       // bumped by every write and touch; never reset (spec ruling 6)
  changedAt  DateTime                  // stamped when data changes or the part is tombstoned (3.3)
  deleted    Boolean  @default(false)  // tombstone
  purgeAt    DateTime?                 // tombstone: changedAt + 7 d (TTL index); finished start: see SwarmStart
  ordinal    Float                     // reassembly order (6.2): migrated index, then the creation time in ms
  data       Json                      // today's record, in today's JSON shape
  // per-model extracted fields below
  @@unique([tabId, key])
  @@index([tabId, changedAt])
}
```

- `version` starts at the tab's final revision `R` for migrated parts. A part created later starts at
  `H.sequenceBase + 1` (`R + 1` in a migrated Swarm, 1 in a new one), so a recreated key whose tombstone was
  already purged still sorts after its old configuration rows. A part recreated while its tombstone exists (an
  agent contributed again) updates the tombstone: `deleted=false`, `version+1`.
- `changedAt` is not bumped by a touch. Clients merge by `version` (a higher version replaces a lower one), so a
  touched part they hold at a lower version is simply replaced at its next data change.
- TTL index on `purgeAt` (`expireAfterSeconds: 0`), created by the worker at startup like `ensureTerminalExpiry`
  (`terminal.ts:17-20`).

### 2.2 Per-model fields

| Model | `data` holds (today's shape) | Extracted fields and indexes |
|---|---|---|
| `SwarmHead` (one per Swarm) | `SuperTabState` scalars and settings: `version:1`, `id`, `name`, `project`, `projects` (**without** `progress`), `leadsConversationId`, `overlapAlerts`, `ownerId`, `environment`, `routingPolicy`, `rules`, `sharing`, `paused`, `invitations`, `retiredConversationNumber`, `localModels` | `groupCounter Int`, `visibilityEpoch Int`, `sequenceBase Int` (the migration's `R`; 0 for a new Swarm). Index `[tabId]` via the unique key. |
| `SwarmMember` (one per person) | `Person` `{id, email, role, generation}` | `personId String`. People live only here, not on the head (Ruling R2). |
| `SwarmGroup` (one per conversation, Leads included) | `Conversation` as today, plus `messageSeq`, `reportSeq`, `dormant`, `lastActivityAt` (ISO), `audience?` (4.8) | `projectId String?`, `kind String?`, `archived Boolean`, `dormant Boolean`, `agentIds String[]`, `executionMachineId String?` (active assignment), `messageSeq Int`, `reportSeq Int`, `lastActivityAt DateTime`. Indexes: `[tabId, dormant, changedAt]`, `[tabId, agentIds]`, `[tabId, projectId, dormant, lastActivityAt]`, `[tabId, projectId, dormant, reportSeq]`, `[dormant, lastActivityAt]` (sweep), `[executionMachineId]`. |
| `SwarmAgent` | `Agent` as today | `machineId`, `machineOwnerId`, `contributorId`. Indexes `[machineId, deleted]`, `[tabId, contributorId]`. |
| `SwarmMachine` (per machine the Swarm references) | `{ machineId, contribution: ContributedMachine \| null (incl. observation), reservations: [{harnessId, generation, renewed}], released: [harnessId] (newest last, capped at 200), closingSessions: [{agentId, harnessId, machineOwnerId}], cleanups: [{removalId, machineOwnerId}] }` | `machineId`, `contributed Boolean`, `cleanupOwnerIds String[]`. Index `[machineId, deleted]`. |
| `SwarmStart` | `AgentStart` as today | `machineId`, `conversationId`, `agentId String?` (once it has a harness, 3.1), `finishedAt DateTime?` (set when it errors, or has a harness and is settled or not pooled). The expiry sweep tombstones a start 7 days after `finishedAt`; until then a command that matches it loads it by key or `agentId`. Index `[tabId, finishedAt]`, `[machineId, finishedAt]`, `[tabId, agentId]`. |
| `SwarmProgress` (one per project with stored projects) | `{ since, summarizedFloor, summarized: {groupId: seq}, requestedFloor, requested: {groupId: seq}, requestedAt?, requestMessageId? }` (3.6) | `projectId`. |

**Group `data` fields added:**
- `messageSeq`: the last sequence given to a message in this group. A group created after the migration starts at
  `H.sequenceBase`, so its sequences are always above every pre-migration value (needed by the legacy
  `throughRevision` rule in 3.6).
- `reportSeq`: the sequence of its last message that counts for project reports (today's `noteProjectReports` set).
- `dormant` and `lastActivityAt`: the active set (Ruling R3).
- `audience`: section 4.8.

`lastMessageSequence` keeps its meaning: the sequence of the last shown message.

### 2.3 What stays in existing collections

- `SuperTab` (`schema.prisma:996-1014`) becomes the **index row**. It keeps `memberIds`, `invitedEmails`,
  `machineIds` and `cleanupMachineIds`, maintained as in 1.4, and `revision`, which the migration sets to `R+1`. It
  gains `format Int @default(1)` (2 once migrated), `migratedAt DateTime?` and `legacyState Json?`. The migration
  moves the old state there unchanged and read-only, and leaves `state = { "version": 2 }` as the data fence
  against old processes (6.1.1, R14).
  - `machineIds` stays the union of agents', contributions', closing sessions' and cleanups' machines. Active
    assignments' machines are dropped from the union: an assignment's machine is its agent's, or a closing session's
    once the agent is removed (`commands.ts:529-533`).
- Unchanged collections: messages, deliveries, operations, native contexts, runs, attempts, route decisions, stop
  receipts, role texts, terminal requests, mentions, attachments, session scopes and routing policies. Their only
  changes:
  - `SuperTabMessage.sequence` is the group sequence for new rows. The index `[tabId, conversationId, sequence]`
    (`schema.prisma:1050`) becomes `[tabId, conversationId, sequence, id]` for the `(sequence, id)` page cursor (4.6).
  - `SuperTabOperation` gains `parts Json?`, the reply's part versions (4.7). `revision` keeps its stored value on
    old receipts and is `0` on new ones (spec ruling 8).
  - `SuperTabConfiguration.revision` stores the agent part's new `version`. Versions start at `R`, so a new row
    always sorts after every older row of that agent (`schema.prisma:1234`).

## 3. Concurrency

### 3.1 Transaction shape (every command)

```text
transaction(db, async tx => {                       // store.ts:101-123, unchanged retry/backoff, timeout 15 s
  stamp = clock.next()                              // per attempt (3.3)
  view  = loadActive(tx, tabId, named)              // H, all M, all live A, non-dormant G, all Mc, unfinished S, all P,
                                                    // plus groups the command names by id (dormant ones too),
                                                    // plus D8 groups by agentIds when the command removes agents,
                                                    // plus finished starts it matches (below)
  state = reassemble(view)                          // SuperTabState shape, parts in ordinal order (6.2)
  ...actor, team, receipt and context reads exactly as executeOnce today (store.ts:519-650)
  effects = applyCommand(state, actor, command, context)   // pure, unchanged except the audience rule (4.8)
  plan  = diffParts(view, effects.state)            // per part key: insert / update data / tombstone
  touch = touchesFor(command, actor, view, effects) // section 1 T column, minus parts already in plan
  for p in plan ∪ touch: guardedWrite(p)            // 3.2
  messages: per group in plan, seq = ++messageSeq per message, in draft order
  side collections exactly as today, minus every use of the tab revision
  receipt: { result, parts: [{kind, key, version}] }
})
```

- **Finished starts a command matches stay loadable** until the expiry sweep tombstones them, 7 days after
  `finishedAt`. Two places look a finished start up:
  - `work.assign` with a `routeDecisionId` loads the start named by the decision's `final.startId`, so
    `started(d)` matches the routed worker as today (`commands.ts:1471-1478`).
  - `agent.remove` by the agent itself loads the start whose `agentId` equals the removed agent, to close its route
    hold (`store.ts:785-789`).
  - `SwarmStart` therefore extracts `agentId = stableId(request.machineId, harnessId)` once it has a harness
    (`commands.ts:1109`, 2.2).
  - Slot counts do not need finished starts. A started harness is also counted through its agent or its
    reservation, which a person's removal keeps (`commands.ts:1216-1219`, `machines.ts:341-364`).
- The loaders read with snapshot semantics. A stale read is caught only by a write to the same part, which is
  why section 1 lists touches.
- `loadActive` costs what today's full read costs, minus dormant groups and finished starts. Group 0's benchmark
  measures it.

### 3.2 Guarded write

- Every part write and touch is
  `updateMany({ where: { id, version: seen }, data: { version: seen + 1, ...dataFields } })`. `dataFields` is
  `{ data, changedAt: stamp, deleted, purgeAt, ...extracted }` for a write and empty for a touch.
- A count of 0 throws a `PartConflict` (code `P2034` so `retryable()`, `store.ts:119-123`, keeps working
  unchanged).
- An insert is `create` on the unique `[tabId, key]`. A race raises P2002, which is already retryable.
- The guard does not depend on the transaction's read concern. It checks the committed version at write time.
  Mongo's own write conflict, a `TransientTransactionError`, also retries.

### 3.3 Retry, timeout and the `changedAt` clock

- Retry stays #1722's: 8 attempts, jittered backoff from 50 ms capped at 1.5 s, `SWARM_BUSY` (503) at the end,
  `maxWait 5 s`, `timeout 15 s` (`store.ts:101-123`). The timeout must stay ≤ 15 s, because the cursor overlap
  depends on it.
- **Backend processes.** The number is not fixed in this repository. Production runs `Dockerfile.k8s`: one `node
  dist/server.js` per container. ArgoCD sets the replica count outside this repo (`.github/workflows/production-be-build.yaml:69`,
  `backend/README.md:85-88`). The Docker image runs a pm2 cluster with `instances: 'max'`
  (`backend/ecosystem.config.cjs.docker`), plus one `backend-worker`. Several processes write Swarm state at once.
  The design assumes **N ≥ 2 writers on different hosts** and does not depend on N.
- **Clock source.** Each process's wall clock (`Date.now()`), made strictly increasing per process:
  `next() = max(Date.now(), last + 1)`, in ms. One stamp covers all parts of one attempt, and is taken again on
  retry.
  - Mongo's server clock (`$currentDate`) would remove cross-host drift. Prisma's `updateMany` cannot express it
    without raw commands, so it is not used.
- **Overlap.** 30 s = the 15 s transaction timeout + 15 s budget for clock drift between pods. Nodes are assumed
  NTP-synced well inside that budget (section 8, Q6). A part committed after the read start `T0` has
  `changedAt ≥ T0 − 15 s − drift > T0 − 30 s`, so the next poll (cursor `T0 − 30 s`) sees it.

### 3.4 The actor part touch (spec ruling 2)

- `SA` is touched by every command (D1) and by native appends, claims, acks and holds (1.3).
- A person's removal tombstones `M(p)`, and an agent's removal tombstones `A(a)`. An action already in flight by
  that actor then conflicts and retries against the new state, where `author()` refuses it.
- Cost:
  - An agent's own commands serialize with each other, which they already are in practice (one session).
  - They also serialize with claims of its own deliveries (same host), and with `observeMachine` only when its
    presence actually flips.
  - The Lead's part is the busiest. It is touched by its commands and by claims of its deliveries, all from one
    host.

### 3.5 Delivery claim, ack and hold (spec ruling 9)

- **Loads:** `H`, all `M`, the receiving and sending agents' `A`, the delivery's group, and `GP` of its project.
  Not the whole active state.
- **Checks:** `deliveryAllowed` and `senderAllowed` stay as they are (`store.ts:1410-1432`), plus the audience
  rule (4.8).
- **Touches:** `A(receiver)`, and `M(sender)` or `A(sender)`. **Writes:** the delivery row only.
- **Revocation** keeps cancelling delivery rows (`store.ts:823-833`, `native.ts:259-261`), so a claim and a cancel
  conflict on the row.
- **Group-level changes** that do not cancel rows today (archive, removal from a group, a new audience) bump the
  rows' `updatedAt` (D10), so they conflict on the row too.
- **Exactly once** is unchanged: `claimId` on the row. The existing integration cases must pass unmodified:
  "allows one claim winner and preserves the original native receipt", "serializes revocation against claims and
  exposes no pending instruction after removal", and "durably resumes a claim, never steals it on timeout…"
  (`backend/integration/superTabs.test.ts:1535-1582`).

### 3.6 Project progress watermark (spec ruling 1) and `recordingProgress`

- **Per group:** `reportSeq` is set by every message that `noteProjectReports` counts today: shown messages and
  native turns in a non-Lead project group. Hold notices and stop notices bump `lastMessageSequence` but not
  `reportSeq`, as today (`store.ts:1538`, `store.ts:1597`). They do not mark a project dirty. Ruling R12.
- **Dirty on read:** group `g` of project `p` is dirty when `g.reportSeq > (P.summarized[g] ?? P.summarizedFloor)`.
  The project is dirty when any of its groups is. Private groups never count (4.8).
- **Dormant groups stay in the report check until the Lead acknowledges them** (review round 1). The dirty check
  reads the project's active groups plus its dormant groups with `reportSeq > P.summarizedFloor`. That is one query
  on the extracted `reportSeq` (index `[tabId, projectId, dormant, reportSeq]`, 2.2), filtered by the `summarized`
  map. A dormant group leaves the check once `summarized[g] ≥ reportSeq`.
  - `message.send` and native appends use the same check to decide the clean→dirty write.
  - The wake-up's `through` map includes those dormant groups.
- **Write on the change from clean to dirty only:** `P.since = now`. Posts in different groups of a dirty project
  never write `P`.
- **Wake-up (`projectUpdateRequest`, `projectUpdates.ts:35-66`).**
  - `through` = `{g: reportSeq}` for the dirty groups.
  - Reports are due when some dirty group has `reportSeq > (P.requested[g] ?? P.requestedFloor)` and
    `now ≥ max(requestedAt, since) + cadence`.
  - Writing the request sets `P.requested = through`, `requestedAt` and `requestMessageId`.
  - The message id is `stableId('project-update', tab, project, canonical JSON of through, …down)`.
  - The text names the groups by number and sequence (for example "#12 after 213990, #14 after 214002") in place of
    "with lastMessageSequence after N".
  - The JSON it asks for is `{"type":"project.report","projectId":"…","through":{"<groupId>":214031,…},"text":"…"}`.
- **`project.report`.** The schema accepts `through: Record<id, int>`. The legacy scalar `throughRevision` is
  accepted only when it is ≤ `H.sequenceBase`, meaning a wake-up from before the migration; it then applies to
  every group. Anything else fails with 400 `THROUGH_REQUIRED`.
  - Effect: `summarized[g] = max(summarized[g] ?? floor, min(through[g], g.reportSeq))`.
  - The wake-up delivery is answered when `through[g] ≥ requested[g]` for every `g` in `requested`.
- **Worker-decision fence (Ruling R5).**
  - `P(p)` is also the part that `requireWorkerDecisions` (`model.ts:270-276`) serializes on. `finishWorker` writes
    `P(p)` (D7).
  - The Lead commands that run the check touch `P(p)`: `agent.start`, `agent.startDispatch`, `work.assign` and
    `route.record`.
  - Without this, a worker finishing in group A while the Lead assigns in group B would let the assignment pass
    over a decision that is now due.
- **`recordingProgress`** (`model.ts:105`, stamped at `store.ts:694-702`). Its `revision` is now the group's
  `messageSeq` after the command.
  - Native recovery (`native.ts:157-162`) looks up `{conversationId, sequence: revision}` as today. Stored values
    from before the migration are tab revisions ≤ `R`, which are still valid message sequences in that group
    (spec ruling 7).

### 3.7 `lastChangedAt` (spec ruling 8): computed when read

- **Choice:** computed, not stored (spec ruling 8 leaves the choice to this group). A stored head field written on every command is the hotspot again. A
  best-effort write after commit can be lost by a crash, and the host form must not miss a change.
- **Single Swarm:** `max(changedAt)` over its seven collections. That is seven index-only `findFirst` calls on
  `[tabId, changedAt]`, done once per response.
- **List and host form:** one aggregate per collection:
  `{$match:{tabId:{$in:ids}}},{$sort:{tabId:1,changedAt:-1}},{$group:{_id:'$tabId',t:{$first:'$changedAt'}}}`.
  It uses the `[tabId, changedAt]` index, so Mongo can use a DISTINCT_SCAN. That is seven queries for up to 100
  Swarms. Group 0's benchmark records the cost.
- A touch does not move `changedAt`, so `lastChangedAt` moves only when data changes.

## 4. Read API contract

### 4.1 Conventions

- All responses use the existing envelope and `respond()` error mapping (`backend/src/routes/superTabs.ts:55-60`).
  The examples show the `data` payload.
- Times are epoch milliseconds (numbers). Part `data` keeps today's ISO strings where today's record has them.
- **Paths must match the daemon proxy's pattern** `^/api/super-tabs(/[A-Za-z0-9_-]+)*(\?[A-Za-z0-9_=&%-]+)?$`
  (`cli/src/superTabs/service.ts:275-282`), because Desktop and web reach the backend through it. Cursors are
  therefore unpadded base64url.
- `asAgentId` works on every read as it does today (`agentQuery`, `backend/src/routes/superTabs.ts:25`).
- **Part envelope.** Live: `{ "key": "<id>", "version": 213995, "changedAt": 1793010101002, "data": { … } }`.
  Tombstone: `{ "key": "<id>", "version": 213996, "changedAt": 1793010102000, "deleted": true }`. A group that went
  dormant (4.4): `{ "key": "<id>", "version": 214000, "changedAt": …, "dormant": true }`.
- **`data` is the reader's view** of the part: today's `visibleState` (`model.ts:392-459`) applied per part. That
  means: `sharing`, `overlapAlerts`, the machine ledger, `downNamed`, `parkedConversations` and
  `retiredConversationNumber` are dropped. Projects, rules, groups, agents, starts and invitations are filtered by
  what the reader may see. The Leads group is shown only to people and Leads, with its `agentIds` cut to visible
  agents. `privacy.detail` goes only to the contributor. Invitations go only to the owner. A machine's observed
  harness ids are cut to the reader's visible agents and starts.
- **`derived`** is recomputed in full on every response (spec ruling 4). It holds the values that change without a
  part changing: time-based values, and values that depend on several parts. Clients overlay it on the parts.

```jsonc
"derived": {
  "agents":   { "<agentId>": { "downSince": "2026-10-26T10:19:51.474Z", "limitedUntil": null,
                               "workDecision": "awaiting", "roleId": "dev" } },
  "machines": { "<machineId>": { "availableSlots": 2, "teamWork": { "allowed": true } } },
  "otherProjectsWork": [ { "conversationId": "…", "projectName": "Web", "title": "…", "owns": ["desktop/lib"],
                           "status": "working", "agentName": "Hugo", "pr": null } ],   // a Lead agent only
  "mentionsWaiting": 2                                                                 // a person only
}
```

Every agent the reader can see has an entry in `derived.agents`; `workDecision` is `null` when the stored value
stands. Every contributed machine has an entry in `derived.machines`. These are the fields `store.ts:461-468` and
`model.ts:403-456` compute today.

### 4.2 Cursor, epoch and reload

- The cursor is opaque to clients: base64url of `{"v":2,"t":<ms>,"e":<epoch>}`. The server makes it at the
  **start** of handling the read: `t = T0 − 30 000` (spec ruling 3), where `T0` is the server's clock when the
  handler starts, before any query.
- `GET …/changes` answers `{"reload": true}` (HTTP 200) instead of changes in any of these cases:
  - the cursor does not parse or has `v ≠ 2`;
  - `e` differs from the head's current `visibilityEpoch` (spec ruling 4);
  - `t < now − 7 d + 1 h`, because tombstones are purged after 7 days (spec ruling 6).
  The client then does a first load.
- **The visibility epoch is bumped by:**
  - `project.sharing`, `project.delete`, `member.remove` (including leaving), and `conversation.audience`;
  - any write of `GL`'s `agentIds` (D5), because who is a Lead decides who sees the Leads group;
  - `invite.accept` and `join` do **not** bump it: a new member's own client does a first load, and nobody else's
    view changes.

### 4.3 First load

`GET /api/super-tabs/:tabId/parts[?asAgentId=]`

```jsonc
{
  "format": 2,
  "tabId": "c51479bd73b59e58176ad9e4",
  "cursor": "eyJ2IjoyLCJ0IjoxNzkzMDEwMDc0Mzc1LCJlIjozfQ",
  "serverTime": 1793010104375,
  "lastChangedAt": 1793010101002,
  "epoch": 3,
  "githubApp": true,                                   // as today (routes/superTabs.ts:151)
  "head": { "key": "head", "version": 213990, "changedAt": 1793009000000,
            "data": { "version": 1, "id": "c51479bd73b59e58176ad9e4", "name": "openharness", "ownerId": "6a86…",
                      "environment": "prod", "paused": false, "leadsConversationId": "…",
                      "projects": [ { "id": "5701…", "name": "openharness", "ownerId": "6a86…", "leadConversationId": "…",
                                      "visibility": "public", "members": [], "updateMinutes": 5, "skillMode": "default",
                                      "skillSet": "default" } ],
                      "rules": [], "invitations": [], "localModels": { "grid": "swarm-…", "enabled": true } } },
  "members":  [ { "key": "6a86…", "version": 213990, "changedAt": 1793000000000,
                  "data": { "id": "6a86…", "email": "ken15@autonomous.ai", "role": "owner", "generation": "c514…" } } ],
  "agents":   [ { "key": "0540…", "version": 214010, "changedAt": 1793010090000,
                  "data": { "id": "0540…", "projectId": "5701…", "machineId": "7835…", "harnessId": "2973…",
                            "machineOwnerId": "6a91…", "contributorId": "6a91…", "membershipGeneration": "02c4…",
                            "hostGrant": null, "name": "Builder", "displayName": "Hugo",
                            "configuration": { "engine": "claude", "model": "opus", "effort": "high",
                                               "contextWindow": null, "engineVersion": null } } } ],
  "groups":   [ { "key": "aeef…", "version": 214031, "changedAt": 1793010101002,
                  "data": { "id": "aeef…", "projectId": "5701…", "number": 204, "title": "1726 G1: design doc…",
                            "leadId": "0fcb…", "agentIds": ["0fcb…", "0540…"], "archived": false,
                            "brief": "Goal: …", "task": { "goal": "…", "changes": "…", "constraints": "…", "owns": ["docs/design/…"] },
                            "checks": [ { "id": "b936…", "description": "…", "independent": false, "evidence": null, "passedBy": null } ],
                            "assignment": { "id": "09d0…", "agentId": "0540…", "status": "working", "result": null,
                                            "configuration": { "engine": "claude", "model": "opus", "effort": "high",
                                                               "contextWindow": null, "engineVersion": null },
                                            "execution": { "machineId": "7835…", "harnessId": "2973…", "machineOwnerId": "6a91…" },
                                            "recordingProgress": { "at": 1793010104375, "revision": 219804 } },
                            "lastMessageSequence": 219804, "messageSeq": 219804, "pullRequestUrls": [] } } ],
  "machines": [ { "key": "7835…", "version": 214020, "changedAt": 1793010100000,
                  "data": { "machineId": "7835…", "name": "MacBookPro2021", "contributorId": "6a91…", "scope": "swarm",
                            "engines": ["claude", "codex"], "maxAgents": 4, "paused": false, "cwd": "/Users/…",
                            "generation": "…", "membershipGeneration": "…",
                            "observation": { "receivedAt": 1793010099000, "resources": { … }, "quotas": [ … ],
                                             "runningHarnessIds": ["2973…"], "stoppedHarnessIds": [] } } } ],
  "starts":   [ ],
  "progress": [ { "key": "5701…", "version": 214001, "changedAt": 1793009900000,
                  "data": { "since": 1793009900000, "summarizedFloor": 213800, "summarized": { "aeef…": 219700 },
                            "requestedFloor": 213800, "requested": {}, "requestedAt": null } } ],
  "derived": { "agents": { "0540…": { "downSince": null, "limitedUntil": null, "workDecision": null, "roleId": null } },
               "machines": { "7835…": { "availableSlots": 3, "teamWork": { "allowed": true } } },
               "mentionsWaiting": 0 }
}
```

- **Machine `data`** is the contribution as `state.machines[]` has it today (`machines.ts:7-31`). Machines with no
  contribution are not sent: the ledger is never readable (`model.ts:410-415`).
- **Groups** are the reader's visible non-dormant groups. Dormant ones are fetched on demand (4.4).
- **Starts** are unfinished starts and starts finished within 7 days, as today minus the expired ones.

### 4.4 Changes since a cursor

`GET /api/super-tabs/:tabId/changes?cursor=<cursor>[&asAgentId=]`

```jsonc
{
  "format": 2, "reload": false,
  "cursor": "eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjozfQ",
  "serverTime": 1793010107375, "lastChangedAt": 1793010106120, "epoch": 3,
  "head": null,                                      // or the head envelope when it changed
  "members": [], "agents": [],
  "groups": [ { "key": "aeef…", "version": 214033, "changedAt": 1793010106120, "data": { …whole group… } },
              { "key": "9c1d…", "version": 214040, "changedAt": 1793010105000, "dormant": true },
              { "key": "77ab…", "version": 214041, "changedAt": 1793010105500, "deleted": true } ],
  "machines": [ { "key": "7835…", "version": 214050, "changedAt": 1793010105900, "data": { … } } ],
  "starts": [], "progress": [],
  "derived": { … complete, as in 4.1 … }
}
```

- **The server returns** every part the reader can see with `changedAt > cursor.t`, each whole. Dormant groups
  come back as the one-line stub until they change again (spec ruling 5).
- **A part the reader can no longer see** never appears with data: any change that makes one invisible bumps the epoch.
- **Tombstones and dormant stubs pass the same read check as live parts.**
  - A tombstone keeps the part's last live `data` on the server; it is never sent.
  - A stub or tombstone goes only to a reader who could read that last data: `canReadGroup` for a group (audience
    included), `canReadAgent` for an agent, a start's group for a start, the machine rules for a machine. Members
    and the head are visible to every member.
  - Where the check cannot be made because the project is gone, the change bumps the epoch, and every reader reloads.
    `project.delete` already bumps the epoch (4.2).
  - A private group's stub, removal or key never reaches anyone outside its audience.
- **The client merges** by `(kind, key)`, keeping the higher `version`. A tombstone removes the part. A dormant stub
  moves the group out of the active list. The client replaces `derived` and moves to the returned `cursor`.
  Overlap duplicates have equal versions and are ignored.
- **Messages are not in the feed.** A group's `lastMessageSequence` tells the client there is something to read,
  and it pages messages per group as today (4.6).

### 4.5 Dormant groups on demand

- `GET /api/super-tabs/:tabId/groups?dormant=1[&projectId=<id>][&before=<cursor>][&asAgentId=]`: dormant groups
  the reader may see, newest activity first, 50 per page.

```jsonc
{ "groups": [ { "key": "9c1d…", "version": 214040, "changedAt": 1793010105000, "data": { …whole group, "dormant": true… } } ],
  "next": "eyJsYSI6MTc5MzAwMDAwMDAwMCwiayI6IjljMWQifQ" }   // base64url {"la":lastActivityAt,"k":key}; null at the end
```

- `GET /api/super-tabs/:tabId/groups/:conversationId[?asAgentId=]`: one group, active or dormant.
  Returns `{ "group": <envelope> }`, or 404 `NOT_FOUND` when unreadable.
- The messages, attempts and route-decision routes accept a dormant group's id as they accept an archived one today.

### 4.6 Messages (unchanged path, new sequence source)

- `GET /api/super-tabs/:tabId/conversations/:conversationId/messages?after=|before=|messageId=` is unchanged
  (`store.ts:1126-1152`), except that the response drops `revision`.
- `sequence` is per group and strictly increasing for new messages. Old messages keep theirs, ties included
  (spec ruling 7).
- **Pages use a stable `(sequence, id)` cursor** (review round 1). Today a page boundary inside a run of equal
  sequences skips rows (`store.ts:1135`, `1145`).
  - Rows are ordered by `(sequence, id)`, ascending forward and descending backward.
  - Request: `after=<sequence>&afterId=<id>` or `before=<sequence>&beforeId=<id>`, two plain parameters so the
    daemon's path pattern still passes.
    - `after` without `afterId` means strictly after that sequence. That is enough for polling new messages, which
      always have fresh sequences.
    - `before` without `beforeId` means strictly before.
  - Forward: `sequence > s OR (sequence = s AND id > i)`. Backward: the mirror.
  - Response: `"next": { "sequence": 213990, "id": "9f2c…" }`, or `null`.
  - Index: `SuperTabMessage` `[tabId, conversationId, sequence, id]`, which replaces `[tabId, conversationId, sequence]`
    (2.3).
- A message posted to a dormant group makes it active: it comes back in the feed as a full group.

### 4.7 Command reply

`POST /api/super-tabs/:tabId/commands` (body unchanged except the schema changes in 3.6 and 4.8):

```jsonc
{ "result": { "messageId": "…" },
  "parts": [ { "kind": "group", "key": "aeef…", "version": 214033 },
             { "kind": "progress", "key": "5701…", "version": 214034 } ],
  "lastChangedAt": 1793010106120 }
```

- `parts` lists the parts the command **wrote**, never the ones it only touched. `kind` is one of `head`, `member`,
  `agent`, `group`, `machine`, `start`, `progress`. This replaces `revision` (spec ruling 8).
- A replayed receipt returns the stored `parts`. A receipt from before the migration returns
  `{ "result": …, "parts": [], "legacyRevision": 213990 }`.
- Other replies that carried `revision`:
  - `POST /api/super-tabs` → `{ "id" }`
  - `POST …/join` → `{ "id", "role", "alreadyMember" }`
  - `POST …/machines/:m` (observation) → `{ "version" }` of `Mc(m)`
  - native append → `{ "eventId", "sequence" }`
  - `POST …/stopped` → `{ "confirmed": true }`, unchanged

### 4.8 Private conversations: audience (addendum)

**Storage.** `G.data.audience?: { people: Array<{ id: string; generation: string }> }`.
- Absent: the group is visible to whoever may read its project, as today.
- Present: the group is a private conversation. Generations are captured as `projectMembers` captures them
  (`projects.ts:202-207`), so leaving and rejoining does not restore access.
- The Leads conversation and project Lead conversations never have an audience.

**One predicate.** `readConversation` (`projects.ts:107-116`) gains the rule. Every read path goes through it, or
through `canReadGroup(state, actor, group)`, which group 2 adds next to it:

```text
canReadGroup(state, actor, g) =
  isLeads(g)          → today's rule
  !canReadProject(…)  → false
  !g.audience         → true
  actor is a person   → g.audience.people has { id: actor.userId, generation: member.generation }
                        || (PRIVATE_VISIBLE_TO_OWNERS && actor is the project owner or the Swarm owner)
  actor is an agent   → actor is the project's Lead (ledProject(state, actor.agentId)?.id === project.id)
```

The project owner and the Swarm owner are **not** implied: only the listed people and the Lead (addendum).
This is one constant, `PRIVATE_VISIBLE_TO_OWNERS = false`, next to `canReadGroup`. The owner (Ken) decided it stays
off: owners do not see private channels (section 8, Q3a). It stays one constant, and no other path may decide owner
visibility on its own.

**Where it is enforced** (each must use `canReadGroup`, not `canReadProject`):

| Path | Today | Change |
|---|---|---|
| First load, changes, dormant list, one group | `visibleState` filter (`model.ts:432`) | per-group filter |
| Messages, attempts, route decisions | `readConversation` (`store.ts:1131`, `1171`, `1184`) | through `readConversation` |
| Commands naming a group | `authorizeCommandAccess` (`commands.ts:340-343`) | through `readConversation` |
| Uploads, native terminal open | `poster`, `native.open` (`store.ts:941-948`, `native.ts:88`) | through `readConversation` |
| Mentions: tagging, list, waiting count | `canReadProject` (`mentions.ts:32`, `mentions.ts:71`) | `canReadGroup`; a Lead may tag only people in the audience |
| Deliveries | `deliveryAllowed` (`store.ts:1420-1422`) | the sender must be in the audience or be the Lead; recipients can only be the Lead (below) |
| `otherProjectsWork`, overlap alerts | `crossProjectActive` (`model.ts:320-321`) | private groups excluded |
| Project progress and wake-ups | `noteProjectReports` | private groups never mark a project dirty, so the Lead's summary to everyone never draws on them |
| Host roster `active` / `attention` | `store.ts:1340-1345` | unchanged (host rows are the agent's own) |
| Terminal rows (`currentGroup`) | `terminal.ts:46-50` | private groups excluded (only the Lead is in them, and the Lead's rows already skip groups it leads) |

**Rules for private groups.**
- `agentIds` holds only the project's Lead. `conversation.agent` with `present:true` for any other agent fails 403
  `AUDIENCE_LEAD_ONLY`.
- A private group is chat only. `work.define`, `work.assign`, `agent.start`, `route.record` and `reviewOf` targeting
  it fail 400 `AUDIENCE_CHAT_ONLY`, which keeps private work out of `otherProjectsWork`, holds and reviews.
- Attachments are stored and listed like messages and follow the group's readers. Their bucket URLs stay
  unguessable public URLs, as in private projects today (section 8, Q3).

**Commands.**

```jsonc
// create, by a writer person who can read the project (they must list themselves) or by the project's Lead:
{ "type": "conversation.create", "projectId": "5701…", "title": "Ken ↔ PM", "brief": "", "checks": [],
  "audience": { "personIds": ["6a86…"] } }
// change, by the project's Lead or a person in the audience; an empty list leaves only the Lead:
{ "type": "conversation.audience", "conversationId": "…", "personIds": ["6a86…", "6a87…"] }
```

- Each id must be a member who can read the project. Generations are captured from the member parts.
- `conversation.audience` replaces the list, bumps the epoch, and revokes native contexts of people removed. It
  also cancels queued, claimed or uncertain deliveries **authored** by people removed, and bumps the others (D10).
- An audience is never removed: a private conversation does not turn public. A group without `audience` cannot be
  given one, since its history was shared. Both fail 400 `AUDIENCE_FIXED`.

### 4.9 Swarm list

`GET /api/super-tabs/list[?after=<id>]` replaces `GET /api/super-tabs` (`store.ts:347-355`):

```jsonc
{ "tabs": [ { "id": "c514…", "name": "openharness", "ownerId": "6a86…", "paused": false, "lastChangedAt": 1793010106120 } ],
  "next": null }
```

### 4.10 Host form for the CLI

`GET /api/super-tabs/hosts/:machineId/changes?cursor=<cursor>[&full=1]`. It replaces `GET /hosts/:m`,
`GET /hosts/:m/pools` and `GET /hosts/:m/assignments` (`store.ts:1226-1250`, `1313-1375`, `1396-1408`).

```jsonc
{
  "format": 2, "full": false,
  "cursor": "eyJ2IjoyLCJ0IjoxNzkzMDEwMDc3Mzc1LCJlIjowfQ",
  "tabs": [ {
    "tabId": "c514…", "lastChangedAt": 1793010106120,
    "roster": [                       // exactly today's GET /hosts/:m rows for this tab, `revision` replaced by `lastChangedAt`
      { "tabId": "c514…", "tabName": "openharness", "lastChangedAt": 1793010106120, "paused": false, "active": true,
        "attention": null, "agent": { …Agent… }, "joinSwarm": false, "skillMode": "default", "lead": false,
        "leadsConversationId": "…",   // new: lets the host's mayRead skip the full read (cli host.ts:874-876)
        "stopRequested": false, "observers": [ { "email": "ken15@autonomous.ai", "userId": "6a86…" } ] },
      { "tabId": "c514…", "agent": { "id": "…", "harnessId": "…", "machineId": "7835…" }, "closeSession": true, "active": false },
      { "tabId": "c514…", "cleanup": { "machineId": "7835…", "removalId": "…" } },
      { "tabId": "c514…", "joinTeam": { "machineId": "…", "name": "MacBookPro2021", "maxAgents": 4 } } ],
    "pool": { "tabId": "c514…", "paused": false, "machine": { …ContributedMachine… }, "starts": [ … ], "localGrid": "swarm-…",
              "reservations": [ { "harnessId": "…", "generation": "…" } ], "harnessIds": [ "…" ], "githubApp": true },  // or null
    "assignments": [ { "tabId": "c514…", "assignmentId": "09d0…", "harnessId": "2973…" } ]
  } ],
  "removedTabIds": [ "…" ]            // incremental only: Swarms that no longer list this machine
}
```

- **Incremental** (no `full`):
  - The server finds the Swarms that list the machine through `X` (`machineIds`, `cleanupMachineIds`). It keeps
    the ones with a **host-relevant** part whose `changedAt > cursor.t`:
    - the head or any member (names, pause, observers);
    - an agent on this machine;
    - a group whose `agentIds` include such an agent, or whose `executionMachineId` is this machine;
    - `Mc` of this machine or its team pools;
    - a start on this machine.
  - For those Swarms it returns all three row sets in full. The client replaces that Swarm's rows and keeps every
    other Swarm's rows.
  - A post in a group with no agent on this machine does not wake the host.
- **Full** (`full=1`): every Swarm of the machine. The client replaces everything and drops Swarms not listed.
  `removedTabIds` is empty.
- **The CLI must ask for `full=1`** on start and **at least every 60 s**. Grants and billing live in the `Machine`
  and `MachineShare` collections, which are not parts (`store.ts:286-300`), so a revoked share changes no part.
  Section 8 Q2 covers the bound. Commands, claims and deliveries still check grants on every call, so the delay
  affects only the roster.
- The cursor epoch is unused here (`e: 0`).
- The 100-Swarm cap (`store.ts:89`) is replaced by a 500 cap on full reads. Incremental reads are bounded by what
  changed.

### 4.11 `UPDATE_REQUIRED` on old routes

These routes answer **HTTP 426** with
`{ "error": { "code": "UPDATE_REQUIRED", "message": "Update Harness to keep using this Swarm." } }`:

- `GET /api/super-tabs`
- `GET /api/super-tabs/:tabId`
- `GET /api/super-tabs/hosts/:machineId`
- `GET /api/super-tabs/hosts/:machineId/pools`
- `GET /api/super-tabs/hosts/:machineId/assignments`

Every other route keeps working for any client. Every old client reads one of the 426 routes before or right after
any action: the CLI reads full state for every action (`cli/src/superTabs/service.ts:294-296`), the old host reads
`/hosts/:m` every second (`host.ts:502`), and Desktop reads full state after every command (`controller.dart:1089-1093`).
So an old client meets the error at once.
- The daemon passes the status and code through (`cli/src/superTabs/host.ts:24-38`, `service.ts:406-408`).
- Old Desktop shows the message in its error banner (`desktop/lib/super_tabs/view.dart:1296-1306`).
- Old CLI prints it as JSON with exit 1.
- An old daemon's host loop only logs it (`host.ts:329-331`). The person sees the error on their Desktop of the same
  version.

Until a Swarm is migrated (6.1), its new routes answer 503 `SWARM_MIGRATING`, which every client retries.

## 5. Client contract

### 5.1 Shared rules for every client

- **Parts store.** Keep a map `(kind, key) → envelope`, plus `derived`, `cursor`, `epoch` and `lastChangedAt`.
  - Merge rule (4.4): a higher `version` wins, a tombstone deletes, and a dormant stub moves the group to the
    dormant cache.
  - On `reload: true`, a 404 or a 403, drop the store and do a first load. A 403 or 404 on first load revokes the
    tab, as today.
- **Reassemble a state.** Build the old `SuperTabState` shape from the store so existing screens and code keep
  working: head `data`, plus `people` (member `data`), `agents` (with `derived.agents` overlaid), `conversations`
  (active groups), `machines` (with `derived.machines` overlaid), `starts`, `progress` (on each project), and
  `otherProjectsWork`/`mentionsWaiting` from `derived`.
  - Both clients get a reassembler; each group writes its own (Dart, TypeScript). The backend's reassembler (6.2)
    is the reference.
- **Order.** Parts come back in `ordinal` order on first load. Clients keep insertion order for new keys. Lists
  sort as today (conversations by number, messages by sequence).
- **Sequences.** `lastMessageSequence` and message `sequence` are compared **within one group** only, as both
  clients already do. Stored read marks keyed by conversation stay valid: sequences continue from `R`.
- **426 / `UPDATE_REQUIRED`.** Show "Update Harness to keep using this Swarm." and stop polling that Swarm (no retry
  loop). The CLI prints it and exits 1. The host logs it once and backs off 60 s.
- **503 `SWARM_BUSY` / `SWARM_MIGRATING`.** Retry with backoff, as for any 5xx.

### 5.2 Desktop and web (`desktop/lib/super_tabs`)

Today: a full `GET /:tabId` every 3 s per open Swarm (`controller.dart:52`, `414-416`). Web adapts the interval
(`web/shell/web_chrome.dart:51-58`, `controller.dart:429-442`). Changes are found by revision or deep compare
(`controller.dart:704-716`).

| Area | Change |
|---|---|
| `client.dart` | New calls: `parts`, `changes`, `groups?dormant=1`, `groups/:id`, `list`. Remove the full-state `GET /:tabId` and `GET /api/super-tabs`. |
| `controller.dart` refresh | First load once, then `changes` on the same timers (3 s desktop; the web's adaptive 15 s/light-read schedule stays). Drop the revision acceptance rule (`:716`) and the deep compare (`:704-710`): the snapshot changes exactly when a part or `derived` changes. Keep the cleanup for conversations no longer listed (`:718-747`), driven by tombstones, dormant stubs and reloads. |
| `model.dart` | `SuperTabSnapshot` is built by the reassembler. Replace the `version != 1` check (`:194-196`) with `format == 2`. Parse `progress` if needed (not used today). |
| After a command (`controller.dart:1089-1093`) | Call `changes` once. Drop the second refresh keyed by `revision`; the reply's `parts` versions may be used to skip a redundant fetch. |
| Saved web view (`saved_view.dart:21-36`, `controller.dart:457-478`) | Store `{cursor, parts, derived, …}` keyed by `lastChangedAt` in place of `{revision, state}`. A saved cursor older than 7 days, or with another epoch, reloads. |
| `onSnapshot` (`client.dart:433-436`), mentions reload (`notifications.dart:90-104`) | Fire on `lastChangedAt` or `mentionsWaiting` change in place of `revision`. |
| Swarm list (`client.dart:311-331`, `tab_invites_section.dart:56-63`) | `GET /api/super-tabs/list`; it reads `id`, `name` (and may use `lastChangedAt`). |
| Work details and archived groups (`work_details.dart`, `view.dart:646-690`, `project_sidebar.dart:288-295`) | The active list comes from active groups. Archived and auto-dormant groups load on demand from `groups?dormant=1` when the person opens the archived or earlier list, and one group by id when a link or mention names it. Selecting one pages its messages through the unchanged route (`controller.dart:625-643`). |
| Unread, scroll, read marks (`controller.dart:393-401`, `647-657`, `view.dart:188-193`) | No change: per-group sequence. |
| Message paging (`controller.dart:839-851`, `918-934`) | Older history sends `before` and `beforeId` from the response's `next` object (4.6). Polling for new messages keeps `after=<last sequence>`. Merge by id and sort by `(sequence, id)`. |
| Errors (`controller.dart:864-878`, `1096-1113`) | Map 426 to the update message (5.1). A first-load 426 shows the full-page error on web (`view.dart:1188-1210`). |
| Private conversations | No UI in this project. The client must not assume every member sees every group of a project. It renders what it receives and reloads on an epoch change. |

**Stops fetching:** the whole Swarm every 3 s (now only parts changed since the cursor), every archived group's
record, and the whole list on every poll.

### 5.3 CLI (`cli/src/superTabs`)

- **Per-tab parts cache in the daemon.** A cache keyed by `(tabId, asAgentId)`, refreshed with `changes`, used by
  every action that needs Swarm data. The daemon is long-lived (`service.ts` handles `super_tabs`), so one-shot
  `harness super-tab` calls cost one `changes` poll instead of a full read.

**What each part of the CLI uses:**

| Part of the CLI | Today | New |
|---|---|---|
| Host tick (`host.ts:280`, `:502`) | `GET /hosts/:m` every 1 s | `GET /hosts/:m/changes?cursor=` every 1 s; `full=1` at start and every 60 s (4.10). Keep the rows per Swarm and replace a Swarm's rows when it is returned. |
| Pools (`machines.ts:151`, 5 s) | `GET /hosts/:m/pools` | `tabs[].pool` from the same host form. |
| Assignments (`host.ts:343`, 5 s; `github.ts:123`, 60 s) | `GET /hosts/:m/assignments` | `tabs[].assignments` from the host form. |
| `mayRead` (`host.ts:874-876`) | full read per tab:agent | roster `lead` and `leadsConversationId`. |
| `releaseWorker`, `tellSkill`, `swarmRoleFor` (`host.ts:371-410`, `735-738`, `61-71`) | full read | parts cache with `asAgentId` (rare events). |
| Deliveries (`host.ts:577-589`, `936`, `924-930`, `1011-1012`, `477-495`) | per agent per tick | unchanged routes and bodies. Claims no longer bump the Swarm (3.5). |
| Native recorder (`native.ts:139-146`, `290-294`) | reads `result.eventId` | unchanged; the reply's `revision` becomes `sequence` and is not read. |
| `observeMachine` (`machines.ts:236-273`) | `POST /:tab/machines/:m` | unchanged body; the reply is `{ version }`. |
| Pro cards (`cards.ts:141-213`, `285`, `296-301`) | list plus full read when `revision` moves | `list` plus the parts cache when `lastChangedAt` moves. Recap reads use the per-group `lastMessageSequence` (`cards.ts:272-339`), with no logic change. |
| `sharedSwarm` (`service.ts:134-145`), contribution (`contribution.ts:24`), machine cleanup (`machines.ts:369`) | full read | parts cache (only `members`, `machines` and `agents` needed). |
| `harness super-tab` actions (`service.ts:294-302`) | full read before every action | parts cache. `messages`, `message`, `screen`, `type`, `remove-machine` and `start`/`resume` status polling stop fetching Swarm state at all. `post`/`command` read the cache only for `--mention` (members). `help` reads it only for `isLead`. |
| `route` (`routeCommand.ts`, `service.ts:314-330`) | full read twice | the parts cache once. Machines carry `availableSlots` and `teamWork` from `derived`, and agents carry `limitedUntil`; the fields it reads are unchanged (`routeCommand.ts:116-177`, `252-297`, `339-366`). |
| `project.report` help example (`service.ts:38`) | `throughRevision` | `through` map (3.6). |
| Message paging (`service.ts:360-362`; `cards.ts:101-102`, `299-301`) | `after=`/`before=` a sequence | `message` keeps `after=<sequence>` (new messages). Card recaps page back with `before` and `beforeId` from `next` (4.6). |

**`harness super-tab status` keeps its output.**
- It prints `{"ok":true,"value":{…}}` (`command.ts:152`), where `value.state` is built by `statusView`
  (`service.ts:77-85`) from the reassembled state. The keys, shapes and the Lead/non-Lead filtering are unchanged.
- Two differences:
  - `value.revision` is replaced by `value.lastChangedAt` (section 8, Q5);
  - `state.conversations` lists only active groups, because dormant ones leave the active set (the spec's archive).
- Each active group still carries `lastMessageSequence`, now per group, and the wake-up text names groups with
  their sequence (3.6).

**Stops fetching:**
- the full state before every agent action;
- the three per-machine rosters, each loading up to 100 full Swarms, every 1–5 s;
- the full state when a card's revision moves.

## 6. Migration

### 6.1 Algorithm (one transaction per Swarm, idempotent)

The migration runs as a one-off job of the new image (`node dist/migrate.js`, group 3) inside a maintenance window
in which **no old backend process is running** (6.1.1). A Swarm whose `SuperTab.format` is still 1 answers 503
`SWARM_MIGRATING` on the new routes (4.11); the new backend also migrates such a row on first access with the same
code, as a safety net for a row the job did not see.

#### 6.1.1 Deploy sequence and the gate on old writers

A guarded bump of `revision` alone does not fence old processes. An old process that reads the row after the
migration sees `R+1`, and its own guarded write (`store.ts:519-521`, `767-769`; `observeMachine` `1273`, `1308`)
succeeds. So old writers are stopped first, and the data is fenced as well. This matches the owner's decision that
every client moves at once (spec, owner decisions).

1. **Prepare.** The release's backend image, CLI and Desktop builds are ready and the local dry run (6.5) passed. Do
   not publish the CLI or Desktop yet: they need the new routes.
2. **Gate: stop every old writer.**
   - Kubernetes: scale the old API Deployment and the old job Deployment to 0 replicas. Suspend ArgoCD sync for
     them so they are not scaled back up, and serve 503 from the ingress during the window.
   - Docker/pm2 installs: `pm2 stop all`.
   - Clients retry 5xx. Hosts log and retry, and Desktop shows its reconnecting state (`controller.dart:773-776`).
3. **Verify no old writer remains.**
   - The orchestrator shows 0 running pods of the old image for both Deployments.
   - The job's preflight reads `max(SuperTab.updatedAt)`, `max(SuperTabMessage.createdAt)` and
     `max(SuperTabDelivery.updatedAt)`, waits 60 s, and reads them again. Any change aborts with "a writer is still
     running".
   - While any host is online, a live old API process writes within 15 s: hosts observe every 5–15 s
     (`cli/src/superTabs/machines.ts:34`, `37`, `140-146`) and claim deliveries every second.
4. **Migrate** every `format = 1` row (6.1.2). The job's report must say `ok` for every Swarm. If any
   Swarm fails, fix and rerun, or roll back (6.4); no new write has happened yet.
5. **Deploy the new backend** (API and job), then lift the gate.
6. **Publish the CLI and Desktop.** Old clients get 426 from now on (4.11).

**Data fence (backstop).**
- Step 6 of the migration moves the old state to `legacyState` and leaves `state = { "version": 2 }`.
- Every old code path reads `state` through `stateOf` before it writes, and `stateOf` refuses any `version ≠ 1`
  with `UPDATE_REQUIRED` (`store.ts:39-45`). The paths:
  - commands (`store.ts:520`), observations (`1273`), native recording (`158`, then `native.ts:85`, `111`);
  - claims, acks and holds (`1497`), the deliveries wake-up (`1437`), stopped receipts (`1564`);
  - sharing (`381`), join (`416`), the read backfill (`449`), and terminal relays (`1030`, `1068`).
- So an old process that somehow survives the gate fails before writing.
- The only old write that skips `stateOf` is `create` (`store.ts:330-345`), which inserts a new `format = 1` row;
  the new backend migrates it on first access.
- The spec's "old `state` kept read-only" holds: the old state is kept unchanged in `legacyState` until the owner
  says it can go (Ruling R14).

#### 6.1.2 Per-Swarm steps

For each `SuperTab` row with `format = 1`, in one transaction (`transaction()` with a 60 s timeout for this job only):

1. Read the row at revision `R` and `state = stateOf(row)` (`store.ts:39-45`).
2. **Normalize**, applying exactly what the next read or command would do, so behavior is identical:
   - `parkLaterConversations`, `syncLeads`, `numberConversations`, `placeRules`, `assignAgentDisplayNames`
     (persist every name);
   - `restorePullRequestUrls` (`store.ts:49-68`; reads messages and attempts);
   - fill `agent.projectId` with `agentProjectId(state, agent)` when `state.projects` exists and the field is
     absent (`projects.ts:77-80`);
   - persist `workDecision: 'awaiting'` for the workers `awaitingWorkers` derives it for (`model.ts:261-269`);
   - group numbers in legacy append order.
   - Not applied: `expireRemovals` (time-based; the first observation or command applies it) and the
     `releasedHarnesses` cap (applied on the next write of that `Mc`).
3. **Split** into parts with `version = R` and `changedAt = now`. `ordinal` is the index in the source array.
   - **Head:** `data` = the head fields (2.2); `groupCounter = nextConversationNumber(state) − 1`;
     `visibilityEpoch = 1`; `sequenceBase = R`.
   - **Members:** one per `people[]`.
   - **Groups:** one per `conversations[]` and `parkedConversations[]`:
     - `messageSeq = R`;
     - `reportSeq = min(lastMessageSequence, P.dirtyRevision ?? 0)` for a non-Lead project group, else 0;
     - `lastActivityAt` = its newest message's `createdAt`, from one aggregate over `SuperTabMessage` for the tab;
     - `dormant` = archived, or (assignment `done`/`cancelled` and `lastActivityAt` older than 24 h, and not a
       Lead conversation or the Leads conversation).
   - **Agents**, **starts:** one each. Starts get `finishedAt` when finished; the time is unknown, so use migration
     time.
   - **Machines:** one per machine id found in `machines`, `harnessReservations`, `releasedHarnesses`,
     `closingSessions` and `machineCleanups`, holding those records.
   - **Progress:** one per stored project with `progress`, converted as follows:
     - `since`, `requestedAt`, `requestMessageId` copied;
     - `summarizedFloor = summarizedRevision`, `summarized = {}`;
     - `requestedFloor = requestedRevision`, `requested = {}`.
4. **Keep every sequence** (spec ruling 7). Messages are not touched. Every stored reference stays valid unchanged:
   `lastMessageSequence`, `recordingProgress.revision`, `checkpoint.sequence` in message sources, the progress
   floors, and `throughRevision` values in old wake-up texts. All are tab revisions ≤ `R`, and every group continues
   numbering after `R`.
5. **Verify** (6.3). On any difference, throw: the transaction aborts, nothing is written, and the Swarm stays at
   `format 1` (503 `SWARM_MIGRATING`) with the difference logged.
6. **Insert** the parts (`createMany` per model). Update the row:
   `{ format: 2, revision: R + 1, migratedAt: now, legacyState: <the old state, unchanged>, state: { version: 2 } }`,
   guarded by `where: { id, revision: R }`.

**Freeze.**
- Old writes are frozen for the whole migration by the gate (6.1.1, steps 2–3), and afterwards by the data fence.
- The guarded update in step 6 only protects against the new backend's own lazy migration racing the job.

**Idempotent.** A Swarm with `format = 2` is skipped. A failed Swarm wrote nothing and is retried on the next start
or by the dry-run tool.

### 6.2 Reassembly (the reference for verification and rollback)

`reassemble(parts) → SuperTabState`, owned by group 2 (`backend/src/superTabs/parts/shape.ts`):
- head `data`;
- `people` from members, sorted by `ordinal`;
- `agents`, `conversations` (with `messageSeq`, `reportSeq`, `dormant` and `lastActivityAt` removed) and `starts`,
  each sorted by `ordinal`; `parkedConversations` are the groups of unknown `kind`;
- `machines`, `harnessReservations`, `releasedHarnesses`, `closingSessions` and `machineCleanups` from the machine
  parts;
- `projects[].progress` rebuilt from progress plus groups: `dirtyRevision = max(reportSeq)` over the project's
  non-Lead groups; `summarizedRevision = summarizedFloor` while `summarized` is empty; `requestedRevision`
  likewise.

The same function serves commands (3.1), the CLI's `status` (5.3), verification and rollback.

### 6.3 Verification (every Swarm, inside its migration transaction)

- **State:** `canonical(reassemble(parts))` deep-equals `canonical(normalize(old state))`, field by field.
  `canonical` sorts these arrays, which carry no order: `harnessReservations`, `releasedHarnesses`,
  `closingSessions`, `machineCleanups`, `overlapAlerts`. Every other array keeps its order. The first differing path
  is logged.
- **Messages:** before and after, `count` and `sha256` of the ordered list of `(conversationId, sequence, id)` for
  the tab match. Because messages are not written, this proves the migration did not touch them. A message in a
  conversation still present after normalization must have a group part. Historical messages of conversations
  already deleted in the old state remain unchanged and inaccessible; migration must not create a new orphan.
- **Counts unchanged:** deliveries, route decisions, attempts and operations for the tab.
- **Reports:** a per-Swarm line `{tabId, bytes, groups, dormant, parts, ms, ok}` and a total, written to the worker
  log and to `artifacts/swarm-parts-migration-<date>.json` by the dry-run tool.

### 6.4 Rollback

- Every rollback runs behind the same gate (6.1.1, steps 2–3), with the new backend stopped and verified quiet.
- **Before any new write** (failure at step 4 or 5): run `scripts/swarm-parts/rollback --legacy`. For every
  `format = 2` row it sets `state = legacyState`, `format = 1`, and leaves `revision = R+1`. Then redeploy the
  previous backend; it reads the old state and works. Drop the part collections.
- **After new writes:** run `scripts/swarm-parts/rollback` (group 3). For each `format = 2` Swarm, it does
  `state = reassemble(parts)`, checks it with the old `stateOf`, and writes
  `{ state, revision: max(R+1, highest message sequence, highest part version) + 1, format: 1 }`. Then redeploy the
  previous backend and lift the gate.
  - Old code numbers new messages from that revision. Old code also numbers per tab: it gives every new message, in
    any group, `row.revision + 1`. Starting `revision` above every sequence written in parts mode keeps each group
    strictly increasing.
  - **Refused for a Swarm the previous backend would misread** (final review, Critical 2; Lead ruling for v1). The
    previous backend checks no audience: it filters conversations and messages by project alone. It also ends work
    only on done, stopped or cancelled. So `rollbackFromParts` refuses, before changing any row, a Swarm with:
    - any private conversation, which would become readable by every project reader;
    - any task with status `lost`, which would read as active;
    - any task cancelled after it was lost (it keeps `assignment.lost`). The previous backend reads it as finished, but
      ignores the marker, so the fenced worker would read as an ordinary finished worker awaiting a decision.
  - The refusal names the Swarm and the reason. The Swarm stays in parts. Recovery is to roll forward with a fix: the
    parts stay authoritative, so nothing is lost or made public.
  - A reassigned task whose `lostAttempt` names an earlier worker is not refused. The current assignment is the new
    worker's, and the previous backend accepts status only for the current assignment id and its agent.
- Part collections are dropped only after the owner says so. The old `state` field is likewise kept until the owner
  says it can go (spec).

### 6.5 Local dry run (no production data; spec PM ruling)

- **Stack:** a local isolated stack (spec "Constraints all groups share"): a MongoDB replica set on localhost with
  its own data directory and port (or MongoMemoryReplSet), and no remote URLs.
- **Seed:** `backend/scripts/swarm-parts/seed.ts` builds synthetic Swarms by running real commands through
  `applyCommand` and the store on the **old** code path, so states have production shape:
  - one Swarm of about 1.16 MB with 195 groups (≈ 20 agents, 6 machines, 3 projects, mixed done, cancelled,
    archived, reconciling and active groups, starts in every state, rules, invitations, a legacy group without
    `pullRequestUrls`, a parked unknown-kind group), with about 40 000 messages;
  - one of about 422 KB with 50 groups;
  - ten small ones;
  - one legacy Swarm without `projects`.
- **Run:**
  1. migrate;
  2. verify;
  3. migrate again, with no change expected;
  4. run the new backend's integration suites against the migrated data;
  5. post commands through the new store, then write a private chat into one Swarm and a lost task into another;
  6. roll back: those two are refused with their rows unchanged (6.4), the rest roll back;
  7. read every rolled-back Swarm with this branch's `visibleState`. This checks the old shape still reads. It does
     not run the previous backend's binary or its access checks, so it is not evidence that the previous backend reads
     the state safely; the refusal in 6.4 keeps out what it would misread.
  Time each step. Group 6 repeats it on the integrated branch.

## 7. Group split for 2–5

### 7.1 Owned paths (no overlaps)

| Group | Owns |
|---|---|
| **2 Backend storage and commands** | `backend/prisma/schema.prisma` (part models, `SuperTab.format/migratedAt/legacyState`, `SuperTabOperation.parts`, the message index); `backend/src/superTabs/parts/**` (new: models, `loadActive`, `reassemble`, `split`, `diffParts`, `guardedWrite`, `clock`, `touchesFor`); `store.ts`, `commands.ts`, `model.ts`, `projects.ts` (incl. `canReadGroup`), `machines.ts`, `native.ts`, `projectUpdates.ts`, `mentions.ts`, `terminal.ts`, `sessionScope.ts`, `agentNames.ts`, `holdNotice.ts`, `routeDecisions.ts`; sweeps in `backend/src/worker.ts` and `backend/src/superTabs/sweeps.ts` (new); `backend/src/superTabs/*.test.ts`; `backend/integration/superTabs.test.ts`, `superTabSharing.test.ts`, `superTabTeam.test.ts`, `superTabGithub.test.ts` (adapted, never weakened) |
| **3 Backend read API and migration** | `backend/src/routes/superTabs.ts`; `backend/src/superTabs/read/**` (new: `parts`, `changes`, `groups`, `list`, host form, per-part visible views, `derived`, cursor codec, `lastChangedAt`); `backend/src/superTabs/migration/**` (new); `backend/scripts/swarm-parts/**` (seed, dry run, rollback); `backend/integration/superTabRead.test.ts`, `backend/integration/superTabMigration.test.ts` (new) |
| **4 Desktop and web** | `desktop/lib/super_tabs/**`; `desktop/lib/settings/sections/tab_invites_section.dart`; the Swarm list calls in `desktop/lib/state/app_state.dart` (`:1723-1771` only); `desktop/test/super_tab*`, `desktop/test/support/super_tab_fixture.dart`, `desktop/tool/super_tab_mobile_fixture.dart` |
| **5 CLI** | `cli/src/superTabs/**` (host, machines, cards, service, command, start, routeCommand, contribution, github, native, attach, swarmGrids) and their specs; Lead-facing texts that name `throughRevision` or `lastMessageSequence` outside the backend (`cli/src/superTabs/service.ts`) |

`docs/` changes for user-facing behavior go with the group that changes it.

### 7.2 Interfaces between groups

**Group 2 → group 3** (TypeScript, in `backend/src/superTabs/parts/index.ts`; group 3 codes against it as soon as
this doc is accepted, with a stub until group 2 lands):

```ts
export type PartKind = 'head' | 'member' | 'agent' | 'group' | 'machine' | 'start' | 'progress'
export interface Part<T = unknown> { kind: PartKind; key: string; version: number; changedAt: number;
  deleted?: true; dormant?: true; ordinal: number; data: T | null }
export interface SwarmParts { head: Part<HeadData>; members: Part<Person>[]; agents: Part<Agent>[]; groups: Part<GroupData>[];
  machines: Part<MachineData>[]; starts: Part<AgentStart>[]; progress: Part<ProgressData>[]; sequenceBase: number; epoch: number }
export function loadActive(tx: Transaction, tabId: string, opts?: { groupIds?: string[]; agentIds?: string[] }): Promise<SwarmParts>
export function loadChanged(tx: Transaction, tabIds: string[], since: Date, kinds?: PartKind[]): Promise<Map<string, Part[]>>
export function loadDormant(tx: Transaction, tabId: string, page: { projectId?: string; before?: { lastActivityAt: number; key: string } }): Promise<Part<GroupData>[]>
export function reassemble(parts: SwarmParts): SuperTabState          // 6.2
export function split(state: SuperTabState, opts: { version: number; now: number; lastActivity: Map<string, number> }): SwarmParts
export function lastChangedAt(tx: Transaction, tabIds: string[]): Promise<Map<string, number>>  // 3.7
export function canReadGroup(state: SuperTabState, actor: Actor, group: Conversation): boolean    // 4.8, in projects.ts
export const clock: { next(): number }                                // 3.3
```

- Group 2 keeps `visibleState` (`model.ts:392`) correct for the reassembled state. Group 3 builds per-part views
  from the same rules and must not change them.
- Group 3 consumes the store's existing `read()` helpers for `derived` (`machineSlots`, `teamWorkRefusal`,
  `downSince`, `awaitingWorkers`, `otherProjectsWork`, `mentionsWaiting`). Group 2 exports `otherProjectsWork`,
  which is private today (`model.ts:323`).

**Group 3 → groups 4 and 5:** the HTTP contracts in section 4, exactly. Group 3 adds
`backend/src/superTabs/read/contract.ts` with the response types, as the single source of truth that groups 4 and 5
mirror by hand. Any change to it after acceptance is announced to the Lead before it merges.

**Group 2 → group 5:** the `project.report` schema (`through`, 3.6) and the wake-up text.

**Merge order:** 2, then 3 (spec), then 4 and 5. Groups 4 and 5 develop against a local backend running 2+3, or
against recorded fixtures of the section 4 examples.

## 8. Open questions and findings, ranked

Each item has a recommended answer.

**Lead's rulings (2026-10-26):**
- Q1, Q2, Q4, Q5, Q7: accepted as recommended.
- Q3: (b)–(g) accepted. (a): the owner (Ken) decided owners do **not** see private channels; the single constant in
  4.8 is `false`.
- Q6: accepted as independent of N. The replica count and NTP are being confirmed with the owner; this does not
  block anything.
- R1–R10: no objection.

The items as raised:

**Q1. Auto-archive must not use `archived` (spec ruling 5 against the code).**
- Spec ruling 5 says archive uses the existing `Conversation.archived` field, and that a new message brings the
  group back. In the code, `archived` is a hard state:
  - posts and work in it are refused (`commands.ts:371-375` `ARCHIVED`);
  - its native terminal contexts are revoked and their deliveries cancelled (`native.ts:243`, `259-261`);
  - deliveries to it are withheld (`store.ts:1413`);
  - the host releases agents that are only in archived groups to automatic cleanup (`store.ts:1339-1340`).
- Setting it automatically after 24 h would close terminals, withhold deliveries and let hosts clean up idle
  finished workers. Making a post reopen it would break the "Reopen this conversation" rule and its tests.
- **Recommendation (designed in):** a separate `dormant` flag (Ruling R3). It is set by the 24 h sweep or by a
  manual archive, and cleared by any message or new work. Only the feed and first load read it. `archived` keeps
  today's meaning.

**Q2. Host roster delay after a share or billing change (Ruling R7).**
- `Machine` and `MachineShare` are outside the parts, so the incremental host form cannot see a revoked share.
- **Recommendation:** a full host read every 60 s (4.10). Commands, deliveries and claims recheck grants on every
  call (`store.ts:286-300`, `1427-1432`), so only the roster lags.
- **Alternative:** 15 s full reads, which cost 4× more.

**Q3. Private conversation rules not fixed by the addendum (4.8).**
- **Recommendations:**
  - (a) Only the listed people and the Lead see it; the project owner and Swarm owner do not.
  - (b) A person creates one only with themselves in it; the Lead may create one for any project reader.
  - (c) Only the Lead or a listed person changes the audience.
  - (d) Chat only, Lead the only agent.
  - (e) An audience is fixed once set: never removed, never added to an existing public group.
  - (f) Its posts do not feed project reports.
  - (g) Attachment URLs stay unguessable public URLs, as in private projects. Signed URLs are a separate change if
    wanted.
- The PM channel UI builds on (a)–(f).

**Q4. Swarm-wide limits serialize on the head.** Pending starts ≤ 32 (`commands.ts:1034`), machines ≤ 32, projects
≤ 100 and rules ≤ 50 are guarded by touching or writing `H`. So two `agent.start` calls in one Swarm conflict and
one retries. **Recommendation:** accept. Starts are rare, and the limit stays exact.

**Q5. `status` drops `revision`.** No tab revision exists after migration. **Recommendation:** replace it with
`lastChangedAt`. The CLI reads no `revision` from `status`, only from the list (`cards.ts:113-116`, `209`). The
skill texts reference `throughRevision` only through the wake-up text, which changes with 3.6.

**Q6. Backend processes and clock (spec ruling 3).**
- Several processes write: k8s pods with one process each, and pm2 `max` in Docker. The count is outside this repo.
- **Recommendation:** keep the design independent of N (section 3.3). The owner confirms the replica count, and that
  nodes run NTP, so drift stays far below the 15 s budget.

**Q7. Legacy `throughRevision`.**
- **Recommendation:** accept it only when it is ≤ `sequenceBase`, meaning a wake-up from before the migration that a
  Lead answers after it (3.6).
- After the migration a scalar cannot be safe, because groups number independently. A scalar would mark unread
  posts in a slower group as summarized.

**Findings where the spec's shape needed a change (Rulings, no decision needed unless you disagree):**

- **R1 Machine parts exist for every referenced machine, not only contributed ones.**
  - `reserveHarnessSlot` and `releaseHarness` write reservations and stop receipts for any machine an agent runs
    on, contributed or not (`commands.ts:315-324`, `1574-1584`; `store.ts:1297-1307`).
  - "One document per contributed machine" (spec table) would leave those without a home.
  - *Cost if wrong:* none; a machine part with `contribution: null` is never sent to clients.
- **R2 People live only in member parts.** Spec ruling 2 gives every person a part; keeping a second copy on the
  head would make every membership change write two places. *Cost if wrong:* none.
- **R3 `dormant` separate from `archived`:** Q1.
- **R4 Every message gets its own sequence, and pages use `(sequence, id)`** (4.6).
  - Today all messages of one command share the tab revision (`store.ts:1110`).
  - The page cursor `next = last row's sequence` with `sequence > after` (`store.ts:1135`, `1145`) can skip rows
    that share a sequence at a page edge.
  - New messages are numbered one by one; old ties are kept.
- **R5 `P(p)` is also the worker-decision fence** (3.6). Without it, `requireWorkerDecisions` acts on a stale read
  across groups.
- **R6 `lastChangedAt` is computed when read** (3.7).
- **R7 Host form full refresh:** Q2.
- **R8 `read()` never writes.** The migration does the `pullRequestUrls` backfill (`store.ts:451-456`).
- **R9 Part versions start at `R`.** Agent versions then keep `SuperTabConfiguration.revision` ordered after old
  rows.
- **R10 Group-level changes bump delivery rows** (D10). This is what makes ruling 9's claim touches enough. Without
  it, a claim could deliver into a group archived a moment earlier, which today's Swarm-wide bump prevents
  (`store.ts:1513-1514`).
- **R11 `project.report` takes a `through` map** (3.6, Q7).
- **R12 `reportSeq` is separate from `lastMessageSequence`.**
  - Hold and stop notices bump `lastMessageSequence` but never marked a project dirty (`store.ts:1538`, `1597`;
    neither calls `noteProjectReports`).
  - Computing dirtiness from `lastMessageSequence` would change that.
- **R13 Finished starts leave first load and command state, but stay loadable by key for 7 days** (spec archive,
  review round 1).
  - `work.assign` and an agent's own removal load the finished start they match (3.1).
  - After the 7-day expiry, a decision that still names that start falls back to the member-candidate match.
  - *Cost if wrong:* an assignment more than 7 days after a routed start needs an override reason.
- **R14 The old state moves to `legacyState`; `state` becomes `{ "version": 2 }`** (6.1.1, review round 1).
  - Old code refuses that state in `stateOf` before every write (`store.ts:39-45`), so a surviving old process
    cannot write.
  - The old state is kept unchanged and read-only until the owner says it can go, which is the spec's intent.
  - *Cost if wrong:* a reader of the raw `state` field outside the backend would see the stub. None exists in this
    repository.
- **R15 Host reads need what a write changed, not only its new data** (group 3 review round 1; Lead's ruling).
  - 4.10 woke a host for a group whose new `agentIds` include one of its agents. An agent removed from its last group
    then never woke its host, which kept it `active` (and out of automatic cleanup) until the 60 s full read.
  - Each group write therefore records the machines its agents and its work were on, before and after
    (`SwarmGroup.hostMachineIds`, set by `parts/commit.ts`), and the host form wakes on that.
  - That list is the last write's only, so a later write to the group (a rename, a post) would replace it before the
    host reads. An agent a group's write lets go (out of its members and its work) is therefore also written again, its
    data unchanged, and its host wakes on that agent's change, whatever the group's later writes say (review round 2).
- **R16 A machine's own reading wakes no host** (group 5's end-to-end run; Lead's ruling).
  - Machines report every 15 s. With the 30 s overlap every host tick resent its Swarm in full.
  - A host's rows carry only its own reading, which it sent. So the host form wakes on `SwarmMachine.hostChangedAt`,
    which `parts/commit.ts` moves only when a machine part's settings or ledger change, never when only its reading
    does. Desktop and web feeds still get readings by `changedAt`.
