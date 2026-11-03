# Switch a Swarm PM to another engine or account

Date: 2026-11-02. Requested by Diego.

## Problem

Two reports from 11-01:

1. The Product Manager (PM) of a project runs on a Mac Studio, and its Claude account reached its usage limit. Nobody could
   move it to another account, so the PM stopped working until the limit reset.
2. Diego's own PM reached its Claude limit. He wanted to move it to Codex or to his second Claude account. Exiting Claude in
   the terminal and starting Codex there did not work, because the Swarm host reopens the PM on its old engine within about
   5 s (`cli/src/superTabs/host.ts` `keepAlive`), and a hand-started process is not the PM.

What exists today:

- PR #2493 (CLI 0.5.19, Desktop 1.3.45) lets the **machine owner** change a PM's **engine** with the pane header's Agent
  control (Change agent). The PM keeps its Swarm agent id, role and tasks (`agent.rebind`); the new engine reads a handoff
  file. The PM's conversation is never purged, and a failed switch reopens the old PM.
- A machine has **several Codex accounts** (Codex profiles, `CODEX_HOME` folders, `cli/src/lib/codexProfiles.ts`), but
  Change agent never passes one, so a switch always lands on the default `~/.codex`.
- A machine has **one Claude account**. Claude Code does support several: each `CLAUDE_CONFIG_DIR` keeps its own sign-in in
  the macOS Keychain under `Claude Code-credentials-<first 8 hex of sha256(dir)>` (checked on Diego's Mac against an Orca
  profile: `79cb9be9`). Harness never starts Claude with one.
- When the PM itself hits a limit, the host's screen watch posts `agent.alert limit`; the backend writes one row in the
  project's PM chat, "… hit a usage limit. Routing skips it until HH:MM UTC.", with no recipients and no action
  (`backend/src/superTabs/terminal.ts:150-176`). Nothing offers a way out.
- The person who owns the project is often not the owner of the machine running its PM (a teammate's Mac Studio, a Harness
  Team account). Change agent is refused for them (`OWNER_REQUIRED`, `services/handoffRequest.ts:19`).

## Goal

A person who may manage a project can move its PM to another engine **or another account on the same machine** in one
action, from the project's menu or from the limit line, whoever owns that machine. The PM stays the same Swarm agent.

## Decisions (Diego, 11-02)

- Manual, one button (option B). No automatic switch on a limit.
- "Another account" means another sign-in **on the same machine** (option a). Moving the PM to another machine is out of
  scope.

## Scope

1. **Claude profiles.** A machine lists, links and launches several Claude accounts, each a `CLAUDE_CONFIG_DIR` folder, the
   way it does Codex profiles. It finds Orca's profiles (`~/Library/Application Support/orca/claude-profiles/*/home`).
   Adding one opens a pane running `claude` with the new folder, where the person signs in with `/login`. Harness never
   reads or stores a token except to read usage, as it already does for the default account.
2. **Usage per profile.** Each Claude and Codex profile gets its own usage reading (remaining percent of its tightest
   window).
3. **Change agent picks engine and profile.** The picker lists `Claude · <profile> (12% left)` and `Codex · <profile>` rows.
   A switch to another profile of the same engine is allowed.
4. **Switch PM from the Swarm.** A new backend command asks the PM's host to switch. The host runs the same steps Desktop's
   Change agent runs, over its own local daemon socket, and #2493's guards apply unchanged.
5. **Limit line with an action.** When the PM hits a limit, its line says so in local time and offers **Switch PM…**. The
   project's ⋮ menu also has **Switch PM…**.

## Non-goals

- Automatic switching on a limit.
- Moving the PM to another machine.
- Keeping the whole native conversation across a switch. Every switch, including Claude to Claude on another account,
  uses #2493's handoff file: the new session starts fresh and reads it. The Swarm's state (tasks, groups, chat, decisions)
  lives on the backend and is not affected. Resuming the same Claude conversation in another account (copy the transcript
  into the other `CLAUDE_CONFIG_DIR`, then `claude --resume`) is a follow-up, to be tried as a spike first: the other
  account also needs its own folder trust, settings and hooks, and per-project memory does not follow.
- The phone. It gets the same menu item and limit button in a follow-up.
- Switching a Builder or a Reviewer from the Swarm. Change agent already works on their panes for the machine owner.

## Design

### 1. Claude profiles on the machine (CLI)

- `cli/src/lib/claudeProfiles.ts` mirrors `codexProfiles.ts`: `listClaudeProfiles(observed)`, `linkClaudeProfile(path)`,
  `resolveClaudeProfilePath(path)`, persisted as `claude-profiles.json` (paths only, 0600, atomic, at most 256).
  - A folder counts when it holds `.claude.json` or `settings.json`.
  - Discovery: an inherited `CLAUDE_CONFIG_DIR`, conventional `~/.claude-*` folders, and Orca's
    `claude-profiles/*/home`, and the folders Desktop's "Add Claude account…" makes under `~/.harness/claude-profiles/`.
    The default account (no `CLAUDE_CONFIG_DIR`) is always the first row, marked `default: true`.
  - Local label (the owner's own windows): the account's `displayName`, else the folder name. Reported label (leaves the
    machine): from the folder only, never a name or email: the folder name, `Orca <first 4 of the uuid>` for Orca's `home`,
    `Claude <n>` for Harness's own folders.
  - **Offered** (owner's consent; both security reviews of #2528): a row is `offered` when it is the default account or the
    owner offered it by name (`swarm_account_offer {engine, path, offered}`, `lib/accountOffers.ts`). Linking a folder, Add
    Claude account and using an account in Change agent never offer it. Only offered accounts are reported to the Swarm (see 5).
    A withdraw drops it from the next report, and a switch on its way finds it gone; a PM already on it stays until moved.
- RPCs `claude_profiles_list {observedPaths}` and `claude_profile_link {path}` sit beside the Codex pair in
  `services/models.ts` `launchTargetRequests` and in `core/api.ts` `MODELS_REQUESTS`. They stay off the E2EE type lists
  (`lib/e2ee/core.ts` is pinned by the interop keystone and is not edited for this work), so they serve the machine's own
  windows and its host; a relayed window does not list another machine's accounts. Both answer the machine owner only (`OWNER_REQUIRED`), and so do
  the Codex pair from now on: they disclose folder paths.
- Every profile has an opaque `id`: the first 16 hex of sha256(`<machine id>:<engine>:<realpath>`); the default account's id
  is sha256(`<machine id>:<engine>:default`)[0..16]. The CLI, the backend and Desktop compute the same value and each pins the
  vector `('m', 'claude') -> 71dc90339553114c`. Only the machine maps an id back to a folder. The path given to Claude Code
  (and hashed for its Keychain item) is the folder as linked, not its realpath.

### 2. Starting Claude in a profile (CLI)

- `agent_create` takes `claudeHome`, validated as `codexHome` is (`core/agents/launches.ts:375-386`): absolute, at most
  4096 characters, no control characters, engine `claude`, no grid, and a listed non-default Claude profile of this machine
  or a folder under `~/.harness/claude-profiles/`; otherwise `INVALID_CLAUDE_HOME`. A default account is started with no
  `claudeHome` / `codexHome`.
- It travels on the `CreateAgent` input to the native launch, which already maps `NativeLaunchSource.claudeHome` to
  `CLAUDE_CONFIG_DIR` and installs the hooks there (`engines/nativeLaunch.ts:141-143`, `:210`).
- The registry row keeps it (`RegisteredSession.claudeHome`, as `hermesHome`), so restart, resume and the PM's rollback
  relaunch in the same account. It joins the launch-authority fingerprint (`core/agents/launchAuthority.ts`) and the agent
  frame (`lib/agentFrame.ts`).
- The native launch adopts an explicit `claudeHome` into the machine's known homes (`confirmHome`, today called only for
  the implicit home at `nativeLaunch.ts:218`), so the session's transcript is inside the transcript roots and binds.
- `launchHomeOf` (`lib/engineHomes.ts:370-374`) honours `profile` for variable homes, so folder trust (`.claude.json`) and
  `settings.json` writes go to the profile.
- A Harness Team account keeps its own rule for a Codex PM (`pmEngineHome`, `superTabs/start.ts:425-430`); a switch on a
  Team daemon offers its default account only.

### 3. Usage per profile (CLI)

- `readAccountUsage` takes an optional `claudeHome` or `codexHome`:
  - Claude: Keychain service `Claude Code-credentials-<sha256(dir)[0..8]>` with `-a <$USER or claude-code-user>`
    (the rule Desktop already has in `desktop/lib/usage/usage_credentials.dart:56-91`); file fallback
    `<dir>/.credentials.json`; account from `<dir>/.claude.json`.
  - Codex: `<dir>/auth.json`.
  - The default reading also passes `-a`, which fixes the stale Keychain item the CLI can read today.
- `usage_read` accepts an optional `{ profile: { engine, id } }`. Without it the answer is unchanged (old clients).
- Profile readings share the Anthropic throttle the machine report already respects: at most one read per profile per
  `USAGE_FRESH_MS`, and at most 8 profiles per engine.

### 4. Change agent with a profile (Desktop)

- The picker's engine rows (`desktop/lib/state/swarm_search.dart` `_filter`, ~:1959-1993) become one row per
  `(engine, profile)` on the pane's machine, read with `claude_profiles_list` / `codex_profiles_list` and `usage_read`:
  `Claude · Work (12% left)`. A machine with one account shows today's rows.
- `SwarmDestination` carries `agentProfile` beside `agentEngine` (`swarm_navigation.dart`). `_AgentChange` carries the
  chosen profile (`app_state.dart:271`).
- `changeAgent` compares `(engine, profile)`, not the engine alone (`app_state.dart:17262`), so a move to another account of
  the same engine runs.
- `_changeAgent` passes `claudeHome` / `codexHome` to `createAgent` (`:17506`). The handoff request is unchanged: the
  handoff file does not depend on the account, and `leadSwitch.ts` reads only `targetEngine` from its receipt.
- "Add Claude account…" at the end of the Claude rows opens a pane on the same machine running `claude` with a new
  `CLAUDE_CONFIG_DIR` under `~/.harness/claude-profiles/<n>` (the next free `n`, one add at a time) and says "Run /login,
  then pick it again". The CLI finds that folder by itself once Claude has created it.
- Change agent asks for accounts only on this computer's own panes (the list RPCs are local only). A Swarm Buddy's pane offers
  no engine or account change ("A Buddy keeps its engine for now"). Rows not offered to the Swarm say "Not offered to the Swarm";
  picking one runs this pane on it and offers nothing. "Swarm accounts…" opens the one place to offer or withdraw, which says who
  can then spend the account.

### 5. The machine reports its profiles (CLI → backend)

- The machine report gains `profiles: [{ engine, id, label, leftPercent, resetsAt }]`, at most 16, beside `readiness`:
  the **offered** accounts only (see 1), the default one of each engine included. A Team daemon reports its default accounts
  only. `label` is the reported label, at most 40 characters, never containing `@`. No path, email, account id or plan is
  sent. It is sent only to a backend that asks for capabilities.
- The backend's `machineObservationSchema` accepts it (strict, capped). `storedObservation` keeps it for contributed engines
  only, and serves it only to people who may switch a PM on that machine (its owner, owners of projects whose PM runs there);
  everyone else and every agent gets the reading without it. An old backend refuses the field and the CLI drops it through
  the existing `sendAlone` chain.
- The CLI advertises a `leadSwitch` capability (`machines.ts` `CAPABILITIES`), which the backend requires before it sends a
  switch, as `leadStart` is today.

### 6. Switch PM (backend)

- New person command `lead.switch { projectId, engine, profileId, model?, effort? }`.
  - Allowed for the project's owner (`manageProject`, as `lead.start`) and for the real owner of the machine running the PM
    (`machineOwnerId`; a borrower of a lent machine is not its owner).
  - A literal `'default'` profileId means the default id of the requested engine. The agent's `profileId` is absent for a
    default account.
  - Refused when: the project has no running PM (`NO_LEAD`); the PM's machine is offline (`MACHINE_OFFLINE`); its host lacks `leadSwitch`
    (`HOST_OUTDATED`); a switch is already pending (`LEAD_SWITCHING`); `profileId` is not in that machine's reported
    profiles for `engine` (`PROFILE_UNKNOWN`); the engine is not offered on that machine (`ENGINE_NOT_OFFERED`).
  - It is allowed while the Swarm is paused: it starts no new work.
- It sets `switchRequest = { id: operationId, engine, profileId, model, effort, requestedBy, at }` on the PM's agent row.
  The row already reaches its host (`read/hostRows.ts:77`).
- `agent.switchClaim { agentId, switchId }`: the host claims it (actor must be that agent), as `agent.stopLease` does.
  Answers `{ leaseId, expiresAt }` (15 minutes, covering #2493's 3 + 10 minute limits).
- `agent.switchResult { agentId, switchId, ok, error? }`: the host reports the end. It clears `switchRequest` and writes one
  line in the project's PM chat: "PM moved to Codex · Work." or "Couldn't switch the PM: <error>. It is back on Claude."
- `agent.rebind` takes an optional `profileId` (what actually started; an old backend refuses the field and the CLI resends
  once without it). It clears `switchRequest` (remembering it as landed, so exactly one result line is written), and clears
  `limitedUntil` and the `limit` alert only when the engine or the normalized account changed.
- When a switch lands on a non-default account and the person who asked is not the machine's owner, the owner gets one line
  in their Buddy chat: `<requester> moved the PM of <project> on <machine> to your <Engine> account "<label>".`
- An unclaimed request older than 2 minutes, or a claim whose lease ran out with no result, is dropped by the liveness
  sweep that runs on any machine's report (`staleSwitches`, `backend/src/superTabs/tidy.ts`) with the line "Couldn't switch
  the PM: its machine did not answer." An expired request cannot be claimed.

### 7. Switch PM (host)

- `cli/src/superTabs/leadSwitchRequest.ts` serves the PM rows of this machine whose agent has a `switchRequest`:
  1. claim it (`agent.switchClaim`);
  2. map `profileId` to a folder with the profile lists (refuse `PROFILE_UNKNOWN` if it is gone);
  3. over the local daemon socket (which is the machine owner, `backendSocket.ts:1024`), with a fresh 32-hex `changeId`:
     `agent_handoff_prepare { agentId, changeId, targetEngine }`, then `agent_close { mode: 'now', changeId }`, then
     `agent_create { engine, cwd, creationId: changeId, claudeHome | codexHome, model, effort, the old PM's Swarm role, skill
     and GitHub fields, startedBy: 'agent', prompt: <the Lead start prompt, then the handoff> }` (the PM comes back as a
     Swarm PM, exactly as its first start made it), then `agent_handoff_complete`;
  Before the close it refuses an account that is not offered or not signed in, and an old PM with no saved Swarm skill.
  4. report `agent.switchResult`. Success is when `agent.rebind` lands for that agent; failure is any refused step, or
     #2493's rollback reopening the old PM.
- #2493's `leadSwitch.ts` guards are unchanged. The host's own handoff receipt is what lets the close through.
- One switch per PM at a time (the run is recorded before the claim); a restart mid-switch follows #2493's record instead of
  running again. A Team daemon allows the default account only, and a Codex PM there keeps its own engine home (`pmEngineHome`).
- Result errors are fixed phrases, never paths or raw errors.

### 8. Where people see it (Desktop)

- Project ⋮ menu (`desktop/lib/super_tabs/view.dart` `_options`, ~:2401): **Switch PM…** for whoever may switch (see 6),
  shown while the project has a PM.
- The PM's limit line (`SuperTabTerminalRow`, `view.dart` ~:2686): the backend writes "<PM> hit a usage limit." with
  `source.limitedUntil`; Desktop shows "until 2:00 PM" in local time, and **Switch PM…** while the PM's `alerting` still has
  `limit` (the pattern of `answeredPromptAlerts`).
- The Switch PM dialog lists the PM machine's reported profiles: engine, label, `% left` and reset time, the current one
  marked, the ones at 0% shown but not selectable. Below the list: "The new session starts fresh and reads a handoff note.
  Tasks and chat stay." When the reader does not own that machine: "Only accounts its owner offered are listed." Confirm
  sends `lead.switch`. While it runs, the PM row shows "Switching…".

### 9. Move a PM between machines and choose its model (Dee, 11-03)

- `lead.switch` adds optional `machineId` and `model` fields. An omitted `machineId` keeps the existing same-machine
  behavior. When supplied, the backend admits the destination only if its contribution is active, its latest observation is
  online, it advertises `leadSwitch`, it offers the requested engine and profile, and the actor may place this project's PM
  there. Only the project's owner moves its PM to another machine (`manageProject`, as `lead.start`); the real owner of the
  source PM's machine still switches engine or account on that machine only. The destination is placed and recorded as the
  person who asked (`placeLead` with the actor, the whole command context, Team accounts idle included; both security
  reviews of #2705). A destination must pass the same
  `requireTeamWork` rules as a project Lead start; Team-account placement, contribution scope, project folder and
  generation are rechecked when the destination host launches. The server never accepts a machine merely because its id
  appears in the request.
- The backend stores the destination machine, requested model, and destination account in the one pending request on the
  PM row. The target host claims it, rechecks its current contribution and profile/sign-in, and starts a fresh PM session
  there with the existing handoff note and selected engine, account, and model. It carries the original PM's project folder,
  role, saved Swarm skill, permission mode, and GitHub setting; machine-specific folder and Team account rules are
  recomputed for the target. A request id/change id makes claim, create, adoption after restart and reporting idempotent.
- The candidate session is a separate agent until it proves it started. In one backend transaction, its successful start
  promotes it to the lead of the same lead conversation, clears the source's switch request, preserves project/task/chat
  state, and writes the single success line. Only after that committed promotion does the source host see the old session
  is no longer PM and close the old process named by this switch. The source stays authoritative and running before
  promotion. If destination validation or start fails, the candidate is closed if this switch created it, the source PM
  remains authoritative and running, and one failure line gives a fixed, safe reason. A timed-out or abandoned request is
  cleared by the existing liveness sweep; a late target cannot promote after the request expires or its claim is
  superseded.
- The source host prepares the existing handoff in its local project folder and sends only the bounded handoff note to
  the destination start through the switch's private host data. The backend exposes that note only to the claimed
  destination host, never in person or ordinary agent reads, and deletes it when the request settles or expires. The
  destination start treats it as quoted context, not instructions. A source that cannot prepare or transfer the note
  leaves the old PM running and ends the request with one fixed failure line.
- The Desktop dialog follows the agreed layout: a machine picker, then engine/account choices for that machine, then a
  model picker with Default first. It lists machines the person may use, including unavailable machines disabled with a
  short reason. Switching machines refreshes the account rows and compatible model choices; no stale selection can be
  submitted. When no destination, engine/account, or model can change, it shows the reason in one line. Phone remains out
  of scope. The chosen model is passed to the new session; an engine refusal follows existing launch behavior and drops
  the unsupported model/effort together, while the PM moves only if the fallback session rebinds.

```text
Switch PM
Machine   [ Mac 1 ▾ ]
○ Claude · Default     Current · 64% left
○ Codex · Default      80% left · resets Fri
Model     [ Default ▾ ]
The new session starts fresh and reads a handoff note. Tasks and chat stay.
                              [Cancel]  [Switch]
```

#### Design checklist addendum

- **Growth:** one optional target id and model on each PM's existing single switch request; cleared on rebind, failure, or
  stale-request expiry. No destination history or additional polling table.
- **Concurrency:** one request per PM. Claim lease and request id serialize competing hosts; destination contribution
  generation, Team placement and engine/profile support are revalidated immediately before launch. Only one accepted
  candidate promotion changes the lead conversation. Source closure is fenced by the settled switch id and old harness id.
- **Read cost:** no new poll; destination data uses the existing machine observation and host-row feed. Desktop reads the
  already loaded project snapshot and machine observations.
- **Scale:** bounded by existing machine, agent, profile and contribution caps. First warning is stale target claims or
  repeated start failures, visible through the existing switch failure line and machine liveness telemetry.
- **Compatibility:** `machineId` and `model` are optional; old clients retain same-machine switching. Old hosts cannot
  claim a destination switch without `leadSwitch`; clients refresh machine data before submission. A destination host
  accepts only request fields it knows and reports a safe failure if a newer backend asks for unsupported behavior.
- **Migration + rollback:** no migration. Old serialized requests omit destination and model and retain current semantics.
  Rolling back the backend leaves unknown optional fields unused; a target that cannot complete leaves the source PM
  running. Rollback never deletes task/chat state.
- **Audience:** backend checks both the actor's right to switch and the destination's right to run this project's work;
  the host repeats its contribution, generation, Team and profile checks. Machine ids and model names do not grant access.
- **Identity:** the target host starts the PM with its own authorized daemon and account. The project's owner login is never
  copied to the target. Team-account restrictions remain enforced by `requireTeamWork` and `teamAccountPool`.
- **Failure:** any pre-promotion refusal leaves the source authoritative and running and produces one fixed-reason line. The
  target process is stopped only if this switch created it and launch fails after creation. Once rebind lands, source
  cleanup cannot report the move as failed.
- **Platforms:** backend protocol and CLI host behavior are platform-neutral. Destination availability reflects each host's
  reported capabilities and account offerings; Desktop tests use a memory store and fake sign-in. Phone UI is out of scope.

## Design checklist (docs/feature-design-rules.md)

- **Growth:** `claude-profiles.json` is capped at 256 paths, the report at 16 profiles, `switchRequest` is one field per PM
  cleared on result or rebind. The handoff files are #2493's.
- **Concurrency:** one switch per PM, enforced by the backend (`LEAD_SWITCHING`) and by the host's #2493 record. The command
  writes only the PM's agent row in the Swarm's state transaction.
- **Read cost:** profiles ride the existing machine report (every 15 s heartbeat, unchanged size class). Usage per profile
  is throttled per profile. No new poll.
- **Scale:** 10x profiles per machine is capped at 16 reported; the warning metric is Anthropic 429s on usage reads, already
  logged by `machines.ts`.
- **Compatibility:** an old host never gets a switch (`leadSwitch` capability). An old backend refuses `profiles` and the
  CLI drops it. An old Desktop ignores the new fields and the new command. `usage_read` without a payload answers as today.
- **Migration and rollback:** no data migration. Rolling back the backend leaves `switchRequest` unread; rolling back the
  CLI leaves `claude-profiles.json` unused. A failed switch reopens the old PM (#2493).
- **Audience:** the backend checks who may switch. Profile ids are opaque; paths stay on the machine; the list RPCs answer
  the machine owner only.
- **Identity:** the PM runs in the account the person chose on that machine, never the project owner's own login. The
  switch is done by the machine's own daemon, as Change agent is.
- **Failure:** every refusal and every rollback is a line in the PM chat. A profile that lost its sign-in reads as
  "signed out" in the dialog and cannot be picked.
- **Platforms:** Claude profiles' Keychain rule is macOS; Linux uses `<dir>/.credentials.json`. Windows: the same file rule,
  untested, not offered until tested.

## Testing

- CLI: `claudeProfiles` list/link/discover (Orca layout, label rules, no email in the reported label); `agent_create` with
  `claudeHome` sets `CLAUDE_CONFIG_DIR`, writes trust into the profile and binds the transcript; `readAccountUsage` per
  profile (suffixed Keychain service, `-a`); the host's switch request end to end against a fake backend (claim, the four
  daemon calls with one `changeId`, result on rebind, result on rollback).
- Backend: `lead.switch` permissions and refusals; `switchClaim` / `switchResult`; `agent.rebind` clears the request and the
  limit; the limit line for a PM; the stale request pass.
- Desktop: picker rows per profile; a same-engine profile change runs; the ⋮ item and the limit button show for the right
  people and hide once the limit ends; the dialog sends `lead.switch`.
- One manual run on Diego's Mac: a PM on the default Claude account switched to his Orca Claude account, then to Codex, then
  back, from the Swarm menu.
