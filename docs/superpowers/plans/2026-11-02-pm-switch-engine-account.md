# Switch a Swarm PM to another engine or account: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person who may manage a project moves its PM to another engine or another account on the same machine in one action, and the PM stays the same Swarm agent.

**Architecture:** The CLI learns Claude profiles (`CLAUDE_CONFIG_DIR` folders) as it knows Codex profiles, launches Claude in one, reads usage per profile and reports opaque profile ids to the backend. The backend gains `lead.switch`, which the PM's host claims and carries out with #2493's Change agent steps over its own local daemon socket. Desktop's Change agent picks engine and profile, and the Swarm offers **Switch PM…** in the project menu and on the PM's limit line.

**Tech Stack:** TypeScript (cli, backend, vitest), Flutter/Dart (desktop).

**Spec:** `docs/superpowers/specs/2026-11-02-pm-switch-engine-account-design.md`

## Global Constraints

- Every switch uses #2493's handoff file; no transcript is copied between accounts.
- No path, email, account id or plan leaves the machine. Reported profile labels are at most 40 characters and dropped if they contain `@`.
- Profile id = first 16 hex of sha256(`<machine id>:<engine>:<realpath>`). The default account's id is `'default'`.
- Claude Keychain service for a profile: `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR as given, no trailing slash)>`, read with `-a <$USER if /^[a-zA-Z0-9._-]+$/ else claude-code-user>`.
- At most 256 linked Claude paths, 16 reported profiles per machine, 8 usage reads per engine, one usage read per profile per `USAGE_FRESH_MS`.
- `lead.switch` is allowed for the project owner (`manageProject`) and the owner of the PM's machine. Error codes: `LEAD_SWITCHING`, `PROFILE_UNKNOWN`, `HOST_OUTDATED`, `ENGINE_NOT_OFFERED`, `PROJECT_OWNER_REQUIRED`, `NO_LEAD`, `MACHINE_OFFLINE`.
- Switch claim lease: 15 minutes. Unclaimed request expires after 2 minutes.
- Copy, verbatim: menu item `Switch PM…`; dialog note `The new session starts fresh and reads a handoff note. Tasks and chat stay.`; result lines `PM moved to <Engine> · <label>.` / `Couldn't switch the PM: <error>. It is back on <Engine>.` / `Couldn't switch the PM: its machine did not answer.`; limit line `<PM name> hit a usage limit.`
- One PR per part (A CLI profiles + launch + usage + report, B backend, C host, D Desktop), each test first, Reviewer in its own group, `make merge-pr` once `ci/required` is green. CLI files under `src/core` and `src/services` keep 100% coverage (`npm run test:core`).

## Review Focus

- A profile folder deleted or signed out after it was reported: the host refuses `PROFILE_UNKNOWN` (gone) or the new session fails; either way the old PM is back and a line says so. Test in Task 8.
- A `lead.switch` for a PM whose machine runs an old CLI: refused `HOST_OUTDATED`, never left pending. Test in Task 6.
- Two people press Switch PM at once: the second gets `LEAD_SWITCHING`. Test in Task 6.
- An Orca profile folder named `home` with an `oauthAccount.emailAddress` and no `displayName`: the reported label is `Orca <4 hex>`, never the email. Test in Task 1.
- Change agent on a pane whose current profile is the one picked: nothing happens (no close, no create). Test in Task 9.

---

## Part A: CLI (one PR)

### Task 1: Claude profiles: list, link, discover

**Files:**
- Create: `cli/src/lib/claudeProfiles.ts`, `cli/src/lib/claudeProfiles.test.ts`
- Modify: `cli/src/services/models.ts:511-546` (`launchTargetRequests`), `cli/src/core/api.ts:727-732` (`MODELS_REQUESTS`), `cli/src/services/models.spec.ts` (never `cli/src/lib/e2ee/core.ts` or `desktop/lib/e2ee/envelope.dart`: the RPCs serve the local machine only)

**Interfaces:**
- Produces: `interface ClaudeProfile { id: string; path: string; label: string; reportLabel: string }`; `listClaudeProfiles(observedPaths?: string[], options?: { home?: string; environment?: NodeJS.ProcessEnv; machineId: string }): ClaudeProfile[]`; `linkClaudeProfile(path: string, machineId: string): { profile: ClaudeProfile } | { error: 'INVALID_PATH' | 'NOT_FOUND' }`; `profileId(machineId: string, engine: 'claude' | 'codex', realpath: string): string`; RPCs `claude_profiles_list { observedPaths }` → `{ profiles }`, `claude_profile_link { path }` → `{ profile } | { error }`.

- [ ] **Step 1: Write the failing tests** in `claudeProfiles.test.ts`:
  - `lists the default account first with id 'default'`.
  - `finds Orca profiles`: a temp home with `Library/Application Support/orca/claude-profiles/ab12cd34-…/home/.claude.json` holding `{"oauthAccount":{"emailAddress":"a@b.c"}}` → one row with `label` `'a@b.c'` and `reportLabel` `'Orca ab12'`.
  - `uses displayName for the label when present` → `reportLabel === 'Work'` for `{"oauthAccount":{"displayName":"Work"}}`.
  - `drops a report label containing @` and `cuts it at 40 characters`.
  - `links a folder and keeps it across reads`; `refuses a relative path with INVALID_PATH`.
  - `profileId is stable and 16 hex`.
  - In `models.spec.ts`: `claude_profiles_list and codex_profiles_list answer OWNER_REQUIRED to a guest`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/claudeProfiles.test.ts src/services/models.spec.ts`. Expected: FAIL (module missing; codex RPC answers a guest).
- [ ] **Step 3: Implement** by copying `codexProfiles.ts`/`codexProfileDiscovery.ts` patterns (file `claude-profiles.json`, 0600, atomic, 256 cap; a folder counts when it holds `.claude.json` or `settings.json`; discovery = inherited `CLAUDE_CONFIG_DIR`, `~/.claude-*`, Orca `claude-profiles/*/home`). Add the two RPCs beside the Codex pair with `if (!asker.owner) reply({ error: 'OWNER_REQUIRED' })` on all four, and add the types to `MODELS_REQUESTS` only.
- [ ] **Step 4: Run** the same command, then `npm run test:core`. Expected: PASS, 100% for `services/models.ts`.
- [ ] **Step 5: Commit** `feat(cli): Claude profiles, listed and linked like Codex profiles`.

### Task 2: Start Claude in a profile

**Files:**
- Modify: `cli/src/core/agents/launches.ts:375-386,506`, `cli/src/core/agents/create.ts`, `cli/src/lib/registry.ts:178-192`, `cli/src/core/agents/launchAuthority.ts:5-10`, `cli/src/lib/agentFrame.ts:88,259`, `cli/src/engines/nativeLaunch.ts:216-218`, `cli/src/lib/engineHomes.ts:370-374`, `cli/src/backendSocket.ts:153-160`
- Test: `cli/src/core/agents/launches.spec.ts`, `cli/src/engines/nativeLaunch.spec.ts`, `cli/src/lib/engineHomes.spec.ts`

**Interfaces:**
- Consumes: none.
- Produces: `agent_create` payload field `claudeHome?: string`; `RegisteredSession.claudeHome?: string | null`; agent frame field `claudeHome`; error `INVALID_CLAUDE_HOME`.

- [ ] **Step 1: Write the failing tests:**
  - launches.spec: `claudeHome is refused for codex and with a grid (INVALID_CLAUDE_HOME)`; `claudeHome reaches the create input and the registry row`.
  - nativeLaunch.spec: `an explicit claudeHome is adopted as a known home` (`confirmHome` called with `('claude', home)`).
  - engineHomes.spec: `launchHomeOf honours the profile for CLAUDE_CONFIG_DIR homes` (trust file resolves to `<profile>/.claude.json`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/agents/launches.spec.ts src/engines/nativeLaunch.spec.ts src/lib/engineHomes.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement:** validate like `codexHome` (absolute, ≤4096, no control characters, engine claude, no grid); put it on `CreateAgent`; store it on the row as `hermesHome` is; add it to the authority fingerprint and agent frame; call `confirmHome` for an explicit Claude home; in `launchHomeOf`'s variable branch use `profile ||` before the environment.
- [ ] **Step 4: Run** the same tests and `npm run test:core`. Expected: PASS, coverage 100%.
- [ ] **Step 5: Commit** `feat(cli): agents start Claude in a chosen profile (CLAUDE_CONFIG_DIR)`.

### Task 3: Usage per profile

**Files:**
- Modify: `cli/src/lib/agentCredentials.ts`, `cli/src/lib/accountUsage.ts`, `cli/src/services/usage.ts`
- Test: `cli/src/lib/accountUsage.spec.ts`, `cli/src/services/usage.spec.ts`

**Interfaces:**
- Produces: `claudeKeychainService(configDir?: string): string`; `readAccountUsage(deps & { claudeHome?: string; codexHome?: string })`; `usage_read { profile?: { engine: 'claude' | 'codex'; id: string } }` → `{ providers }` for that profile.

- [ ] **Step 1: Write the failing tests:** `claudeKeychainService('/x/home')` equals `'Claude Code-credentials-' + sha256('/x/home').slice(0, 8)`; `the keychain read passes -a`; `a Claude profile reads <dir>/.credentials.json and <dir>/.claude.json`; `a Codex profile reads <dir>/auth.json`; `usage_read without a payload answers as before`; `usage_read with an unknown profile id answers PROFILE_UNKNOWN`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/lib/accountUsage.spec.ts src/services/usage.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the service rule and `-a` account rule (port `desktop/lib/usage/usage_credentials.dart:56-91`), the per-home paths, and the payload lookup through `listClaudeProfiles` / `listCodexProfiles` by id.
- [ ] **Step 4: Run** the same tests and `npm run test:core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): read each Claude and Codex profile's usage`.

### Task 4: Report profiles and the leadSwitch capability

**Files:**
- Modify: `cli/src/superTabs/machines.ts` (observation literal ~:530-547, `CAPABILITIES` :175, `sendAlone` :731-760)
- Test: `cli/src/superTabs/machines.spec.ts`

**Interfaces:**
- Consumes: Task 1 `listClaudeProfiles`, Task 3 per-profile usage.
- Produces: observation field `profiles: { engine: 'claude' | 'codex'; id: string; label: string; leftPercent: number | null; resetsAt: string | null }[]` (≤16); capability `'leadSwitch'`.

- [ ] **Step 1: Write the failing tests:** `the report lists profiles with ids and report labels, no paths`; `profiles are dropped after the backend refuses the field`; `capabilities include leadSwitch when asked`; `usage is read at most once per profile per USAGE_FRESH_MS`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/machines.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with the existing readiness/quota caches; `leftPercent` = 100 − the tightest window's `usedPercent`.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): machines report their engine profiles and can switch a PM`, then open PR A.

## Part B: Backend (one PR)

### Task 5: Store reported profiles

**Files:**
- Modify: `backend/src/superTabs/machines.ts:114-187` (`machineObservationSchema`, `storedObservation`), `backend/src/superTabs/model.ts:805-815`
- Test: `backend/src/superTabs/machines.test.ts`

**Interfaces:**
- Produces: `StoredReading.profiles` (same shape as Task 4), kept only for contributed engines and sent to clients with `pool.observation`.

- [ ] **Step 1: Write the failing tests:** `accepts up to 16 profiles and refuses a 17th`; `refuses a label with @`; `keeps profiles of contributed engines only`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/machines.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** a strict, capped zod schema and the `storedObservation` filter.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(swarm): store each machine's reported engine profiles`.

### Task 6: `lead.switch`, claim and result

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (schema :121-287; handlers beside `lead.start` :1343 and `agent.stopLease` :2315; `agent.rebind` :2241), `backend/src/superTabs/model.ts` (`Agent.switchRequest`)
- Test: `backend/src/superTabs/commands.test.ts`, `backend/integration/superTabLiveness.test.ts`

**Interfaces:**
- Consumes: Task 5 `profiles`.
- Produces: commands `lead.switch { projectId, engine, profileId, model?, effort? }`, `agent.switchClaim { agentId, switchId }` → `{ leaseId, expiresAt }`, `agent.switchResult { agentId, switchId, ok, error? }`; `Agent.switchRequest?: { id: string; engine: string; profileId: string; model?: string; effort?: string; requestedBy: string; at: string; claimedUntil?: string }`.

- [ ] **Step 1: Write the failing tests (commands.test.ts):**
  - `the project owner and the PM machine's owner may switch; a member may not (PROJECT_OWNER_REQUIRED)`.
  - `refuses NO_LEAD, MACHINE_OFFLINE (no fresh reading), HOST_OUTDATED (no leadSwitch capability), LEAD_SWITCHING (second request), PROFILE_UNKNOWN, ENGINE_NOT_OFFERED`.
  - `works while the Swarm is paused`.
  - `switchClaim only by the PM agent itself; lease 15 minutes`.
  - `switchResult ok writes "PM moved to Codex · Work." and clears the request`; `ok:false writes "Couldn't switch the PM: <error>. It is back on Claude."`.
  - `agent.rebind clears switchRequest, limitedUntil and the limit alert when engine or account changed`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/commands.test.ts -t "lead.switch|switchClaim|switchResult|rebind clears"`. Expected: FAIL.
- [ ] **Step 3: Implement** the three commands with `manageProject` or `[pool.ownerId]` for the PM machine; `switchRequest.id = operationId`.
- [ ] **Step 4: Run** the same command and `npx vitest run --config vitest.super-tabs.config.ts integration/superTabLiveness.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(swarm): lead.switch asks a PM's host to move it to another engine or account`.

### Task 7: The PM's limit line, and stale switches

**Files:**
- Modify: `backend/src/superTabs/terminal.ts:150-176` (`terminalAlert`), `backend/src/superTabs/tidy.ts` (beside `idleNotices`), `backend/src/superTabs/store.ts:3097`
- Test: `backend/src/superTabs/terminal.test.ts`, `backend/src/superTabs/tidy.test.ts`

**Interfaces:**
- Produces: limit row text `<PM name> hit a usage limit.` with `source.limitedUntil` and `source.lead: true` when the target is the project's PM; `staleSwitches(state: SuperTabState, now: number): MessageDraft[]`.

- [ ] **Step 1: Write the failing tests:** `a PM's limit row says "<name> hit a usage limit." and marks source.lead`; `a worker's row is unchanged`; `staleSwitches drops an unclaimed request after 2 minutes and a lapsed claim, with "Couldn't switch the PM: its machine did not answer."`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/terminal.test.ts src/superTabs/tidy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**; call `staleSwitches` where `idleNotices` runs (store.ts:3097).
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(swarm): the PM's limit line names it, and a switch nobody answered ends with a line`, then open PR B.

## Part C: Host (one PR, after A and B are merged)

### Task 8: The host carries out a switch request

**Files:**
- Create: `cli/src/superTabs/leadSwitchRequest.ts`, `cli/src/superTabs/leadSwitchRequest.spec.ts`
- Modify: `cli/src/superTabs/host.ts` (poll beside `releaseWorker` :948 and `keepAlive` :984-987)

**Interfaces:**
- Consumes: Task 6 commands and `switchRequest`; Task 1/3 profile lookup by id; Task 2 `claudeHome`; #2493 `leadSwitch.ts` unchanged.
- Produces: `serveLeadSwitch(row: HostRow, deps: { backend; daemon: LocalDaemon; profiles: (engine, id) => string | null | 'default'; now }): Promise<void>`.

- [ ] **Step 1: Write the failing tests (leadSwitchRequest.spec.ts)** against a fake backend and a fake daemon:
  - `claims, then prepares the handoff, closes with the change id, creates with creationId = changeId and the profile's home, completes the handoff` (assert the four daemon calls and one shared 32-hex `changeId`).
  - `reports ok once agent.rebind is seen for the PM`.
  - `reports ok:false with the error and leaves the old PM to #2493's rollback when the create is refused`.
  - `refuses PROFILE_UNKNOWN without closing the PM when the profile is gone`.
  - `does nothing for a request it cannot claim`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/superTabs/leadSwitchRequest.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** over the local daemon socket (`openDaemon(where)` as `start.ts` does); the handoff prompt is the one `agent_handoff_prepare` returns; Team daemons offer only `'default'`.
- [ ] **Step 4: Run** the spec, `npx vitest run src/superTabs/host.spec.ts src/superTabs/leadSwitch.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): a PM's host switches it when the Swarm asks`, then open PR C.

## Part D: Desktop (one PR; Task 9 may ship after A alone)

### Task 9: Change agent picks engine and profile

**Files:**
- Modify: `desktop/lib/state/swarm_search.dart` (`_filter` ~:1959-1993), `desktop/lib/state/swarm_navigation.dart:319,367`, `desktop/lib/state/app_state.dart` (`_AgentChange` :271, `changeAgent` :17255-17262, `_changeAgent` :17506, add `listClaudeProfiles`/`linkClaudeProfile` beside :15109-15130, `createAgent` `claudeHome` beside `codexHome`)
- Test: `desktop/test/agent_change_test.dart`

**Interfaces:**
- Consumes: Task 1 RPCs, Task 2 `claudeHome`, Task 3 `usage_read { profile }`.
- Produces: `SwarmDestination.agentProfile: String?` (profile id); `AppNotifier.changeAgent(machineId, agentId, engine, {String? profile})`.

- [ ] **Step 1: Write the failing tests:** `the picker lists one row per profile with % left`; `a same-engine change to another profile closes and creates with claudeHome`; `picking the current engine and profile does nothing`; `a Codex profile passes codexHome`; `Add Claude account… opens a pane running claude with a new CLAUDE_CONFIG_DIR and links it`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/agent_change_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement**; compare `(engine, profile)` in `changeAgent`; the handoff request stays as it is.
- [ ] **Step 4: Run** the same test and `flutter analyze lib/state`. Expected: PASS, no issues.
- [ ] **Step 5: Commit** `feat(desktop): Change agent picks the engine and the account`.

### Task 10: Switch PM in the Swarm

**Files:**
- Create: `desktop/lib/super_tabs/switch_pm.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (`_options` ~:2401, `SuperTabTerminalRow` ~:2686), `desktop/lib/super_tabs/model.dart` (read `observation.profiles`, `agent.switchRequest`)
- Test: `desktop/test/super_tab_switch_pm_test.dart`, `desktop/test/super_tab_terminal_rows_test.dart`

**Interfaces:**
- Consumes: Task 5 `profiles`, Task 6 `lead.switch` and `switchRequest`, Task 7 `source.lead`.
- Produces: `showSwitchPm(BuildContext, SuperTabController, String projectId)`.

- [ ] **Step 1: Write the failing tests:** `the project owner and the PM machine's owner see Switch PM…; a member does not`; `the dialog lists the PM machine's profiles with % left, marks the current one and disables 0%`; `confirm sends lead.switch with engine and profileId`; `the PM row shows Switching… while switchRequest is set`; `the PM's limit line shows local time and Switch PM… until the limit alert ends`.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_switch_pm_test.dart test/super_tab_terminal_rows_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement**; copy `SuperTabRouteRow._action` (route_row.dart:76) for the row button and `showProjectAction` (project_options.dart:82) for the menu item.
- [ ] **Step 4: Run** the same tests and `flutter analyze lib/super_tabs`. Expected: PASS, no issues.
- [ ] **Step 5: Commit** `feat(desktop): Switch PM from the project menu and the PM's limit line`, then open PR D.

### Task 11: Manual check on Diego's Mac

- [ ] With all four PRs merged and released, from the Swarm menu: switch a PM from the default Claude account to an Orca Claude account, then to Codex, then back. Record each line the PM chat shows and that the PM kept its tasks. Note the result in PR D.
