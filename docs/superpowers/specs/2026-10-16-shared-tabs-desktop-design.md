# Shared tabs on the desktop (step 1c)

October 16, 2026. Design approved in conversation with the owner; built (the rulings below settle what the design left open). The desktop and web half of
[Agent Messages across accounts](2026-10-15-agent-messages-across-accounts-design.md) (the "base spec"). Steps 1a and
1b built the daemon and backend side; this step puts it in front of a person.

## Why

Everything a shared tab does today happens through `agent_messages` actions on a daemon's local socket: invite, accept,
add and remove harnesses, leader, stop, retrust, move, the Tasks search. There is no command for a person and no
screen. Without 1c nobody can share a tab, and the trust work of 1b ("detect, not block": alerts, retrust, move) is
invisible.

Success: on the desktop or the web, a person invites someone by email, the invitee accepts and adds harnesses, both
see each other's harnesses in the tab (view only), watch the messages, people and tasks of the tab, and recover from
the trust situations 1b detects, without a terminal.

## Scope

The owner chose "minimum plus trust" (2026-10-16):

- In: invite, accept, add and remove harnesses, leader, remove member, leave, stop sharing; the shared tab's mark;
  pane chips; People and Tasks beside Messages; alerts shown where people are listed; **Trust again**; **Move here**;
  the five desktop seams step 0 found; the switch's copy.
- Out: a per-harness consent view ("which of my harnesses are watched in which tab"), "also visible to tab X" in the
  Share dialog, a notice center, the phone.

Desktop and web share the Flutter code; the web is mouse-first, so everything in a native menu or a chord is also
clickable. The one native-only part is the macOS tab row (`SwarmTitlebar.swift`).

## Daemon additions (built first)

Small changes to the 1b daemon so the windows can follow it:

1. **`shared_tabs_changed`**, a frame to this computer's windows, like `messages_changed`: sent when a held roster, a
   pending invitation, an alert, a notice or the untrusted list changes. No payload beyond a revision; windows read
   `shares` again.
2. **Notices are kept on disk** (beside the other shared-tab state, 0600, written like the others) with an `id` and a
   read flag, bounded (oldest dropped beyond 100), and a new action **`share_notice_dismiss`** `{ id }`. Today they live
   in memory and vanish on restart. `shares` returns unread notices; alerts keep their existing store, gain an `id` and a dismissed
   flag, and are dismissed through the same action; `shares` returns the undismissed ones.
3. **`DAEMON_TOO_OLD`**: a daemon whose core predates the shared-tab queries answers it (today it shares
   `ACCOUNT_UNAVAILABLE` with a transient failure). The desktop also treats `UNKNOWN_ACTION` for a `share_*` action as
   `DAEMON_TOO_OLD`.

4. **The tab's working state.** The daemon reads its own listed harnesses' working state from the core (`activity`) on
   its 5 s tick and sends changes, plus a renewal every 20 s while working, to the tab's machines of other accounts
   (sealed like every tab request). The receiving daemon tells its windows (`shared_activity`). The core answers the
   same `activity` for this account's own panes.
5. **`share_who`** asks each machine of the tab the existing `who` (project, branch) with a 4 s deadline; a machine
   that does not answer shows its harnesses without them.
6. **`shares` carries more.** `api: 2` (the capability marker; an answer without `me`, from a 1b daemon, which never
   shipped, reads as unavailable), `me` (this account), `tabId` per roster the account owns (null for a member's), and
   `pendingInvites` per owned roster (the invitation ids, for Revoke). A `removed` or `relay_taken` notice carries the
   owner's email, so it reads right after the tab is gone and after a restart. An invitation carries `tabName` (from
   the backend; unverified, shown only before Accept; an older backend gives none and the copy says "a tab").

Each with a test; `test:shared-tabs` and `test:core` stay at 100%; `sharedTabs.e2e.ts` gains one step: a window
connected to the daemon receives `shared_tabs_changed` after an invitation arrives.

## Rulings made while building

These settle what the design left open.

- **A member's desk tab id is derived from the `sharedTabId`**: the first 32 hex characters of
  sha256('harness-member-tab' + sharedTabId). Desk `tab.create` takes the client's id, so every computer of the member
  names the tab the same with nothing stored. It is a desk id in shape (32 lowercase hex), which is why it is derived
  rather than the raw 24-hex `sharedTabId`: a released desktop gives any other id a fresh desk id at launch and seeds it
  back, so a member's second computer on an older build added a duplicate of the tab to the desk at every launch. The
  daemon files a member's tab under the `sharedTabId`, so the desktop maps between the two: Show Agent Messages reads
  the `sharedTabId` log (messages across accounts) and the desk tab's (between the member's own harnesses), and
  `messages_changed` for a `sharedTabId` counts in the derived desk tab. The owner's desk tab is the tab it shared.
- **The owner's own harnesses follow the desk tab.** In the tab this account shares, adding, moving or removing its
  own harness sends no `share_add` or `share_remove` (the sharing computer refuses them): the desk composes the roster.
  Remove from Tab and People ▸ Remove are not offered for them; People ▸ Remove stays for a member's harness.
- **A harness still `Joining…` can be withdrawn.** Remove from Tab, or moving the pane out, sends `share_remove`; the
  daemon drops the queued add and the consent at once, without waiting for the owner's computer.
- **Invite People only where it works**: an unshared desk tab, or the tab this account shares from the computer asked.
  Another computer of the owner offers Stop Sharing and Move Here, not Invite.
- **Placed once, recorded per computer.** Each computer keeps, per shared tab, the other accounts' harnesses it has seen
  (`shared_tabs.placed`). A harness not seen before is placed with a desk `pane.add`, unless the desk already holds it
  in any tab. On the first sight of a tab whose desk tab exists, only harnesses the desk holds nowhere are placed. A
  member's desk tab is created only on the first sight of that tab on this computer; one the person closed is never
  created again there. If wrong, a pane the person closed comes back once on a new computer.
- **At most 9 panes.** A desk tab holds 9 harness panes (a viewer or an empty tile is not on the desk), so a shared tab
  shows at most 9; the rest are retried when room frees and are listed under People. Placement, a person's add and a
  move into a shared tab count the same way; a harness whose pane did not land is not recorded as placed.
- **People shows repo and branch through `share_who`**: a roster carries no state, repo or branch.
- **The web has no push.** Window frames reach only this computer's windows. The browser sends `agent_messages` to one
  of the account's own machines and relies on reads on open, after its own actions, and the 60 s fallback. **Move here**
  is not offered on the web (there is no "here").
- **The invitation notice** is the desktop's: a pending invitation whose id this computer has not shown before
  (`shared_tabs.invites_seen`). The invitation band also has **Not now**.
- **No Decline.** Only the owner can revoke an invitation, so the invitee has nothing to decline with; it expires.
- **Share form in tab mode** (`ShareHarnessDialog` with `tabMode`): no Copy, Access or Comments rows, and at most 8
  addresses.
- **Seam 4 already held** (`_requestViewClose` skips shared machines); only tests were added.
- **A pane of another account whose owner cannot be named** reads "Another account" (seam 3 and the chips).
- **Menus.** The File menu says **Invite People** (no ellipsis, like the rest of File); tab menus say **Invite People…**.

Known limitation: a computer that holds a tab but lists no harness in it (an owner's or member's viewer-only computer)
is refused by the relay, so its windows get no spinner for other accounts' harnesses.

## Desktop architecture

- **`SharedTabsController`**, a `ChangeNotifier` on `AppNotifier.sharedTabs`, separate so its traffic never rebuilds
  the workspace (as `AgentMessagesController` is). It calls the `agent_messages` actions on this computer's daemon the
  way `readAgentMessages` does, and holds: the shared tabs (roster: owner, leader, members, harnesses with account,
  machine, state, repo and branch), pending invitations, untrusted tabs, alerts and notices, and per tab the last Tasks
  answer. It reads `shares` again on `shared_tabs_changed`, when a panel opens, and every 60 s while the window is in
  front (a fallback; nothing polls in the background). Late answers for a superseded read are dropped (revision
  check, as the rest of `AppNotifier` does).
- **The desk carries foreign panes** (base spec, step 0 Variant A): when this computer holds a roster that lists a
  harness of another account not yet in the member's desk tab, the controller places it once with a desk `pane.add`
  (once per member, not per launch); after that the desk owns where it sits and whether it is closed.
- **A foreign pane is a Share pane**: `TerminalPane.sharedHarness`, drawn by `SharedHarnessPanel` over the observer
  channel, with the grant the hosting daemon derives from its roster (1b C1).

## What the person sees

### The tab row

- A shared tab shows a two-person mark and the harness count beside its name (`app · 👥 7`), natively on macOS and in
  the Flutter row elsewhere.
- The status slot keeps its spinner, ✓ or ?, and now also follows foreign panes (seam 1 below).
- Right-click the tab (native menu; Flutter menu on the web) and the File menu:
  - a tab this account shares, or any unshared tab: **Invite People…**, **Show Agent Messages**, and when shared
    **Stop Sharing Tab**; on another computer of the owner also **Move here**;
  - a tab this account was invited to: **Show Agent Messages**, **Leave Tab**.

### Invite People

The Share form (`ShareHarnessDialog`'s email list and 7, 30 or 90 days), titled for the tab. The first invitation
shares the tab first (`share_tab`), then invites (`share_invite`). Pending invitations appear under People with
Revoke.

### Receiving an invitation

- An in-app notice ("Alice invited you to the tab 'app'" with **View**) and Settings ▸ **Tab invites**, listing pending
  invitations.
- **Accept** opens a dialog with the tab's name, the owner's email and: *"Alice and everyone in this tab will see the
  terminals of the harnesses you add. Only you can type into them."* After **Accept** succeeds it shows the owner
  computer's fingerprint with *"Compare it with Alice if you want to be sure."* (the invitee cannot read the roster
  before accepting; base spec, First trust). A pending accept (`{ pending: true }`) says the tab will appear when
  Alice's computer is reachable.
- Then **Add harnesses**: the person's existing harnesses to pick, or **New Harness here**.

### Adding and removing harnesses

Dragging one of this account's harnesses into a shared tab, or **New Harness** inside it, adds it (`share_add`). A
pane's menu has **Remove from Tab** (`share_remove`). A harness on another of this account's computers is handled by
the daemon's forwarding; `MACHINE_AWAY` is shown as "Bob's laptop is away. Try again when it's on."

### Pane chips

- `Leader` on the leader's pane.
- On another account's pane: the owner's avatar and name and `View only`. No "Open here", no take control, and Close
  pane never sends a stop (seam 4).
- `Joining…` while a member's add waits for the owner's computer (tooltip: "Waiting for Alice's computer").
- `Sharing ended` with **Remove** when the grant is gone (removed, stopped, or the owner left).

### Show Agent Messages: Messages | People | Tasks

The existing dialog gains three tabs (as `session_work_dialog` has two). An unshared tab shows Messages only, as today.

- **Messages**: as today.
- **People**: one block per account: email (and name), each harness with engine · machine · state · repo/branch. The
  owner also has Invite, pending invitations with Revoke, **Make Leader**, **Remove** (a harness) and **Remove member**.
  Actions this computer cannot do are not shown, and a visible line says why: "Only the computer that shares this tab
  can change who is in it. Stop Sharing and Move here work from any of your computers." (it also works on the web, which
  has no tooltips). **Alerts** for this tab sit in
  an amber band at the top, each with plain words and a dismiss (see Errors).
- **Tasks**: the `share_tasks` table — repo, issue, title, assignee, pull request and CI. Enter opens the issue or pull
  request in the browser; an assignee opens its pane. Titles are plain text (they come from GitHub and anyone can
  write them).

### Trust

- A tab in the untrusted list shows an amber band in the tab's panel and under Settings ▸ Tab invites: *"Alice's
  computer has a new key."* with **Trust again**, which shows the new fingerprint (`share_retrust_check`) and confirms
  (`share_retrust`).
- **Move here** (owner, on another of its computers) calls `share_move` and says *"Members whose computers can't confirm
  the move will be asked to trust this computer."*

### The switch

Settings ▸ Experimental, **Agents in the same tab can message each other**, with the base spec's description (adds
"Invite people to a tab and their harnesses join it from their own computers.").

## Desktop seams from step 0

1. **Status slot for foreign panes**: the tab's spinner and attention marks follow another account's harness (the
   observer channel's activity fed into the shared machine's `MachineState`, or an observer activity frame).
2. **A desk-carried foreign pane renders as shared at once**: reconcile and attach set `sharedHarness` /
   `sharedOwnerName` when the machine is shared, instead of offering "Open here" for up to five minutes; re-read
   `/api/harness-shares` when the desk names an unknown machine.
3. **Restore before the inventory**: a foreign pane restores as "Alice · waiting", never "machine isn't available"
   or a takeover offer.
4. **Close never routes a stop** to a shared machine, including the tab-close review (`requestCloseSwarm`).
5. **The status bar** for a focused foreign pane shows the owner's name, not a machine id.

## Errors

Every failure says what happened and what to do; copy follows `docs/naming-system.md` ("shared tab", "member",
"leader"; never "team").

| Situation | Shown |
|---|---|
| `DAEMON_TOO_OLD` (or `UNKNOWN_ACTION`) | Shared-tab items hidden; one line in the panel, also on an unshared tab: "Update Harness on this computer to share tabs." |
| `SHARED_TABS_UNSUPPORTED` | "Shared tabs aren't available on the Harness service yet." |
| `MESSAGES_OFF` | Shared-tab items lead to Settings ▸ Experimental with the switch |
| Owner's computer offline | `Joining…` chip, tooltip "Waiting for Alice's computer" |
| `MACHINE_AWAY` | "Bob's laptop is away. Try again when it's on." |
| `TAB_FULL`, `RATE_LIMITED`, `TOO_LARGE` | A notice naming the limit (32 harnesses, 8 people, 120 messages in 10 minutes, message too long) |
| `RELAY_TAKEN` | Amber band: "This tab is connected from another place; messages wait here." |
| Removed, or sharing stopped | Foreign panes show `Sharing ended` with Remove; the tab becomes an ordinary tab; a notice "You were removed from Alice's tab" |
| Alerts: `foreign_machine`, `machine_key_mismatch`, `own_machine_listed`, `bad_signature`, `unpinned_key`, `share_id_mismatch` | Amber band in People, plain words, e.g. "The tab lists a computer as yours that isn't." with Remove where it applies; `foreign_machine` has only a dismiss in 1c (an alert names no machine) |
| `gh` errors in Tasks | One line: install `gh`, run `gh auth login`, or try again later |
| Restore before inventory | "Alice · waiting" |

Waiting is drawn in the shape of the answer (skeletons for People and Tasks, as the desktop's rule says); "loading"
and "nothing" never look alike. Strings from another account are shown as plain text.

## Verification

- **Daemon additions**: unit tests at 100% (`test:shared-tabs`, `test:core`) and the `sharedTabs.e2e.ts` step.
- **Flutter tests** (fake `AppNotifier`, `MemoryStore`, `handleEventForTest`, the desk seams): the controller (push,
  60 s fallback, each error code, stale answers dropped); the tab mark and menus by role; Invite, Accept (fingerprint
  after accept, pending), Add harnesses, Remove, Leave, Stop, Make Leader, Trust again, Move here; the five seams; the
  three-tab panel with alerts, dismiss, Tasks errors and skeletons. `flutter analyze`, `make -C .. desktop-test`.
- **Native macOS**: an integration test of the tab row's mark through `tool/native_driver.py`.
- **Web**: Chrome tests with `--dart-define=HARNESS_TEST=true` for the mouse-only paths (tab menu, panel tabs).
- **By hand**: `cli/scripts/spike-a-stack.ts` (two fake accounts on a local backend) with Bob's desktop built under a
  separate bundle id (never the installed Harness.app); the whole flow from invite to `Sharing ended`, screenshots
  compared. Then two real Google accounts on a Mac and the docker boxes with a real GitHub repo.

## Rollout

Backend, then CLI and daemon, then desktop (base spec, Rollout). A desktop on an older daemon shows "Update Harness on
this computer". Agent Messages stays off by default; nothing changes for anyone who has not turned it on.

## Out of scope

The consent view, "also visible to tab X" in the Share dialog, a notice center, the phone, and composing messages or
tasks in the panel (people prompt their harnesses in panes, as always).
