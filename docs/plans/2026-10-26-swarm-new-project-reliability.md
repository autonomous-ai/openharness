# Swarm New Project reliability

Status: ready to implement (2026-10-26). Owner: Ken.

A Swarm's **New project** failed on three machines in one afternoon, each time for a different reason, and
each failure left the form locked. This spec covers the four defects found. The phases are independent: each
one can be built, reviewed and shipped on its own, in any order. Phase 1 is the most urgent.

All evidence below was collected on 2026-10-26 from Ken's Mac (`MacbookPro.local`), the Windows PC
`DESKTOP-0TFH0OJ` (`WIN-DELL`, CLI 0.4.67), the Mac Studio (`MACs-Mac-Studio.local`, CLI 0.4.68), production
Mongo (read-only) and the backend pod logs (`argocd app logs production-autonomous-code-be`).

## How New project works (what the phases touch)

1. Desktop opens the New Harness form through `SuperTabLaunch.open` (`desktop/lib/super_tabs/launch.ts`),
   which keeps a **journal** in the desktop store under
   `super_tab.launch.<account>.<swarmTabLocalId>.new-project`
   (`desktop/lib/screens/swarm_screen.dart:3846` passes the fixed id `new-project`).
2. `prepare` sends `project.create` to the backend (`POST /api/super-tabs/<tab>/commands`) and records
   `projectId` and `projectPrepared: true`.
3. `beforeSubmit` records `machineId`, `creationId` and `phase: 'starting'`, then the native create
   (`agent_create`) runs on the chosen machine. The machine keeps a receipt in
   `~/.harness/cli/data/agent-creations/<creationId>.json` (+ `.claim`, `.result`).
4. `complete` records `phase: 'joining'` and sends `agent.add` (operation id `joinId`), then
   `project.rename`, then deletes the journal.
5. While a journal has `phase` `starting` or `joining`, reopening New project restores it
   (`recovering`), the form's button becomes **Check status**, and Check status calls `resume()` →
   `AppNotifier.recoverSuperTabCreation` (`agent_create_status` on the journal's machine) → `complete`.

---

## Phase 1 — Backend: a busy Swarm answers its commands instead of 500

### Problem

`agent.add` (and any other command) on a busy Swarm fails with **500 "An internal server error occurred"**.
The form shows "Harness started. Could not join the conversation: An internal server error occurred", and every
Check status fails the same way.

Backend log, the person's Check status at 07:15:51Z:

```
path: /api/super-tabs/c51479bd73b59e58176ad9e4/commands  method: POST
Invalid `prisma.superTab.update()` invocation: Transaction failed due to a write conflict or a deadlock.
Please retry your transaction                                              (Unhandled error)
```

The same 8-minute window also has, on the same Swarm: the same write conflict on `POST /native/<id>` and
`POST /machines/<id>`, `Transaction already closed … timeout for this transaction was 5000 ms` on message and
host reads, and `LockTimeout: Unable to acquire IX lock … within 5ms` on `SuperTabMention` /
`SuperTabTerminalRequest`. All five backend pods (HPA max) restarted at 07:07Z.

Why the Swarm conflicts: `SuperTab c51479bd73b59e58176ad9e4` has a 1.16 MB document (`state`: 195
conversations, 134 starts, 100 releasedHarnesses), revision 213,9xx, and is written about every 3 s (four agents
posting 8–16 commands an hour each, plus host and native writes). Every command reads and rewrites the whole
document. `transaction()` in `backend/src/superTabs/store.ts:92` retries `P2034`/`P2002` four more times
**immediately**, with no delay, so a slow command (contribution lookups + a 1 MB write) loses all five attempts
to the faster writers.

### Change

In `backend/src/superTabs/store.ts`:

- Retry `P2034` and `P2002`, and also Prisma errors whose message or meta carries Mongo's
  `TransientTransactionError` label (the `LockTimeout` above), with **exponential backoff plus full jitter**:
  base 50 ms, factor 2, cap 1.5 s, at most 8 attempts. Keep the existing rule that a retry never repeats a host
  action (every effect in a transaction is a durable DB write).
- Pass an explicit interactive-transaction `timeout` (15 s) and `maxWait` (5 s) to `db.$transaction`, so a
  command on a large Swarm is not killed at the 5 s default.
- When retries run out, answer `503 SWARM_BUSY` "This Swarm is busy. Try again in a moment." (the module's
  `fail()`) instead of an unhandled 500. It must be a 5xx: every client retries a 5xx and treats a 4xx as final,
  and a 409 on `POST /native/<id>` makes the host stop that terminal's recording for good
  (`cli/src/superTabs/native.ts`, the `[400, 403, 404, 409]` branch). No client change is needed.
- Check every other `$transaction` under `backend/src/superTabs/` (read paths such as conversation messages
  and host reads hit the 5 s timeout too) and route them through the same helper.

### Out of scope

Shrinking the Swarm document (moving conversations, starts and released harnesses out of `state`, or
splitting the row) is the real cure for the contention. Record it as a follow-up; do not start it here.

### Tests and acceptance

- Unit test the helper: a body failing with `P2034` N times then succeeding returns its value; delays grow
  and stay within the cap (use fake timers); a non-retryable error is thrown at once; exhausting the attempts
  throws `SWARM_BUSY` 503; a `P2002` still taken after every attempt is rethrown as it is.
- Existing super-tab store tests stay green.
- After deploy: Check status on the stuck Mac Studio journal (project `5701099db2a04f605ac0d4d4`, harness
  `f34164d3-1f97-4d10-8a25-4e2fffdf2f06`) joins; pod logs show no `Unhandled error` write conflicts on
  `/commands` for that Swarm over 30 minutes.

---

## Phase 2 — Desktop: a stuck New project request can be seen and dropped

### Problem

One journal stuck in `starting` or `joining` locks New project for its whole Swarm tab, on every machine,
until someone edits `state.json` by hand (done twice today: Ken's Mac, and pending on WIN-DELL). Specifically:

1. The journal key is fixed per tab (`…new-project`), so the next New project always restores the stuck one.
2. While recovering, the machine and folder pickers show and accept new choices ("This Mac", "rosy-maple"),
   but Check status ignores them and asks the **journal's** machine. Ken picked This Mac and Check status kept
   asking WIN-DELL, then Mac Studio.
3. There is no way out. `canCancelPending` covers only an ordinary held create (`AgentCreationAttempt`), not
   the Swarm journal. Close twice leaves the journal in place.
4. A journal whose project was deleted elsewhere stays forever: `prepare` deletes it only when `phase` is
   neither `starting` nor `joining` (`launch.ts`, the `PROJECT_UNAVAILABLE` branch).
5. The messages say nothing useful. "MACs-Mac-Studio.local has not confirmed the new harness yet" was shown while
   the harness had been created and was waiting at Claude Code's trust prompt (see Phase 3).

### Change

In `desktop/lib/super_tabs/launch.ts`, `desktop/lib/state/new_harness.dart` and the form widgets:

- **Show what is being checked.** While `integration.pending` (recovering), lock the engine, machine and
  folder pickers to the journal's values (machine from `saved['machineId']`) and show a line such as
  "Waiting for MACs-Mac-Studio.local to start the Lead for “New project”." Never display a different machine than
  the one Check status asks.
- **Say what the machine says.** Map `recoverSuperTabCreation` outcomes to plain lines:
  - receipt `created`, join failed → "The Lead started on <machine>. Joining it to the project failed: <reason>.
    Check status to try again."
  - receipt pending/held → "<machine> has not started the Lead yet."
  - harness created but needs the person (agent state `needs-input`) → "The Lead on <machine> is waiting for
    you. Open it to answer." with an action that focuses that pane.
- **Discard request.** Add a secondary action, shown only while recovering:
  - `phase: 'starting'`: send `agent_create_cancel` for `creationId` to the journal's machine. On `cancelled`,
    `missing` or `failed`, delete the journal. On `created`, do not delete: switch to the "Lead started" line
    (it can still be joined).
  - `phase: 'joining'` (harness exists, join failed): confirm "The Lead keeps running on <machine>. Remove
    this request?" and delete the journal. Do not close the harness.
  - Machine unreachable: say so, and keep the journal unless the person confirms "Discard anyway".
  - If `projectPrepared` and the project has no agents, also delete the empty project (check whether a
    `project.delete`/`project.remove` command exists in `backend/src/superTabs/commands.ts`; if none, leave the
    project and list the gap in the PR).
- **Deleted project.** When `prepare`/`complete` gets `PROJECT_UNAVAILABLE`, offer Discard request instead
  of leaving the journal forever.
- After a discard, reopening New project starts a fresh journal.

### Tests and acceptance

- Widget/state tests for: pickers locked and showing the journal's machine while recovering; Discard in
  `starting` sends `agent_create_cancel` and removes the journal; `created` is not discarded; Discard in
  `joining` removes the journal and leaves the harness; `PROJECT_UNAVAILABLE` offers Discard; the next New project
  gets a new `operationId`/`creationId`.
- Manual: reproduce on WIN-DELL's own Desktop, which still holds journal
  `super_tab.launch.6a86d24c2ea251076eb4eebe.a697ce0e844cb84738fdeb5a8f0904c4.new-project` (`phase: joining`,
  project `ed6c8957ca05794b6182a449`, harness `c25e2575`). Discard it from the form.

---

## Phase 3 — CLI: a Swarm Lead does not stop at Claude Code's startup dialogs

### Problem

Every new Lead on a machine whose folder Claude Code had not been asked about sat in `needs-input` before its
first turn, which the form reports as "has not confirmed". Seen twice today:

- **WIN-DELL, reused checkout.** The Lead's request had `projectFolder: { source: 'remote', repositoryUrl:
  …/openharness.git }`. `prepareProjectFolder` (`cli/src/lib/projectFolder.ts:236`) found
  `C:\Users\DELL\harnesses\openharness` already holding that repository and started there. Pre-trust is only
  for an empty new folder or a Swarm clone (`cli/src/core/agents/create.ts:128`, `cli/src/superTabs/cloneTrust.ts`),
  so Claude Code showed "Is this a project you created or one you trust?". Trust on the parent
  `C:/Users/DELL/harnesses` does not count: Claude Code walks up only to the repository root.
- **Mac Studio, worktree of a trusted repository.** The Lead ran in a new worktree
  `/Users/mac/harnesses/worktrees/openharness/bold-pine` of `/Users/mac/harnesses/openharness`, whose
  `~/.claude.json` entry already had `hasTrustDialogAccepted: true`. The trust prompt still appeared, the daemon
  logged no `pre-trust` line, and after answering Yes the worktree still has no entry of its own in
  `~/.claude.json`. `launches.ts:124-128` is meant to give a worktree its source's answer
  (`projectFolder.source === 'worktree' && engineTrust.trusts(gitSource)`); for this launch it did not.
  The same Lead then showed Claude Code's one-time **Bypass Permissions** acceptance ("Yes, I accept"),
  because the Swarm forces full mode and that machine had never accepted it, and then a "Try the new fullscreen
  renderer?" promotion.

### Change

1. **Find why the worktree did not inherit trust, and fix it.** Trace the Desktop New project launch with
   Worktree on (`desktop/lib/core/project_folder.dart:185` → `agent_create` → `cli/src/core/agents/launches.ts`)
   on Claude Code 2.1.310. Determine (a) whether this launch reaches line 127 with `source: 'worktree'`, and
   (b) which `projects` key Claude Code reads for a git worktree (the worktree path, its main repository, or
   its realpath), by trying it with the real binary in a throwaway `CLAUDE_CONFIG_DIR`. Record trust under the
   key Claude Code actually reads. Name the finding in a code comment.
2. **A Swarm Lead's reused checkout.** When a Swarm agent starts with the Swarm's forced full permission mode in
   a folder that `prepareProjectFolder` reused because it `holdsRepository` of the project's own repository,
   record Claude Code trust for that folder, and for a worktree made from it. The owner's standing decision is
   that machine trust favors UX over prompts (the person chose this repository and full mode for the Swarm).
   Keep the guard in `folderTrust.ts`: never for any other existing folder.
3. **Bypass acceptance.** For a Swarm agent launched in full mode, apply Claude Code's documented setting
   that records the bypass-permissions acceptance, in the same declared, data-driven way as trust
   (`cli/src/engines/claude/launch.ts` contracts, applied by core before spawn). If Claude Code exposes no
   setting for it, skip this item and say so in the PR.
4. **Report what blocks a start.** When a Swarm agent's pane shows a startup modal (`trust_open`,
   `permission_open`, a menu), its creation status should carry it, so Phase 2 can show "waiting for you"
   rather than "not confirmed". The screen reading already classifies these (`cli/src/engines/kit/screen.ts`
   `HOLDS`).

### Tests and acceptance

- Unit tests in `cli/src/engines/kit/folderTrust.spec.ts` / `launchPrep` goldens for the worktree key and the
  reused-checkout case, including the guard (an unrelated existing folder is still not trusted).
- `npm run test:core` at 100% for touched core files.
- Manual: on a machine where the repository is trusted, New project with Worktree on starts a Lead that takes
  its first turn without any prompt. On WIN-DELL with a fresh `harnesses/<repo>` checkout, the same.

---

## Phase 4 — CLI: a Swarm message is typed and sent on Windows

### Problem

On WIN-DELL, messages to the Lead (from the Swarm chat on Ken's Mac) were pasted but never submitted. The
composer showed `> [Pasted text #3 +10 lines]`, and later deliveries waited with `team_waiting_draft`. The DELL
daemon log (`~/.harness/cli/data/harness.log`):

```
23:38:44 [inject] 25ab99d4 typed, not sent · engine=claude · prompt_hidden opened before Enter
23:40:14 [inject] 25ab99d4 typed, not sent · engine=claude · prompt_hidden opened before Enter
23:42:38 [inject] 25ab99d4 typed, not sent · engine=claude · prompt_hidden opened before Enter
```

The check before Enter (`messageWriter` `beforeEnter`, `cli/src/core/input.ts`) read the pane 12 times over
3 s, and each time `composerState` (`cli/src/engines/claude/composer.ts`) returned `absent`. Read a few
minutes later from the console buffer, the same pane parses as `ready` with this repository's code and
`process.platform = 'win32'`. The screen had `>` + U+00A0, `─` rules above and below, and the footer
`  ⏵⏵ bypass permissions on (shift+tab to cycle)`. CLI 0.4.67 already has the Windows `>` composer fix (#1649).
So what the daemon read during those 3 s differed from that screen. Either it was a transient frame after the
paste, or the pty-host capture (`op: 'capture'`, `cli/src/lib/ptyHostBackend.ts`) differs from the console.

### Change

1. **Log the screen the Enter was held on.** A patch exists, uncommitted, in worktree `rosy-maple`
   (`cli/src/core/input.ts`, `cli/src/core/input.spec.ts`). When `beforeEnter` returns a hold it logs
   `[inject] <agent> Enter held · <hold> · screen <json>`: the last 15 non-blank rows, escape sequences kept,
   `redactSecretsInText` applied, each row cut at 400 chars (`heldScreen`). It has a test. Carry it over and
   reimplement if needed. A dev build with it (`0.4.67-dev.ecad97507.dirty`) is installed on WIN-DELL and running.
2. **Reproduce.** Send a multi-line message from the Swarm chat to a Claude Code Lead on WIN-DELL. Read the
   `Enter held` line. To compare with what pty-host holds, capture through pty-host directly. A throwaway
   script built from `cli/src/lib/ptyHost/client.ts` + `listDiscoveries(~/.harness/pty)` and run with the managed
   node in session 1 (`schtasks /it`) works. Find the pane by `rootPid` from `op: 'inventory'` and
   `op: 'jobPids'`.
3. **Fix the reading** for the captured screen. Add that capture as a fixture to
   `cli/src/engines/claude/composer.spec.ts` (and `kit/pane.spec.ts` if `claudeWindowsComposer` is involved).
   If the capture is a transient frame, the fix may instead belong in the retry window. Then explain in the
   comment why 3 s was not enough.

### Tests and acceptance

- The new fixture reads `ready`. Existing composer and pane specs stay green. `npm run test:core` passes.
- Manual: three multi-line Swarm messages in a row to the WIN-DELL Lead are each submitted, with no
  `typed, not sent` lines in the log.

---

## Machines and access for manual checks

- WIN-DELL / `DESKTOP-0TFH0OJ`: `ssh DELL@172.168.20.36` (password auth through `expect`). Send PowerShell as
  `-EncodedCommand`. Anything that touches the desktop session runs through `schtasks /create … /it`. A console
  screen can be read with a small C# `AttachConsole` + `ReadConsoleOutputCharacterW` program compiled with the
  in-box `csc.exe`. Clean up every temporary file and task.
- Mac Studio: `ssh mac@100.119.87.56` (key auth). Its host key differs from the entry in Ken's
  `~/.ssh/known_hosts`, so use a separate known-hosts file.
- Production Mongo is read-only (`.secrets/mongodb-prod-readonly.env`). Backend logs:
  `argocd app logs production-autonomous-code-be --grpc-web --kind Pod --name <pod>`.

## Validation and shipping

Follow `docs/validation-and-release.md`. Phase 1 ships as a backend release. Phases 3–4 ship as a CLI
release, then update WIN-DELL to it, replacing the dev build. Phase 2 ships as a Desktop release. Record the
local coverage gates you ran in each PR.
