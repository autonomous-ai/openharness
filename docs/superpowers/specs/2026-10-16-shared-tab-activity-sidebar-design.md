# Tab Activity, a leader and tasks in every tab

October 16, 2026. Design approved in conversation with the owner; built on branch `feat/tab-activity`, not released. Builds on shared tabs, shipped the
same day (PR #1376): [Shared tabs on the desktop](2026-10-16-shared-tabs-desktop-design.md) (the "1c spec") and
[Agent Messages across accounts](2026-10-15-agent-messages-across-accounts-design.md) (the "base spec").

## Why

Using shared tabs on day one showed two problems.

1. **Coordination was locked behind sharing.** A leader, the Tasks list, People and the pane chips existed only in a
   tab shared with another account. A person with three harnesses of their own in one tab could not name a leader or
   see the tab's tasks without inviting someone. Sharing is for one thing: inviting people.
2. **Following the work meant opening panes one by one.** The owner wants one place, always in view, that says which
   harness is doing what and how far each task has got: a sidebar like VS Code's Explorer, listing harnesses and tasks
   instead of files.

Smaller rough edges from the same day are fixed with them: an "Update Harness" line with no way to act on it, a panel
with no way to share, a leader that is only a label, and removals that happen on the first click.

Success: in any tab where Agent Messages are on, a person names a leader, gives it a task in one sentence, and watches
from the sidebar which harness is doing what and each task's step (working, building, waiting for review, merging,
merged), without opening a pane, and without sharing the tab unless they want to invite someone.

## Scope

- In:
  - A leader for every tab; roles in what each agent is told about its tab.
  - Tasks for every tab, with a marker that survives sharing.
  - The Show Agent Messages panel with Messages | People | Tasks in every tab, and Invite People in it.
  - The Tab Activity sidebar in every tab: Harnesses and Tasks, a one-line summary per harness, each task's step.
  - The "update Harness" line with versions and an action.
  - A confirmation before Remove and Remove member.
- Out: agents reporting their own status (`harness status …`), history over time, the phone, editing tasks from the
  sidebar, a separate working folder per harness (follow-up), the 1c follow-ups not named here.
- Unchanged: inviting, accepting, trust, alerts, Move here and Stop Sharing work as 1c built them.

Everything here needs Agent Messages on (Settings ▸ Experimental); with it off, nothing changes.

## A leader in every tab

- **Where it is kept:** the tab's Agent Messages setting on the backend (`/api/agent-messages/tabs/:tabId`, which holds
  `enabled` today) gains `leader: { machineId, agentId } | null`. It belongs to the account, so every computer of the
  person sees and changes the same leader; the change is announced as `desk_changed`, as the setting is today.
- **Choosing:** right-click a pane ▸ **Make Leader** (on the leader: **Remove Leader**), in any tab with Agent Messages
  on; also People ▸ Make Leader. The leader's pane has the `Leader` chip.
- **Shared tabs:** the owner's tab setting is the one source. Sharing a tab that has a leader carries it into the first
  roster. When the owner changes the leader from any of their computers, the sharing computer sees the setting change and
  signs a roster with the new leader. 1c's rule "only the sharing computer can change the leader" goes. Members see the
  leader the roster names and cannot change it. **Stop Sharing** leaves the tab with its leader.
- A leader that leaves the tab (its pane closed, removed, or the harness stopped) is no longer the leader: the setting is
  cleared by the computer that notices, and the roster follows.

## Roles in what each agent is told

The note each agent gets about its tab (with `harness send`) names the leader and, when there is one, gives each its
role in one or two plain sentences:

- **The leader:** "You lead this tab. Split the work, give each part to a harness here with `harness send`, track it as
  GitHub issues with this tab's marker, and report back to the person."
- **The others:** "<leader> leads this tab. Take work from it, and tell it with `harness send` when a part is done or
  blocked."

With no leader, the note is as today. The roles are text in the note; nothing enforces them.

## Tasks in every tab

- **One marker for the life of a tab:** `<!-- harness-tab:<key> assignee:<account>/<harness> -->`, where `key` is
  `sharedTabIdOf(owner account, desk tab id)`, the hash the daemon already uses for a shared tab's id. An unshared tab
  computes the same value, so issues created before a tab is shared keep belonging to it after.
- **The note** tells the agents the marker for every tab, not only shared ones.
- **Reading:** `share_tasks` accepts a desk tab (`tabId`) as well as a shared tab (`sharedTabId`) and reads the same way
  (`gh`, 30-second cache, the same error codes). In an unshared tab the assignees are this account's harnesses.

## The Show Agent Messages panel

- Every tab with Agent Messages on has **Messages | People | Tasks**.
- **People** in an unshared tab lists this account's harnesses in the tab (engine · machine · state · repo/branch) with
  Make Leader, and an **Invite People…** button that opens the Share form (the first invitation shares the tab, as in
  1c). In a shared tab, People is as 1c built it, with Make Leader now on every computer of the owner.
- **Remove** and **Remove member** ask first: "Remove <name> from this tab? Its owner can add it again." / "Remove
  <email> and their harnesses from this tab?", with Cancel focused.

## The Tab Activity sidebar

### Where it is

- In every tab with Agent Messages on. Opened and closed from a button in the tab's toolbar area, a shortcut, and the
  command palette (**Show Tab Activity**). It sits to the left of the panes and its width can be dragged. Whether it is
  open, and its width, are remembered per tab on this computer.
- Desktop and web share the code; the web is mouse-first, so everything is clickable. The phone has no sidebar.
- The sidebar is the summary to keep open; the panel is where the tab is managed.

```
TAB ACTIVITY · app
▾ HARNESSES
  ● lead  Alice  Leader · planning the search work      #43
  ● api   Bob    fixing the login test                  #42
  ○ web   Alice  idle · waiting for review of PR #45
▾ TASKS
  #42 Fix login      api    working
  #43 Add search     web    building
  #45 Refactor db    lead   waiting for review
  #41 Cache layer    api    merging
  #40 Init repo      lead   merged ✓
```

### Harnesses

- One row per harness in the tab (in a shared tab, every account's): a state mark (● working, ○ idle, ⚠ waiting for its
  owner's computer or sharing ended), its name, its owner in a shared tab (short email), the one-line summary, and the
  issue number of the task assigned to it, if any. The leader is first, with `Leader`.
- Clicking a row focuses that harness's pane. A harness the desk does not show (beyond the 9 panes a tab holds) is
  listed but has no pane to focus; its row says so in a tooltip.

### Tasks

- From the tab's tasks, ordered by step: working, building, waiting for review, merging, then merged. A merged task
  stays for 24 hours, then leaves the list.
- Clicking a row opens its issue or pull request in the browser; clicking its assignee focuses that harness's pane.

## The one-line summary

- **Source:** the core keeps each turn's recap (`conversations.recaps`). The summary is the latest recap. While a turn
  is running and has no recap yet, it is the prompt that started the turn.
- **This account's harnesses:** read from the daemon of the computer they run on, as their working state is.
- **Other accounts' harnesses (shared tabs):** the `activity` request 1c sends gains an optional `summary` per harness.
  It is sent only when it changes, cut to 120 characters with control and format characters removed, and only for
  harnesses the rule for activity already allows: listed in the roster, and for a member's harness on its own computer,
  one the member added. The receiving daemon keeps it with the activity, tells its windows in `shared_activity`
  (`summary` field), and returns it in `shares.activity`.
- **Privacy:** everyone in a shared tab can already watch these harnesses' terminals, so the summary reveals nothing new.
  It still has a switch, on by default, in Settings ▸ Experimental under Agent Messages: **Share a one-line summary of
  what your harnesses are doing with people in your shared tabs**. Off, no summary leaves this account; the working state
  still goes.
- **Older computers:** a computer whose daemon predates this gives no summary; its harnesses show only working or idle.

## A task's step

`share_tasks` already gives each task its issue, assignee, pull request state (Draft, Open, Merged, Closed) and CI
(passing, failing, pending, none). The pull request read gains two fields, `autoMergeRequest` and `mergeStateStatus`;
no extra `gh` call, the same 30-second cache.

The first row that matches decides the step:

| Condition | Shown |
|---|---|
| Pull request merged | **merged** ✓ |
| Pull request closed, issue still open | **pull request closed** |
| Auto-merge on | **merging** |
| CI failing | **build failed** ✗ |
| CI pending | **building** |
| CI passing or none, pull request open | **waiting for review** |
| Pull request draft | **working (draft)** |
| Issue closed, no pull request | **closed** |
| No pull request, assignee working | **working** |
| No pull request, assignee idle or no assignee | **not started** |

The tasks are read when the sidebar or the panel's Tasks opens, when a harness in the tab goes from working to idle (it
often just pushed or opened a pull request), and every 60 seconds while the window is in front and the sidebar is open.
Nothing is read while both are closed.

## Updating Harness

The panel's "Update Harness on this computer to share tabs." becomes: "This computer runs Harness <current>; shared tabs
need <required> or newer." with **Update now** (it runs the daemon's update, as `harness update` does) and, while it
runs, "Updating…". On a development build (`-dev`), which does not update itself, the line says so and offers the same
button, which installs the latest release.

## Errors and waiting

- A `gh` failure shows one line in Tasks (install `gh`, run `gh auth login`, or try again later); Harnesses keeps
  working.
- Make Leader that cannot be saved (offline, backend error) says so in the menu's place and keeps the old leader.
- Waiting is drawn in the shape of the answer (skeleton rows); "loading" and "nothing" never look alike.
- Strings from another account (names, emails, summaries, issue titles) are plain text, one line, ellipsized.
- Copy follows `docs/naming-system.md` ("shared tab", "member", "leader"; never "team").

## Changes by part

- **Backend:** the tab setting gains `leader` (validated: an agent and machine id of this account, or null), returned
  with the tab listing; tests for set, clear, validation and `desk_changed`.
- **Daemon:**
  1. The directory reads each tab's leader; the note names the leader and the roles; the note gives every tab its task
     marker.
  2. The sharing computer republishes the roster when the owner's tab setting names another leader; `share_leader`
     writes the tab setting instead of the roster alone. A leader that left the tab is cleared.
  3. `share_tasks` accepts `tabId`; `tasks.ts` reads `autoMergeRequest` and `mergeStateStatus`.
  4. The `activity` request, `shared_activity` and `shares.activity` gain `summary?`; `ActivityOut.due` treats a
     changed summary as a change; a core query gives the latest recap or the running prompt per agent id (at most 64).
  5. The summary switch, read where activity is sent.
  6. An update action for the panel's **Update now**.

  `test:shared-tabs` and `test:core` stay at 100%; `sharedTabs.e2e.ts` gains: a leader set on the owner's second computer
  reaches the member's roster; a task created in an unshared tab is still the tab's after it is shared; Bob's window
  receives Alice's harness's summary.
- **Desktop:** Make Leader / Remove Leader on panes; the panel's three tabs in every tab; People for unshared tabs with
  Invite People…; confirmations; the sidebar; the update line.

## Verification

- Backend and daemon: unit tests at 100% and the end-to-end steps above.
- Desktop (Flutter tests): the step table (every row); Make Leader in an unshared and a shared tab, from the owner's
  second computer; the panel in an unshared tab; the confirmations; the sidebar (open/close, remembered width, row
  clicks, skeletons, hostile strings, the 24-hour merged rule); the summary switch; the update line; a Chrome test for
  the mouse paths.
- By hand: `cli/scripts/spike-a-stack.ts` with both desktops under the spike bundle id, one tab of three harnesses
  without sharing (leader, a task, the sidebar), then shared; a repository through the `gh` stub; screenshots of each
  step.

## Rollout

Backend, then CLI and daemon, then desktop and web, as for shared tabs. A daemon from before reads no leader for an
unshared tab, gives no summary and no merge fields: the desktop then shows the leader only where a roster names one,
working or idle, and the steps it can derive; the update line offers the update.

## Out of scope

Agents reporting their own status, history over time, the phone, editing tasks from the sidebar, a working folder per
harness, and the remaining 1c follow-ups (viewer-only spinners, more than 9 panes, declining an invitation, Remove for
the `foreign_machine` alert, closing every "Sharing ended" pane at once, harnesses on a machine shared whole).

## Rulings made while building

Building found where the code differs from what this spec assumed. These rulings settle it.

- **A leader that left the tab is derived, not cleared.** The backend has no table of agents; it knows them only as
  desk panes. It validates a new leader as a pane of that desk tab, and the tab listing returns `leader: null` when
  that pane is no longer in the tab. Nothing writes to clear it, so no two computers race.
- **A shared tab's leader may be any harness its roster lists.** "Of this account" above was an oversight; shared
  tabs already allowed a member's harness. The backend accepts an own-machine pane or a pane in the owner's live share
  roster, at write time and at read time. A member's harness can be leader only while it is a pane of the owner's desk
  tab, so Make Leader is offered only for panes in the tab.
- **The core keeps the running prompt.** `recentAsks` is written only when a turn ends, and recaps exist only with a
  paired device or `alwaysGenerate`. The core keeps the last prompt of each agent from the turn funnel. Working shows
  that prompt; idle shows the latest recap line, else that prompt; nothing known means no summary.
- **`tab_activity { tabId }` answers every harness of the tab.** This computer's harnesses come from the core, the
  account's other computers through `who` (extended with `state` and `summary`), and other accounts from what
  `activity` frames brought.
- **Marker labels come from `markerLabel`.** `markerLabel(email)` is the account label with every character outside
  `[\w.-]` turned into `-`, at most 64 characters, `account` when nothing is left. The desktop mirrors it. The label
  can differ from the display label for an email with `+`. An unshared tab uses the same label, so a task assigned
  before sharing still names the right harness after.
- **Harness names in the marker come from `markerName`.** A display name is a session title ("Fix login test") or carries
  the start of an id when two share one ("app (1a2b)"), and the reader takes only `[\w.-]{1,64}`, so a task written
  with it was no task. `markerName(name)` is `markerLabel`'s rule in lower case, `harness` when nothing is left. The note
  ends its marker lines with each harness's assignee (`Assignees in this marker: alice/fix-login-test for you,
  alice/app-1a2b for app (1a2b), bob/api for bob/api.`), and the desktop maps an assignee back by the marker name of the
  harness's name, or of the name with the start of its id for a shared name. The desktop mirrors the function.
- **The summary switch is stored inverted.** Every account experiment is off unless true, so the setting is
  `agent_messages_hide_summary` (backend) and `agentMessagesHideSummary` (daemon), off by default. The desktop shows
  "Share a one-line summary ..." checked when it is off.
- **Cross-account `who` carries no summary.** A summary reaches another account only through `activity`, for
  harnesses the activity rule allows.
- **An agent shell cannot widen summary sharing through `harness settings`.** `harness settings` refuses to turn the
  hide switch off from an agent shell; the person turns it off in the desktop. The daemon's `PATCH /api/agent-settings`
  has no agent-shell check, the same protection every other setting has.
- **Idle summaries reach the windows.** An idle entry that carries a summary is kept for 10 minutes after it was
  heard (`ACTIVITY_IDLE_KEEP_MS`); working entries keep their lease.
- **Everything new follows the account's Agent Messages switch.** The Tab Activity button, menu rows and palette
  command, Make Leader and Remove Leader (File, palette, the pane link, People), the Leader chip, and an unshared tab's
  People and Tasks need the switch on as well as a daemon and backend that support Agent Messages
  (`AppNotifier.tabActivityOffered`). Support alone showed them to every account with the switch off, the default.
- **Make Leader lives where pane actions already are.** There is no pane context menu, so it is in the File menu
  (macOS and Linux), the command palette, and a chip on the focused pane. The chip offers Make Leader and, on the
  leader, Remove Leader.
- **The sidebar's button.** On macOS it is a button in the native tab strip, plus the View menu and the command
  palette. The shortcut is Cmd+Shift+Y. While Harness is in front it takes macOS's "Make New Sticky Note" Service. On
  Linux and the web the shortcut is Alt+Shift+Y.
- **A merged task stays 24 hours from the pull request's merge time** (`mergedAt` from `gh pr view`), not from the
  issue's last update.
- **Update now is native only.** No daemon request updates Harness, and `harness update` stops the daemon it asks. The
  desktop runs `harness update` itself; a development build runs `harness update --force` after a confirmation that it
  replaces the development build. The daemon's version is read over the local socket from `/api/health`. The web shows
  the line without the button. The required version is `kAgentMessagesMinimumCli = '0.4.15'`.
- **A too-old daemon.** When the daemon has no shares, the panel shows Messages plus the update line; People and Tasks
  wait for the update.
- **Every agent's note changes once.** The marker (and roles) now reach unshared tabs, so each note's signature changes
  and agents are told the new note once.
- **"Merging" is auto-merge only.** gh exports no merge-queue field: `gh pr view --json isInMergeQueue` is refused
  before any request (`Unknown JSON field`, exit 1, gh 2.95.0), which failed every pull request read. Reading the queue
  would take another `gh api graphql` call per pull request, so the step reads `autoMergeRequest` alone. A spec test
  pins every requested `--json` field to gh's own list.
- **Merge fields share the 20-PR cap** of the existing `gh pr view` calls; a pull request beyond it shows the steps
  derivable without them.
- **Known limitation.** A member's computer with no harness in the tab gets no activity or summaries, because the
  relay refuses it (`NOT_IN_TAB`). This is the 1c viewer-only limit.
